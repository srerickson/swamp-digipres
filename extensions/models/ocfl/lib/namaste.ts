/**
 * NAMASTE conformance declaration handling for storage roots and object roots.
 *
 * A storage root declares `0=ocfl_1.1` containing `ocfl_1.1\n`; an object root
 * declares `0=ocfl_object_1.1` containing `ocfl_object_1.1\n` (§3.1, §4.1).
 *
 * @module
 */
import type { StorageBackend } from "./backend/backend.ts";
import { joinKey, readText } from "./backend/backend.ts";
import type { ValidationIssue } from "./errors.ts";
import { error, OcflError } from "./errors.ts";
import { joinOcflPath } from "./paths.ts";

/** Which kind of root a declaration describes. */
export type NamasteKind = "root" | "object";

/** A parsed NAMASTE conformance declaration. */
export interface Namaste {
  /** Whether the declaration is for a storage root or an object root. */
  kind: NamasteKind;
  /** Declared OCFL specification version, e.g. `"1.1"`. */
  version: string;
  /** The declaration filename, e.g. `"0=ocfl_object_1.1"`. */
  filename: string;
}

/** Filename prefix for each declaration kind. */
const PREFIX: Record<NamasteKind, string> = {
  root: "0=ocfl_",
  object: "0=ocfl_object_",
};

/** Validation codes for each declaration kind. */
const CODES: Record<
  NamasteKind,
  { missing: string; multiple: string; content: string }
> = {
  root: { missing: "E069", multiple: "E076", content: "E080" },
  object: { missing: "E003", multiple: "E003", content: "E007" },
};

/** Build the declaration filename for a kind and spec version. */
export function namasteFilename(kind: NamasteKind, version: string): string {
  return `${PREFIX[kind]}${version}`;
}

/** Build the required file contents for a declaration (dvalue plus newline). */
export function namasteContent(kind: NamasteKind, version: string): string {
  return `${namasteFilename(kind, version).slice(2)}\n`;
}

/**
 * Find declaration filenames of a given kind in an already-listed directory.
 *
 * A storage-root declaration prefix (`0=ocfl_`) also matches object
 * declarations (`0=ocfl_object_`), so root matches exclude those explicitly.
 */
function matchDeclarations(entries: readonly string[], kind: NamasteKind) {
  return entries.filter((name) => {
    if (!name.startsWith(PREFIX[kind])) return false;
    if (kind === "root" && name.startsWith(PREFIX.object)) return false;
    return true;
  });
}

/**
 * Read and verify the NAMASTE declaration in a directory, collecting issues
 * rather than throwing.
 *
 * @param key Storage-root-relative key of the directory; `""` for the root.
 * @returns The parsed declaration (`null` when missing or malformed) alongside
 * every issue found.
 */
export async function checkNamaste(
  backend: StorageBackend,
  key: string,
  kind: NamasteKind,
  location: string,
): Promise<{ namaste: Namaste | null; issues: ValidationIssue[] }> {
  const codes = CODES[kind];
  const entries = await backend.list(key);
  if (entries === null) {
    return {
      namaste: null,
      issues: [
        error(
          codes.missing,
          location,
          `directory not found: ${joinKey(backend.url, key)}`,
        ),
      ],
    };
  }

  const matches = matchDeclarations(
    entries.filter((entry) => entry.kind === "file").map((entry) => entry.name),
    kind,
  );
  if (matches.length === 0) {
    return {
      namaste: null,
      issues: [
        error(
          codes.missing,
          location,
          `missing ${kind} conformance declaration (${PREFIX[kind]}<version>)`,
        ),
      ],
    };
  }
  if (matches.length > 1) {
    return {
      namaste: null,
      issues: [
        error(
          codes.multiple,
          location,
          `expected exactly one conformance declaration, found ${matches.length}: ${
            matches.join(", ")
          }`,
        ),
      ],
    };
  }

  const filename = matches[0];
  const version = filename.slice(PREFIX[kind].length);
  const issues: ValidationIssue[] = [];
  if (!/^\d+\.\d+$/.test(version)) {
    issues.push(
      error(
        kind === "root" ? "E079" : "E006",
        joinOcflPath(location, filename),
        `declaration version is not a valid spec version: ${
          JSON.stringify(version)
        }`,
      ),
    );
    return { namaste: null, issues };
  }

  const expected = namasteContent(kind, version);
  const actual = await readText(backend, joinKey(key, filename));
  if (actual !== expected) {
    issues.push(
      error(
        codes.content,
        joinOcflPath(location, filename),
        `declaration content must be ${JSON.stringify(expected)}, found ${
          JSON.stringify(actual)
        }`,
      ),
    );
  }

  return { namaste: { kind, version, filename }, issues };
}

/**
 * Read a NAMASTE declaration, throwing on any problem.
 *
 * Used on read paths where a malformed declaration means the caller cannot
 * proceed at all; the validator uses {@link checkNamaste} instead.
 */
export async function readNamaste(
  backend: StorageBackend,
  key: string,
  kind: NamasteKind,
): Promise<Namaste> {
  const where = joinKey(backend.url, key);
  const { namaste, issues } = await checkNamaste(backend, key, kind, where);
  if (namaste === null || issues.length > 0) {
    const issue = issues[0];
    throw new OcflError(
      issue?.message ?? `invalid ${kind} conformance declaration in ${where}`,
      { code: issue?.code, path: where },
    );
  }
  return namaste;
}

/** Write a conformance declaration into a directory. */
export async function writeNamaste(
  backend: StorageBackend,
  key: string,
  kind: NamasteKind,
  version: string,
): Promise<void> {
  await backend.write(
    joinKey(key, namasteFilename(kind, version)),
    new TextEncoder().encode(namasteContent(kind, version)),
  );
}
