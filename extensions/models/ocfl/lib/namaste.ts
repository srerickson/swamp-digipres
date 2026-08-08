/**
 * OCFL conformance declarations ("namaste" files).
 *
 * A storage root carries `0=ocfl_N.M` and an object root carries
 * `0=ocfl_object_N.M`; both must contain exactly `dvalue\n` — the filename
 * without the leading `0=` (§4.1, §3.1; E003–E007, E076–E080).
 *
 * @module
 */
import { OcflError } from "./errors.ts";
import type { Entry, Storage } from "./storage/types.ts";
import { joinPath } from "./storage/types.ts";

/** Which kind of root a declaration describes. */
export type NamasteKind = "root" | "object";

/** A parsed conformance declaration. */
export type Namaste = {
  kind: NamasteKind;
  /** Spec version the root declares, e.g. `"1.1"`. */
  version: string;
  /** Declaration filename, e.g. `"0=ocfl_object_1.1"`. */
  filename: string;
};

const ROOT_PATTERN = /^0=ocfl_(\d+\.\d+)$/;
const OBJECT_PATTERN = /^0=ocfl_object_(\d+\.\d+)$/;

/** The `dvalue` a declaration of this kind and version must contain. */
export function namasteValue(kind: NamasteKind, version: string): string {
  return kind === "root" ? `ocfl_${version}` : `ocfl_object_${version}`;
}

/** The filename a declaration of this kind and version must use. */
export function namasteFilename(kind: NamasteKind, version: string): string {
  return `0=${namasteValue(kind, version)}`;
}

/**
 * Find the declaration among a directory's entries, without reading it.
 *
 * Returns `undefined` when there is none. More than one is a hard error: the
 * root's declared version would be ambiguous (E003, E076).
 */
export function findNamaste(
  entries: Entry[],
  kind: NamasteKind,
  dir: string,
): Namaste | undefined {
  const pattern = kind === "root" ? ROOT_PATTERN : OBJECT_PATTERN;
  const matches = entries
    .filter((entry) => entry.type === "file")
    .flatMap((entry) => {
      const match = entry.name.match(pattern);
      if (match === null) return [];
      return [{ kind, version: match[1], filename: entry.name }];
    });

  if (matches.length > 1) {
    throw new OcflError(
      `found ${matches.length} OCFL conformance declarations; expected exactly one`,
      { code: kind === "root" ? "E076" : "E003", path: dir },
    );
  }
  return matches[0];
}

/**
 * Read and verify the conformance declaration in `dir`.
 *
 * Returns `undefined` when no declaration is present — callers decide whether
 * that is an error (reading an object) or expected (initializing a root).
 *
 * @throws {OcflError} when a declaration exists but its contents are wrong.
 */
export async function readNamaste(
  storage: Storage,
  dir: string,
  kind: NamasteKind,
): Promise<Namaste | undefined> {
  const namaste = findNamaste(await storage.listDir(dir), kind, dir);
  if (namaste === undefined) return undefined;

  const path = joinPath(dir, namaste.filename);
  const contents = new TextDecoder().decode(await storage.read(path));
  const expected = `${namasteValue(kind, namaste.version)}\n`;
  if (contents !== expected) {
    throw new OcflError(
      `conformance declaration contents ${JSON.stringify(contents)} do not ` +
        `match its filename; expected ${JSON.stringify(expected)}`,
      { code: kind === "root" ? "E080" : "E007", path },
    );
  }
  return namaste;
}

/**
 * Read the declaration in `dir`, failing when there is none.
 *
 * @throws {OcflError} when absent or malformed.
 */
export async function requireNamaste(
  storage: Storage,
  dir: string,
  kind: NamasteKind,
): Promise<Namaste> {
  const namaste = await readNamaste(storage, dir, kind);
  if (namaste === undefined) {
    throw new OcflError(
      kind === "root"
        ? "no OCFL storage root conformance declaration (0=ocfl_N.M) found"
        : "no OCFL object conformance declaration (0=ocfl_object_N.M) found",
      { code: kind === "root" ? "E069" : "E001", path: dir || "." },
    );
  }
  return namaste;
}

/** Write a conformance declaration into `dir`. */
export async function writeNamaste(
  storage: Storage,
  dir: string,
  kind: NamasteKind,
  version: string,
): Promise<string> {
  const filename = namasteFilename(kind, version);
  await storage.write(
    joinPath(dir, filename),
    new TextEncoder().encode(`${namasteValue(kind, version)}\n`),
  );
  return filename;
}
