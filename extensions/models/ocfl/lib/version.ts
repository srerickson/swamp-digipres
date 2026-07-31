/**
 * Version directory naming: parsing, ordering, and convention detection
 * (§3.3, E008–E013, E104).
 *
 * An object's naming convention — zero-padded or not, and at what width — is
 * fixed by `v1` and must be preserved by every later version, so both the
 * validator and the commit writer read it from the object rather than assuming
 * one.
 *
 * @module
 */
import { OcflError } from "./errors.ts";
import { VERSION_NAME_PATTERN } from "./types.ts";

/** A parsed version directory name. */
export interface ParsedVersion {
  /** The name as written, e.g. `"v0002"`. */
  name: string;
  /** The version number, e.g. `2`. */
  number: number;
  /**
   * Total width of the digit portion when zero-padded, or `0` when not padded.
   * `"v1"` gives `0`; `"v0002"` gives `4`.
   */
  padding: number;
}

/**
 * Parse a version directory name.
 *
 * @returns The parsed version, or `null` when the name is not `v` followed by
 * digits (E104) or numbers zero (E009).
 */
export function parseVersionName(name: string): ParsedVersion | null {
  if (!VERSION_NAME_PATTERN.test(name)) return null;
  const digits = name.slice(1);
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const padding = digits.startsWith("0") ? digits.length : 0;
  return { name, number, padding };
}

/** Parse a version name, throwing when it is malformed. */
export function requireVersionName(name: string): ParsedVersion {
  const parsed = parseVersionName(name);
  if (parsed === null) {
    throw new OcflError(
      `invalid version directory name: ${JSON.stringify(name)}`,
      { code: "E104" },
    );
  }
  return parsed;
}

/** Format a version number using an object's padding convention. */
export function formatVersionName(number: number, padding: number): string {
  if (padding === 0) return `v${number}`;
  return `v${String(number).padStart(padding, "0")}`;
}

/**
 * Compute the next version name for an object, preserving its convention.
 *
 * @throws OcflError when the next number would overflow a padded width — a
 * padded object has a hard ceiling (E011) and must not silently widen.
 */
export function nextVersionName(head: string): string {
  const parsed = requireVersionName(head);
  const next = parsed.number + 1;
  if (parsed.padding > 0 && String(next).length > parsed.padding - 1) {
    throw new OcflError(
      `object uses ${parsed.padding}-digit zero-padded version names and cannot represent v${next}`,
      { code: "E011" },
    );
  }
  return formatVersionName(next, parsed.padding);
}

/** Sort version names in ascending numeric order. */
export function sortVersionNames(names: readonly string[]): string[] {
  return [...names].sort((a, b) => {
    const left = parseVersionName(a);
    const right = parseVersionName(b);
    if (left === null || right === null) return a.localeCompare(b);
    return left.number - right.number;
  });
}
