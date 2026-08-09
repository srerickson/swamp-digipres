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
  /** Directory holding scratch files for {@linkcode writeAtomic}. */
  readonly #scratch: string;

  /**
   * @param root Absolute path to the OCFL storage root directory.
   */
  constructor(root: string) {
    this.#root = root.replace(/\/+$/, "");
    this.location = this.#root;
    // The storage root's parent: on the same filesystem as the root in the
    // ordinary case, so `rename` is atomic, and outside the root, so a scratch
    // file is never a stray entry in the object hierarchy (E072, E001).
    const slash = this.#root.lastIndexOf("/");
    this.#scratch = slash > 0 ? this.#root.slice(0, slash) : this.#root;
  }

  /** Resolve a storage path to a filesystem path. */
  #resolve(path: string): string {
    const relative = path.split("/").filter((segment) => segment.length > 0)
      .join("/");
    return relative.length === 0 ? this.#root : `${this.#root}/${relative}`;
  }

  /** Create the parent directory of a resolved filesystem path. */
  static async #mkdirFor(target: string): Promise<void> {
    const slash = target.lastIndexOf("/");
    if (slash > 0) {
      await Deno.mkdir(target.slice(0, slash), { recursive: true });
    }
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

  async readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    let file: Deno.FsFile;
    try {
      file = await Deno.open(this.#resolve(path), { read: true });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new NotFoundError(path, { cause: error });
      }
      throw error;
    }
    // `readable` closes the file when the stream ends, is cancelled, or errors,
    // so the descriptor is the stream's to own from here.
    return file.readable;
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
    await LocalStorage.#mkdirFor(target);
    await Deno.writeFile(target, bytes);
  }

  /**
   * Write via a scratch file and `rename`, so a reader sees either the old
   * contents or the new ones and never a partial file.
   *
   * `rename` is only atomic within a filesystem. The scratch file normally
   * lives beside the storage root; if that rename fails — a storage root that
   * is itself a mount point, a read-only parent — it retries with a scratch
   * file beside the *target*, which is same-filesystem by construction. That
   * leaves a stray file in the object hierarchy for the microseconds between
   * `write` and `rename`, which is a far better trade than a torn inventory.
   */
  async writeAtomic(path: string, bytes: Bytes): Promise<void> {
    const target = this.#resolve(path);
    await LocalStorage.#mkdirFor(target);

    const slash = target.lastIndexOf("/");
    const targetDir = slash > 0 ? target.slice(0, slash) : "/";
    for (const dir of [this.#scratch, targetDir]) {
      const temp = `${dir}/.ocfl-tmp-${crypto.randomUUID()}`;
      try {
        const file = await Deno.open(temp, {
          write: true,
          create: true,
          truncate: true,
        });
        try {
          let written = 0;
          while (written < bytes.byteLength) {
            written += await file.write(bytes.subarray(written));
          }
          await file.sync();
        } finally {
          file.close();
        }
        await Deno.rename(temp, target);
        await syncDir(targetDir);
        return;
      } catch (error) {
        await Deno.remove(temp).catch(() => {});
        if (dir === targetDir) throw error;
      }
    }
  }

  async writeStream(
    path: string,
    body: ReadableStream<Uint8Array>,
    _options?: { size?: number },
  ): Promise<void> {
    const target = this.#resolve(path);
    await LocalStorage.#mkdirFor(target);
    const file = await Deno.open(target, {
      write: true,
      create: true,
      truncate: true,
    });
    // pipeTo closes the destination, and closes `body` on failure too, so no
    // explicit cleanup is needed on either side.
    await body.pipeTo(file.writable);
  }

  async remove(path: string): Promise<void> {
    try {
      await Deno.remove(this.#resolve(path));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  /**
   * Remove empty directories beneath `prefix`, then `prefix` itself.
   *
   * An empty directory anywhere under a storage root is a validation error
   * (E073), so aborting a version must not leave the skeleton behind.
   */
  async pruneEmptyDirs(prefix: string): Promise<void> {
    const relative = prefix.split("/").filter((segment) => segment.length > 0);
    if (relative.length === 0) return; // never prune the storage root itself

    const target = this.#resolve(prefix);
    let empty = true;
    try {
      for await (const entry of Deno.readDir(target)) {
        if (entry.isDirectory) {
          await this.pruneEmptyDirs(`${relative.join("/")}/${entry.name}`);
        }
        empty = false;
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }

    // Re-check: the recursive calls above may have emptied it.
    if (!empty) {
      for await (const _ of Deno.readDir(target)) return;
    }
    await Deno.remove(target).catch(() => {});
  }
}

/**
 * Flush a directory entry so a completed `rename` survives power loss.
 *
 * Best-effort: opening a directory is not portable, and a failure here costs
 * durability rather than correctness.
 */
async function syncDir(path: string): Promise<void> {
  try {
    const dir = await Deno.open(path, { read: true });
    try {
      await dir.sync();
    } finally {
      dir.close();
    }
  } catch {
    // Not fatal — the rename itself has already happened.
  }
}
