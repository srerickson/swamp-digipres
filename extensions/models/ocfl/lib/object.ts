/**
 * Locating and reading OCFL objects within a storage root.
 *
 * Every lookup confirms `inventory.id` matches the requested id — the layout
 * maps id to path, but the path is never trusted on its own.
 *
 * @module
 */
import { OcflError } from "./errors.ts";
import { normalizeDigest } from "./digest.ts";
import { readInventoryVerified } from "./inventory.ts";
import type { DiscoveredObject, StorageLayout } from "./layout.ts";
import { loadLayout, scanObjectRoots } from "./layout.ts";
import { readNamaste } from "./namaste.ts";
import type { Inventory, Version } from "./types.ts";
import { contentDirectoryOf } from "./types.ts";
import { sortVersionNames } from "./version.ts";

/** An opened OCFL storage root. */
export interface StorageRoot {
  /** Absolute path to the storage root. */
  path: string;
  /** OCFL specification version declared by the root, e.g. `"1.1"`. */
  specVersion: string;
  /** Resolved storage layout, or `null` when none is declared or implemented. */
  layout: StorageLayout | null;
}

/** An OCFL object read from a storage root. */
export interface OcflObject {
  /** Object id as recorded in its inventory. */
  id: string;
  /** Object root path relative to the storage root. */
  relativePath: string;
  /** Absolute object root path. */
  absolutePath: string;
  /** The verified root inventory. */
  inventory: Inventory;
  /** Exact bytes of the root inventory. */
  inventoryBytes: Uint8Array;
}

/**
 * Open a storage root: verify its conformance declaration and resolve its
 * storage layout.
 */
export async function openStorageRoot(path: string): Promise<StorageRoot> {
  const namaste = await readNamaste(path, "root");
  if (namaste.version !== "1.1" && namaste.version !== "1.0") {
    throw new OcflError(
      `unsupported OCFL specification version in storage root: ${namaste.version}`,
      { path },
    );
  }
  const { layout } = await loadLayout(path);
  return { path, specVersion: namaste.version, layout };
}

/** Read the object rooted at an absolute path, verifying its declaration. */
async function readObjectAt(
  discovered: DiscoveredObject,
): Promise<OcflObject> {
  await readNamaste(discovered.absolutePath, "object");
  const { inventory, bytes } = await readInventoryVerified(
    discovered.absolutePath,
  );
  return {
    id: inventory.id,
    relativePath: discovered.relativePath,
    absolutePath: discovered.absolutePath,
    inventory,
    inventoryBytes: bytes,
  };
}

/** Whether a path exists and is a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw cause;
  }
}

/**
 * Locate an object by id.
 *
 * With a layout, the id resolves directly to a path and the inventory's id is
 * checked against the request. Without one, the hierarchy is scanned and every
 * object's inventory read until the id matches.
 *
 * @returns The object, or `null` when no object with that id exists.
 */
export async function locateObject(
  root: StorageRoot,
  id: string,
): Promise<OcflObject | null> {
  if (root.layout !== null) {
    const relativePath = root.layout.resolve(id);
    const absolutePath = `${root.path}/${relativePath}`;
    if (!(await isDirectory(absolutePath))) return null;
    const object = await readObjectAt({ relativePath, absolutePath });
    if (object.id !== id) {
      throw new OcflError(
        `object at ${relativePath} declares id ${
          JSON.stringify(object.id)
        }, expected ${JSON.stringify(id)}`,
        { code: "E083", path: relativePath },
      );
    }
    return object;
  }

  for (const discovered of await scanObjectRoots(root.path)) {
    const object = await readObjectAt(discovered);
    if (object.id === id) return object;
  }
  return null;
}

/** Locate an object by id, throwing when it does not exist. */
export async function requireObject(
  root: StorageRoot,
  id: string,
): Promise<OcflObject> {
  const object = await locateObject(root, id);
  if (object === null) {
    throw new OcflError(`no OCFL object with id ${JSON.stringify(id)}`, {
      path: root.path,
    });
  }
  return object;
}

/** Read every object in the storage root, ordered by path. */
export async function listObjects(root: StorageRoot): Promise<OcflObject[]> {
  const discovered = await scanObjectRoots(root.path);
  const objects: OcflObject[] = [];
  for (const entry of discovered) {
    objects.push(await readObjectAt(entry));
  }
  return objects;
}

/** One entry of a version's logical state. */
export interface StateEntry {
  /** Logical path as it appears in the version's `state` block. */
  logicalPath: string;
  /** Digest as written in the inventory, original casing preserved. */
  digest: string;
  /** Content paths the digest resolves to via the manifest. */
  contentPaths: string[];
}

/**
 * Resolve a version's logical state against the manifest.
 *
 * @param versionName Version to resolve; defaults to `head`.
 * @throws OcflError when the version is unknown, or a state digest has no
 * manifest entry (E050).
 */
export function getVersionState(
  inventory: Inventory,
  versionName?: string,
): StateEntry[] {
  const name = versionName ?? inventory.head;
  const version: Version | undefined = inventory.versions[name];
  if (version === undefined) {
    throw new OcflError(
      `object has no version ${JSON.stringify(name)}`,
      { code: "E046" },
    );
  }

  const manifestByDigest = new Map<string, string[]>();
  for (const [digest, contentPaths] of Object.entries(inventory.manifest)) {
    manifestByDigest.set(normalizeDigest(digest), contentPaths);
  }

  const entries: StateEntry[] = [];
  for (const [digest, logicalPaths] of Object.entries(version.state)) {
    const contentPaths = manifestByDigest.get(normalizeDigest(digest));
    if (contentPaths === undefined) {
      throw new OcflError(
        `version ${name} references digest ${digest}, which is not in the manifest`,
        { code: "E050" },
      );
    }
    for (const logicalPath of logicalPaths) {
      entries.push({ logicalPath, digest, contentPaths });
    }
  }
  entries.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
  return entries;
}

/** Version names of an object in ascending order. */
export function versionNames(inventory: Inventory): string[] {
  return sortVersionNames(Object.keys(inventory.versions));
}

/** Number of logical files in a version's state. */
export function versionFileCount(
  inventory: Inventory,
  versionName: string,
): number {
  const version = inventory.versions[versionName];
  if (version === undefined) return 0;
  return Object.values(version.state).reduce(
    (total, paths) => total + paths.length,
    0,
  );
}

/** Absolute path of a content path within an object. */
export function contentPathToAbsolute(
  object: OcflObject,
  contentPath: string,
): string {
  return `${object.absolutePath}/${contentPath}`;
}

/** The content directory name in use for an object (§3.3.1). */
export function objectContentDirectory(object: OcflObject): string {
  return contentDirectoryOf(object.inventory);
}
