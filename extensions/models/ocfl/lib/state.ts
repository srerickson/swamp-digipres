/**
 * Building the next version's logical state from a staged source tree.
 *
 * `commit` treats the source tree as the *complete* desired logical state:
 * paths present in the previous version but absent from the source are
 * logically deleted. Deletions require explicit opt-in at the commit layer.
 *
 * @module
 */
import { OcflError } from "./errors.ts";
import { digestFile, normalizeDigest } from "./digest.ts";
import {
  joinOcflPath,
  validateContentPath,
  validateLogicalPath,
} from "./paths.ts";
import type { Inventory } from "./types.ts";

/** One file discovered in a source tree. */
export interface SourceFile {
  /** Path relative to the source root, using `/` separators. */
  logicalPath: string;
  /** Absolute path on disk. */
  absolutePath: string;
}

/**
 * Walk a source tree into the logical paths it would produce.
 *
 * Symbolic links are rejected (E090): OCFL content must be regular files, and
 * following a link would silently copy content from outside the source tree.
 * Empty directories are rejected too — a logical state has no way to represent
 * one (E024), so committing a tree containing one would silently drop it.
 */
export async function walkSource(sourcePath: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];

  async function walk(absolute: string, relative: string): Promise<void> {
    const names: string[] = [];
    for await (const entry of Deno.readDir(absolute)) {
      names.push(entry.name);
      const childAbsolute = `${absolute}/${entry.name}`;
      const childRelative = joinOcflPath(relative, entry.name);
      if (entry.isSymlink) {
        throw new OcflError(
          `source tree contains a symbolic link, which cannot be stored in an OCFL object: ${childRelative}`,
          { code: "E090", path: childAbsolute },
        );
      }
      if (entry.isDirectory) {
        await walk(childAbsolute, childRelative);
        continue;
      }
      const issues = validateLogicalPath(childRelative, sourcePath);
      if (issues.length > 0) {
        throw new OcflError(
          `source path is not a valid OCFL logical path: ${issues[0].message}`,
          { code: issues[0].code, path: childAbsolute },
        );
      }
      files.push({ logicalPath: childRelative, absolutePath: childAbsolute });
    }
    if (names.length === 0 && relative !== "") {
      throw new OcflError(
        `source tree contains an empty directory, which an OCFL logical state cannot represent: ${relative}`,
        { code: "E024", path: absolute },
      );
    }
  }

  await walk(sourcePath, "");
  files.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath));
  return files;
}

/** A content file that must be copied into the new version directory. */
export interface NewContent {
  /** Absolute source path to copy from. */
  sourcePath: string;
  /** Content path relative to the object root, e.g. `v2/content/a.txt`. */
  contentPath: string;
  /** Digest of the file. */
  digest: string;
}

/** The computed next version, before anything is written. */
export interface NextState {
  /** The new version's `state` block. */
  state: Record<string, string[]>;
  /** Manifest entries after adding this version's new content. */
  manifest: Record<string, string[]>;
  /** Files that must be copied into the new version directory. */
  newContent: NewContent[];
  /** Logical paths present in the previous state but absent from the new one. */
  deletedPaths: string[];
  /** Logical paths added since the previous state. */
  addedPaths: string[];
  /** Logical paths whose content digest changed. */
  modifiedPaths: string[];
  /** False when the new state is identical to the previous one. */
  changed: boolean;
}

/** Map logical path to digest for a version's state block. */
function stateByPath(state: Record<string, string[]>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [digest, paths] of Object.entries(state)) {
    for (const path of paths) map.set(path, normalizeDigest(digest));
  }
  return map;
}

/**
 * Compute the next version's state from a source tree.
 *
 * Content is deduplicated against the existing manifest case-insensitively: a
 * staged file whose digest is already present reuses that manifest entry and
 * produces no new content file.
 *
 * @param previous The current inventory, or `null` when ingesting a new object.
 * @param sourceFiles Files walked from the source tree.
 * @param versionName Name of the version being created, used in content paths.
 * @param contentDirectory Content directory name for the object.
 * @param algorithm Digest algorithm to use.
 */
export async function buildNextState(
  previous: Inventory | null,
  sourceFiles: readonly SourceFile[],
  versionName: string,
  contentDirectory: string,
  algorithm: string,
): Promise<NextState> {
  // Existing manifest digests, keyed case-insensitively, preserving the
  // original casing so reused entries are written back unchanged.
  const manifest: Record<string, string[]> = previous === null
    ? {}
    : { ...previous.manifest };
  const digestKeys = new Map<string, string>();
  for (const digest of Object.keys(manifest)) {
    digestKeys.set(normalizeDigest(digest), digest);
  }

  const state: Record<string, string[]> = {};
  const newContent: NewContent[] = [];

  for (const file of sourceFiles) {
    const digest = await digestFile(file.absolutePath, algorithm);
    const existingKey = digestKeys.get(digest);

    let key: string;
    if (existingKey !== undefined) {
      // Content already stored under some earlier version — no copy needed.
      key = existingKey;
    } else {
      key = digest;
      digestKeys.set(digest, digest);
      const contentPath = joinOcflPath(
        versionName,
        contentDirectory,
        file.logicalPath,
      );
      const issues = validateContentPath(contentPath, versionName);
      if (issues.length > 0) {
        throw new OcflError(
          `computed content path is invalid: ${issues[0].message}`,
          { code: issues[0].code },
        );
      }
      manifest[key] = [contentPath];
      newContent.push({
        sourcePath: file.absolutePath,
        contentPath,
        digest,
      });
    }

    (state[key] ??= []).push(file.logicalPath);
  }

  for (const paths of Object.values(state)) paths.sort();

  const previousState = previous === null
    ? new Map<string, string>()
    : stateByPath(previous.versions[previous.head]?.state ?? {});
  const nextState = stateByPath(state);

  const deletedPaths: string[] = [];
  const addedPaths: string[] = [];
  const modifiedPaths: string[] = [];
  for (const [path, digest] of previousState) {
    const current = nextState.get(path);
    if (current === undefined) deletedPaths.push(path);
    else if (current !== digest) modifiedPaths.push(path);
  }
  for (const path of nextState.keys()) {
    if (!previousState.has(path)) addedPaths.push(path);
  }
  deletedPaths.sort();
  addedPaths.sort();
  modifiedPaths.sort();

  return {
    state,
    manifest,
    newContent,
    deletedPaths,
    addedPaths,
    modifiedPaths,
    changed: deletedPaths.length > 0 || addedPaths.length > 0 ||
      modifiedPaths.length > 0,
  };
}
