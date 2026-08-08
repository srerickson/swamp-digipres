/**
 * Storage layouts: the deterministic id → object-root-path mapping (§4.2, E083).
 *
 * Supports the two registered extensions this repository uses:
 * `0004-hashed-n-tuple-storage-layout` and `0002-flat-direct-storage-layout`.
 * A root declaring anything else still lists and reads — it just falls back to
 * scanning for object roots instead of computing paths.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { digestText, isSupportedAlgorithm } from "./digest.ts";
import { isNotFound, OcflError } from "./errors.ts";
import type { Storage } from "./storage/types.ts";

/** Registered name of the hashed n-tuple layout. */
export const HASHED_N_TUPLE = "0004-hashed-n-tuple-storage-layout";
/** Registered name of the flat direct layout. */
export const FLAT_DIRECT = "0002-flat-direct-storage-layout";

/** Layout extensions this implementation can compute paths for. */
export const SUPPORTED_LAYOUTS = [HASHED_N_TUPLE, FLAT_DIRECT] as const;

/** A layout extension name this implementation can compute paths for. */
export type SupportedLayout = typeof SUPPORTED_LAYOUTS[number];

/** Maps object ids to their storage paths. */
export interface StorageLayout {
  /** Registered extension name. */
  readonly name: string;
  /** Object root path for `id`, relative to the storage root. */
  resolve(id: string): string;
}

/** `ocfl_layout.json` at the storage root (§4.3). */
export const LayoutDeclarationSchema = z.object({
  extension: z.string(),
  description: z.string().optional(),
}).loose();

/** Config for `0004-hashed-n-tuple-storage-layout`. */
export const HashedNTupleConfigSchema = z.object({
  extensionName: z.literal(HASHED_N_TUPLE).default(HASHED_N_TUPLE),
  digestAlgorithm: z.string().default("sha256"),
  tupleSize: z.number().int().min(0).max(32).default(3),
  numberOfTuples: z.number().int().min(0).max(32).default(3),
  shortObjectRoot: z.boolean().default(false),
}).loose();

/** Config for `0002-flat-direct-storage-layout`. */
export const FlatDirectConfigSchema = z.object({
  extensionName: z.literal(FLAT_DIRECT).default(FLAT_DIRECT),
}).loose();

/** Parsed hashed n-tuple configuration. */
export type HashedNTupleConfig = z.infer<typeof HashedNTupleConfigSchema>;

/**
 * The hashed n-tuple layout.
 *
 * The id is digested, then the hex digest's leading characters are split into
 * `numberOfTuples` directory names of `tupleSize` characters each. The object
 * root is the full digest, or the digest with those leading characters removed
 * when `shortObjectRoot` is set.
 */
export class HashedNTupleLayout implements StorageLayout {
  readonly name = HASHED_N_TUPLE;
  readonly config: HashedNTupleConfig;

  constructor(config: HashedNTupleConfig) {
    if (!isSupportedAlgorithm(config.digestAlgorithm)) {
      throw new OcflError(
        `layout ${HASHED_N_TUPLE} uses unsupported digest algorithm ` +
          `${config.digestAlgorithm}`,
        { code: "E063" },
      );
    }
    this.config = config;
  }

  resolve(id: string): string {
    const { tupleSize, numberOfTuples, shortObjectRoot } = this.config;
    const digest = digestText(id, this.config.digestAlgorithm);

    const consumed = tupleSize * numberOfTuples;
    if (consumed > digest.length) {
      throw new OcflError(
        `layout ${HASHED_N_TUPLE} needs ${consumed} digest characters but ` +
          `${this.config.digestAlgorithm} produces only ${digest.length}`,
      );
    }

    // The extension requires shortObjectRoot to be false when the tuples
    // consume the whole digest — otherwise the object root name is empty.
    if (shortObjectRoot && consumed === digest.length) {
      throw new OcflError(
        `layout ${HASHED_N_TUPLE} sets shortObjectRoot but its tuples consume ` +
          `the entire ${digest.length}-character digest, leaving no remainder`,
      );
    }

    const tuples: string[] = [];
    for (let i = 0; i < numberOfTuples; i++) {
      tuples.push(digest.slice(i * tupleSize, (i + 1) * tupleSize));
    }
    const leaf = shortObjectRoot ? digest.slice(consumed) : digest;
    return [...tuples, leaf].filter((segment) => segment.length > 0).join("/");
  }
}

/**
 * The flat direct layout: the object root is the id, used without any change.
 *
 * The extension's limitations are filesystem-dependent rather than a fixed
 * character set — its own example maps `..hor_rib:lé-$id` unchanged — so only
 * ids that could not round-trip as a single path segment are rejected.
 */
export class FlatDirectLayout implements StorageLayout {
  readonly name = FLAT_DIRECT;

  resolve(id: string): string {
    if (id.length === 0 || id.length > 255) {
      throw new OcflError(
        `layout ${FLAT_DIRECT} requires ids of 1–255 characters; ` +
          `${JSON.stringify(id)} has ${id.length}`,
        { code: "E083" },
      );
    }
    if (id.includes("/") || id.includes("\\") || id === "." || id === "..") {
      throw new OcflError(
        `layout ${FLAT_DIRECT} cannot represent id ${
          JSON.stringify(id)
        } as a ` +
          `single directory name`,
        { code: "E083" },
      );
    }
    return id;
  }
}

/** A storage root's declared layout, and whether we can compute paths for it. */
export type LoadedLayout = {
  /** Extension name from `ocfl_layout.json`, or `null` when undeclared. */
  declared: string | null;
  /** Description from `ocfl_layout.json`, when present. */
  description: string | undefined;
  /** Resolver, or `undefined` when the layout is undeclared or unsupported. */
  layout: StorageLayout | undefined;
};

/**
 * Load the storage root's layout.
 *
 * A missing or unsupported layout is not an error: `list` falls back to
 * scanning for object roots, and `get` compares ids against that scan. Only a
 * declared-and-supported layout whose own config is broken throws.
 */
export async function loadLayout(storage: Storage): Promise<LoadedLayout> {
  let bytes: Uint8Array;
  try {
    bytes = await storage.read("ocfl_layout.json");
  } catch (error) {
    // Only a genuinely absent file means "no declared layout" (§4.3 is a
    // SHOULD). Anything else — an S3 outage, a permissions failure — must
    // surface, or a transient error would silently downgrade the root to an
    // unindexed scan.
    if (!isNotFound(error)) throw error;
    return { declared: null, description: undefined, layout: undefined };
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new OcflError("ocfl_layout.json is not well-formed JSON", {
      code: "E070",
      path: "ocfl_layout.json",
      cause: error,
    });
  }

  const parsed = LayoutDeclarationSchema.safeParse(json);
  if (!parsed.success) {
    throw new OcflError("ocfl_layout.json is missing an 'extension' key", {
      code: "E070",
      path: "ocfl_layout.json",
    });
  }
  const declaration = parsed.data;

  const name = declaration.extension;
  const configPath = `extensions/${name}/config.json`;
  let rawConfig: unknown = {};
  try {
    rawConfig = JSON.parse(
      new TextDecoder().decode(await storage.read(configPath)),
    );
  } catch (error) {
    // The config file itself is optional — both supported layouts have usable
    // defaults — but a config that exists and cannot be read or parsed would
    // silently change every object's path, so it is fatal.
    if (!isNotFound(error)) {
      throw new OcflError(
        `layout config exists but could not be read: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        { path: configPath, cause: error },
      );
    }
  }

  if (name === HASHED_N_TUPLE) {
    const config = HashedNTupleConfigSchema.safeParse(rawConfig);
    if (!config.success) {
      throw new OcflError(
        `layout config is invalid: ${
          config.error.issues.map((i) => i.message)
            .join("; ")
        }`,
        { path: configPath },
      );
    }
    return {
      declared: name,
      description: declaration.description,
      layout: new HashedNTupleLayout(config.data),
    };
  }

  if (name === FLAT_DIRECT) {
    return {
      declared: name,
      description: declaration.description,
      layout: new FlatDirectLayout(),
    };
  }

  return {
    declared: name,
    description: declaration.description,
    layout: undefined,
  };
}

/** Default config for a layout, used when initializing a storage root. */
export function defaultLayoutConfig(
  name: SupportedLayout,
  overrides: Partial<HashedNTupleConfig> = {},
): Record<string, unknown> {
  if (name === HASHED_N_TUPLE) {
    return HashedNTupleConfigSchema.parse({
      extensionName: HASHED_N_TUPLE,
      ...overrides,
    });
  }
  return FlatDirectConfigSchema.parse({ extensionName: FLAT_DIRECT });
}
