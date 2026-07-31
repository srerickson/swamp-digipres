/**
 * Zod schemas and inferred types for OCFL 1.1 inventories.
 *
 * Schemas are strict: unknown keys fail parsing, which implements E102
 * ("inventory MUST NOT contain keys not defined by the specification") at
 * parse time rather than as a separate validator pass.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Inventory `type` value for OCFL 1.1 objects (E038). */
export const INVENTORY_TYPE_1_1 = "https://ocfl.io/1.1/spec/#inventory";

/** Inventory `type` value for OCFL 1.0 objects — recognized, not yet supported. */
export const INVENTORY_TYPE_1_0 = "https://ocfl.io/1.0/spec/#inventory";

/** Default content directory name when `contentDirectory` is absent (§3.3.1). */
export const DEFAULT_CONTENT_DIRECTORY = "content";

/**
 * RFC 3339 timestamp with a required timezone offset (E049).
 *
 * Seconds are mandatory; fractional seconds are permitted. `Z` and numeric
 * offsets are both accepted — the Go `ocfl` tool emits numeric offsets, this
 * library emits `Z`.
 */
export const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** Version directory name: `v` followed by digits, zero-padded or not (E104). */
export const VERSION_NAME_PATTERN = /^v\d+$/;

/** Digest algorithms permitted for the inventory `digestAlgorithm` key (E025). */
export const DigestAlgorithmSchema = z.enum(["sha512", "sha256"]);

/** Digest algorithm usable for the inventory itself and its sidecar. */
export type DigestAlgorithm = z.infer<typeof DigestAlgorithmSchema>;

/**
 * Algorithms accepted in the optional `fixity` block (§3.5.4). `sha512`/`sha256`
 * are also valid here; the legacy set is permitted for migrated content.
 */
export const FIXITY_ALGORITHMS = [
  "md5",
  "sha1",
  "sha256",
  "sha512",
  "blake2b-512",
  "sha512/256",
] as const;

/** An algorithm name valid inside a `fixity` block. */
export type FixityAlgorithm = (typeof FIXITY_ALGORITHMS)[number];

/**
 * Agent responsible for a version (§3.5.3.1). `name` is required (E054);
 * `address` should be a URI, ideally `mailto:` or an ORCID (W008/W009).
 */
export const UserSchema = z.strictObject({
  name: z.string().min(1),
  address: z.string().optional(),
});

/** Agent responsible for a version. */
export type User = z.infer<typeof UserSchema>;

/**
 * A single version block: creation time, logical state, and optional
 * provenance metadata (§3.5.3).
 */
export const VersionSchema = z.strictObject({
  created: z.string().regex(RFC3339_PATTERN),
  state: z.record(z.string(), z.array(z.string())),
  message: z.string().optional(),
  user: UserSchema.optional(),
});

/** A single version block from an inventory. */
export type Version = z.infer<typeof VersionSchema>;

/**
 * An OCFL inventory (§3.5). Strict — unknown keys are rejected (E102).
 *
 * `type` is typed as a plain string so a 1.0 inventory parses far enough to
 * produce a targeted E038 diagnostic instead of an opaque literal mismatch.
 */
export const InventorySchema = z.strictObject({
  id: z.string().min(1),
  type: z.string().min(1),
  digestAlgorithm: DigestAlgorithmSchema,
  head: z.string().regex(VERSION_NAME_PATTERN),
  contentDirectory: z.string().optional(),
  manifest: z.record(z.string(), z.array(z.string())),
  versions: z.record(z.string(), VersionSchema),
  fixity: z.record(z.string(), z.record(z.string(), z.array(z.string())))
    .optional(),
});

/** A parsed OCFL inventory. */
export type Inventory = z.infer<typeof InventorySchema>;

/**
 * An inventory together with the exact bytes it was parsed from.
 *
 * The raw bytes matter: the root inventory must be a byte-for-byte copy of the
 * head version's inventory (E064), and sidecar digests are computed over these
 * bytes, so re-serializing would drift.
 */
export interface LoadedInventory {
  /** The parsed inventory. */
  inventory: Inventory;
  /** Exact bytes read from disk. */
  bytes: Uint8Array;
  /** Path the inventory was read from. */
  path: string;
}

/** Resolve the content directory name for an inventory (§3.3.1). */
export function contentDirectoryOf(inventory: Inventory): string {
  return inventory.contentDirectory ?? DEFAULT_CONTENT_DIRECTORY;
}
