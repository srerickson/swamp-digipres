/**
 * Digest helpers for OCFL inventories and fixity.
 *
 * Uses `node:crypto`, which Deno provides natively — no npm dependency, and it
 * covers every algorithm in the OCFL digest tables.
 *
 * @module
 */
import { createHash } from "node:crypto";

/** Digest algorithms an inventory may declare (§3.5.1, E025). */
export type InventoryDigestAlgorithm = "sha512" | "sha256";

/** Map an OCFL algorithm name to its `node:crypto` equivalent. */
const NODE_ALGORITHMS: Record<string, string> = {
  "md5": "md5",
  "sha1": "sha1",
  "sha256": "sha256",
  "sha512": "sha512",
  "sha512/256": "sha512-256",
  "blake2b-512": "blake2b512",
};

/** Whether this build can compute the named OCFL digest algorithm. */
export function isSupportedAlgorithm(algorithm: string): boolean {
  return algorithm in NODE_ALGORITHMS;
}

/**
 * Hex digest of `bytes` under an OCFL algorithm name, lowercased.
 *
 * @throws {Error} when the algorithm is not one OCFL names.
 */
export function digestBytes(bytes: Uint8Array, algorithm: string): string {
  const nodeAlgorithm = NODE_ALGORITHMS[algorithm];
  if (nodeAlgorithm === undefined) {
    throw new Error(`unsupported digest algorithm: ${algorithm}`);
  }
  return createHash(nodeAlgorithm).update(bytes).digest("hex").toLowerCase();
}

/** Hex digest of a UTF-8 string, lowercased. */
export function digestText(text: string, algorithm: string): string {
  return digestBytes(new TextEncoder().encode(text), algorithm);
}

/**
 * Digest a stream without holding it in memory.
 *
 * Used by the planning pass, which must know every source's digest before the
 * inventory can be assembled — and before dedupe can decide whether a content
 * write is needed at all.
 *
 * @throws {Error} when the algorithm is not one OCFL names.
 */
export async function digestStream(
  stream: ReadableStream<Uint8Array>,
  algorithm: string,
): Promise<{ digest: string; size: number }> {
  const nodeAlgorithm = NODE_ALGORITHMS[algorithm];
  if (nodeAlgorithm === undefined) {
    throw new Error(`unsupported digest algorithm: ${algorithm}`);
  }
  const hash = createHash(nodeAlgorithm);
  let size = 0;
  for await (const chunk of stream) {
    hash.update(chunk);
    size += chunk.byteLength;
  }
  return { digest: hash.digest("hex").toLowerCase(), size };
}

/** A pass-through stream that digests the bytes flowing through it. */
export type DigestingStream = {
  /** Insert into a pipeline with `source.pipeThrough(this.stream)`. */
  readonly stream: TransformStream<Uint8Array, Uint8Array>;
  /** Hex digest of everything passed through. Valid once the stream closes. */
  digest(): string;
  /** Bytes passed through so far. */
  size(): number;
};

/**
 * Wrap a copy so its digest is computed from the bytes actually written.
 *
 * Verifying the write itself, rather than re-reading the source, is what
 * catches source drift that slipped past the size+mtime check and corruption in
 * transit (`references/transactions.md` §7). It costs one hash over data
 * already in memory.
 *
 * @throws {Error} when the algorithm is not one OCFL names.
 */
export function digestingStream(algorithm: string): DigestingStream {
  const nodeAlgorithm = NODE_ALGORITHMS[algorithm];
  if (nodeAlgorithm === undefined) {
    throw new Error(`unsupported digest algorithm: ${algorithm}`);
  }
  const hash = createHash(nodeAlgorithm);
  let size = 0;
  let finished: string | undefined;

  return {
    stream: new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hash.update(chunk);
        size += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        finished = hash.digest("hex").toLowerCase();
      },
    }),
    digest(): string {
      if (finished === undefined) {
        throw new Error("digest() called before the stream finished");
      }
      return finished;
    },
    size: () => size,
  };
}

/**
 * Compare two digests.
 *
 * OCFL digests are case-insensitive (§3.4), so a plain string comparison would
 * wrongly report a mismatch between inventories written by different clients.
 */
export function digestsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
