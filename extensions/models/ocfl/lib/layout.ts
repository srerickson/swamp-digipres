/**
 * Storage layout resolution: mapping object ids to paths under the storage
 * root (§4.2, §4.3).
 *
 * Implements `0004-hashed-n-tuple-storage-layout`. When no layout is declared
 * or the declared one is unknown, callers fall back to
 * {@link scanObjectRoots}, which walks the hierarchy for object conformance
 * declarations.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { OcflError } from "./errors.ts";
import { digestBytes, isDigestAlgorithmSupported } from "./digest.ts";

/** Filename of the storage root layout declaration (§4.2). */
export const LAYOUT_FILENAME = "ocfl_layout.json";

/** Directory holding storage root extension configurations. */
export const EXTENSIONS_DIRNAME = "extensions";

/** Name of the one storage layout extension implemented here. */
export const HASHED_N_TUPLE_LAYOUT = "0004-hashed-n-tuple-storage-layout";

/**
 * A deterministic mapping from object id to a storage-root-relative path
 * (E083).
 */
export interface StorageLayout {
  /** Registered extension name of the layout. */
  name: string;
  /** Map an object id to its object root path, relative to the storage root. */
  resolve(id: string): string;
}

/** `ocfl_layout.json` contents (E070, E071). */
const LayoutDeclarationSchema = z.object({
  extension: z.string().min(1),
  description: z.string().optional(),
});

/** Configuration for `0004-hashed-n-tuple-storage-layout`. */
const HashedNTupleConfigSchema = z.object({
  extensionName: z.literal(HASHED_N_TUPLE_LAYOUT),
  digestAlgorithm: z.string().default("sha256"),
  tupleSize: z.number().int().min(0).max(32).default(3),
  numberOfTuples: z.number().int().min(0).max(32).default(3),
  shortObjectRoot: z.boolean().default(false),
});

/** Parsed configuration for the hashed n-tuple layout. */
export type HashedNTupleConfig = z.infer<typeof HashedNTupleConfigSchema>;

/**
 * Build a `0004-hashed-n-tuple-storage-layout` mapping.
 *
 * The id is digested, the hex digest split into `numberOfTuples` tuples of
 * `tupleSize` characters forming the directory hierarchy, and the object
 * directory is the full digest (or the remainder after the tuples when
 * `shortObjectRoot` is set).
 */
export function hashedNTupleLayout(
  config: HashedNTupleConfig,
): StorageLayout {
  if (!isDigestAlgorithmSupported(config.digestAlgorithm)) {
    throw new OcflError(
      `storage layout uses unsupported digest algorithm: ${config.digestAlgorithm}`,
      { code: "E063" },
    );
  }
  const { tupleSize, numberOfTuples, shortObjectRoot } = config;
  if (tupleSize === 0 && numberOfTuples !== 0) {
    throw new OcflError(
      "hashed n-tuple layout: numberOfTuples must be 0 when tupleSize is 0",
    );
  }
  return {
    name: HASHED_N_TUPLE_LAYOUT,
    resolve(id: string): string {
      const digest = digestBytes(
        new TextEncoder().encode(id),
        config.digestAlgorithm,
      );
      const consumed = tupleSize * numberOfTuples;
      if (consumed > digest.length) {
        throw new OcflError(
          `hashed n-tuple layout: tupleSize*numberOfTuples (${consumed}) exceeds digest length (${digest.length})`,
        );
      }
      const tuples: string[] = [];
      for (let i = 0; i < numberOfTuples; i++) {
        tuples.push(digest.slice(i * tupleSize, (i + 1) * tupleSize));
      }
      const encapsulation = shortObjectRoot ? digest.slice(consumed) : digest;
      return [...tuples, encapsulation].filter((part) => part !== "").join("/");
    },
  };
}

/** Read a JSON file, returning `null` when it does not exist. */
async function readJsonOrNull(path: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return null;
    throw cause;
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new OcflError(
      `${path} is not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { path },
    );
  }
}

/** Result of inspecting a storage root's layout declaration. */
export interface LayoutResolution {
  /** The resolved layout, or `null` when none is declared or implemented. */
  layout: StorageLayout | null;
  /** The declared extension name, when `ocfl_layout.json` is present. */
  declaredExtension: string | null;
  /** Why no layout was resolved, for diagnostics. */
  reason: string | null;
}

/**
 * Resolve the storage layout for a root.
 *
 * A missing `ocfl_layout.json` is not an error — the layout is optional and
 * callers fall back to scanning. An unimplemented layout is likewise reported
 * rather than thrown, so `list` and `validate` still work on such roots.
 */
export async function loadLayout(root: string): Promise<LayoutResolution> {
  const declaration = await readJsonOrNull(`${root}/${LAYOUT_FILENAME}`);
  if (declaration === null) {
    return {
      layout: null,
      declaredExtension: null,
      reason: `no ${LAYOUT_FILENAME} in storage root`,
    };
  }

  const parsed = LayoutDeclarationSchema.safeParse(declaration);
  if (!parsed.success) {
    throw new OcflError(
      `${LAYOUT_FILENAME} must contain an "extension" key naming a storage layout extension`,
      { code: "E070", path: `${root}/${LAYOUT_FILENAME}` },
    );
  }
  const extension = parsed.data.extension;

  if (extension !== HASHED_N_TUPLE_LAYOUT) {
    return {
      layout: null,
      declaredExtension: extension,
      reason: `storage layout extension ${extension} is not implemented`,
    };
  }

  const configPath = `${root}/${EXTENSIONS_DIRNAME}/${extension}/config.json`;
  const rawConfig = await readJsonOrNull(configPath);
  const config = HashedNTupleConfigSchema.safeParse(
    rawConfig ?? { extensionName: extension },
  );
  if (!config.success) {
    throw new OcflError(
      `invalid ${extension} config: ${
        config.error.issues.map((i) => i.message).join("; ")
      }`,
      { path: configPath },
    );
  }

  return {
    layout: hashedNTupleLayout(config.data),
    declaredExtension: extension,
    reason: null,
  };
}

/** An object root discovered by scanning the storage hierarchy. */
export interface DiscoveredObject {
  /** Path relative to the storage root, using `/` separators. */
  relativePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
}

/**
 * Walk the storage hierarchy for object roots.
 *
 * Descent stops at any directory holding a `0=ocfl_object_*` declaration —
 * objects cannot contain other objects — and skips the storage root's own
 * `extensions/` directory.
 *
 * This doubles as the engine for `list` and for the validator's "find every
 * object" pass, so it works with or without a declared layout.
 */
export async function scanObjectRoots(
  root: string,
): Promise<DiscoveredObject[]> {
  const found: DiscoveredObject[] = [];

  async function walk(absolute: string, relative: string): Promise<void> {
    const subdirectories: string[] = [];
    let isObjectRoot = false;
    for await (const entry of Deno.readDir(absolute)) {
      if (entry.isFile && entry.name.startsWith("0=ocfl_object_")) {
        isObjectRoot = true;
      } else if (entry.isDirectory) {
        subdirectories.push(entry.name);
      }
    }

    if (isObjectRoot) {
      found.push({ relativePath: relative, absolutePath: absolute });
      return;
    }

    for (const name of subdirectories) {
      if (relative === "" && name === EXTENSIONS_DIRNAME) continue;
      await walk(
        `${absolute}/${name}`,
        relative === "" ? name : `${relative}/${name}`,
      );
    }
  }

  await walk(root, "");
  found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return found;
}
