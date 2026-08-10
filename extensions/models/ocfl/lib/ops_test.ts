/**
 * Tests for the operation language.
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
  parseOps,
  splitOp,
  validatePaths,
} from "./ops.ts";

/** Digest stand-in: the source path spelled backwards, so it is distinctive. */
const fakeDigest = (source: string) => [...source].reverse().join("");

function state(entries: Record<string, string>): LogicalState {
  return new Map(Object.entries(entries));
}

Deno.test("splitOp splits on unescaped colons", () => {
  assertEquals(splitOp("add:/data/a.txt:a.txt"), [
    "add",
    "/data/a.txt",
    "a.txt",
  ]);
});

Deno.test("splitOp honors escaped colons and backslashes", () => {
  assertEquals(splitOp("add:/data/odd\\:name:docs/odd\\:name"), [
    "add",
    "/data/odd:name",
    "docs/odd:name",
  ]);
  assertEquals(splitOp("remove:a\\\\b"), ["remove", "a\\b"]);
});

Deno.test("splitOp leaves other backslashes alone", () => {
  // A backslash that is not an escape must survive, or a path carrying one
  // would be silently rewritten.
  assertEquals(splitOp("remove:a\\nb"), ["remove", "a\\nb"]);
});

Deno.test("parseOps reads each verb", () => {
  assertEquals(
    parseOps([
      "add:/data/a.txt:a.txt",
      "remove:old.txt",
      "rename:b.txt:docs/b.txt",
    ]),
    [
      { op: "add", source: "/data/a.txt", logicalPath: "a.txt" },
      { op: "remove", logicalPath: "old.txt" },
      { op: "rename", from: "b.txt", to: "docs/b.txt" },
    ],
  );
});

Deno.test("parseOps accepts one newline-delimited string", () => {
  // swamp's --input does not accumulate repeated keys, so this is a first-class
  // way to pass a list rather than a convenience.
  assertEquals(
    parseOps("add:/data/a.txt:a.txt\n\n  remove:old.txt  \n"),
    [
      { op: "add", source: "/data/a.txt", logicalPath: "a.txt" },
      { op: "remove", logicalPath: "old.txt" },
    ],
  );
});

Deno.test("parseOps rejects an unknown verb", () => {
  const error = assertThrows(() => parseOps(["copy:a.txt:b.txt"]), OcflError);
  assert(error.message.includes("unknown operation"));
});

Deno.test("parseOps rejects the wrong arity", () => {
  const tooFew = assertThrows(() => parseOps(["add:/data/a.txt"]), OcflError);
  assert(tooFew.message.includes("2 operand(s) but got 1"));
  // An unescaped colon in a path shows up as arity, so the message points at
  // the escape rule.
  const tooMany = assertThrows(
    () => parseOps(["add:/data/a:b.txt:a.txt"]),
    OcflError,
  );
  assert(tooMany.message.includes("\\:"));
});

Deno.test("parseOps rejects empty operands and empty lists", () => {
  assertThrows(() => parseOps(["remove:"]), OcflError, "empty operand");
  assertThrows(() => parseOps([]), OcflError, "no operations given");
  assertThrows(() => parseOps("   \n  "), OcflError, "no operations given");
});

Deno.test("addSources deduplicates and preserves order", () => {
  const ops = parseOps([
    "add:/data/a.txt:a.txt",
    "add:/data/b.txt:b.txt",
    "add:/data/a.txt:copy-of-a.txt",
  ]);
  assertEquals(addSources(ops), ["/data/a.txt", "/data/b.txt"]);
});

Deno.test("applyOps folds operations in order", () => {
  const result = applyOps(
    state({ "a.txt": "digest-a", "b.txt": "digest-b" }),
    parseOps([
      "rename:a.txt:archive/a.txt",
      "add:/data/new:a.txt",
      "remove:b.txt",
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
  applyOps(base, parseOps(["remove:a.txt"]), fakeDigest);
  assertEquals(base.size, 1);
});

Deno.test("applyOps treats add onto an existing path as a supersede", () => {
  const result = applyOps(
    state({ "a.txt": "old" }),
    parseOps(["add:/data/new:a.txt"]),
    fakeDigest,
  );
  assertEquals(result.get("a.txt"), fakeDigest("/data/new"));
});

Deno.test("applyOps rejects removing or renaming an absent path", () => {
  assertThrows(
    () => applyOps(state({}), parseOps(["remove:gone.txt"]), fakeDigest),
    OcflError,
    "cannot remove",
  );
  assertThrows(
    () => applyOps(state({}), parseOps(["rename:a.txt:b.txt"]), fakeDigest),
    OcflError,
    "cannot rename",
  );
});

Deno.test("applyOps rejects renaming onto an occupied path", () => {
  assertThrows(
    () =>
      applyOps(
        state({ "a.txt": "digest-a", "b.txt": "digest-b" }),
        parseOps(["rename:a.txt:b.txt"]),
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
    parseOps(["remove:b.txt", "rename:a.txt:b.txt"]),
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
