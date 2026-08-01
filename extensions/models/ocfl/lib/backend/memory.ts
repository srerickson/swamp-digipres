/**
 * In-memory {@link StorageBackend} with object-store semantics, for tests.
 *
 * Models modern S3: a flat, strongly consistent key namespace with no
 * directories and no rename. `list` groups keys by delimiter the way
 * `ListObjectsV2` does, and never reports an empty directory — an empty
 * prefix simply does not exist. Conditional writes are enforced atomically.
 *
 * Test hooks: `onWrite` observes (and may mutate state or throw before) every
 * write, simulating crashes and concurrent writers at exact points in a
 * sequence; {@link failNextWrite} is a one-shot convenience over it.
 *
 * Never imported by `mod.ts`, so it is not bundled into the extension.
 *
 * @module
 */
import { digestBytes } from "../digest.ts";
import { OcflError } from "../errors.ts";
import type {
  BackendEntry,
  StorageBackend,
  WriteConditions,
} from "./backend.ts";
import { PreconditionFailedError } from "./backend.ts";

/** One stored object: its bytes and entity tag. */
interface StoredObject {
  data: Uint8Array;
  etag: string;
}

/** In-memory storage backend with S3-like semantics. */
export class MemoryBackend implements StorageBackend {
  readonly kind = "memory" as const;
  readonly url: string;

  /** Flat key space; no directories exist. */
  readonly objects = new Map<string, StoredObject>();

  /**
   * Called before each write is applied, with the key being written. May
   * throw (simulated crash) or mutate the store (simulated concurrent
   * writer); conditional checks run after it, so mutations it makes are seen.
   */
  onWrite?: (key: string) => void | Promise<void>;

  #failNext: ((key: string) => boolean) | null = null;

  constructor(url = "memory://root") {
    this.url = url;
  }

  /** Make the next write whose key matches `predicate` fail. */
  failNextWrite(predicate: (key: string) => boolean): void {
    this.#failNext = predicate;
  }

  /** The prefix under which children of a directory-like key live. */
  #childPrefix(prefix: string): string {
    return prefix === "" ? "" : `${prefix}/`;
  }

  read(key: string): Promise<Uint8Array | null> {
    const stored = this.objects.get(key);
    return Promise.resolve(stored === undefined ? null : stored.data.slice());
  }

  readWithMeta(
    key: string,
  ): Promise<{ data: Uint8Array; etag?: string } | null> {
    const stored = this.objects.get(key);
    if (stored === undefined) return Promise.resolve(null);
    return Promise.resolve({ data: stored.data.slice(), etag: stored.etag });
  }

  readStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const stored = this.objects.get(key);
    if (stored === undefined) {
      return Promise.reject(
        new OcflError(`no such key: ${key}`, { path: key }),
      );
    }
    const data = stored.data.slice();
    return Promise.resolve(
      new ReadableStream({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      }),
    );
  }

  async write(
    key: string,
    data: Uint8Array,
    conditions?: WriteConditions,
  ): Promise<void> {
    if (this.#failNext?.(key)) {
      this.#failNext = null;
      throw new OcflError(`simulated write failure for ${key}`, { path: key });
    }
    await this.onWrite?.(key);
    if (conditions?.ifNoneMatch && this.objects.has(key)) {
      throw new PreconditionFailedError(key, conditions);
    }
    if (conditions?.ifMatch !== undefined) {
      const stored = this.objects.get(key);
      if (stored === undefined || stored.etag !== conditions.ifMatch) {
        throw new PreconditionFailedError(key, conditions);
      }
    }
    this.objects.set(key, {
      data: data.slice(),
      etag: digestBytes(data, "md5"),
    });
  }

  async writeFromFile(key: string, sourcePath: string): Promise<void> {
    await this.write(key, await Deno.readFile(sourcePath));
  }

  list(prefix: string): Promise<BackendEntry[] | null> {
    const childPrefix = this.#childPrefix(prefix);
    const names = new Map<string, "file" | "dir">();
    for (const key of this.objects.keys()) {
      if (!key.startsWith(childPrefix)) continue;
      const remainder = key.slice(childPrefix.length);
      const slash = remainder.indexOf("/");
      if (slash === -1) {
        names.set(remainder, "file");
      } else {
        names.set(remainder.slice(0, slash), "dir");
      }
    }
    if (names.size === 0) return Promise.resolve(null);
    return Promise.resolve(
      [...names.entries()].map(([name, kind]) => ({ name, kind })),
    );
  }

  prefixExists(prefix: string): Promise<boolean> {
    const childPrefix = this.#childPrefix(prefix);
    for (const key of this.objects.keys()) {
      if (key.startsWith(childPrefix)) return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  deletePrefix(prefix: string): Promise<void> {
    const childPrefix = this.#childPrefix(prefix);
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(childPrefix)) this.objects.delete(key);
    }
    return Promise.resolve();
  }
}
