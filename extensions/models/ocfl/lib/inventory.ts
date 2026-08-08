/**
 * OCFL inventory parsing and sidecar verification (§3.5, §3.7).
 *
 * @module
 */
import { z } from "npm:zod@4";
import { digestBytes, digestsEqual, isSupportedAlgorithm } from "./digest.ts";
import { OcflError } from "./errors.ts";
import type { Storage } from "./storage/types.ts";
import { joinPath } from "./storage/types.ts";

/** The agent recorded against a version (§3.5.3.1). */
const UserSchema = z.object({
  name: z.string(),
  address: z.string().optional(),
}).strict();

/** One version block: its timestamp, logical state, and provenance. */
const VersionSchema = z.object({
  created: z.string(),
  state: z.record(z.string(), z.array(z.string())),
  message: z.string().optional(),
  user: UserSchema.optional(),
}).strict();

/**
 * An OCFL inventory.
 *
 * `.strict()` throughout, which enforces E102 (no unknown keys) at parse time
 * rather than as a separate validation pass.
 */
export const InventorySchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  digestAlgorithm: z.enum(["sha512", "sha256"]),
  head: z.string(),
  contentDirectory: z.string().optional(),
  manifest: z.record(z.string(), z.array(z.string())),
  versions: z.record(z.string(), VersionSchema),
  fixity: z.record(z.string(), z.record(z.string(), z.array(z.string())))
    .optional(),
}).strict();

/** A parsed OCFL inventory. */
export type Inventory = z.infer<typeof InventorySchema>;

/** An inventory together with the exact bytes it was parsed from. */
export type LoadedInventory = {
  inventory: Inventory;
  /** Original bytes — required for the E064 byte-identity comparison. */
  bytes: Uint8Array;
  /** Digest of `bytes` under the inventory's own algorithm. */
  digest: string;
};

/** The content directory an inventory uses, defaulting to `content` (§3.3.1). */
export function contentDirectoryOf(inventory: Inventory): string {
  return inventory.contentDirectory ?? "content";
}

/**
 * Parse inventory bytes.
 *
 * @throws {OcflError} when the JSON is malformed or violates the schema.
 */
export function parseInventory(bytes: Uint8Array, path: string): Inventory {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new OcflError("inventory is not well-formed JSON", {
      code: "E033",
      path,
      cause: error,
    });
  }

  const parsed = InventorySchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new OcflError(`inventory failed validation: ${issues}`, {
      code: "E034",
      path,
    });
  }

  const inventory = parsed.data;
  if (!(inventory.head in inventory.versions)) {
    throw new OcflError(
      `inventory head ${inventory.head} is not present in versions`,
      { code: "E040", path },
    );
  }
  return inventory;
}

/** Sidecar filename for an inventory using `algorithm`. */
export function sidecarName(algorithm: string): string {
  return `inventory.json.${algorithm}`;
}

/**
 * Parse a sidecar's `DIGEST inventory.json` line (§3.7, E061).
 *
 * @throws {OcflError} when the line is not in the required form.
 */
export function parseSidecar(text: string, path: string): string {
  const match = text.trim().match(/^([0-9a-fA-F]+)[ \t]+inventory\.json$/);
  if (match === null) {
    throw new OcflError(
      "inventory sidecar is not of the form '<digest> inventory.json'",
      { code: "E061", path },
    );
  }
  return match[1].toLowerCase();
}

/**
 * Read `inventory.json` from `dir` and verify it against its sidecar.
 *
 * The sidecar is the commit marker in OCFL, so an inventory is never trusted
 * without it (E058–E061).
 *
 * @throws {OcflError} when the sidecar is missing or the digest disagrees.
 */
export async function readInventory(
  storage: Storage,
  dir: string,
): Promise<LoadedInventory> {
  const path = joinPath(dir, "inventory.json");
  const bytes = await storage.read(path);
  const inventory = parseInventory(bytes, path);

  const algorithm = inventory.digestAlgorithm;
  if (!isSupportedAlgorithm(algorithm)) {
    throw new OcflError(`unsupported digest algorithm ${algorithm}`, {
      code: "E025",
      path,
    });
  }

  const sidecarPath = joinPath(dir, sidecarName(algorithm));
  let sidecarBytes: Uint8Array;
  try {
    sidecarBytes = await storage.read(sidecarPath);
  } catch (error) {
    throw new OcflError(
      `inventory sidecar ${sidecarName(algorithm)} is missing`,
      { code: "E058", path: sidecarPath, cause: error },
    );
  }

  const expected = parseSidecar(
    new TextDecoder().decode(sidecarBytes),
    sidecarPath,
  );
  const actual = digestBytes(bytes, algorithm);
  if (!digestsEqual(expected, actual)) {
    throw new OcflError(
      `inventory digest mismatch: sidecar declares ${expected}, ` +
        `contents digest to ${actual}`,
      { code: "E060", path },
    );
  }

  return { inventory, bytes, digest: actual };
}

/**
 * Version names in the order `v1 … head`.
 *
 * Sorted numerically so that zero-padded and unpadded conventions both order
 * correctly, and `v10` never sorts before `v2`.
 */
export function versionNames(inventory: Inventory): string[] {
  return Object.keys(inventory.versions).sort((a, b) =>
    versionNumber(a) - versionNumber(b)
  );
}

/** Numeric part of a version directory name; `0` when unparseable. */
export function versionNumber(name: string): number {
  const match = name.match(/^v(\d+)$/);
  return match === null ? 0 : Number.parseInt(match[1], 10);
}

/**
 * Zero-padding width the object's version names use.
 *
 * `v0001` yields 4 and `v1` yields 0. The convention is fixed by v1 and must
 * never change within an object (E011–E013), so it is read from the object
 * rather than configured.
 */
export function versionPadding(inventory: Inventory): number {
  const first = versionNames(inventory)[0];
  if (first === undefined) return 0;
  const digits = first.slice(1);
  return digits.startsWith("0") ? digits.length : 0;
}

/** Format a version number under a padding convention. */
export function formatVersionName(number: number, padding: number): string {
  return `v${String(number).padStart(padding, "0")}`;
}

/**
 * The version that would follow `head`.
 *
 * Verifies the existing sequence is a contiguous `v1..head` under one naming
 * convention before extending it: a gap or a stray name means the object is
 * already invalid (E010–E013), and appending to it would bury the evidence.
 *
 * @throws {OcflError} when the version sequence is not well-formed.
 */
export function nextVersion(
  inventory: Inventory,
): { name: string; number: number } {
  const names = versionNames(inventory);
  const padding = versionPadding(inventory);

  for (const [index, name] of names.entries()) {
    const expected = formatVersionName(index + 1, padding);
    if (name !== expected) {
      throw new OcflError(
        `object ${inventory.id} has a malformed version sequence: expected ` +
          `${expected} but found ${name} (versions: ${names.join(", ")})`,
        { code: "E011" },
      );
    }
  }

  const head = versionNumber(inventory.head);
  if (head !== names.length) {
    throw new OcflError(
      `object ${inventory.id} declares head ${inventory.head} but has ` +
        `${names.length} version(s): ${names.join(", ")}`,
      { code: "E040" },
    );
  }

  const number = head + 1;
  const name = formatVersionName(number, padding);
  if (padding > 0 && name.length !== names[0].length) {
    throw new OcflError(
      `object ${inventory.id} cannot be extended: ${number} does not fit the ` +
        `zero-padded naming convention established by ${names[0]}`,
      { code: "E011" },
    );
  }
  return { name, number };
}
