import { assertEquals } from "jsr:@std/assert@1";
import {
  checkContentPathConflicts,
  checkLogicalPathConflicts,
  validateContentDirectory,
  validateContentPath,
  validateLogicalPath,
} from "./paths.ts";

function codes(issues: { code: string }[]): string[] {
  return issues.map((issue) => issue.code).sort();
}

Deno.test("valid logical paths produce no issues", () => {
  for (const path of ["a", "a/b", "a/b/c.txt", "dir/file name.txt", "a.b/c"]) {
    assertEquals(validateLogicalPath(path, "v1").length, 0, path);
  }
});

Deno.test("logical path elements must not be '.', '..' or empty (E052)", () => {
  for (const path of ["./a", "a/../b", "a//b", ".", ".."]) {
    assertEquals(
      codes(validateLogicalPath(path, "v1")).includes("E052"),
      true,
      path,
    );
  }
});

Deno.test("logical paths must not begin or end with a slash (E053)", () => {
  assertEquals(codes(validateLogicalPath("/a/b", "v1")).includes("E053"), true);
  assertEquals(codes(validateLogicalPath("a/b/", "v1")).includes("E053"), true);
});

Deno.test("content paths carry E099/E100 for the same violations", () => {
  assertEquals(
    codes(validateContentPath("a/../b", "m")).includes("E099"),
    true,
  );
  assertEquals(codes(validateContentPath("/a", "m")).includes("E100"), true);
});

Deno.test("logical path prefix conflicts are detected (E095)", () => {
  assertEquals(codes(checkLogicalPathConflicts(["a/b", "a/b/c"], "v1")), [
    "E095",
  ]);
  assertEquals(codes(checkLogicalPathConflicts(["a/b", "a/bc"], "v1")), []);
  assertEquals(codes(checkLogicalPathConflicts(["a/b", "a/b"], "v1")), [
    "E095",
  ]);
});

Deno.test("content path prefix conflicts are detected (E101)", () => {
  assertEquals(
    codes(checkContentPathConflicts(["v1/content/a", "v1/content/a/b"], "m")),
    ["E101"],
  );
  assertEquals(
    codes(checkContentPathConflicts(["v1/content/a", "v1/content/b"], "m")),
    [],
  );
});

Deno.test("contentDirectory must not contain a slash or be a dot segment", () => {
  assertEquals(codes(validateContentDirectory("content", "inv")), []);
  assertEquals(codes(validateContentDirectory("a/b", "inv")), ["E017"]);
  assertEquals(codes(validateContentDirectory("..", "inv")), ["E018"]);
});
