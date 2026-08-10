/**
 * Staging an object's content on the local filesystem.
 *
 * Split in two like {@linkcode import("./commit.ts").planVersion} and
 * {@linkcode import("./commit.ts").commitVersion}: {@linkcode planExport}
 * resolves the object, filters the state, and decides every destination path —
 * all the cheap failure modes — and {@linkcode runExport} then moves bytes with
 * no decisions left to make.
 *
 * The destination is a directory standing in for the object root: logical paths
 * are reconstructed beneath it, subdirectories and all. That is what makes two
 * logical paths structurally incapable of contending for one destination, and
 * why there is no basename-collision rule to enforce.
 *
 * This is the one module that writes outside the OCFL storage root, so it is
 * also the one that touches `Deno.*` directly for its *output*. Reads still go
 * through {@linkcode import("./storage/types.ts").Storage}, which is what lets
 * an export from S3 and an export from local disk be the same code.
 *
 * @module
 */
import { digestingStream, digestsEqual, digestStream } from "./digest.ts";
import { OcflError } from "./errors.ts";
import { findObject, resolveState } from "./object.ts";
import { validatePaths } from "./ops.ts";
import type { StorageRoot } from "./root.ts";
import { joinPath } from "./storage/types.ts";

/** Default simultaneous downloads. */
export const DEFAULT_CONCURRENCY = 4;

/**
 * Append a validated logical path to the destination directory.
 *
 * No path library, for the reason `storage/local.ts` gives: Deno accepts `/` on
 * every platform it supports, and the bundler would inline the dependency for
 * nothing. Safe because {@linkcode validatePaths} has already rejected empty,
 * `.`, `..`, and absolute logical paths.
 */
function destinationFor(dest: string, logicalPath: string): string {
  return `${dest.replace(/\/+$/, "")}/${logicalPath}`;
}

/** Everything before the last `/`. */
function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "/";
}

/** Everything after the last `/`. */
function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** One logical file to place beneath the destination directory. */
export type ExportEntry = {
  logicalPath: string;
  /**
   * Content path holding these bytes, relative to the object root.
   *
   * Undefined exactly when {@linkcode copyFrom} is set: the bytes come from a
   * sibling destination this run already wrote, not from storage.
   */
  contentPath?: string;
  /** Absolute path these bytes are written to. */
  destPath: string;
  /** Manifest digest these bytes must produce. */
  digest: string;
  /**
   * Destination of the entry holding the same digest, when one precedes this.
   *
   * Deduplication: a version may map two logical paths onto one content file,
   * so the bytes are fetched once and the duplicate becomes a local copy.
   */
  copyFrom?: string;
};

/** Everything needed to run an export, decided up front. */
export type ExportPlan = {
  id: string;
  /** Object root relative to the storage root. */
  objectPath: string;
  /** Version whose state is being exported. */
  version: string;
  digestAlgorithm: string;
  /** Absolute destination directory. */
  dest: string;
  /** Files to place, in logical-path order. */
  entries: ExportEntry[];
};

/** How one exported file got to its destination. */
export type ExportSource = "fetched" | "existing" | "copied";

/** One file, as actually placed. */
export type ExportedFile = {
  logicalPath: string;
  destPath: string;
  digest: string;
  size: number;
  source: ExportSource;
  verified: boolean;
};

/** Inputs to {@linkcode planExport}. */
export type ExportOptions = {
  id: string;
  /** Absolute destination directory. Created by {@linkcode runExport}. */
  dest: string;
  /** Version to export; defaults to the object's head. */
  version?: string;
  /** Export this one logical path instead of the whole state. */
  only?: string;
};

/**
 * Decide everything about an export without writing anything.
 *
 * @throws {OcflError} when the object, version, or logical path does not exist,
 *   when the inventory holds a path that is unsafe to reconstruct, or when the
 *   destination exists as something other than a directory.
 */
export async function planExport(
  root: StorageRoot,
  options: ExportOptions,
): Promise<ExportPlan> {
  if (!options.dest.startsWith("/")) {
    throw new OcflError(
      `export destination must be an absolute path; got ${
        JSON.stringify(options.dest)
      }`,
    );
  }

  const object = await findObject(root, options.id);
  const version = options.version ?? object.inventory.head;
  const state = resolveState(object.inventory, version);

  // The write path validates the paths it is about to create; the read path
  // must validate the paths it is about to trust. An inventory holding '..',
  // an absolute path, or a file that is also a directory would otherwise write
  // outside the destination or over its own siblings.
  validatePaths(state.map((file) => file.logicalPath), "logical");

  const selected = options.only === undefined
    ? state
    : state.filter((file) => file.logicalPath === options.only);
  if (selected.length === 0) {
    throw new OcflError(
      `${options.id} has no logical path ${JSON.stringify(options.only)} in ` +
        `${version}; that version holds ${state.length} file(s)`,
      { path: object.path },
    );
  }

  await requireDirectoryOrAbsent(options.dest);

  // First entry for a digest fetches; the rest copy from it once it has landed.
  const fetchedFor = new Map<string, string>();
  const entries: ExportEntry[] = [];
  for (const file of selected) {
    const destPath = destinationFor(options.dest, file.logicalPath);
    const already = fetchedFor.get(file.digest.toLowerCase());
    if (already !== undefined) {
      entries.push({
        logicalPath: file.logicalPath,
        destPath,
        digest: file.digest,
        copyFrom: already,
      });
      continue;
    }
    fetchedFor.set(file.digest.toLowerCase(), destPath);
    entries.push({
      logicalPath: file.logicalPath,
      // Any content path for a digest holds the same bytes by definition, so
      // the first is as good as any other.
      contentPath: file.contentPaths[0],
      destPath,
      digest: file.digest,
    });
  }

  return {
    id: object.inventory.id,
    objectPath: object.path,
    version,
    digestAlgorithm: object.inventory.digestAlgorithm,
    dest: options.dest,
    entries,
  };
}

/**
 * Fail unless `path` is absent or a directory.
 *
 * Exporting into a regular file would mean either clobbering it or writing
 * paths beneath something that cannot hold them.
 */
async function requireDirectoryOrAbsent(path: string): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return; // runExport creates it
    throw error;
  }
  if (!info.isDirectory) {
    throw new OcflError(
      `export destination ${path} exists and is not a directory`,
    );
  }
}

/** Reporting hooks {@linkcode runExport} uses. */
export type ExportContext = {
  /** Simultaneous downloads. Defaults to {@linkcode DEFAULT_CONCURRENCY}. */
  concurrency?: number;
  logger?: {
    info: (message: string, properties?: unknown) => void;
    warning: (message: string, properties?: unknown) => void;
  };
};

/**
 * Execute a plan, writing each file only once its digest checks out.
 *
 * Files are placed concurrently — a version's files are independent, and on S3
 * the round trip dominates. Copies run in a second pass, because a copy's
 * source must have landed first.
 *
 * There is no rollback. A half-populated staging directory is not invalid the
 * way a half-written OCFL version is, and the destination may hold files this
 * run did not put there, so a failure leaves what it has already placed and
 * says so.
 *
 * @returns One record per file, in the plan's logical-path order.
 * @throws {OcflError} on a digest mismatch, which leaves nothing at that
 *   destination.
 */
export async function runExport(
  root: StorageRoot,
  plan: ExportPlan,
  context: ExportContext = {},
): Promise<ExportedFile[]> {
  const concurrency = Math.max(1, context.concurrency ?? DEFAULT_CONCURRENCY);
  await Deno.mkdir(plan.dest, { recursive: true });

  // Indexed by plan position, so the manifest keeps logical-path order however
  // the downloads interleave.
  const placed = new Array<ExportedFile | undefined>(plan.entries.length);

  const fetches: number[] = [];
  const copies: number[] = [];
  plan.entries.forEach((entry, index) => {
    (entry.copyFrom === undefined ? fetches : copies).push(index);
  });

  const place = async (index: number) => {
    const entry = plan.entries[index];
    placed[index] = await placeEntry(root, plan, entry);
    context.logger?.info("{source} {logicalPath} -> {destPath}", {
      source: placed[index]?.source,
      logicalPath: entry.logicalPath,
      destPath: entry.destPath,
    });
  };

  await pool(fetches, concurrency, place);
  await pool(copies, concurrency, place);

  return placed as ExportedFile[];
}

/**
 * Run `task` over `items` with at most `limit` in flight.
 *
 * The first failure stops new tasks starting, but the ones already running are
 * awaited before it propagates — a task that is cancelled mid-write cannot
 * clean up its own temp file.
 */
async function pool<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: unknown;

  const worker = async () => {
    while (failure === undefined) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        await task(items[index]);
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  if (failure !== undefined) throw failure;
}

/** Place one file, fetching, copying, or leaving it alone as the plan says. */
async function placeEntry(
  root: StorageRoot,
  plan: ExportPlan,
  entry: ExportEntry,
): Promise<ExportedFile> {
  await Deno.mkdir(parentOf(entry.destPath), { recursive: true });

  if (entry.copyFrom !== undefined) {
    // The source was digest-checked as it landed, so the copy inherits that.
    await Deno.copyFile(entry.copyFrom, entry.destPath);
    const info = await Deno.stat(entry.destPath);
    return {
      logicalPath: entry.logicalPath,
      destPath: entry.destPath,
      digest: entry.digest,
      size: info.size,
      source: "copied",
      verified: true,
    };
  }

  const existing = await matchingExisting(entry, plan.digestAlgorithm);
  if (existing !== undefined) {
    return {
      logicalPath: entry.logicalPath,
      destPath: entry.destPath,
      digest: entry.digest,
      size: existing.size,
      source: "existing",
      verified: true,
    };
  }

  const size = await fetchEntry(root, plan, entry);
  return {
    logicalPath: entry.logicalPath,
    destPath: entry.destPath,
    digest: entry.digest,
    size,
    source: "fetched",
    verified: true,
  };
}

/**
 * Size of the file already at the destination, when its bytes are the ones
 * wanted.
 *
 * Hashing what is already on disk is what makes a re-export cost local reads
 * instead of a second transfer — the whole point of staging content.
 */
async function matchingExisting(
  entry: ExportEntry,
  algorithm: string,
): Promise<{ size: number } | undefined> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(entry.destPath, { read: true });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    if (error instanceof Deno.errors.IsADirectory) {
      throw new OcflError(
        `export destination ${entry.destPath} for logical path ` +
          `${JSON.stringify(entry.logicalPath)} is a directory`,
      );
    }
    throw error;
  }
  const { digest, size } = await digestStream(file.readable, algorithm);
  return digestsEqual(digest, entry.digest) ? { size } : undefined;
}

/**
 * Stream one content file to its destination, verifying as it goes.
 *
 * The bytes land on a sibling temp path and are renamed in only once the digest
 * matches. Sibling rather than a temp directory so the rename stays on one
 * filesystem and is therefore atomic; renamed rather than written in place so a
 * mismatch leaves nothing behind and a concurrent reader never sees a partial
 * file at a real destination.
 *
 * @returns Bytes written.
 */
async function fetchEntry(
  root: StorageRoot,
  plan: ExportPlan,
  entry: ExportEntry,
): Promise<number> {
  const contentPath = entry.contentPath as string;
  const temporary = `${parentOf(entry.destPath)}/.${nameOf(entry.destPath)}.${
    crypto.randomUUID().slice(0, 8)
  }.part`;

  try {
    const digesting = digestingStream(plan.digestAlgorithm);
    const source = await root.storage.readStream(
      joinPath(plan.objectPath, contentPath),
    );
    const file = await Deno.open(temporary, {
      write: true,
      create: true,
      truncate: true,
    });
    await source.pipeThrough(digesting.stream).pipeTo(file.writable);

    const written = digesting.digest();
    if (!digestsEqual(written, entry.digest)) {
      throw new OcflError(
        `content at ${contentPath} digests to ${written}, not the ` +
          `${entry.digest} its manifest records; ${plan.id} fails fixity and ` +
          `${entry.destPath} was not written`,
        { code: "E092", path: contentPath },
      );
    }

    await Deno.rename(temporary, entry.destPath);
    return digesting.size();
  } catch (error) {
    // Best-effort: a cleanup failure must not mask what actually went wrong.
    await Deno.remove(temporary).catch(() => {});
    throw error;
  }
}
