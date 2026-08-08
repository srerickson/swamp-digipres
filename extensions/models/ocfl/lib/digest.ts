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
 * Compare two digests.
 *
 * OCFL digests are case-insensitive (§3.4), so a plain string comparison would
 * wrongly report a mismatch between inventories written by different clients.
 */
export function digestsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
