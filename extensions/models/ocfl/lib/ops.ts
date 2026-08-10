/**
 * The operations that describe a new version's logical state.
 *
 * A caller does not supply a file listing; it supplies edits against the
 * previous version's state — `add`, `remove`, `rename`. Folding those edits in
 * order is what produces the state the new version records.
 *
 * Operations are structured objects rather than a delimited string syntax. That
 * is the form a swamp workflow can build directly, and it removes the class of
 * bug where a path containing the delimiter is silently mis-split and content
 * is deposited somewhere other than where it was asked to go.
 *
 * Nothing here touches storage or computes a digest. Parsing, folding, and path
 * validation all happen before the first byte is written, so a malformed
 * request fails with nothing half-done.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { OcflError } from "./errors.ts";

/**
 * An operand naming a path. Never empty: an empty operand is always a caller
 * mistake, and accepting one as a path would put content at the object root.
 */
const Operand = z.string().min(1);

/**
 * One edit against the previous version's logical state.
 *
 * `.strict()` on every member is load-bearing rather than tidiness. A
 * misspelled key that fell through would leave its operand undefined, and an
 * `add` missing its `logicalPath` is exactly the "content in the wrong place"
 * failure this format exists to prevent. Unknown keys are refused instead.
 */
export const OpObjectSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    source: Operand,
    logicalPath: Operand,
  }).strict(),
  z.object({
    op: z.literal("remove"),
    logicalPath: Operand,
  }).strict(),
  z.object({
    op: z.literal("rename"),
    from: Operand,
    to: Operand,
  }).strict(),
]);

/**
 * One edit against the previous version's logical state.
 *
 * Derived from {@linkcode OpObjectSchema} so the runtime schema and the type
 * are a single definition and cannot drift apart.
 */
export type VersionOp = z.infer<typeof OpObjectSchema>;

/**
 * Every form the operation list may arrive in.
 *
 * A bare object is the single-operation convenience. swamp's
 * `--input key=value` does not accumulate repeated keys, so a list arrives
 * either as `ops:json=[…]` or as a YAML list via `--input-file`.
 */
export const OpsInputSchema = z.union([
  OpObjectSchema,
  z.array(OpObjectSchema),
]);

/** Accepted shape of the operation list, before validation. */
export type OpsInput = z.infer<typeof OpsInputSchema>;

/** Logical path → digest. The working state ops are folded over. */
export type LogicalState = Map<string, string>;

/**
 * Validate one operation.
 *
 * Failures surface as {@linkcode OcflError} rather than as a `ZodError`, which
 * is the contract every caller in this library relies on.
 */
function parseOp(value: unknown): VersionOp {
  const parsed = OpObjectSchema.safeParse(value);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
  throw new OcflError(
    `invalid operation ${JSON.stringify(value)}: ${issues}`,
  );
}

/**
 * Parse the operation list.
 *
 * Accepts one operation or an array of them.
 *
 * @throws {OcflError} when the list is empty or any operation is malformed.
 */
export function parseOps(input: OpsInput): VersionOp[] {
  const items = Array.isArray(input) ? input : [input];

  if (items.length === 0) {
    throw new OcflError(
      "no operations given; a version must be described by at least one " +
        "add, remove, or rename",
    );
  }

  return items.map(parseOp);
}

/** Source paths every `add` in the list refers to, in order, deduplicated. */
export function addSources(ops: VersionOp[]): string[] {
  const sources = new Set<string>();
  for (const op of ops) {
    if (op.op === "add") sources.add(op.source);
  }
  return [...sources];
}

/**
 * Fold the operations over the previous version's state.
 *
 * Applied strictly in order, so `rename a b` followed by `add x a` is
 * well-defined rather than dependent on evaluation strategy. Every failure mode
 * — removing what is not there, renaming onto an occupied path — is an error
 * rather than a silent no-op, because in a preservation repository a request
 * that did not do what it said is worse than one that failed.
 *
 * @param base Previous version's state; not modified.
 * @param digestOf Digest of an `add` source, computed by the caller.
 * @throws {OcflError} when an operation cannot be applied.
 */
export function applyOps(
  base: LogicalState,
  ops: VersionOp[],
  digestOf: (source: string) => string,
): LogicalState {
  const state = new Map(base);

  for (const op of ops) {
    switch (op.op) {
      case "add": {
        // Overwriting is how a new version supersedes a file, so an add onto an
        // existing path is expected rather than an error.
        state.set(op.logicalPath, digestOf(op.source));
        break;
      }
      case "remove": {
        if (!state.has(op.logicalPath)) {
          throw new OcflError(
            `cannot remove ${JSON.stringify(op.logicalPath)}: it is not in ` +
              `the state being built`,
          );
        }
        state.delete(op.logicalPath);
        break;
      }
      case "rename": {
        const digest = state.get(op.from);
        if (digest === undefined) {
          throw new OcflError(
            `cannot rename ${JSON.stringify(op.from)}: it is not in the ` +
              `state being built`,
          );
        }
        if (state.has(op.to)) {
          throw new OcflError(
            `cannot rename ${JSON.stringify(op.from)} to ` +
              `${JSON.stringify(op.to)}: that path is already occupied`,
          );
        }
        state.delete(op.from);
        state.set(op.to, digest);
        break;
      }
    }
  }

  return state;
}

/**
 * Check paths against OCFL's path rules (E099–E101).
 *
 * Applies to logical paths and content paths alike — the spec imposes the same
 * constraints on both, and mirroring logical paths into the content directory
 * means a violation in one is a violation in the other.
 *
 * @param kind Named in the error, e.g. `"logical"` or `"content"`.
 * @throws {OcflError} when any path is unsafe.
 */
export function validatePaths(paths: Iterable<string>, kind: string): void {
  const all = [...paths];

  for (const path of all) {
    if (path.length === 0) {
      throw new OcflError(`${kind} path is empty`, { code: "E099" });
    }
    if (path.startsWith("/") || path.endsWith("/")) {
      throw new OcflError(
        `${kind} path ${JSON.stringify(path)} has a leading or trailing '/'`,
        { code: "E100" },
      );
    }
    for (const element of path.split("/")) {
      if (element === "" || element === "." || element === "..") {
        throw new OcflError(
          `${kind} path ${JSON.stringify(path)} contains an empty, '.', or ` +
            `'..' element`,
          { code: "E099" },
        );
      }
    }
  }

  // E101: no path may be a directory prefix of another, or a file and a
  // directory would have to occupy the same name.
  //
  // Every ancestor of every path is checked against the whole set, not just
  // against sort-adjacent neighbours: a third path can sort between a file and
  // its directory-form sibling and hide the conflict. "a", "a!b", "a/x" sorts
  // in that order, because '!' precedes '/', so "a" and "a/x" are never
  // neighbours.
  const seen = new Set<string>();
  for (const path of all) {
    if (seen.has(path)) {
      throw new OcflError(
        `${kind} path ${JSON.stringify(path)} appears more than once`,
        { code: "E101" },
      );
    }
    seen.add(path);
  }

  for (const path of all) {
    for (
      let slash = path.indexOf("/");
      slash !== -1;
      slash = path.indexOf("/", slash + 1)
    ) {
      const ancestor = path.slice(0, slash);
      if (seen.has(ancestor)) {
        throw new OcflError(
          `${kind} path ${JSON.stringify(ancestor)} is a prefix of ` +
            `${JSON.stringify(path)}; one cannot be both a file and a ` +
            `directory`,
          { code: "E101" },
        );
      }
    }
  }
}
