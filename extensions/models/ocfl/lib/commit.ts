/**
 * Atomic version writing: unified ingest (new object) and update (new version).
 *
 * Everything is staged outside the storage root and moved in with `rename(2)`,
 * so a crash leaves either the previous consistent state or the new one — with
 * one documented exception, the two-write window when replacing the root
 * inventory and its sidecar (see {@link FinalizeStep}).
 *
 * OCFL has no locking. This library assumes a sole-writer contract per storage
 * root and re-verifies the object's head immediately before finalizing, which
 * narrows but does not close the race against an external writer.
 *
 * @module
 */
import { HeadConflictError, OcflError } from "./errors.ts";
import {
  bytesEqual,
  readInventoryVerified,
  serializeInventory,
  writeInventoryPair,
} from "./inventory.ts";
import { writeNamaste } from "./namaste.ts";
import type { OcflObject, StorageRoot } from "./object.ts";
import { locateObject } from "./object.ts";
import { joinOcflPath, validateContentDirectory } from "./paths.ts";
import { digestFile, isDigestAlgorithmSupported } from "./digest.ts";
import type { NewContent } from "./state.ts";
import { buildNextState, walkSource } from "./state.ts";
import type { DigestAlgorithm, Inventory, User, Version } from "./types.ts";
import {
  contentDirectoryOf,
  DEFAULT_CONTENT_DIRECTORY,
  INVENTORY_TYPE_1_1,
} from "./types.ts";
import { nextVersionName } from "./version.ts";

/**
 * Points during finalization, exposed for crash-safety testing.
 *
 * `after-root-inventory` is the one window POSIX cannot make atomic: the root
 * `inventory.json` has been replaced but its sidecar has not. An object
 * interrupted there is recoverable — `validate` reports it as such.
 */
export type FinalizeStep =
  | "before-finalize"
  | "after-version-move"
  | "after-root-inventory"
  | "after-root-sidecar";

/** Options for a commit. */
export interface CommitOptions {
  /** Object id. Created if no object with this id exists. */
  id: string;
  /** Directory whose contents become the new version's complete logical state. */
  sourcePath: string;
  /** Version message recorded in the new version block. */
  message?: string;
  /** Agent recorded in the new version block. */
  user?: User;
  /**
   * Permit paths present in the current version to be absent from the source
   * tree. Without this, a commit that would drop any path fails.
   */
  allowDeletes?: boolean;
  /**
   * Directory to stage the new version in. Must be on the same filesystem as
   * the storage root. Defaults to a sibling of the storage root.
   */
  stagingDir?: string;
  /** Digest algorithm for a newly created object. Ignored for updates. */
  digestAlgorithm?: DigestAlgorithm;
  /** Content directory for a newly created object. Ignored for updates. */
  contentDirectory?: string;
  /**
   * Additional algorithms to record in the `fixity` block for content written
   * by this commit (§3.5.4). Existing fixity entries are always carried
   * forward; this only adds entries for newly written content.
   */
  fixityAlgorithms?: readonly string[];
  /** Test hook invoked at each finalize step; throwing simulates a crash. */
  onFinalizeStep?: (step: FinalizeStep) => void | Promise<void>;
}

/** Outcome of a successful commit. */
export interface CommitResult {
  /** Object id. */
  id: string;
  /** Object root path relative to the storage root. */
  objectPath: string;
  /** True when this commit created the object. */
  created: boolean;
  /** Head before the commit, or `null` for a new object. */
  previousHead: string | null;
  /** Head after the commit. */
  head: string;
  /** Logical paths added in this version. */
  addedPaths: string[];
  /** Logical paths whose content changed in this version. */
  modifiedPaths: string[];
  /** Logical paths removed in this version. */
  deletedPaths: string[];
  /** Number of content files newly written (deduplicated files are excluded). */
  newContentCount: number;
}

/** Parent directory of a path. */
function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return index === 0 ? "/" : ".";
  return trimmed.slice(0, index);
}

/** Final component of a path. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** RFC 3339 UTC timestamp with second granularity (E049). */
export function nowRfc3339(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

/** Whether a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw cause;
  }
}

/** Device id of the filesystem holding a path. */
async function deviceOf(path: string): Promise<number | null> {
  const info = await Deno.stat(path);
  return info.dev;
}

/**
 * Create and return a staging directory guaranteed to be on the storage root's
 * filesystem, so the finalizing `rename` is atomic.
 */
async function createStagingDir(
  root: StorageRoot,
  requested: string | undefined,
): Promise<string> {
  const base = requested ??
    `${dirname(root.path)}/.${basename(root.path)}-staging`;

  try {
    await Deno.mkdir(base, { recursive: true });
  } catch (cause) {
    throw new OcflError(
      `could not create staging directory ${base}: ${
        cause instanceof Error ? cause.message : String(cause)
      }. Set the stagingDir argument to a writable directory on the same filesystem as the storage root.`,
      { path: base },
    );
  }

  const rootDevice = await deviceOf(root.path);
  const stagingDevice = await deviceOf(base);
  if (rootDevice !== stagingDevice) {
    throw new OcflError(
      `staging directory ${base} is on a different filesystem than the storage root ${root.path}; ` +
        "the commit could not be finalized atomically. Set stagingDir to a directory on the same filesystem.",
      { path: base },
    );
  }

  return await Deno.makeTempDir({ dir: base, prefix: "commit-" });
}

/**
 * Verify that the directories leading to an object root hold no files (E084)
 * and create them.
 */
async function prepareIntermediateDirectories(
  root: StorageRoot,
  relativePath: string,
): Promise<void> {
  const segments = relativePath.split("/");
  let current = root.path;
  for (const segment of segments.slice(0, -1)) {
    current = `${current}/${segment}`;
    if (!(await exists(current))) break;
    for await (const entry of Deno.readDir(current)) {
      if (!entry.isDirectory) {
        throw new OcflError(
          `storage hierarchy directory ${current} contains a file (${entry.name}); ` +
            "intermediate directories must contain only directories",
          { code: "E084", path: current },
        );
      }
    }
  }
  await Deno.mkdir(dirname(`${root.path}/${relativePath}`), {
    recursive: true,
  });
}

/** Copy a file, creating its parent directories. */
async function copyInto(source: string, target: string): Promise<void> {
  await Deno.mkdir(dirname(target), { recursive: true });
  await Deno.copyFile(source, target);
}

/**
 * Create a new version of an object, or create the object if it does not exist.
 *
 * The source tree is the complete desired logical state: paths absent from it
 * are logically deleted, which requires `allowDeletes`.
 *
 * @throws OcflError when the commit would be a no-op, would delete without
 * permission, or the object/storage root is malformed.
 * @throws HeadConflictError when another writer advanced the object's head
 * while this commit was being staged.
 */
export async function commit(
  root: StorageRoot,
  options: CommitOptions,
): Promise<CommitResult> {
  const sourceInfo = await Deno.stat(options.sourcePath).catch(() => null);
  if (sourceInfo === null || !sourceInfo.isDirectory) {
    throw new OcflError(
      `sourcePath is not a directory: ${options.sourcePath}`,
      { path: options.sourcePath },
    );
  }

  const existing = await locateObject(root, options.id);
  const sourceFiles = await walkSource(options.sourcePath);

  if (sourceFiles.length === 0 && existing === null) {
    throw new OcflError(
      `refusing to create object ${
        JSON.stringify(options.id)
      } from an empty source tree`,
      { path: options.sourcePath },
    );
  }

  return existing === null
    ? await ingest(root, options, sourceFiles)
    : await update(root, existing, options, sourceFiles);
}

/**
 * Extend a fixity block with digests for newly written content.
 *
 * Existing entries are preserved untouched; only content this commit writes
 * gains new entries, since prior content was already recorded (or deliberately
 * was not) by whoever wrote it.
 */
async function extendFixity(
  existing: Record<string, Record<string, string[]>> | undefined,
  newContent: readonly NewContent[],
  algorithms: readonly string[],
): Promise<Record<string, Record<string, string[]>> | undefined> {
  if (algorithms.length === 0 || newContent.length === 0) return existing;

  const fixity: Record<string, Record<string, string[]>> = {};
  for (const [algorithm, block] of Object.entries(existing ?? {})) {
    fixity[algorithm] = { ...block };
  }

  for (const algorithm of algorithms) {
    if (!isDigestAlgorithmSupported(algorithm)) {
      throw new OcflError(
        `fixity algorithm ${algorithm} is not supported by this client`,
        { code: "E027" },
      );
    }
    const block = fixity[algorithm] ??= {};
    // Digests are compared case-insensitively but each may appear only once
    // per block regardless of case (E097).
    const seen = new Map<string, string>();
    for (const digest of Object.keys(block)) {
      seen.set(digest.toLowerCase(), digest);
    }

    for (const content of newContent) {
      const digest = await digestFile(content.sourcePath, algorithm);
      const key = seen.get(digest) ?? digest;
      seen.set(digest, key);
      const paths = block[key] ??= [];
      if (!paths.includes(content.contentPath)) paths.push(content.contentPath);
      paths.sort();
    }
  }

  return fixity;
}

/** Build the inventory for a new version. */
function buildInventory(
  base: {
    id: string;
    digestAlgorithm: DigestAlgorithm;
    contentDirectory: string | undefined;
    priorVersions: Record<string, Version>;
    fixity: Record<string, Record<string, string[]>> | undefined;
  },
  versionName: string,
  manifest: Record<string, string[]>,
  state: Record<string, string[]>,
  message: string | undefined,
  user: User | undefined,
): Inventory {
  const versions: Record<string, Version> = { ...base.priorVersions };
  const version: Version = { created: nowRfc3339(), state };
  if (message !== undefined) version.message = message;
  if (user !== undefined) version.user = user;
  versions[versionName] = version;

  const inventory: Inventory = {
    id: base.id,
    type: INVENTORY_TYPE_1_1,
    digestAlgorithm: base.digestAlgorithm,
    head: versionName,
    manifest,
    versions,
  };
  if (base.contentDirectory !== undefined) {
    inventory.contentDirectory = base.contentDirectory;
  }
  if (base.fixity !== undefined) inventory.fixity = base.fixity;
  return inventory;
}

/** Create a brand new object at v1. */
async function ingest(
  root: StorageRoot,
  options: CommitOptions,
  sourceFiles: Awaited<ReturnType<typeof walkSource>>,
): Promise<CommitResult> {
  if (root.layout === null) {
    throw new OcflError(
      "the storage root declares no supported storage layout, so the path for a new object cannot be determined",
      { code: "E070", path: root.path },
    );
  }

  const relativePath = root.layout.resolve(options.id);
  const objectPath = `${root.path}/${relativePath}`;
  if (await exists(objectPath)) {
    throw new OcflError(
      `object root ${relativePath} already exists but holds no object with id ${
        JSON.stringify(options.id)
      }`,
      { path: objectPath },
    );
  }

  const contentDirectory = options.contentDirectory ??
    DEFAULT_CONTENT_DIRECTORY;
  const issues = validateContentDirectory(contentDirectory, relativePath);
  if (issues.length > 0) {
    throw new OcflError(issues[0].message, { code: issues[0].code });
  }
  const digestAlgorithm = options.digestAlgorithm ?? "sha512";
  const versionName = "v1";

  const next = await buildNextState(
    null,
    sourceFiles,
    versionName,
    contentDirectory,
    digestAlgorithm,
  );

  const inventory = buildInventory(
    {
      id: options.id,
      digestAlgorithm,
      contentDirectory: contentDirectory === DEFAULT_CONTENT_DIRECTORY
        ? undefined
        : contentDirectory,
      priorVersions: {},
      fixity: await extendFixity(
        undefined,
        next.newContent,
        options.fixityAlgorithms ?? [],
      ),
    },
    versionName,
    next.manifest,
    next.state,
    options.message,
    options.user,
  );
  const inventoryBytes = serializeInventory(inventory);

  const staging = await createStagingDir(root, options.stagingDir);
  try {
    // Stage the entire object root, so it lands complete in one rename.
    const staged = `${staging}/object`;
    await Deno.mkdir(`${staged}/${versionName}`, { recursive: true });
    await writeNamaste(staged, "object", "1.1");
    for (const content of next.newContent) {
      await copyInto(content.sourcePath, `${staged}/${content.contentPath}`);
    }
    await writeInventoryPair(
      `${staged}/${versionName}`,
      inventoryBytes,
      digestAlgorithm,
    );
    await writeInventoryPair(staged, inventoryBytes, digestAlgorithm);

    await prepareIntermediateDirectories(root, relativePath);
    await options.onFinalizeStep?.("before-finalize");
    if (await exists(objectPath)) {
      throw new HeadConflictError(relativePath, "<absent>", "<created>");
    }
    await Deno.rename(staged, objectPath);
    await options.onFinalizeStep?.("after-root-sidecar");
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }

  return {
    id: options.id,
    objectPath: relativePath,
    created: true,
    previousHead: null,
    head: versionName,
    addedPaths: next.addedPaths,
    modifiedPaths: next.modifiedPaths,
    deletedPaths: next.deletedPaths,
    newContentCount: next.newContent.length,
  };
}

/** Add a new version to an existing object. */
async function update(
  root: StorageRoot,
  object: OcflObject,
  options: CommitOptions,
  sourceFiles: Awaited<ReturnType<typeof walkSource>>,
): Promise<CommitResult> {
  const previous = object.inventory;
  const previousHead = previous.head;
  const versionName = nextVersionName(previousHead);
  const contentDirectory = contentDirectoryOf(previous);

  const next = await buildNextState(
    previous,
    sourceFiles,
    versionName,
    contentDirectory,
    previous.digestAlgorithm,
  );

  if (!next.changed) {
    throw new OcflError(
      `refusing to commit: the source tree is identical to ${previousHead}, which would create an empty version`,
      { path: object.relativePath },
    );
  }
  if (next.deletedPaths.length > 0 && options.allowDeletes !== true) {
    throw new OcflError(
      `refusing to commit: ${next.deletedPaths.length} path(s) present in ${previousHead} are absent from the source tree ` +
        `(${next.deletedPaths.slice(0, 5).join(", ")}${
          next.deletedPaths.length > 5 ? ", …" : ""
        }). Pass allowDeletes to logically delete them.`,
      { path: object.relativePath },
    );
  }

  const inventory = buildInventory(
    {
      id: previous.id,
      digestAlgorithm: previous.digestAlgorithm,
      contentDirectory: previous.contentDirectory,
      // Prior version blocks are carried forward exactly as parsed (E066).
      priorVersions: previous.versions,
      fixity: await extendFixity(
        previous.fixity,
        next.newContent,
        options.fixityAlgorithms ?? [],
      ),
    },
    versionName,
    next.manifest,
    next.state,
    options.message,
    options.user,
  );
  const inventoryBytes = serializeInventory(inventory);

  const staging = await createStagingDir(root, options.stagingDir);
  try {
    const stagedVersion = `${staging}/${versionName}`;
    await Deno.mkdir(stagedVersion, { recursive: true });
    for (const content of next.newContent) {
      // Content paths are prefixed with the version name; strip it, since the
      // staged directory *is* that version directory.
      const withinVersion = content.contentPath.slice(versionName.length + 1);
      await copyInto(content.sourcePath, `${stagedVersion}/${withinVersion}`);
    }
    await writeInventoryPair(
      stagedVersion,
      inventoryBytes,
      previous.digestAlgorithm,
    );

    await options.onFinalizeStep?.("before-finalize");

    // Re-verify the head immediately before finalizing, after all staging is
    // done: OCFL has no locking, and another writer may have advanced the
    // object while we were staging.
    const current = await readInventoryVerified(object.absolutePath);
    if (
      current.inventory.head !== previousHead ||
      !bytesEqual(current.bytes, object.inventoryBytes)
    ) {
      throw new HeadConflictError(
        object.relativePath,
        previousHead,
        current.inventory.head,
      );
    }
    const targetVersionPath = `${object.absolutePath}/${versionName}`;
    if (await exists(targetVersionPath)) {
      throw new HeadConflictError(
        object.relativePath,
        previousHead,
        versionName,
      );
    }

    try {
      await Deno.rename(stagedVersion, targetVersionPath);
    } catch (cause) {
      // The version directory appeared between the check above and the
      // rename — the narrowest form of the same race.
      if (cause instanceof Deno.errors.AlreadyExists) {
        throw new HeadConflictError(
          object.relativePath,
          previousHead,
          versionName,
        );
      }
      throw cause;
    }
    await options.onFinalizeStep?.("after-version-move");

    // The root inventory is a byte copy of the one just written (E064).
    await Deno.writeFile(
      `${object.absolutePath}/inventory.json`,
      inventoryBytes,
    );
    await options.onFinalizeStep?.("after-root-inventory");

    // Sidecar last — it is the commit marker (E062).
    await writeInventoryPair(
      object.absolutePath,
      inventoryBytes,
      previous.digestAlgorithm,
    );
    await options.onFinalizeStep?.("after-root-sidecar");
  } finally {
    await Deno.remove(staging, { recursive: true }).catch(() => {});
  }

  return {
    id: previous.id,
    objectPath: object.relativePath,
    created: false,
    previousHead,
    head: versionName,
    addedPaths: next.addedPaths,
    modifiedPaths: next.modifiedPaths,
    deletedPaths: next.deletedPaths,
    newContentCount: next.newContent.length,
  };
}

/**
 * Initialize a new OCFL 1.1 storage root with the hashed n-tuple layout.
 *
 * @throws OcflError when the directory already contains a conformance
 * declaration or is not empty.
 */
export async function initStorageRoot(
  path: string,
  options: {
    layoutDigestAlgorithm?: string;
    tupleSize?: number;
    numberOfTuples?: number;
    description?: string;
  } = {},
): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
  for await (const entry of Deno.readDir(path)) {
    throw new OcflError(
      `refusing to initialize a storage root in a non-empty directory (found ${entry.name})`,
      { path },
    );
  }

  const extensionName = "0004-hashed-n-tuple-storage-layout";
  const config = {
    extensionName,
    digestAlgorithm: options.layoutDigestAlgorithm ?? "sha256",
    tupleSize: options.tupleSize ?? 3,
    numberOfTuples: options.numberOfTuples ?? 3,
    shortObjectRoot: false,
  };

  await writeNamaste(path, "root", "1.1");
  await Deno.writeTextFile(
    `${path}/ocfl_layout.json`,
    `${
      JSON.stringify(
        {
          extension: extensionName,
          description: options.description ??
            "OCFL storage root managed by @crudec/ocfl-repository",
        },
        null,
        2,
      )
    }\n`,
  );
  const extensionDir = joinOcflPath(path, "extensions", extensionName);
  await Deno.mkdir(extensionDir, { recursive: true });
  await Deno.writeTextFile(
    `${extensionDir}/config.json`,
    `${JSON.stringify(config, null, 2)}\n`,
  );
}
