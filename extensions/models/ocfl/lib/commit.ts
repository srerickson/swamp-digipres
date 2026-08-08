/**
 * Building and committing a new OCFL object version.
 *
 * Split in two on purpose. {@linkcode planVersion} does everything that can
 * fail cheaply — resolving the object, folding the operations, digesting
 * sources, deciding what actually needs writing, and serializing the inventory
 * exactly once. {@linkcode commitVersion} then performs a fixed sequence of
 * writes with no remaining decisions to make. A dry run is the planner alone,
 * and a durable transaction log, if one is ever added, wraps the same seam.
 *
 * This deviates from the OCFL implementation notes in one respect: there is no
 * staging tree. Content streams from the caller's source paths straight to its
 * final `vN/<contentDirectory>/…` location. `references/transactions.md` §2
 * ratifies that ("Write directly to final paths… One code path for POSIX and
 * S3") and §8.2 documents the cost — a bounded window in which a third-party
 * validator would report E046, ending when the root sidecar lands.
 *
 * @module
 */
import {
  digestBytes,
  digestingStream,
  digestsEqual,
  digestStream,
} from "./digest.ts";
import { isNotFound, OcflError } from "./errors.ts";
import {
  contentDirectoryOf,
  type Inventory,
  nextVersion,
  readInventory,
  sidecarName,
} from "./inventory.ts";
import { addSources, applyOps, validatePaths, type VersionOp } from "./ops.ts";
import { readNamaste, writeNamaste } from "./namaste.ts";
import { resolveState } from "./object.ts";
import type { StorageRoot } from "./root.ts";
import { removeTree } from "./storage/tree.ts";
import type { Bytes, Storage } from "./storage/types.ts";
import { joinPath } from "./storage/types.ts";

/** Where content bytes come from. Sources are outside the OCFL storage root. */
export interface SourceReader {
  /** Size and modification time, used to detect drift between plan and write. */
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  /** Open the source for reading. */
  open(path: string): Promise<ReadableStream<Uint8Array>>;
}

/** Reads sources from the local filesystem. */
export const localSources: SourceReader = {
  async stat(path: string) {
    let info: Deno.FileInfo;
    try {
      info = await Deno.stat(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new OcflError(`source file not found: ${path}`, { cause: error });
      }
      throw error;
    }
    if (!info.isFile) {
      throw new OcflError(`source is not a regular file: ${path}`);
    }
    return { size: info.size, mtimeMs: info.mtime?.getTime() ?? 0 };
  },
  async open(path: string) {
    const file = await Deno.open(path, { read: true });
    return file.readable;
  },
};

/** One content file that must be written for the new version. */
export type ContentEntry = {
  /** Source path, outside the storage root. */
  source: string;
  /** Destination relative to the object root, under the target version. */
  contentPath: string;
  /** Manifest digest these bytes must produce. */
  digest: string;
  /** Source size recorded at plan time. */
  size: number;
  /** Source modification time recorded at plan time. */
  mtimeMs: number;
};

/** Everything needed to commit a new version, decided up front. */
export type VersionPlan = {
  id: string;
  /** Object root relative to the storage root. */
  objectPath: string;
  /** Whether this commit creates the object as well as the version. */
  isNew: boolean;
  /** Target version directory name, under the object's padding convention. */
  version: string;
  /** Numeric form of {@linkcode version}. */
  versionNumber: number;
  /** Object spec version, e.g. `"1.1"`. */
  specVersion: string;
  digestAlgorithm: string;
  contentDirectory: string;
  /** Content files to write. Deduplicated files produce no entry. */
  content: ContentEntry[];
  /** Logical paths in the new version's state, sorted. */
  logicalPaths: string[];
  /** Serialized inventory. Written byte-identically to both locations (E064). */
  inventoryBytes: Bytes;
  /** Digest of {@linkcode inventoryBytes} under {@linkcode digestAlgorithm}. */
  inventoryDigest: string;
  /** Sidecar contents, `"<digest> inventory.json\n"`. */
  sidecarBytes: Bytes;
  /** Root inventory digest at plan time; re-checked immediately before commit. */
  baseInventoryDigest: string | undefined;
};

/** Inputs to {@linkcode planVersion}. */
export type PlanOptions = {
  id: string;
  ops: VersionOp[];
  userName: string;
  userAddress: string;
  message?: string;
  /** Expected version number, unpadded. Asserted against the computed target. */
  version?: number;
  /** New objects only. */
  digestAlgorithm?: string;
  /** New objects only. */
  contentDirectory?: string;
  /** Permit a version whose state matches its predecessor's. */
  allowNoChange?: boolean;
  /** RFC 3339 timestamp for the version block. Defaults to now. */
  created?: string;
  sources?: SourceReader;
};

/** The object a new version will extend, when one already exists. */
type BaseObject = {
  path: string;
  specVersion: string;
  inventory: Inventory;
  /** Digest of the root inventory bytes — the pre-commit head check compares it. */
  digest: string;
};

/**
 * Locate the object to extend, distinguishing "absent" from "broken".
 *
 * Conflating those would be catastrophic: treating an unreadable object as
 * absent would create a fresh v1 on top of it. So absence is established by the
 * *conformance declaration* being missing, and any object whose declaration
 * exists must then parse and verify or the plan fails.
 */
async function openBase(
  root: StorageRoot,
  id: string,
): Promise<{ path: string; base: BaseObject | undefined }> {
  const resolver = root.layout.layout;

  if (resolver === undefined) {
    throw new OcflError(
      `storage root at ${root.storage.location} declares layout ` +
        `${root.layout.declared ?? "none"}, which this model cannot compute ` +
        `object paths for; writing requires a supported layout because a scan ` +
        `can find existing objects but cannot place a new one`,
      { code: "E063" },
    );
  }

  const path = resolver.resolve(id);
  const namaste = await readNamaste(root.storage, path, "object");
  if (namaste === undefined) return { path, base: undefined };

  const loaded = await readInventory(root.storage, path);
  if (loaded.inventory.id !== id) {
    throw new OcflError(
      `object at ${path} declares id ${JSON.stringify(loaded.inventory.id)}, ` +
        `not the requested ${JSON.stringify(id)}`,
      { code: "E083", path },
    );
  }
  return {
    path,
    base: {
      path,
      specVersion: namaste.version,
      inventory: loaded.inventory,
      digest: loaded.digest,
    },
  };
}

/**
 * Return the manifest's own spelling of a digest, if it holds one.
 *
 * OCFL compares digests case-insensitively but forbids the same digest
 * appearing twice in a block regardless of case (E096/E097). Since this
 * implementation always produces lowercase, an inventory written by a client
 * that used uppercase would otherwise gain a second, colliding key.
 */
function canonicalDigest(manifest: Record<string, unknown>, digest: string) {
  if (digest in manifest) return digest;
  for (const key of Object.keys(manifest)) {
    if (digestsEqual(key, digest)) return key;
  }
  return digest;
}

/**
 * Decide everything about a new version without writing anything.
 *
 * @throws {OcflError} when the request cannot be satisfied.
 */
export async function planVersion(
  root: StorageRoot,
  options: PlanOptions,
): Promise<VersionPlan> {
  const sources = options.sources ?? localSources;
  const { path: objectPath, base } = await openBase(root, options.id);

  // Version naming follows the object's own convention; a new object starts
  // unpadded at v1.
  const target = base === undefined
    ? { name: "v1", number: 1 }
    : nextVersion(base.inventory);
  if (options.version !== undefined && options.version !== target.number) {
    throw new OcflError(
      base === undefined
        ? `expected to create ${options.id} at v${options.version}, but the ` +
          `object does not exist yet, so the next version is v${target.number}`
        : `expected to create v${options.version} of ${options.id}, but its ` +
          `head is ${base.inventory.head}, so the next version is ` +
          `${target.name}`,
      { code: "E011", path: objectPath },
    );
  }

  // An existing object's algorithm and content directory are fixed properties;
  // silently honoring a conflicting argument would mislead the caller.
  const digestAlgorithm = base?.inventory.digestAlgorithm ??
    options.digestAlgorithm ?? "sha512";
  if (
    base !== undefined && options.digestAlgorithm !== undefined &&
    options.digestAlgorithm !== base.inventory.digestAlgorithm
  ) {
    throw new OcflError(
      `object ${options.id} uses digestAlgorithm ` +
        `${base.inventory.digestAlgorithm}; it cannot be changed to ` +
        `${options.digestAlgorithm}`,
      { code: "E025", path: objectPath },
    );
  }

  const contentDirectory = base === undefined
    ? options.contentDirectory ?? "content"
    : contentDirectoryOf(base.inventory);
  if (
    base !== undefined && options.contentDirectory !== undefined &&
    options.contentDirectory !== contentDirectory
  ) {
    throw new OcflError(
      `object ${options.id} uses contentDirectory ${contentDirectory}; it is ` +
        `fixed at v1 and cannot be changed`,
      { code: "E019", path: objectPath },
    );
  }

  // Digest every source before building anything. The inventory cannot be
  // assembled without these, and dedupe cannot decide what needs writing.
  const sourceInfo = new Map<
    string,
    { digest: string; size: number; mtimeMs: number }
  >();
  for (const source of addSources(options.ops)) {
    const stat = await sources.stat(source);
    const { digest, size } = await digestStream(
      await sources.open(source),
      digestAlgorithm,
    );
    sourceInfo.set(source, { digest, size, mtimeMs: stat.mtimeMs });
  }

  const baseState = new Map<string, string>();
  if (base !== undefined) {
    for (const file of resolveState(base.inventory, base.inventory.head)) {
      baseState.set(file.logicalPath, file.digest);
    }
  }

  const manifest: Record<string, string[]> = base === undefined
    ? {}
    : Object.fromEntries(
      Object.entries(base.inventory.manifest).map(([digest, paths]) => [
        digest,
        [...paths],
      ]),
    );

  const newState = applyOps(baseState, options.ops, (source) => {
    const info = sourceInfo.get(source);
    if (info === undefined) {
      throw new OcflError(`source not digested: ${source}`);
    }
    return canonicalDigest(manifest, info.digest);
  });

  validatePaths(newState.keys(), "logical");

  if (!options.allowNoChange && sameState(baseState, newState)) {
    throw new OcflError(
      `the operations leave ${options.id} with exactly the state of ` +
        `${base?.inventory.head ?? "an empty object"}; refusing to create a ` +
        `version that changes nothing (pass allowNoChange to override)`,
      { path: objectPath },
    );
  }

  // State block: digest → logical paths, both sorted, so the serialization is
  // deterministic and two identical requests produce identical bytes.
  const logicalPaths = [...newState.keys()].sort();
  const stateBlock: Record<string, string[]> = {};
  for (const logicalPath of logicalPaths) {
    const digest = newState.get(logicalPath) as string;
    (stateBlock[digest] ??= []).push(logicalPath);
  }

  // Content plan: only digests absent from the base manifest need bytes. The
  // content path mirrors the logical path, matching the convention already in
  // this repository's fixtures.
  const sourceForDigest = new Map<string, string>();
  for (const [source, info] of sourceInfo) {
    const digest = canonicalDigest(manifest, info.digest);
    if (!sourceForDigest.has(digest)) sourceForDigest.set(digest, source);
  }

  const content: ContentEntry[] = [];
  for (const [digest, paths] of Object.entries(stateBlock)) {
    if (manifest[digest] !== undefined) continue; // deduplicated
    const source = sourceForDigest.get(digest);
    if (source === undefined) {
      throw new OcflError(
        `digest ${digest} is in the new state but is neither in the manifest ` +
          `nor produced by any source; this is a bug in the planner`,
        { path: objectPath },
      );
    }
    const info = sourceInfo.get(source) as { size: number; mtimeMs: number };
    const contentPath = `${target.name}/${contentDirectory}/${paths[0]}`;
    manifest[digest] = [contentPath];
    content.push({
      source,
      contentPath,
      digest,
      size: info.size,
      mtimeMs: info.mtimeMs,
    });
  }
  validatePaths(content.map((entry) => entry.contentPath), "content");

  const versions = {
    ...(base?.inventory.versions ?? {}),
    [target.name]: {
      created: options.created ?? new Date().toISOString(),
      state: stateBlock,
      ...(options.message === undefined ? {} : { message: options.message }),
      user: { name: options.userName, address: options.userAddress },
    },
  };

  const specVersion = base?.specVersion ?? root.specVersion;
  const inventory: Record<string, unknown> = {
    id: options.id,
    // Carried forward verbatim on update: an object created under 1.0 keeps its
    // own type unless deliberately upgraded (E103).
    type: base?.inventory.type ??
      `https://ocfl.io/${specVersion}/spec/#inventory`,
    digestAlgorithm,
    head: target.name,
    ...(base?.inventory.contentDirectory !== undefined ||
        (base === undefined && contentDirectory !== "content")
      ? { contentDirectory }
      : {}),
    manifest,
    versions,
    ...(base?.inventory.fixity === undefined
      ? {}
      : { fixity: base.inventory.fixity }),
  };

  // Serialized exactly once. The root and version copies are then the same
  // bytes by construction, which is what makes E064 hold rather than depend on
  // key order and whitespace surviving a second pass.
  const inventoryBytes = new TextEncoder().encode(
    `${JSON.stringify(inventory, null, 2)}\n`,
  );
  const inventoryDigest = digestBytes(inventoryBytes, digestAlgorithm);

  return {
    id: options.id,
    objectPath,
    isNew: base === undefined,
    version: target.name,
    versionNumber: target.number,
    specVersion,
    digestAlgorithm,
    contentDirectory,
    content,
    logicalPaths,
    inventoryBytes,
    inventoryDigest,
    sidecarBytes: new TextEncoder().encode(
      `${inventoryDigest} inventory.json\n`,
    ),
    baseInventoryDigest: base?.digest,
  };
}

/** Whether two logical states name the same paths with the same digests. */
function sameState(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, digest] of a) {
    const other = b.get(path);
    if (other === undefined || !digestsEqual(other, digest)) return false;
  }
  return true;
}

/** Reporting hooks {@linkcode commitVersion} uses. */
export type CommitContext = {
  sources?: SourceReader;
  logger?: {
    info: (message: string, properties?: unknown) => void;
    warning: (message: string, properties?: unknown) => void;
  };
};

/**
 * Execute a plan.
 *
 * The write order is fixed and load-bearing (`references/transactions.md` §8):
 * conformance declaration first for a new object, then content, then the
 * version inventory and its sidecar, then the root inventory and — as the
 * single commit point — the root sidecar.
 *
 * @throws {OcflError} on drift, digest mismatch, or a concurrent head move.
 *   Storage is cleaned back to its prior state on a best-effort basis.
 */
export async function commitVersion(
  root: StorageRoot,
  plan: VersionPlan,
  context: CommitContext = {},
): Promise<void> {
  const storage = root.storage;
  const sources = context.sources ?? localSources;
  const logger = context.logger;
  const versionDir = joinPath(plan.objectPath, plan.version);
  const sidecar = sidecarName(plan.digestAlgorithm);
  // Only ever true once this call has established that the object root was
  // empty and written the declaration into it. Rollback keys off it, so it must
  // not be set a moment earlier: everything under a root we did not claim
  // belongs to somebody else.
  let claimedObjectRoot = false;

  try {
    if (plan.isNew) {
      // Declaration first. A crash after it leaves an object root that is
      // invalid but unambiguously an incomplete ingest, and discoverable by the
      // same namaste walk that finds every other object. Declaration-last would
      // leave an anonymous directory that recovery cannot even see.
      const existing = await storage.listDir(plan.objectPath);
      if (existing.length > 0) {
        throw new OcflError(
          `object root ${plan.objectPath} is not empty; refusing to create ` +
            `${plan.id} over it`,
          { code: "E069", path: plan.objectPath },
        );
      }
      await writeNamaste(storage, plan.objectPath, "object", plan.specVersion);
      claimedObjectRoot = true;
    }

    for (const entry of plan.content) {
      await writeContent(storage, sources, plan, entry);
      logger?.info("Wrote {contentPath} ({size} bytes)", {
        contentPath: entry.contentPath,
        size: entry.size,
      });
    }

    // A complete, self-describing version directory, written before the root is
    // touched. Its inventory names this version as head, so an interrupted
    // commit can be told apart from abandoned junk.
    await storage.writeAtomic(
      joinPath(versionDir, "inventory.json"),
      plan.inventoryBytes,
    );
    await storage.writeAtomic(
      joinPath(versionDir, sidecar),
      plan.sidecarBytes,
    );

    // OCFL has no locking, so this is the only thing standing between a
    // concurrent writer and a lost version.
    if (!plan.isNew) {
      const current = await readInventory(storage, plan.objectPath);
      if (!digestsEqual(current.digest, plan.baseInventoryDigest ?? "")) {
        throw new OcflError(
          `object ${plan.id} changed while ${plan.version} was being ` +
            `prepared: its head is now ${current.inventory.head}. Nothing was ` +
            `committed; re-plan against the current head.`,
          { path: plan.objectPath },
        );
      }
    }

    // Nothing may come between these two writes. In that window the sidecar
    // digests the previous inventory, so the object fails E060 outright.
    await storage.writeAtomic(
      joinPath(plan.objectPath, "inventory.json"),
      plan.inventoryBytes,
    );
    await storage.writeAtomic(
      joinPath(plan.objectPath, sidecar),
      plan.sidecarBytes,
    );
  } catch (error) {
    await rollback(storage, plan, claimedObjectRoot, logger, error);
    throw error;
  }
}

/** Copy one source to its content path, verifying the bytes as they land. */
async function writeContent(
  storage: Storage,
  sources: SourceReader,
  plan: VersionPlan,
  entry: ContentEntry,
): Promise<void> {
  // The plan froze a digest for these bytes; a source that has changed since is
  // no longer the artifact the inventory describes, so stop rather than guess.
  const stat = await sources.stat(entry.source);
  if (stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs) {
    throw new OcflError(
      `source ${entry.source} changed after it was digested: planned ` +
        `size=${entry.size} mtime=${entry.mtimeMs}, found size=${stat.size} ` +
        `mtime=${stat.mtimeMs}. Nothing was committed; re-run to re-digest.`,
      { path: entry.contentPath },
    );
  }

  const digesting = digestingStream(plan.digestAlgorithm);
  const stream = (await sources.open(entry.source)).pipeThrough(
    digesting.stream,
  );
  await storage.writeStream(
    joinPath(plan.objectPath, entry.contentPath),
    stream,
    { size: entry.size },
  );

  // Digesting the bytes actually written catches drift that slipped past the
  // stat check and corruption in transit, and costs one hash over data already
  // in memory.
  const written = digesting.digest();
  if (!digestsEqual(written, entry.digest)) {
    throw new OcflError(
      `content written to ${entry.contentPath} digests to ${written}, not the ` +
        `planned ${entry.digest}; source ${entry.source} is not what was ` +
        `digested`,
      { code: "E092", path: entry.contentPath },
    );
  }
}

/**
 * Undo an uncommitted version.
 *
 * Only paths under the target version directory are touched — and the object
 * root itself, but *only* when this call verified the root was empty and then
 * claimed it. Nothing in the base manifest can reference the target version, so
 * that directory provably belongs to this attempt; an object root we did not
 * claim may hold anything, including another writer's data.
 *
 * Best-effort by design: a cleanup failure must never mask the error that
 * caused it, so it is reported and swallowed.
 */
async function rollback(
  storage: Storage,
  plan: VersionPlan,
  claimedObjectRoot: boolean,
  logger: CommitContext["logger"],
  cause: unknown,
): Promise<void> {
  const target = claimedObjectRoot
    ? plan.objectPath
    : joinPath(plan.objectPath, plan.version);
  try {
    const removed = await removeTree(storage, target);
    if (claimedObjectRoot) {
      // An empty directory under the storage root is itself invalid (E073), so
      // the hierarchy built to hold the object goes too.
      const segments = plan.objectPath.split("/");
      for (let depth = segments.length - 1; depth > 0; depth -= 1) {
        await storage.pruneEmptyDirs?.(segments.slice(0, depth).join("/"));
      }
    }
    logger?.warning(
      "Rolled back {target} after a failed commit: removed {count} file(s)",
      { target, count: removed.length },
    );
  } catch (error) {
    logger?.warning(
      "Could not fully roll back {target} after {cause}; inspect it manually: {error}",
      {
        target,
        cause: cause instanceof Error ? cause.message : String(cause),
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

/** True when an error means a path was simply absent. Re-exported for callers. */
export { isNotFound };
