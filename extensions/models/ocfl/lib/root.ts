/**
 * Storage root operations: open, initialize, and find the objects inside.
 *
 * @module
 */
import { OcflError } from "./errors.ts";
import {
  defaultLayoutConfig,
  type HashedNTupleConfig,
  type LoadedLayout,
  loadLayout,
  type SupportedLayout,
} from "./layout.ts";
import { readNamaste, writeNamaste } from "./namaste.ts";
import type { Storage } from "./storage/types.ts";
import { joinPath } from "./storage/types.ts";

/** Spec version new storage roots are created at. */
export const DEFAULT_SPEC_VERSION = "1.1";

/** An opened OCFL storage root. */
export type StorageRoot = {
  storage: Storage;
  /** Spec version from the root conformance declaration, e.g. `"1.1"`. */
  specVersion: string;
  layout: LoadedLayout;
};

/**
 * Open an existing storage root.
 *
 * @throws {OcflError} when there is no valid root conformance declaration.
 */
export async function openStorageRoot(storage: Storage): Promise<StorageRoot> {
  const namaste = await readNamaste(storage, "", "root");
  if (namaste === undefined) {
    throw new OcflError(
      `no OCFL storage root conformance declaration (0=ocfl_N.M) at ` +
        `${storage.location}`,
      { code: "E069" },
    );
  }
  return {
    storage,
    specVersion: namaste.version,
    layout: await loadLayout(storage),
  };
}

/** What {@linkcode initStorageRoot} did. */
export type InitResult = {
  root: StorageRoot;
  /** False when a conformant root already declared this layout. */
  created: boolean;
};

/**
 * Create a storage root, or accept one that already matches.
 *
 * Re-running with the same layout is a no-op so the method stays safe to
 * repeat; re-running against a root that declares a *different* layout throws,
 * because rewriting `ocfl_layout.json` would orphan every object already
 * stored under the old mapping.
 */
export async function initStorageRoot(
  storage: Storage,
  options: {
    layout: SupportedLayout;
    description?: string;
    layoutConfig?: Partial<HashedNTupleConfig>;
    specVersion?: string;
  },
): Promise<InitResult> {
  const specVersion = options.specVersion ?? DEFAULT_SPEC_VERSION;
  const existing = await readNamaste(storage, "", "root");

  if (existing !== undefined) {
    const current = await loadLayout(storage);
    if (current.declared !== null && current.declared !== options.layout) {
      throw new OcflError(
        `storage root at ${storage.location} already declares layout ` +
          `${current.declared}; refusing to replace it with ${options.layout}`,
        { code: "E070" },
      );
    }
    if (current.declared === options.layout) {
      return {
        root: { storage, specVersion: existing.version, layout: current },
        created: false,
      };
    }
    // Declaration present but no layout: fill in the missing layout files.
  } else {
    // A non-empty directory that is not a storage root is almost certainly a
    // mistake — writing a declaration into it would claim someone else's data.
    const entries = await storage.listDir("");
    if (entries.length > 0) {
      throw new OcflError(
        `${storage.location} is not empty and has no OCFL conformance ` +
          `declaration; refusing to initialize it as a storage root`,
        { code: "E069" },
      );
    }
    await writeNamaste(storage, "", "root", specVersion);
  }

  const encoder = new TextEncoder();
  const config = defaultLayoutConfig(options.layout, options.layoutConfig);
  await storage.write(
    "ocfl_layout.json",
    encoder.encode(
      `${
        JSON.stringify(
          {
            extension: options.layout,
            description: options.description ??
              `OCFL storage root using ${options.layout}`,
          },
          null,
          2,
        )
      }\n`,
    ),
  );
  await storage.write(
    joinPath("extensions", options.layout, "config.json"),
    encoder.encode(`${JSON.stringify(config, null, 2)}\n`),
  );

  return { root: await openStorageRoot(storage), created: true };
}

/**
 * Find every object root in the storage root.
 *
 * Object roots are located by their conformance declaration rather than by the
 * layout, because the layout only maps a *known* id to a path — it cannot
 * enumerate. Returns paths relative to the storage root, sorted.
 */
export async function findObjectRoots(root: StorageRoot): Promise<string[]> {
  const paths = new Set<string>();
  for await (const filePath of root.storage.walkFiles("")) {
    const slash = filePath.lastIndexOf("/");
    const dir = slash === -1 ? "" : filePath.slice(0, slash);
    const name = slash === -1 ? filePath : filePath.slice(slash + 1);

    // The storage root's own extensions directory holds layout configs, never
    // objects; skipping it also avoids matching an extension's sample files.
    if (dir === "extensions" || dir.startsWith("extensions/")) continue;
    if (!/^0=ocfl_object_\d+\.\d+$/.test(name)) continue;
    if (dir === "") continue; // an object root cannot be the storage root
    paths.add(dir);
  }
  return [...paths].sort();
}

/**
 * Verify that `dir` holds a valid object conformance declaration.
 *
 * @throws {OcflError} when absent or malformed.
 */
export async function requireObjectDeclaration(
  storage: Storage,
  dir: string,
): Promise<string> {
  const namaste = await readNamaste(storage, dir, "object");
  if (namaste === undefined) {
    throw new OcflError(
      `no OCFL object conformance declaration (0=ocfl_object_N.M) at ${dir}`,
      { code: "E001", path: dir },
    );
  }
  return namaste.version;
}
