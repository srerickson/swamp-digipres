/**
 * Locating OCFL objects and resolving their content.
 *
 * @module
 */
import { digestsEqual } from "./digest.ts";
import { OcflError } from "./errors.ts";
import {
  contentDirectoryOf,
  type Inventory,
  readInventory,
  versionNames,
} from "./inventory.ts";
import { requireObjectDeclaration, type StorageRoot } from "./root.ts";
import { findObjectRoots } from "./root.ts";

/** An object located in a storage root, with its root inventory loaded. */
export type OcflObject = {
  /** Object root path relative to the storage root. */
  path: string;
  /** Spec version from the object's conformance declaration. */
  specVersion: string;
  inventory: Inventory;
};

/** One logical file in a version's state, resolved to its content. */
export type ResolvedFile = {
  logicalPath: string;
  digest: string;
  /**
   * Content paths holding these bytes, relative to the object root.
   *
   * Usually one. Deduplication means the path often lives under an *earlier*
   * version directory than the version being resolved.
   */
  contentPaths: string[];
};

/**
 * Open the object rooted at `path`, verifying its declaration and inventory.
 */
export async function openObjectAt(
  root: StorageRoot,
  path: string,
): Promise<OcflObject> {
  const specVersion = await requireObjectDeclaration(root.storage, path);
  const { inventory } = await readInventory(root.storage, path);
  return { path, specVersion, inventory };
}

/**
 * Find an object by id.
 *
 * When the root declares a layout we can compute, the path is derived and the
 * object opened directly. Otherwise every object root is scanned. Either way
 * the inventory's own `id` is checked against the requested one — the path is
 * never taken as proof of identity.
 *
 * @throws {OcflError} when no object with that id exists.
 */
export async function findObject(
  root: StorageRoot,
  id: string,
): Promise<OcflObject> {
  const resolver = root.layout.layout;
  if (resolver !== undefined) {
    const path = resolver.resolve(id);
    const object = await openObjectAt(root, path).catch((error) => {
      throw new OcflError(
        `no OCFL object with id ${JSON.stringify(id)} at its layout path ` +
          `${path}: ${error instanceof Error ? error.message : String(error)}`,
        { path, cause: error },
      );
    });
    if (object.inventory.id !== id) {
      throw new OcflError(
        `object at ${path} declares id ${
          JSON.stringify(object.inventory.id)
        }, ` +
          `not the requested ${JSON.stringify(id)}`,
        { code: "E083", path },
      );
    }
    return object;
  }

  // No usable layout: scan. Correct but linear, which is why a declared layout
  // is worth having.
  for (const path of await findObjectRoots(root)) {
    const object = await openObjectAt(root, path);
    if (object.inventory.id === id) return object;
  }
  throw new OcflError(
    `no OCFL object with id ${JSON.stringify(id)} in ${root.storage.location}`,
  );
}

/** Open every object in the storage root, in path order. */
export async function listObjects(root: StorageRoot): Promise<OcflObject[]> {
  const paths = await findObjectRoots(root);
  const objects: OcflObject[] = [];
  for (const path of paths) {
    objects.push(await openObjectAt(root, path));
  }
  return objects;
}

/**
 * Resolve a version's logical state to content paths.
 *
 * Every digest in a version's state must appear in the manifest (E050); a
 * state entry that does not resolve means the object cannot be reconstructed,
 * so it is an error rather than an omission. A digest mapped to an *empty* list
 * of content paths is the same failure wearing a different hat — the schema
 * permits it, and it names no bytes either — so it is reported the same way
 * rather than left for a reader to trip over.
 *
 * @param version Version name; defaults to the object's head.
 */
export function resolveState(
  inventory: Inventory,
  version?: string,
): ResolvedFile[] {
  const name = version ?? inventory.head;
  const block = inventory.versions[name];
  if (block === undefined) {
    throw new OcflError(
      `object ${inventory.id} has no version ${JSON.stringify(name)}; ` +
        `known versions: ${versionNames(inventory).join(", ")}`,
      { code: "E010" },
    );
  }

  const files: ResolvedFile[] = [];
  for (const [digest, logicalPaths] of Object.entries(block.state)) {
    const contentPaths = manifestLookup(inventory, digest);
    if (contentPaths === undefined || contentPaths.length === 0) {
      throw new OcflError(
        `version ${name} of ${inventory.id} references digest ${digest}, ` +
          `which names no content path in the manifest`,
        { code: "E050" },
      );
    }
    for (const logicalPath of logicalPaths) {
      files.push({ logicalPath, digest, contentPaths });
    }
  }

  files.sort((a, b) =>
    a.logicalPath < b.logicalPath ? -1 : a.logicalPath > b.logicalPath ? 1 : 0
  );
  return files;
}

/**
 * Look a digest up in the manifest.
 *
 * Digests are case-insensitive in OCFL, so a direct property access would miss
 * entries written by a client that used a different case.
 */
export function manifestLookup(
  inventory: Inventory,
  digest: string,
): string[] | undefined {
  const direct = inventory.manifest[digest];
  if (direct !== undefined) return direct;
  for (const [key, paths] of Object.entries(inventory.manifest)) {
    if (digestsEqual(key, digest)) return paths;
  }
  return undefined;
}

/** Number of logical files in a version's state. */
export function versionFileCount(
  inventory: Inventory,
  version: string,
): number {
  const block = inventory.versions[version];
  if (block === undefined) return 0;
  return Object.values(block.state).reduce(
    (total, paths) => total + paths.length,
    0,
  );
}

/** The content directory this object uses. */
export function objectContentDirectory(object: OcflObject): string {
  return contentDirectoryOf(object.inventory);
}
