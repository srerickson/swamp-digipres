/**
 * Error and validation-issue types for the OCFL library.
 *
 * Validation codes (`E###`/`W###`) come from the OCFL 1.1 validation code
 * registry: https://ocfl.io/1.1/spec/validation-codes.html
 *
 * @module
 */

/** Severity of a validation issue. `error` violates a MUST; `warning` a SHOULD. */
export type Severity = "error" | "warning";

/**
 * A single validation finding, keyed by its OCFL validation code.
 *
 * Validators accumulate these rather than throwing so one object's report is
 * complete in a single pass.
 */
export interface ValidationIssue {
  /** OCFL validation code, e.g. `E064` or `W011`. */
  code: string;
  /** `error` for E-codes, `warning` for W-codes. */
  severity: Severity;
  /** Path the issue applies to, relative to the storage root where possible. */
  path: string;
  /** Human-readable description of what failed. */
  message: string;
}

/** Build an error-severity {@link ValidationIssue}. */
export function error(
  code: string,
  path: string,
  message: string,
): ValidationIssue {
  return { code, severity: "error", path, message };
}

/** Build a warning-severity {@link ValidationIssue}. */
export function warning(
  code: string,
  path: string,
  message: string,
): ValidationIssue {
  return { code, severity: "warning", path, message };
}

/**
 * An OCFL operation failed. Carries the validation code when the failure maps
 * to one, so callers can distinguish spec violations from I/O problems.
 */
export class OcflError extends Error {
  /** OCFL validation code, when the failure maps to one. */
  readonly code?: string;
  /** Path the failure applies to, when known. */
  readonly path?: string;

  constructor(message: string, options?: { code?: string; path?: string }) {
    super(message);
    this.name = "OcflError";
    this.code = options?.code;
    this.path = options?.path;
  }
}

/**
 * A commit could not proceed because the object's head moved between the
 * initial read and the finalize step.
 *
 * OCFL has no locking; `commit` re-verifies head immediately before finalizing
 * and aborts with this error rather than clobbering another writer's version.
 */
export class HeadConflictError extends OcflError {
  /** Head recorded when the commit started. */
  readonly expectedHead: string;
  /** Head found at finalize time. */
  readonly actualHead: string;

  constructor(objectPath: string, expectedHead: string, actualHead: string) {
    super(
      `object head moved during commit: expected ${expectedHead}, found ${actualHead}`,
      { path: objectPath },
    );
    this.name = "HeadConflictError";
    this.expectedHead = expectedHead;
    this.actualHead = actualHead;
  }
}
