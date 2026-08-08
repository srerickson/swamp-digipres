/**
 * Shared recursive walk over a {@linkcode Storage} that only implements
 * `listDir`.
 *
 * The local backend uses this as its `walkFiles`. The S3 backend does not — a
 * flat paginated list is one request per 1,000 keys instead of one request per
 * directory.
 *
 * @module
 */
import { type Entry, joinPath } from "./types.ts";

/** Minimal surface {@linkcode walkFilesViaListDir} needs from a backend. */
export interface DirLister {
  listDir(path: string): Promise<Entry[]>;
}

/**
 * Yield every file beneath `prefix` by walking directories depth-first.
 *
 * Ordering within a directory follows the backend's own listing order.
 */
export async function* walkFilesViaListDir(
  lister: DirLister,
  prefix: string,
): AsyncIterable<string> {
  const entries = await lister.listDir(prefix);
  for (const entry of entries) {
    const path = joinPath(prefix, entry.name);
    if (entry.type === "file") {
      yield path;
    } else {
      yield* walkFilesViaListDir(lister, path);
    }
  }
}
