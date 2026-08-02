/**
 * Storage backend abstraction for OCFL storage roots.
 *
 * All OCFL library code performs I/O through a {@link StorageBackend} so the
 * same logic serves local filesystems and S3-compatible object stores. Methods
 * take storage-root-relative keys: `/`-separated, no leading or trailing
 * slash, with `""` denoting the root itself.
 *
 * `list` semantics differ deliberately between backends: a local directory
 * can exist and be empty (`[]`), while an S3 prefix with no keys under it
 * simply does not exist (`null`). Callers that check for empty directories
 * (E073, E024) rely on this distinction being preserved.
 *
 * @module
 */
import { OcflError } from "../errors.ts";

/** One immediate child of a listed prefix. */
export interface BackendEntry {
  /** Child name, a single path segment with no separators. */
  name: string;
  /** `dir` for subdirectories/sub-prefixes; `file` for everything else. */
  kind: "file" | "dir";
}

/**
 * Preconditions for a conditional write.
 *
 * Backends that cannot enforce a condition atomically degrade to
 * check-then-write and report the degradation through their own logging;
 * callers treat conditions as best-effort guards, not locks.
 */
export interface WriteConditions {
  /** Fail with {@link PreconditionFailedError} when the key already exists. */
  ifNoneMatch?: true;
  /** Fail unless the key's current entity tag matches this value. */
  ifMatch?: string;
}

/** A conditional write's precondition did not hold. */
export class PreconditionFailedError extends OcflError {
  constructor(key: string, condition: WriteConditions) {
    const description = condition.ifNoneMatch
      ? "key already exists"
      : `entity tag no longer matches ${JSON.stringify(condition.ifMatch)}`;
    super(`conditional write to ${key} failed: ${description}`, { path: key });
    this.name = "PreconditionFailedError";
  }
}

/**
 * I/O operations an OCFL storage root requires of its underlying store.
 *
 * Absent from the interface on purpose: `mkdir` (writes create parents
 * implicitly; object stores have no directories), `rename` (local-only —
 * the local commit finalizer uses it directly), and filesystem-identity
 * queries (a local staging concern).
 */
export interface StorageBackend {
  /** Display form of the root: an absolute path or `s3://bucket/prefix`. */
  readonly url: string;
  /** Backend family, used to select commit finalize strategies. */
  readonly kind: "local" | "s3" | "memory";

  /** Read a key's bytes, or `null` when it does not exist. */
  read(key: string): Promise<Uint8Array | null>;

  /**
   * Read a key's bytes together with its entity tag, when the backend has
   * one. `null` when the key does not exist.
   */
  readWithMeta(
    key: string,
  ): Promise<{ data: Uint8Array; etag?: string } | null>;

  /** Open a readable stream over a key. Throws when the key is absent. */
  readStream(key: string): Promise<ReadableStream<Uint8Array>>;

  /** Write bytes to a key, creating any parent directories. */
  write(
    key: string,
    data: Uint8Array,
    conditions?: WriteConditions,
  ): Promise<void>;

  /**
   * Upload a local file to a key, creating any parent directories.
   *
   * Sources of any size are accepted: backends that cannot send a large file
   * in one request (S3) split it into parts internally, so callers never need
   * to chunk content themselves.
   */
  writeFromFile(key: string, sourcePath: string): Promise<void>;

  /**
   * Immediate children of a directory-like prefix.
   *
   * @returns Entries in no guaranteed order; `[]` for an existing empty
   * directory (local only); `null` when nothing exists at the prefix.
   */
  list(prefix: string): Promise<BackendEntry[] | null>;

  /** Whether anything exists at or under a directory-like prefix. */
  prefixExists(prefix: string): Promise<boolean>;

  /**
   * Whether a key exists. Local backends answer via `lstat`, so dangling
   * symlinks count as existing.
   */
  exists(key: string): Promise<boolean>;

  /** Delete a key. A missing key is not an error. */
  delete(key: string): Promise<void>;

  /** Delete every key under a prefix. A missing prefix is not an error. */
  deletePrefix(prefix: string): Promise<void>;
}

/** Join a base key and a relative part, treating `""` as the root. */
export function joinKey(base: string, part: string): string {
  if (base === "") return part;
  if (part === "") return base;
  return `${base}/${part}`;
}

/** Read a key as UTF-8 text, or `null` when it does not exist. */
export async function readText(
  backend: StorageBackend,
  key: string,
): Promise<string | null> {
  const bytes = await backend.read(key);
  if (bytes === null) return null;
  return new TextDecoder().decode(bytes);
}
