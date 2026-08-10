/**
 * The operation language that describes a new version's logical state.
 *
 * A caller does not supply a file listing; it supplies edits against the
 * previous version's state — `add:<source>:<logical>`, `remove:<logical>`,
 * `rename:<from>:<to>`. Folding those edits in order is what produces the state
 * the new version records.
 *
 * Nothing here touches storage or computes a digest. Parsing, folding, and path
 * validation all happen before the first byte is written, so a malformed
 * request fails with nothing half-done.
 *
 * @module
 */
import { OcflError } from "./errors.ts";

/** One edit against the previous version's logical state. */
export type VersionOp =
  | { op: "add"; source: string; logicalPath: string }
  | { op: "remove"; logicalPath: string }
  | { op: "rename"; from: string; to: string };

/** Logical path → digest. The working state ops are folded over. */
export type LogicalState = Map<string, string>;

/** Operands each verb takes, after the verb itself. */
const ARITY: Record<string, number> = { add: 2, remove: 1, rename: 2 };

/**
 * Split on unescaped `:`, honoring `\:` as a literal colon.
 *
 * Logical paths rarely contain colons, but "rarely" is not "never" and a
 * silently mis-split path would deposit content at the wrong place.
 */
export function splitOp(text: string): string[] {
  const fields: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\" && index + 1 < text.length) {
      const next = text[index + 1];
      // Only `\:` and `\\` are escapes; anything else keeps its backslash, so
      // a Windows-style path is not silently mangled.
      if (next === ":" || next === "\\") {
        current += next;
        index += 1;
        continue;
      }
      current += character;
      continue;
    }
    if (character === ":") {
      fields.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  fields.push(current);
  return fields;
}

/**
 * Parse the operation list.
 *
 * Accepts an array of op strings or a single newline-delimited string, because
 * swamp's `--input key=value` does not accumulate repeated keys — a list
 * arrives either as `ops:json=[…]`, as a YAML list via `--input-file`, or as
 * one multi-line string.
 *
 * @throws {OcflError} when an op has an unknown verb or the wrong arity.
 */
export function parseOps(input: string[] | string): VersionOp[] {
  const lines = (Array.isArray(input) ? input : input.split("\n"))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    throw new OcflError(
      "no operations given; a version must be described by at least one " +
        "add, remove, or rename",
    );
  }

  return lines.map((line) => {
    const fields = splitOp(line);
    const verb = fields[0];
    const operands = fields.slice(1);
    const arity = ARITY[verb];

    if (arity === undefined) {
      throw new OcflError(
        `unknown operation ${JSON.stringify(verb)} in ${
          JSON.stringify(line)
        }; ` +
          `expected one of ${Object.keys(ARITY).join(", ")}`,
      );
    }
    if (operands.length !== arity) {
      throw new OcflError(
        `operation ${JSON.stringify(line)} takes ${arity} operand(s) but got ` +
          `${operands.length}; escape a literal colon as '\\:'`,
      );
    }
    if (operands.some((operand) => operand.length === 0)) {
      throw new OcflError(
        `operation ${JSON.stringify(line)} has an empty operand`,
      );
    }

    switch (verb) {
      case "add":
        return { op: "add", source: operands[0], logicalPath: operands[1] };
      case "remove":
        return { op: "remove", logicalPath: operands[0] };
      default:
        return { op: "rename", from: operands[0], to: operands[1] };
    }
  });
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
