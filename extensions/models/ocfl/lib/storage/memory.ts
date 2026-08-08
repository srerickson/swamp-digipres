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
}

/** Collapse a storage path to its canonical `a/b/c` form. */
function normalize(path: string): string {
  return path.split("/").filter((segment) => segment.length > 0).join("/");
}
