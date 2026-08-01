/**
 * Reading, verifying, serializing, and writing OCFL inventories and their
 * digest sidecars (§3.5–3.7).
 *
 * Raw bytes are retained everywhere an inventory is read, because the root
 * inventory must be a byte-for-byte copy of the head version's (E064) and
 * sidecar digests are computed over exactly the bytes on disk (E060).
 *
 * @module
 */
import { z } from "npm:zod@4";
import type { StorageBackend } from "./backend/backend.ts";
import { joinKey, readText } from "./backend/backend.ts";
import type { ValidationIssue } from "./errors.ts";
import { error, OcflError } from "./errors.ts";
import { digestBytes, digestsEqual } from "./digest.ts";
import { joinOcflPath } from "./paths.ts";
import type { DigestAlgorithm, Inventory, LoadedInventory } from "./types.ts";
import { INVENTORY_TYPE_1_1, InventorySchema } from "./types.ts";

/** Canonical inventory filename (E034). */
export const INVENTORY_FILENAME = "inventory.json";

/** Build the sidecar filename for a digest algorithm. */
export function sidecarFilename(algorithm: string): string {
  return `${INVENTORY_FILENAME}.${algorithm}`;
}

/** Map a Zod issue on the inventory schema to an OCFL validation code. */
function codeForIssue(issue: z.core.$ZodIssue): string {
  if (issue.code === "unrecognized_keys") return "E102";

  // Nested keys inside a version block carry their own codes and must be
  // matched before the top-level `versions` key claims them.
  if (issue.path.includes("created")) return "E049";
  if (issue.path.includes("user")) return "E054";
  if (issue.path.includes("state")) return "E050";

  const [key] = issue.path;
  switch (key) {
    case "id":
      return "E036";
    case "type":
      return "E038";
    case "digestAlgorithm":
      return "E025";
    case "head":
      return "E040";
    case "manifest":
      return "E041";
    case "versions":
      return "E043";
    case "fixity":
      return "E056";
    default:
      return "E036";
  }
}

/**
 * Parse inventory bytes, collecting issues rather than throwing.
 *
 * @returns The parsed inventory (`null` when parsing failed) and every issue.
 */
export function parseInventory(
  bytes: Uint8Array,
  location: string,
): { inventory: Inventory | null; issues: ValidationIssue[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    return {
      inventory: null,
      issues: [
        error(
          "E033",
          location,
          `inventory is not valid JSON: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        ),
      ],
    };
  }

  const result = InventorySchema.safeParse(raw);
  if (!result.success) {
    return {
      inventory: null,
      issues: result.error.issues.map((issue) =>
        error(
          codeForIssue(issue),
          location,
          `${issue.path.join(".") || "<root>"}: ${issue.message}`,
        )
      ),
    };
  }

  const inventory = result.data;
  const issues: ValidationIssue[] = [];
  if (inventory.type !== INVENTORY_TYPE_1_1) {
    issues.push(
      error(
        "E038",
        location,
        `inventory type must be ${INVENTORY_TYPE_1_1}, found ${
          JSON.stringify(inventory.type)
        }`,
      ),
    );
  }
  return { inventory, issues };
}

/**
 * Parse a sidecar file's contents into its digest (E061).
 *
 * The format is `DIGEST inventory.json`, separated by one or more spaces or
 * tabs. A trailing newline is permitted.
 */
export function parseSidecar(
  text: string,
  location: string,
): { digest: string | null; issues: ValidationIssue[] } {
  const match = /^([0-9a-fA-F]+)[ \t]+inventory\.json\s*$/.exec(text.trim());
  if (match === null) {
    return {
      digest: null,
      issues: [
        error(
          "E061",
          location,
          `sidecar must contain "DIGEST inventory.json", found ${
            JSON.stringify(text)
          }`,
        ),
      ],
    };
  }
  return { digest: match[1], issues: [] };
}

/**
 * Find the sidecar file accompanying an inventory in a directory.
 *
 * The algorithm is discovered from the filename rather than assumed, so a
 * sidecar whose algorithm disagrees with the inventory can be reported as E059
 * instead of appearing to be missing.
 */
async function findSidecar(
  backend: StorageBackend,
  key: string,
): Promise<{ filename: string; algorithm: string } | null> {
  const entries = await backend.list(key) ?? [];
  for (const entry of entries) {
    if (
      entry.kind === "file" && entry.name.startsWith(`${INVENTORY_FILENAME}.`)
    ) {
      return {
        filename: entry.name,
        algorithm: entry.name.slice(INVENTORY_FILENAME.length + 1),
      };
    }
  }
  return null;
}

/** An inventory read from disk together with the outcome of its checks. */
export interface InventoryCheckResult {
  /** The loaded inventory and its bytes, or `null` when unreadable. */
  loaded: LoadedInventory | null;
  /** Every issue found while reading, parsing, and verifying. */
  issues: ValidationIssue[];
  /**
   * True when the inventory parsed and its sidecar verified. A `false` here
   * with a non-null `loaded` means the content is usable but the sidecar
   * disagrees — the recoverable crash-window condition.
   */
  sidecarVerified: boolean;
}

/**
 * Read an inventory and verify it against its sidecar, collecting issues.
 *
 * @param key Storage-root-relative key of the directory holding
 * `inventory.json`; `""` for the root itself.
 * @param location Path used in issue reporting, relative to the storage root.
 */
export async function checkInventory(
  backend: StorageBackend,
  key: string,
  location: string,
): Promise<InventoryCheckResult> {
  const inventoryKey = joinKey(key, INVENTORY_FILENAME);
  const inventoryLocation = joinOcflPath(location, INVENTORY_FILENAME);
  const bytes = await backend.read(inventoryKey);
  if (bytes === null) {
    return {
      loaded: null,
      issues: [error("E063", location, `missing ${INVENTORY_FILENAME}`)],
      sidecarVerified: false,
    };
  }

  const { inventory, issues } = parseInventory(bytes, inventoryLocation);
  if (inventory === null) {
    return { loaded: null, issues, sidecarVerified: false };
  }
  const loaded: LoadedInventory = { inventory, bytes, path: inventoryKey };

  const sidecar = await findSidecar(backend, key);
  if (sidecar === null) {
    issues.push(
      error(
        "E058",
        location,
        `missing inventory sidecar ${
          sidecarFilename(inventory.digestAlgorithm)
        }`,
      ),
    );
    return { loaded, issues, sidecarVerified: false };
  }

  const sidecarLocation = joinOcflPath(location, sidecar.filename);
  if (sidecar.algorithm !== inventory.digestAlgorithm) {
    issues.push(
      error(
        "E059",
        sidecarLocation,
        `sidecar algorithm ${sidecar.algorithm} does not match inventory digestAlgorithm ${inventory.digestAlgorithm}`,
      ),
    );
    return { loaded, issues, sidecarVerified: false };
  }

  const sidecarText = await readText(backend, joinKey(key, sidecar.filename)) ??
    "";
  const parsed = parseSidecar(sidecarText, sidecarLocation);
  issues.push(...parsed.issues);
  if (parsed.digest === null) {
    return { loaded, issues, sidecarVerified: false };
  }

  const actual = digestBytes(bytes, inventory.digestAlgorithm);
  if (!digestsEqual(actual, parsed.digest)) {
    issues.push(
      error(
        "E060",
        sidecarLocation,
        `sidecar digest does not match inventory: expected ${actual}, sidecar states ${parsed.digest}`,
      ),
    );
    return { loaded, issues, sidecarVerified: false };
  }

  return { loaded, issues, sidecarVerified: true };
}

/**
 * Read and verify an inventory, throwing on any problem.
 *
 * Read paths that cannot proceed without a trustworthy inventory use this;
 * the validator uses {@link checkInventory}.
 */
export async function readInventoryVerified(
  backend: StorageBackend,
  key: string,
): Promise<LoadedInventory> {
  const where = joinKey(backend.url, key);
  const result = await checkInventory(backend, key, where);
  if (result.loaded === null || !result.sidecarVerified) {
    const issue = result.issues[0];
    throw new OcflError(
      issue?.message ?? `could not read a verified inventory in ${where}`,
      { code: issue?.code, path: where },
    );
  }
  return result.loaded;
}

/**
 * Serialize an inventory to canonical bytes.
 *
 * Keys are emitted in specification order for readability; the exact bytes
 * produced here are written to both the version directory and the object root,
 * so the two copies cannot drift (E064).
 */
export function serializeInventory(inventory: Inventory): Uint8Array {
  const ordered: Record<string, unknown> = {
    id: inventory.id,
    type: inventory.type,
    digestAlgorithm: inventory.digestAlgorithm,
    head: inventory.head,
  };
  if (inventory.contentDirectory !== undefined) {
    ordered.contentDirectory = inventory.contentDirectory;
  }
  ordered.manifest = inventory.manifest;
  ordered.versions = inventory.versions;
  if (inventory.fixity !== undefined) {
    ordered.fixity = inventory.fixity;
  }
  return new TextEncoder().encode(`${JSON.stringify(ordered, null, 2)}\n`);
}

/**
 * Write an inventory and its sidecar into a directory, sidecar last.
 *
 * The sidecar is the commit marker: its digest is computed over the exact
 * bytes just written, and it is written only after the inventory is fully on
 * disk (E062).
 */
export async function writeInventoryPair(
  backend: StorageBackend,
  key: string,
  bytes: Uint8Array,
  algorithm: DigestAlgorithm,
): Promise<void> {
  await backend.write(joinKey(key, INVENTORY_FILENAME), bytes);
  await writeSidecar(backend, key, bytes, algorithm);
}

/**
 * Write just the sidecar for already-written inventory bytes.
 *
 * Commit finalizers use this when a step must run between the inventory write
 * and its sidecar — the sidecar is the commit marker (E062).
 */
export async function writeSidecar(
  backend: StorageBackend,
  key: string,
  bytes: Uint8Array,
  algorithm: DigestAlgorithm,
): Promise<void> {
  const digest = digestBytes(bytes, algorithm);
  await backend.write(
    joinKey(key, sidecarFilename(algorithm)),
    new TextEncoder().encode(`${digest} ${INVENTORY_FILENAME}\n`),
  );
}

/** Compare two byte strings for exact equality. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
