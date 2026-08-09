/**
 * In-memory {@linkcode Storage} backend.
 *
 * Exists so the OCFL layer above can be tested without touching a disk or a
 * network — if a test passes here and against {@linkcode LocalStorage}, the
 * OCFL code genuinely does not depend on the backend.
 *
 * @module
 */
import { NotFoundError } from "../errors.ts";
import type { Bytes, Entry, Storage } from "./types.ts";
import { walkFilesViaListDir } from "./walk.ts";

/** Bytes per chunk emitted by {@linkcode MemoryStorage.readStream}. */
const CHUNK_SIZE = 64 * 1024;

/** A storage root held entirely in memory. */
export class MemoryStorage implements Storage {
  readonly backend = "local" as const;
  readonly location: string;
  readonly #files = new Map<string, Bytes>();

  constructor(location = "memory://") {
    this.location = location;
  }

  /** Seed the store from a path → contents map. */
  static from(files: Record<string, string | Bytes>): MemoryStorage {
    const storage = new MemoryStorage();
    const encoder = new TextEncoder();
    for (const [path, contents] of Object.entries(files)) {
      storage.#files.set(
        normalize(path),
        typeof contents === "string" ? encoder.encode(contents) : contents,
      );
    }
    return storage;
  }

  /** Every path currently stored, sorted. */
  paths(): string[] {
    return [...this.#files.keys()].sort();
  }

  read(path: string): Promise<Bytes> {
    const bytes = this.#files.get(normalize(path));
    if (bytes === undefined) return Promise.reject(new NotFoundError(path));
    return Promise.resolve(bytes.slice());
  }

  /**
   * Deliver the stored bytes in {@linkcode CHUNK_SIZE} pieces.
   *
   * A single-chunk stream would be the obvious implementation, but then this
   * backend would be the one place a consumer that only reads the first chunk
   * still passes — the opposite of what this backend exists for.
   */
  readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const bytes = this.#files.get(normalize(path));
    if (bytes === undefined) return Promise.reject(new NotFoundError(path));
    let offset = 0;
    return Promise.resolve(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }
          const end = Math.min(offset + CHUNK_SIZE, bytes.byteLength);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        },
      }),
    );
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.#files.has(normalize(path)));
  }

  listDir(path: string): Promise<Entry[]> {
    const dir = normalize(path);
    const prefix = dir.length === 0 ? "" : `${dir}/`;
    const seen = new Map<string, Entry["type"]>();

    for (const key of this.#files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.length === 0) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        seen.set(rest, "file");
      } else {
        const name = rest.slice(0, slash);
        if (!seen.has(name)) seen.set(name, "dir");
      }
    }

    const entries = [...seen].map(([name, type]) => ({ name, type }));
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return Promise.resolve(entries);
  }

  walkFiles(prefix: string): AsyncIterable<string> {
    return walkFilesViaListDir(this, prefix);
  }

  write(path: string, bytes: Bytes): Promise<void> {
    this.#files.set(normalize(path), bytes.slice());
    return Promise.resolve();
  }

  /** A map insert is already indivisible to any reader here. */
  writeAtomic(path: string, bytes: Bytes): Promise<void> {
    return this.write(path, bytes);
  }

  async writeStream(
    path: string,
    body: ReadableStream<Uint8Array>,
    _options?: { size?: number },
  ): Promise<void> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of body) {
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    const bytes = new Uint8Array(new ArrayBuffer(size));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.#files.set(normalize(path), bytes);
  }

  remove(path: string): Promise<void> {
    this.#files.delete(normalize(path));
    return Promise.resolve();
  }
}

/** Collapse a storage path to its canonical `a/b/c` form. */
function normalize(path: string): string {
  return path.split("/").filter((segment) => segment.length > 0).join("/");
}
