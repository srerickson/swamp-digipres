/**
 * Local-filesystem {@link StorageBackend}.
 *
 * Wraps `Deno` filesystem calls with the exact semantics the OCFL library
 * relied on before the backend abstraction existed: `exists` answers via
 * `lstat` (dangling symlinks exist), `list` classifies anything that is not a
 * directory as a file, and an existing empty directory lists as `[]` while a
 * missing one lists as `null`.
 *
 * @module
 */
import { OcflError } from "../errors.ts";
import type {
  BackendEntry,
  StorageBackend,
  WriteConditions,
} from "./backend.ts";
import { PreconditionFailedError } from "./backend.ts";

/** Parent directory of a path. */
function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return index === 0 ? "/" : ".";
  return trimmed.slice(0, index);
}

/** Storage backend over a local directory. */
export class LocalBackend implements StorageBackend {
  /** Absolute path of the storage root directory. */
  readonly rootDir: string;
  readonly kind = "local" as const;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  get url(): string {
    return this.rootDir;
  }

  /** Absolute path for a storage-root-relative key. */
  resolve(key: string): string {
    return key === "" ? this.rootDir : `${this.rootDir}/${key}`;
  }

  async read(key: string): Promise<Uint8Array | null> {
    try {
      return await Deno.readFile(this.resolve(key));
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) return null;
      throw cause;
    }
  }

  async readWithMeta(
    key: string,
  ): Promise<{ data: Uint8Array; etag?: string } | null> {
    const data = await this.read(key);
    if (data === null) return null;
    return { data };
  }

  async readStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const file = await Deno.open(this.resolve(key), { read: true });
    return file.readable;
  }

  async write(
    key: string,
    data: Uint8Array,
    conditions?: WriteConditions,
  ): Promise<void> {
    const path = this.resolve(key);
    await Deno.mkdir(dirname(path), { recursive: true });
    if (conditions?.ifMatch !== undefined) {
      throw new OcflError(
        `local backend cannot enforce an if-match condition on ${key}: local files have no entity tags`,
        { path: key },
      );
    }
    if (conditions?.ifNoneMatch) {
      try {
        await Deno.writeFile(path, data, { createNew: true });
      } catch (cause) {
        if (cause instanceof Deno.errors.AlreadyExists) {
          throw new PreconditionFailedError(key, conditions);
        }
        throw cause;
      }
      return;
    }
    await Deno.writeFile(path, data);
  }

  async writeFromFile(key: string, sourcePath: string): Promise<void> {
    const path = this.resolve(key);
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.copyFile(sourcePath, path);
  }

  async list(prefix: string): Promise<BackendEntry[] | null> {
    const entries: BackendEntry[] = [];
    try {
      for await (const entry of Deno.readDir(this.resolve(prefix))) {
        entries.push({
          name: entry.name,
          kind: entry.isDirectory ? "dir" : "file",
        });
      }
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) return null;
      if (cause instanceof Deno.errors.NotADirectory) {
        throw new OcflError(
          `${this.resolve(prefix)} exists but is not a directory`,
          { path: prefix },
        );
      }
      throw cause;
    }
    return entries;
  }

  async prefixExists(prefix: string): Promise<boolean> {
    try {
      return (await Deno.stat(this.resolve(prefix))).isDirectory;
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) return false;
      throw cause;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await Deno.lstat(this.resolve(key));
      return true;
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) return false;
      throw cause;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await Deno.remove(this.resolve(key));
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) return;
      throw cause;
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    try {
      await Deno.remove(this.resolve(prefix), { recursive: true });
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) return;
      throw cause;
    }
  }
}
