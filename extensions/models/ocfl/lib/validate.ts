/**
 * OCFL 1.1 object and storage root validation.
 *
 * Two tiers, ordered cheapest first:
 *
 * - **Structural** — declarations, inventory syntax, sidecars, version
 *   sequencing, path safety, manifest/state coherence, and on-disk agreement.
 * - **Full fixity** — recomputes the digest of every content file against its
 *   manifest key. Opt-in, because it reads every byte in the object.
 *
 * Checks accumulate {@link ValidationIssue}s instead of throwing, so a single
 * pass produces a complete report for an object.
 *
 * @module
 */
import type { StorageBackend } from "./backend/backend.ts";
import { joinKey } from "./backend/backend.ts";
import type { ValidationIssue } from "./errors.ts";
import { error, warning } from "./errors.ts";
import {
  digestStream,
  isDigestAlgorithmSupported,
  normalizeDigest,
} from "./digest.ts";
import { bytesEqual, checkInventory, INVENTORY_FILENAME } from "./inventory.ts";
import { checkNamaste } from "./namaste.ts";
import { scanObjectRoots } from "./layout.ts";
import {
  checkContentPathConflicts,
  checkLogicalPathConflicts,
  joinOcflPath,
  validateContentDirectory,
  validateContentPath,
  validateLogicalPath,
} from "./paths.ts";
import type { Inventory } from "./types.ts";
import { contentDirectoryOf, VERSION_NAME_PATTERN } from "./types.ts";
import { parseVersionName, sortVersionNames } from "./version.ts";

/** Options controlling a validation run. */
export interface ValidateOptions {
  /** Recompute every content file's digest against the manifest (expensive). */
  fullFixity?: boolean;
}

/** Result of validating one object. */
export interface ObjectValidationResult {
  /** Object id from its inventory, or `null` when unreadable. */
  id: string | null;
  /** Object root path relative to the storage root. */
  path: string;
  /** True when no error-severity issues were found. */
  valid: boolean;
  /** Error-severity issues. */
  errors: ValidationIssue[];
  /** Warning-severity issues. */
  warnings: ValidationIssue[];
  /**
   * True when the only error is a root inventory sidecar mismatch while the
   * head version's inventory is intact and matches the root inventory bytes.
   *
   * This is the crash window between writing the root `inventory.json` and its
   * sidecar: the object is recoverable by rewriting the sidecar, not corrupt.
   */
  recoverable: boolean;
}

/** Result of validating a whole storage root. */
export interface StorageRootValidationResult {
  /** Absolute path to the storage root. */
  storageRoot: string;
  /** ISO-8601 timestamp of the run. */
  checkedAt: string;
  /** Whether the full-fixity tier ran. */
  fullFixity: boolean;
  /** True when the root and every checked object are valid. */
  valid: boolean;
  /** Issues found at the storage root level, outside any object. */
  rootErrors: ValidationIssue[];
  /** Warnings found at the storage root level. */
  rootWarnings: ValidationIssue[];
  /** Per-object results. */
  objects: ObjectValidationResult[];
}

/** Directory entries split by kind. */
interface DirEntries {
  files: string[];
  directories: string[];
}

/**
 * List a directory-like key's immediate entries, split into files and
 * directories. A missing key lists as empty.
 */
async function listEntries(
  backend: StorageBackend,
  key: string,
): Promise<DirEntries> {
  const files: string[] = [];
  const directories: string[] = [];
  for (const entry of await backend.list(key) ?? []) {
    if (entry.kind === "dir") directories.push(entry.name);
    else files.push(entry.name);
  }
  files.sort();
  directories.sort();
  return { files, directories };
}

/**
 * Collect every file beneath a directory-like key, as paths relative to the
 * object root.
 *
 * Also reports empty directories (E024), which have no representation in an
 * inventory and are therefore forbidden inside a content directory. Backends
 * without directories never produce an empty listing, which is correct —
 * empty prefixes cannot exist there.
 */
async function collectFiles(
  backend: StorageBackend,
  key: string,
  prefix: string,
  issues: ValidationIssue[],
  emptyDirCode: string,
): Promise<string[]> {
  const collected: string[] = [];
  const { files, directories } = await listEntries(backend, key);
  if (files.length === 0 && directories.length === 0) {
    issues.push(
      error(emptyDirCode, prefix, "directory is empty"),
    );
    return collected;
  }
  for (const name of files) {
    collected.push(joinOcflPath(prefix, name));
  }
  for (const name of directories) {
    collected.push(
      ...await collectFiles(
        backend,
        joinKey(key, name),
        joinOcflPath(prefix, name),
        issues,
        emptyDirCode,
      ),
    );
  }
  return collected;
}

/** Check that digest keys are unique when compared case-insensitively. */
function checkDigestUniqueness(
  digests: readonly string[],
  code: string,
  location: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Map<string, string>();
  for (const digest of digests) {
    const key = normalizeDigest(digest);
    const previous = seen.get(key);
    if (previous !== undefined) {
      issues.push(
        error(
          code,
          location,
          `digest appears more than once regardless of case: ${previous} and ${digest}`,
        ),
      );
    } else {
      seen.set(key, digest);
    }
  }
  return issues;
}

/** Validate version naming and sequencing across an inventory's versions. */
function checkVersionSequence(
  inventory: Inventory,
  location: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const names = Object.keys(inventory.versions);

  if (names.length === 0) {
    issues.push(error("E008", location, "object has no versions"));
    return issues;
  }

  const parsed = [];
  for (const name of names) {
    const version = parseVersionName(name);
    if (version === null) {
      issues.push(
        error(
          "E104",
          location,
          `invalid version name ${
            JSON.stringify(name)
          }: must be "v" followed by a positive integer`,
        ),
      );
      continue;
    }
    parsed.push(version);
  }
  if (parsed.length !== names.length) return issues;

  const paddings = new Set(parsed.map((version) => version.padding));
  if (paddings.size > 1) {
    issues.push(
      error(
        "E013",
        location,
        `version names mix naming conventions: ${
          sortVersionNames(names).join(", ")
        }`,
      ),
    );
  } else if (parsed[0].padding > 0) {
    issues.push(
      warning(
        "W001",
        location,
        `version names are zero-padded (${
          parsed[0].padding
        } digits); non-padded names are recommended`,
      ),
    );
  }

  const numbers = parsed.map((version) => version.number).sort((a, b) => a - b);
  if (numbers[0] !== 1) {
    issues.push(
      error(
        "E009",
        location,
        `version sequence must start at v1, starts at v${numbers[0]}`,
      ),
    );
  }
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] !== numbers[i - 1] + 1) {
      issues.push(
        error(
          "E010",
          location,
          `version sequence is not continuous: v${
            numbers[i - 1]
          } is followed by v${numbers[i]}`,
        ),
      );
    }
  }

  const highest = sortVersionNames(names)[names.length - 1];
  if (inventory.head !== highest) {
    issues.push(
      error(
        "E040",
        location,
        `head is ${inventory.head} but the highest version is ${highest}`,
      ),
    );
  }

  return issues;
}

/** Validate the manifest block's paths, digests, and state references. */
function checkManifest(
  inventory: Inventory,
  location: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const manifestEntries = Object.entries(inventory.manifest);

  issues.push(
    ...checkDigestUniqueness(
      manifestEntries.map(([digest]) => digest),
      "E096",
      location,
    ),
  );

  const allContentPaths: string[] = [];
  for (const [, contentPaths] of manifestEntries) {
    for (const contentPath of contentPaths) {
      allContentPaths.push(contentPath);
      issues.push(...validateContentPath(contentPath, location));
    }
  }
  issues.push(...checkContentPathConflicts(allContentPaths, location));

  // Every manifest digest must be referenced by some version's state (E107).
  const referenced = new Set<string>();
  for (const version of Object.values(inventory.versions)) {
    for (const digest of Object.keys(version.state)) {
      referenced.add(normalizeDigest(digest));
    }
  }
  for (const [digest] of manifestEntries) {
    if (!referenced.has(normalizeDigest(digest))) {
      issues.push(
        error(
          "E107",
          location,
          `manifest digest ${digest} is not referenced by any version state`,
        ),
      );
    }
  }

  if (inventory.fixity !== undefined) {
    for (const [algorithm, block] of Object.entries(inventory.fixity)) {
      issues.push(
        ...checkDigestUniqueness(
          Object.keys(block),
          "E097",
          `${location} fixity.${algorithm}`,
        ),
      );
    }
  }

  return issues;
}

/** Validate every version block's state, paths, and provenance metadata. */
function checkVersionBlocks(
  inventory: Inventory,
  location: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const manifestDigests = new Set(
    Object.keys(inventory.manifest).map(normalizeDigest),
  );

  for (const versionName of sortVersionNames(Object.keys(inventory.versions))) {
    const version = inventory.versions[versionName];
    const where = `${location} ${versionName}`;

    const logicalPaths: string[] = [];
    for (const [digest, paths] of Object.entries(version.state)) {
      if (!manifestDigests.has(normalizeDigest(digest))) {
        issues.push(
          error(
            "E050",
            where,
            `state digest ${digest} does not appear in the manifest`,
          ),
        );
      }
      for (const path of paths) {
        logicalPaths.push(path);
        issues.push(...validateLogicalPath(path, where));
      }
    }
    issues.push(...checkLogicalPathConflicts(logicalPaths, where));
    issues.push(
      ...checkDigestUniqueness(Object.keys(version.state), "E096", where),
    );

    if (version.message === undefined || version.user === undefined) {
      issues.push(
        warning(
          "W007",
          where,
          "version should include both a message and a user",
        ),
      );
    }
    if (version.user !== undefined && version.user.address === undefined) {
      issues.push(warning("W008", where, "user should include an address"));
    } else if (
      version.user?.address !== undefined &&
      !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(version.user.address)
    ) {
      issues.push(
        warning(
          "W009",
          where,
          `user address should be a URI, ideally mailto: or an ORCID: ${
            JSON.stringify(version.user.address)
          }`,
        ),
      );
    }
  }

  return issues;
}

/**
 * Compare a prior version's inventory against the root inventory.
 *
 * Prior version blocks must describe the same logical state (E066), and their
 * provenance metadata should be unchanged too (W011).
 */
function checkPriorInventoryAgreement(
  root: Inventory,
  prior: Inventory,
  priorVersionName: string,
  location: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (prior.id !== root.id) {
    issues.push(
      error(
        "E037",
        location,
        `inventory id ${
          JSON.stringify(prior.id)
        } differs from the root inventory's ${JSON.stringify(root.id)}`,
      ),
    );
  }

  for (const [versionName, priorVersion] of Object.entries(prior.versions)) {
    const rootVersion = root.versions[versionName];
    if (rootVersion === undefined) {
      issues.push(
        error(
          "E066",
          location,
          `${priorVersionName} inventory describes version ${versionName}, which the root inventory does not`,
        ),
      );
      continue;
    }
    if (!statesEqual(priorVersion.state, rootVersion.state)) {
      issues.push(
        error(
          "E066",
          location,
          `version ${versionName} state differs from the root inventory's`,
        ),
      );
    }
    if (
      priorVersion.created !== rootVersion.created ||
      priorVersion.message !== rootVersion.message ||
      priorVersion.user?.name !== rootVersion.user?.name ||
      priorVersion.user?.address !== rootVersion.user?.address
    ) {
      issues.push(
        warning(
          "W011",
          location,
          `version ${versionName} metadata differs from the root inventory's`,
        ),
      );
    }
  }

  return issues;
}

/** Compare two state blocks for logical equality, ignoring digest case. */
function statesEqual(
  a: Record<string, string[]>,
  b: Record<string, string[]>,
): boolean {
  const normalize = (state: Record<string, string[]>) => {
    const map = new Map<string, string[]>();
    for (const [digest, paths] of Object.entries(state)) {
      map.set(normalizeDigest(digest), [...paths].sort());
    }
    return map;
  };
  const left = normalize(a);
  const right = normalize(b);
  if (left.size !== right.size) return false;
  for (const [digest, paths] of left) {
    const other = right.get(digest);
    if (other === undefined || other.length !== paths.length) return false;
    for (let i = 0; i < paths.length; i++) {
      if (paths[i] !== other[i]) return false;
    }
  }
  return true;
}

/**
 * Recompute every entry in the optional `fixity` block (§3.5.4, E093).
 *
 * Algorithms the runtime cannot compute are ignored rather than failed (E028),
 * since the fixity block may legitimately carry algorithms from a migrated
 * repository that this client does not implement.
 */
async function checkFixityBlock(
  backend: StorageBackend,
  inventory: Inventory,
  objectKey: string,
  location: string,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];
  if (inventory.fixity === undefined) return issues;

  for (const [algorithm, block] of Object.entries(inventory.fixity)) {
    if (!isDigestAlgorithmSupported(algorithm)) {
      issues.push(
        warning(
          "W004",
          location,
          `fixity algorithm ${algorithm} is not supported by this client and was not verified`,
        ),
      );
      continue;
    }
    for (const [digest, contentPaths] of Object.entries(block)) {
      for (const contentPath of contentPaths) {
        const fileKey = joinKey(objectKey, contentPath);
        if (!(await backend.exists(fileKey))) {
          issues.push(
            error(
              "E093",
              joinOcflPath(location, contentPath),
              `fixity block references a content path that does not exist on disk (${algorithm})`,
            ),
          );
          continue;
        }
        const actual = await digestStream(
          await backend.readStream(fileKey),
          algorithm,
        );
        if (actual !== normalizeDigest(digest)) {
          issues.push(
            error(
              "E093",
              joinOcflPath(location, contentPath),
              `fixity ${algorithm} digest mismatch: block states ${digest}, file digests to ${actual}`,
            ),
          );
        }
      }
    }
  }
  return issues;
}

/**
 * Validate a single OCFL object root.
 *
 * @param relativePath Object root key relative to the storage root, used both
 * to address the object and in reporting.
 */
export async function validateObject(
  backend: StorageBackend,
  relativePath: string,
  options: ValidateOptions = {},
): Promise<ObjectValidationResult> {
  const issues: ValidationIssue[] = [];
  const objectKey = relativePath;
  const location = relativePath === "" ? "." : relativePath;

  const namaste = await checkNamaste(backend, objectKey, "object", location);
  issues.push(...namaste.issues);

  const rootInventory = await checkInventory(backend, objectKey, location);
  issues.push(...rootInventory.issues);

  const inventory = rootInventory.loaded?.inventory ?? null;
  if (inventory === null) {
    return finish(null, location, issues, false);
  }

  if (inventory.contentDirectory !== undefined) {
    issues.push(
      ...validateContentDirectory(
        inventory.contentDirectory,
        joinOcflPath(location, INVENTORY_FILENAME),
      ),
    );
  }
  const contentDirectory = contentDirectoryOf(inventory);

  issues.push(...checkVersionSequence(inventory, location));
  issues.push(...checkManifest(inventory, location));
  issues.push(...checkVersionBlocks(inventory, location));

  // Object root contents: only the declaration, inventory pair, version
  // directories, and the reserved `logs`/`extensions` directories (E001).
  const rootEntries = await listEntries(backend, objectKey);
  for (const name of rootEntries.files) {
    const allowed = name === namaste.namaste?.filename ||
      name === INVENTORY_FILENAME ||
      name.startsWith(`${INVENTORY_FILENAME}.`);
    if (!allowed) {
      issues.push(
        error(
          "E001",
          joinOcflPath(location, name),
          "unexpected file in object root",
        ),
      );
    }
  }
  const versionDirsOnDisk = rootEntries.directories.filter((name) =>
    VERSION_NAME_PATTERN.test(name)
  );
  for (const name of rootEntries.directories) {
    if (VERSION_NAME_PATTERN.test(name)) continue;
    if (name === "logs" || name === "extensions") continue;
    issues.push(
      error(
        "E001",
        joinOcflPath(location, name),
        "unexpected directory in object root",
      ),
    );
  }

  // Version directories on disk and in the inventory must agree (E046).
  const inventoryVersions = new Set(Object.keys(inventory.versions));
  for (const name of versionDirsOnDisk) {
    if (!inventoryVersions.has(name)) {
      issues.push(
        error(
          "E046",
          joinOcflPath(location, name),
          "version directory is not listed in the inventory's versions block",
        ),
      );
    }
  }
  for (const name of inventoryVersions) {
    if (!versionDirsOnDisk.includes(name)) {
      issues.push(
        error(
          "E046",
          location,
          `inventory lists version ${name}, which has no directory on disk`,
        ),
      );
    }
  }

  // Per version directory: allowed children, prior inventory agreement, and
  // the set of content files actually present.
  const contentFilesOnDisk: string[] = [];
  let headInventoryBytes: Uint8Array | null = null;
  let headInventoryVerified = false;

  for (const versionName of sortVersionNames(versionDirsOnDisk)) {
    const versionKey = joinKey(objectKey, versionName);
    const versionLocation = joinOcflPath(location, versionName);
    const entries = await listEntries(backend, versionKey);

    for (const name of entries.files) {
      if (
        name === INVENTORY_FILENAME || name.startsWith(`${INVENTORY_FILENAME}.`)
      ) continue;
      issues.push(
        error(
          "E015",
          joinOcflPath(versionLocation, name),
          "unexpected file in version directory",
        ),
      );
    }
    for (const name of entries.directories) {
      if (name === contentDirectory) continue;
      issues.push(
        warning(
          "W002",
          joinOcflPath(versionLocation, name),
          "version directory should not contain directories other than the content directory",
        ),
      );
    }

    if (entries.directories.includes(contentDirectory)) {
      contentFilesOnDisk.push(
        ...await collectFiles(
          backend,
          joinKey(versionKey, contentDirectory),
          joinOcflPath(versionName, contentDirectory),
          issues,
          "E024",
        ),
      );
    }

    if (!entries.files.includes(INVENTORY_FILENAME)) {
      issues.push(
        warning(
          "W010",
          versionLocation,
          "version directory should include an inventory file",
        ),
      );
      continue;
    }

    const versionInventory = await checkInventory(
      backend,
      versionKey,
      versionLocation,
    );
    issues.push(...versionInventory.issues);
    if (versionInventory.loaded === null) continue;

    if (versionName === inventory.head) {
      headInventoryBytes = versionInventory.loaded.bytes;
      headInventoryVerified = versionInventory.sidecarVerified;
    } else {
      issues.push(
        ...checkPriorInventoryAgreement(
          inventory,
          versionInventory.loaded.inventory,
          versionName,
          versionLocation,
        ),
      );
    }
  }

  // The root inventory must be a byte-for-byte copy of the head version's
  // inventory (E064) — semantic equality is not enough.
  let rootMatchesHead = false;
  if (headInventoryBytes !== null && rootInventory.loaded !== null) {
    rootMatchesHead = bytesEqual(
      rootInventory.loaded.bytes,
      headInventoryBytes,
    );
    if (!rootMatchesHead) {
      issues.push(
        error(
          "E064",
          joinOcflPath(location, INVENTORY_FILENAME),
          `root inventory is not byte-identical to ${inventory.head}/${INVENTORY_FILENAME}`,
        ),
      );
    }
  }

  // Manifest content paths and on-disk content files must correspond exactly.
  const manifestPaths = new Map<string, string>();
  for (const [digest, contentPaths] of Object.entries(inventory.manifest)) {
    for (const contentPath of contentPaths) {
      manifestPaths.set(contentPath, digest);
      if (!(await backend.exists(joinKey(objectKey, contentPath)))) {
        issues.push(
          error(
            "E092",
            joinOcflPath(location, contentPath),
            "manifest content path does not exist on disk",
          ),
        );
      }
    }
  }
  for (const contentPath of contentFilesOnDisk) {
    if (!manifestPaths.has(contentPath)) {
      issues.push(
        error(
          "E023",
          joinOcflPath(location, contentPath),
          "content file is not referenced in the manifest",
        ),
      );
    }
  }

  if (options.fullFixity === true) {
    for (const [contentPath, digest] of manifestPaths) {
      const fileKey = joinKey(objectKey, contentPath);
      if (!(await backend.exists(fileKey))) continue;
      const actual = await digestStream(
        await backend.readStream(fileKey),
        inventory.digestAlgorithm,
      );
      if (actual !== normalizeDigest(digest)) {
        issues.push(
          error(
            "E092",
            joinOcflPath(location, contentPath),
            `content digest mismatch: manifest states ${digest}, file digests to ${actual}`,
          ),
        );
      }
    }
    issues.push(
      ...await checkFixityBlock(backend, inventory, objectKey, location),
    );
  }

  // A root sidecar that disagrees while the head version inventory is intact
  // and identical is the recoverable crash window, not corruption.
  const recoverable = !rootInventory.sidecarVerified &&
    headInventoryVerified &&
    rootMatchesHead &&
    issues.every((issue) =>
      issue.severity === "warning" || issue.code === "E060" ||
      issue.code === "E058"
    );

  return finish(inventory.id, location, issues, recoverable);
}

/** Split accumulated issues into an object result. */
function finish(
  id: string | null,
  path: string,
  issues: ValidationIssue[],
  recoverable: boolean,
): ObjectValidationResult {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return {
    id,
    path,
    valid: errors.length === 0,
    errors,
    warnings,
    recoverable,
  };
}

/**
 * Check the storage hierarchy: intermediate directories hold no files (E072,
 * E084) and no directory is empty (E073).
 */
async function checkStorageHierarchy(
  backend: StorageBackend,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = [];

  async function walk(relative: string): Promise<void> {
    const { files, directories } = await listEntries(backend, relative);
    const isObjectRoot = files.some((name) =>
      name.startsWith("0=ocfl_object_")
    );
    if (isObjectRoot) return;

    if (relative !== "") {
      if (files.length > 0) {
        issues.push(
          error(
            "E072",
            relative,
            `storage hierarchy directory contains files that are not part of an OCFL object: ${
              files.join(", ")
            }`,
          ),
        );
      }
      if (files.length === 0 && directories.length === 0) {
        issues.push(error("E073", relative, "empty directory in storage root"));
        return;
      }
    }

    for (const name of directories) {
      if (relative === "" && name === "extensions") continue;
      await walk(joinKey(relative, name));
    }
  }

  await walk("");
  return issues;
}

/**
 * Validate a storage root and the objects it contains.
 *
 * @param ids When given, only objects with these ids are validated; the
 * storage-root checks still run over the whole root.
 */
export async function validateStorageRoot(
  backend: StorageBackend,
  options: ValidateOptions & { ids?: readonly string[] } = {},
): Promise<StorageRootValidationResult> {
  const rootIssues: ValidationIssue[] = [];

  const namaste = await checkNamaste(backend, "", "root", "");
  rootIssues.push(...namaste.issues);
  rootIssues.push(...await checkStorageHierarchy(backend));

  const discovered = await scanObjectRoots(backend);
  const wanted = options.ids === undefined ? null : new Set(options.ids);
  const objects: ObjectValidationResult[] = [];
  const seenIds = new Set<string>();

  for (const entry of discovered) {
    const result = await validateObject(
      backend,
      entry.relativePath,
      options,
    );
    if (wanted !== null && (result.id === null || !wanted.has(result.id))) {
      continue;
    }
    if (result.id !== null) {
      if (seenIds.has(result.id)) {
        rootIssues.push(
          error(
            "E083",
            entry.relativePath,
            `object id ${
              JSON.stringify(result.id)
            } appears at more than one storage path`,
          ),
        );
      }
      seenIds.add(result.id);
    }
    objects.push(result);
  }

  if (wanted !== null) {
    for (const id of wanted) {
      if (!seenIds.has(id)) {
        rootIssues.push(
          error(
            "E083",
            "",
            `no object with id ${JSON.stringify(id)} was found`,
          ),
        );
      }
    }
  }

  const rootErrors = rootIssues.filter((issue) => issue.severity === "error");
  const rootWarnings = rootIssues.filter((issue) =>
    issue.severity === "warning"
  );
  return {
    storageRoot: backend.url,
    checkedAt: new Date().toISOString(),
    fullFixity: options.fullFixity === true,
    valid: rootErrors.length === 0 &&
      objects.every((object) => object.valid),
    rootErrors,
    rootWarnings,
    objects,
  };
}
