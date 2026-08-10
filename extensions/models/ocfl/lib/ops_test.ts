/**
 * Tests for the version operations.
 *
 * Everything here is pure: no storage, no digests, no clock. These are the
 * failures that must be caught before a single byte is written.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { OcflError } from "./errors.ts";
import {
  addSources,
  applyOps,
  type LogicalState,
  type OpsInput,
  parseOps,
  validatePaths,
} from "./ops.ts";

/**
 * Feed `parseOps` something the type system would refuse.
 *
 * Every one of these arrives over the wire as JSON or YAML, so the runtime
 * check is the only thing standing between it and the planner.
 */
const malformed = (value: unknown) => () => parseOps(value as OpsInput);

/** Digest stand-in: the source path spelled backwards, so it is distinctive. */
const fakeDigest = (source: string) => [...source].reverse().join("");

function state(entries: Record<string, string>): LogicalState {
  return new Map(Object.entries(entries));
}

Deno.test("parseOps reads each verb", () => {
  const ops: OpsInput = [
    { op: "add", source: "/data/a.txt", logicalPath: "a.txt" },
    { op: "remove", logicalPath: "old.txt" },
    { op: "rename", from: "b.txt", to: "docs/b.txt" },
  ];
  assertEquals(parseOps(ops), ops);
});

Deno.test("parseOps accepts a bare operation", () => {
  // The single-operation case is common enough that requiring a one-element
  // list would be noise.
  assertEquals(
    parseOps({ op: "remove", logicalPath: "old.txt" }),
    [{ op: "remove", logicalPath: "old.txt" }],
  );
});

Deno.test("parseOps needs no escaping for a path holding a delimiter", () => {
  // The whole point of the structured form. Under the old colon-delimited
  // syntax this path required '\:' escaping, and getting it wrong deposited
  // content somewhere other than where it was asked to go.
  assertEquals(
    parseOps([{
      op: "add",
      source: "/data/odd:name",
      logicalPath: "docs/odd:name",
    }]),
    [{ op: "add", source: "/data/odd:name", logicalPath: "docs/odd:name" }],
  );
});

Deno.test("parseOps rejects an unknown verb", () => {
  const error = assertThrows(
    malformed([{ op: "copy", from: "a.txt", to: "b.txt" }]),
    OcflError,
  );
  assert(error.message.includes("invalid operation"));
});

Deno.test("parseOps rejects an unknown key", () => {
  // Silently dropping it is the failure this format exists to prevent: a
  // misspelled 'logicalPath' would otherwise leave the operand undefined.
  const error = assertThrows(
    malformed([{
      op: "add",
      source: "/data/a.txt",
      logicalPath: "a.txt",
      logicalpath: "a.txt",
    }]),
    OcflError,
  );
  assert(error.message.includes("invalid operation"));
});

Deno.test("parseOps rejects a key belonging to another verb", () => {
  assertThrows(
    malformed([{ op: "remove", from: "a.txt" }]),
    OcflError,
    "invalid operation",
  );
  assertThrows(
    malformed([{ op: "rename", from: "a.txt", logicalPath: "b.txt" }]),
    OcflError,
    "invalid operation",
  );
});

Deno.test("parseOps rejects empty operands and empty lists", () => {
  assertThrows(
    malformed([{ op: "remove", logicalPath: "" }]),
    OcflError,
    "invalid operation",
  );
  assertThrows(() => parseOps([]), OcflError, "no operations given");
});

Deno.test("parseOps rejects anything that is not an operation object", () => {
  // These arrive as JSON or YAML, so the runtime check is the only guard. The
  // old delimited string is included deliberately: it must fail loudly rather
  // than be misread.
  for (const value of [42, null, "add:/data/a.txt:a.txt", ["a"]]) {
    assertThrows(malformed([value]), OcflError, "invalid operation");
  }
});

Deno.test("addSources deduplicates and preserves order", () => {
  const ops = parseOps([
    { op: "add", source: "/data/a.txt", logicalPath: "a.txt" },
    { op: "add", source: "/data/b.txt", logicalPath: "b.txt" },
    { op: "add", source: "/data/a.txt", logicalPath: "copy-of-a.txt" },
  ]);
  assertEquals(addSources(ops), ["/data/a.txt", "/data/b.txt"]);
});

Deno.test("applyOps folds operations in order", () => {
  const result = applyOps(
    state({ "a.txt": "digest-a", "b.txt": "digest-b" }),
    parseOps([
      { op: "rename", from: "a.txt", to: "archive/a.txt" },
      { op: "add", source: "/data/new", logicalPath: "a.txt" },
      { op: "remove", logicalPath: "b.txt" },
    ]),
    fakeDigest,
  );
  assertEquals([...result].sort(), [
    ["a.txt", fakeDigest("/data/new")],
    ["archive/a.txt", "digest-a"],
  ]);
});

Deno.test("applyOps leaves the base state untouched", () => {
  const base = state({ "a.txt": "digest-a" });
  applyOps(
    base,
    parseOps([{ op: "remove", logicalPath: "a.txt" }]),
    fakeDigest,
  );
  assertEquals(base.size, 1);
});

Deno.test("applyOps treats add onto an existing path as a supersede", () => {
  const result = applyOps(
    state({ "a.txt": "old" }),
    parseOps([{ op: "add", source: "/data/new", logicalPath: "a.txt" }]),
    fakeDigest,
  );
  assertEquals(result.get("a.txt"), fakeDigest("/data/new"));
});

Deno.test("applyOps rejects removing or renaming an absent path", () => {
  assertThrows(
    () =>
      applyOps(
        state({}),
        parseOps([{ op: "remove", logicalPath: "gone.txt" }]),
        fakeDigest,
      ),
    OcflError,
    "cannot remove",
  );
  assertThrows(
    () =>
      applyOps(
        state({}),
        parseOps([{ op: "rename", from: "a.txt", to: "b.txt" }]),
        fakeDigest,
      ),
    OcflError,
    "cannot rename",
  );
});

Deno.test("applyOps rejects renaming onto an occupied path", () => {
  assertThrows(
    () =>
      applyOps(
        state({ "a.txt": "digest-a", "b.txt": "digest-b" }),
        parseOps([{ op: "rename", from: "a.txt", to: "b.txt" }]),
        fakeDigest,
      ),
    OcflError,
    "already occupied",
  );
});

Deno.test("applyOps allows a rename into a path freed earlier in the list", () => {
  // Order-sensitivity is the point: this only works because ops are folded
  // strictly in sequence.
  const result = applyOps(
    state({ "a.txt": "digest-a", "b.txt": "digest-b" }),
    parseOps([
      { op: "remove", logicalPath: "b.txt" },
      { op: "rename", from: "a.txt", to: "b.txt" },
    ]),
    fakeDigest,
  );
  assertEquals([...result], [["b.txt", "digest-a"]]);
});

Deno.test("validatePaths accepts ordinary paths", () => {
  validatePaths(["a.txt", "docs/spec.md", "img/deep/cover.png"], "logical");
});

Deno.test("validatePaths rejects unsafe elements (E099)", () => {
  for (const path of ["../escape.txt", "a/./b.txt", "a//b.txt", ""]) {
    const error = assertThrows(
      () => validatePaths([path], "logical"),
      OcflError,
    );
    assertEquals(error.code, "E099");
  }
});

Deno.test("validatePaths rejects leading and trailing slashes (E100)", () => {
  for (const path of ["/a.txt", "a/"]) {
    const error = assertThrows(
      () => validatePaths([path], "logical"),
      OcflError,
    );
    assertEquals(error.code, "E100");
  }
});

Deno.test("validatePaths rejects a path that is a prefix of another (E101)", () => {
  const error = assertThrows(
    () => validatePaths(["docs", "docs/spec.md"], "logical"),
    OcflError,
  );
  assertEquals(error.code, "E101");
  assert(error.message.includes("both a file and a directory"));
});

Deno.test("validatePaths finds a prefix conflict its neighbours hide (E101)", () => {
  // '!' (0x21) sorts before '/' (0x2F), so sorting these puts "a!b" between
  // "a" and "a/x" and a check that only compares neighbours never sees the
  // conflict. Both the write path and the export path rely on this catching
  // every file-that-is-also-a-directory before anything is written.
  for (const paths of [["a", "a!b", "a/x"], ["a/x", "a!b", "a"]]) {
    const error = assertThrows(
      () => validatePaths(paths, "logical"),
      OcflError,
    );
    assertEquals(error.code, "E101");
    assert(error.message.includes("both a file and a directory"));
  }

  // Depth is no help to it either: the conflict can be several levels up.
  const deep = assertThrows(
    () => validatePaths(["docs", "docs!notes", "docs/deep/spec.md"], "logical"),
    OcflError,
  );
  assertEquals(deep.code, "E101");
});

Deno.test("validatePaths rejects duplicates but allows a shared prefix string", () => {
  assertThrows(
    () => validatePaths(["a.txt", "a.txt"], "logical"),
    OcflError,
    "more than once",
  );
  // "docs" is a prefix of "docsy" as a string, but not as a path.
  validatePaths(["docs/a.txt", "docsy/b.txt"], "logical");
});
