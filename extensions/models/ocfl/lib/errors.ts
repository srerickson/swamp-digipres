/**
 * Error types shared by the OCFL library.
 *
 * Errors carry the OCFL validation code (`E###`/`W###`) they correspond to when
 * one applies, so callers can report findings by code rather than by message.
 *
 * @module
 */

/** An OCFL-related failure, optionally keyed by a specification code. */
export class OcflError extends Error {
  /** OCFL validation code (`E064`, `W011`, …) when the failure maps to one. */
  readonly code: string | undefined;
  /** Storage path the failure relates to, relative to the storage root. */
  readonly path: string | undefined;

  constructor(
    message: string,
    options: { code?: string; path?: string; cause?: unknown } = {},
  ) {
    super(
      options.code === undefined ? message : `${options.code}: ${message}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "OcflError";
    this.code = options.code;
    this.path = options.path;
  }
}

/**
 * A requested path does not exist in storage.
 *
 * Backends throw this instead of their native error so callers can probe for
 * absence without knowing which backend they are talking to.
 */
export class NotFoundError extends Error {
  /** Storage path that was not found, relative to the storage root. */
  readonly path: string;

  constructor(path: string, options: { cause?: unknown } = {}) {
    super(
      `not found: ${path}`,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "NotFoundError";
    this.path = path;
  }
}

/** True when `error` signals a missing path from any storage backend. */
export function isNotFound(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError;
}
