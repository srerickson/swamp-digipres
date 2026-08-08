/**
 * Removing a subtree from a {@linkcode Storage}.
 *
 * Used to undo an uncommitted version, which is the only deletion this
 * extension performs. Deliberately built on `walkFiles` + `remove` rather than
 * a backend-specific bulk delete: the two backends disagree about what a
 * directory even is, and correctness here matters more than request count.
 *
 * @module
 */
import type { Storage } from "./types.ts";

/**
 * Delete every file beneath `prefix`, then the directory skeleton itself.
 *
 * Returns the paths removed, so a caller can report exactly what an abort
 * undid. Directory pruning is best-effort and only happens on backends that
 * have directories at all (E073); on S3 a prefix ceases to exist once its last
 * key is gone.
 *
 * @param prefix Directory to remove, relative to the storage root. Refusing an
 *   empty prefix is deliberate — it would mean "delete the entire repository".
 */
export async function removeTree(
  storage: Storage,
  prefix: string,
): Promise<string[]> {
  const normalized = prefix.split("/").filter((segment) => segment.length > 0)
    .join("/");
  if (normalized.length === 0) {
    throw new Error("removeTree requires a non-empty prefix");
  }

  const paths: string[] = [];
  for await (const path of storage.walkFiles(normalized)) {
    paths.push(path);
  }
  for (const path of paths) {
    await storage.remove(path);
  }
  await storage.pruneEmptyDirs?.(normalized);
  return paths;
}
