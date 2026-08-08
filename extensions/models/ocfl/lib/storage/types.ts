/**
 * The storage interface every OCFL operation in this extension talks to.
 *
 * Nothing above this layer touches `Deno.*` or `fetch` directly, which is what
 * lets one implementation of the OCFL logic serve both a local filesystem and
 * an S3-compatible object store.
 *
 * Paths are always `/`-separated and relative to the storage root — never
 * absolute, never platform-specific. S3 has no directories, so a "directory"
 * here means nothing more than a set of keys sharing a prefix: code above this
 * layer must never assume a directory exists as an entity of its own.
 *
 * @module
 */

/**
 * File contents.
 *
 * Pinned to an `ArrayBuffer` backing store rather than the default
 * `ArrayBufferLike`, so contents can be handed straight to `fetch` and `Blob`
 * without a defensive copy.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** One entry returned by {@linkcode Storage.listDir}. */
export type Entry = {
  /** Entry name relative to the listed directory (no slashes). */
  name: string;
  /** Whether the entry is a file or a prefix holding further entries. */
  type: "file" | "dir";
};

/** Read/write access to a tree of paths, backed by local disk or S3. */
export interface Storage {
  /** Human-readable location of the root, for logs and resource output. */
  readonly location: string;

  /** Backend discriminator, mirrored into the `root` resource. */
  readonly backend: "local" | "s3";

  /**
   * Read a file in full.
   *
   * @throws {import("../errors.ts").NotFoundError} when the path is absent.
   */
  read(path: string): Promise<Bytes>;

  /** Whether a file exists at `path`. Directories are not files. */
  exists(path: string): Promise<boolean>;

  /**
   * List the immediate children of a directory.
   *
   * Returns an empty array for a directory that does not exist — absence and
   * emptiness are indistinguishable on S3, so callers must not rely on the
   * difference.
   */
  listDir(path: string): Promise<Entry[]>;

  /**
   * Yield every file path beneath `prefix`, recursively.
   *
   * Paths are relative to the storage root, like every other path here.
   */
  walkFiles(prefix: string): AsyncIterable<string>;

  /** Write a file, creating any intermediate directories. */
  write(path: string, bytes: Bytes): Promise<void>;
}

/**
 * Join path segments into a storage path.
 *
 * Empty segments are dropped, so `join("", "inventory.json")` is
 * `"inventory.json"` — which is what a storage root with no prefix needs.
 */
export function joinPath(...segments: string[]): string {
  return segments
    .flatMap((segment) => segment.split("/"))
    .filter((segment) => segment.length > 0)
    .join("/");
}
