/**
 * Path safety checks for OCFL logical and content paths.
 *
 * Both path kinds share the same restrictions (§3.5.2, §3.5.3.1) but carry
 * different validation codes, so each check takes its codes as parameters and
 * the exported wrappers bind the right set.
 *
 * @module
 */
import type { ValidationIssue } from "./errors.ts";
import { error } from "./errors.ts";

/** Validation codes for one path flavor. */
interface PathCodes {
  /** Code for `.`, `..`, or empty path elements. */
  elements: string;
  /** Code for a leading or trailing `/`. */
  slash: string;
  /** Code for one path being a prefix of another. */
  conflict: string;
}

/** Codes applying to logical paths in a version `state` block. */
const LOGICAL_CODES: PathCodes = {
  elements: "E052",
  slash: "E053",
  conflict: "E095",
};

/** Codes applying to content paths in the `manifest` block. */
const CONTENT_CODES: PathCodes = {
  elements: "E099",
  slash: "E100",
  conflict: "E101",
};

/** Check one path against the element and slash restrictions. */
function checkPath(
  path: string,
  codes: PathCodes,
  location: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (path.startsWith("/") || path.endsWith("/")) {
    issues.push(
      error(
        codes.slash,
        location,
        `path must not begin or end with a forward slash: ${
          JSON.stringify(path)
        }`,
      ),
    );
  }
  const elements = path.split("/");
  for (const element of elements) {
    if (element === "" || element === "." || element === "..") {
      issues.push(
        error(
          codes.elements,
          location,
          `path elements must not be ".", ".." or empty: ${
            JSON.stringify(path)
          }`,
        ),
      );
      break;
    }
  }
  return issues;
}

/** Validate a logical path from a version `state` block (E052, E053). */
export function validateLogicalPath(
  path: string,
  location: string,
): ValidationIssue[] {
  return checkPath(path, LOGICAL_CODES, location);
}

/** Validate a content path from the `manifest` block (E099, E100). */
export function validateContentPath(
  path: string,
  location: string,
): ValidationIssue[] {
  return checkPath(path, CONTENT_CODES, location);
}

/**
 * Detect paths that conflict by being a prefix of another path.
 *
 * A path conflicts when it is the initial *directory* portion of another —
 * `a/b` conflicts with `a/b/c` but not with `a/bc`. Sorting makes any
 * conflicting pair adjacent, so one linear scan finds them all.
 */
function findPrefixConflicts(
  paths: readonly string[],
  code: string,
  location: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sorted = [...paths].sort();
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (current === previous) {
      issues.push(
        error(code, location, `duplicate path: ${JSON.stringify(current)}`),
      );
    } else if (current.startsWith(previous + "/")) {
      issues.push(
        error(
          code,
          location,
          `path ${JSON.stringify(previous)} conflicts with ${
            JSON.stringify(current)
          }: one cannot be the initial part of the other`,
        ),
      );
    }
  }
  return issues;
}

/** Detect prefix conflicts and duplicates among logical paths (E095). */
export function checkLogicalPathConflicts(
  paths: readonly string[],
  location: string,
): ValidationIssue[] {
  return findPrefixConflicts(paths, LOGICAL_CODES.conflict, location);
}

/** Detect prefix conflicts and duplicates among content paths (E101). */
export function checkContentPathConflicts(
  paths: readonly string[],
  location: string,
): ValidationIssue[] {
  return findPrefixConflicts(paths, CONTENT_CODES.conflict, location);
}

/**
 * Validate a `contentDirectory` value (E017, E018).
 *
 * It names a single directory inside each version directory, so it must not
 * contain a path separator or be a relative-path token.
 */
export function validateContentDirectory(
  name: string,
  location: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (name.includes("/")) {
    issues.push(
      error(
        "E017",
        location,
        `contentDirectory must not contain "/": ${JSON.stringify(name)}`,
      ),
    );
  }
  if (name === "." || name === "..") {
    issues.push(
      error(
        "E018",
        location,
        `contentDirectory must not be "." or "..": ${JSON.stringify(name)}`,
      ),
    );
  }
  return issues;
}

/**
 * Join path segments with `/`, the OCFL path separator.
 *
 * Used for building content paths, which are always `/`-separated regardless
 * of host platform.
 */
export function joinOcflPath(...segments: string[]): string {
  return segments.filter((segment) => segment !== "").join("/");
}
