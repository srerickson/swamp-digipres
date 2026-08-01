/**
 * Streaming digest computation for OCFL content and inventory files.
 *
 * Uses `node:crypto` `createHash` — built into Deno, streams (so large content
 * files never load fully into memory), and covers every algorithm in the OCFL
 * fixity table without an npm dependency.
 *
 * @module
 */
import { createHash, getHashes } from "node:crypto";
import { OcflError } from "./errors.ts";
import type { DigestAlgorithm } from "./types.ts";

/** Maps OCFL algorithm names to `node:crypto` hash names. */
const NODE_HASH_NAMES: Record<string, string> = {
  "md5": "md5",
  "sha1": "sha1",
  "sha256": "sha256",
  "sha512": "sha512",
  "sha512/256": "sha512-256",
  "blake2b-512": "blake2b512",
};

/**
 * Whether the runtime can compute the named OCFL algorithm.
 *
 * Unsupported fixity algorithms are ignored rather than treated as errors
 * (E028), so callers check this before attempting verification.
 */
export function isDigestAlgorithmSupported(algorithm: string): boolean {
  const nodeName = NODE_HASH_NAMES[algorithm];
  if (nodeName === undefined) return false;
  return getHashes().includes(nodeName);
}

/** Resolve an OCFL algorithm name to its `node:crypto` name, or throw. */
function nodeHashName(algorithm: string): string {
  const nodeName = NODE_HASH_NAMES[algorithm];
  if (nodeName === undefined) {
    throw new OcflError(`unsupported digest algorithm: ${algorithm}`, {
      code: "E025",
    });
  }
  return nodeName;
}

/**
 * Digest a byte stream through the named algorithm.
 *
 * Used for backend content (an S3 GET body is a stream) and, via
 * {@link digestFile}, for local files.
 *
 * @returns Lowercase hex digest (E029–E031 require hex encoding).
 */
export async function digestStream(
  stream: ReadableStream<Uint8Array>,
  algorithm: string,
): Promise<string> {
  const hash = createHash(nodeHashName(algorithm));
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex").toLowerCase();
}

/**
 * Digest a local file by streaming it through the named algorithm.
 *
 * Source trees for commits are always local directories, so this stays a
 * plain-path API alongside the backend-based {@link digestStream}.
 *
 * @returns Lowercase hex digest (E029–E031 require hex encoding).
 */
export async function digestFile(
  path: string,
  algorithm: string,
): Promise<string> {
  const file = await Deno.open(path, { read: true });
  return await digestStream(file.readable, algorithm);
}

/**
 * Digest an in-memory byte string.
 *
 * Used for inventory sidecars, where the digest must be computed over the
 * exact bytes written to disk.
 *
 * @returns Lowercase hex digest.
 */
export function digestBytes(bytes: Uint8Array, algorithm: string): string {
  const hash = createHash(nodeHashName(algorithm));
  hash.update(bytes);
  return hash.digest("hex").toLowerCase();
}

/**
 * Compare two digests case-insensitively.
 *
 * OCFL digests are hex strings whose case is not significant (§3.4, E096/E097),
 * so every comparison in this library goes through here rather than `===`.
 */
export function digestsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Normalize a digest for use as a lookup key.
 *
 * Original casing is preserved everywhere it is written back out; this is only
 * for building maps and sets that must treat `AB…` and `ab…` as one digest.
 */
export function normalizeDigest(digest: string): string {
  return digest.toLowerCase();
}

/** Digest algorithms valid for the inventory itself, for runtime checks. */
export const INVENTORY_DIGEST_ALGORITHMS: readonly DigestAlgorithm[] = [
  "sha512",
  "sha256",
];
