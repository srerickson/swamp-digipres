/**
 * Local filesystem {@linkcode Storage} backend.
 *
 * Deno accepts `/` as a separator on every platform it supports, so storage
 * paths are appended to the root as-is rather than pulling in a path library —
 * swamp's bundler inlines dependencies, and this one would earn nothing.
 *
 * @module
 */
import { NotFoundError } from "../errors.ts";
import type { Bytes, Entry, Storage } from "./types.ts";
import { walkFilesViaListDir } from "./walk.ts";

/** A storage root on the local filesystem. */
export class LocalStorage implements Storage {
  readonly backend = "local" as const;
  readonly location: string;
  readonly #root: string;

  /**
   * @param root Absolute path to the OCFL storage root directory.
   */
  constructor(root: string) {
    this.#root = root.replace(/\/+$/, "");
    this.location = this.#root;
  }

  /** Resolve a storage path to a filesystem path. */
  #resolve(path: string): string {
    const relative = path.split("/").filter((segment) => segment.length > 0)
      .join("/");
    return relative.length === 0 ? this.#root : `${this.#root}/${relative}`;
  }

  async read(path: string): Promise<Bytes> {
    try {
      return await Deno.readFile(this.#resolve(path));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new NotFoundError(path, { cause: error });
      }
      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const info = await Deno.stat(this.#resolve(path));
      return info.isFile;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }

  async listDir(path: string): Promise<Entry[]> {
    const entries: Entry[] = [];
    try {
      for await (const entry of Deno.readDir(this.#resolve(path))) {
        // Symlinks report as neither file nor directory. OCFL forbids them in
        // content (E090), and skipping them keeps both backends' views of the
        // tree identical.
        if (entry.isFile) {
          entries.push({ name: entry.name, type: "file" });
        } else if (entry.isDirectory) {
          entries.push({ name: entry.name, type: "dir" });
        }
      }
    } catch (error) {
      // Absence and emptiness are indistinguishable on S3, so match that here.
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries;
  }

  walkFiles(prefix: string): AsyncIterable<string> {
    return walkFilesViaListDir(this, prefix);
  }

  async write(path: string, bytes: Bytes): Promise<void> {
    const target = this.#resolve(path);
    const slash = target.lastIndexOf("/");
    if (slash > 0) {
      await Deno.mkdir(target.slice(0, slash), { recursive: true });
    }
    await Deno.writeFile(target, bytes);
  }
}
