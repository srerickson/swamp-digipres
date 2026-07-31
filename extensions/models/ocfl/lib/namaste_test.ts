import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  checkNamaste,
  namasteContent,
  namasteFilename,
  readNamaste,
  writeNamaste,
} from "./namaste.ts";
import {
  FIXTURE_IDS,
  FIXTURE_PATHS,
  FIXTURE_ROOT,
  withTempDir,
} from "./test_util.ts";

function codes(issues: { code: string }[]): string[] {
  return issues.map((issue) => issue.code);
}

Deno.test("declaration filenames and contents follow NAMASTE", () => {
  assertEquals(namasteFilename("root", "1.1"), "0=ocfl_1.1");
  assertEquals(namasteContent("root", "1.1"), "ocfl_1.1\n");
  assertEquals(namasteFilename("object", "1.1"), "0=ocfl_object_1.1");
  assertEquals(namasteContent("object", "1.1"), "ocfl_object_1.1\n");
});

Deno.test("the fixture's root and object declarations verify", async () => {
  const root = await checkNamaste(FIXTURE_ROOT, "root", "");
  assertEquals(root.issues, []);
  assertEquals(root.namaste?.version, "1.1");

  const objectPath = `${FIXTURE_ROOT}/${FIXTURE_PATHS[FIXTURE_IDS.spec]}`;
  const object = await checkNamaste(objectPath, "object", "object");
  assertEquals(object.issues, []);
  assertEquals(object.namaste?.version, "1.1");
});

Deno.test("a root declaration is not matched by an object declaration", async () => {
  await withTempDir(async (dir) => {
    await writeNamaste(dir, "object", "1.1");
    assertEquals(codes((await checkNamaste(dir, "root", "")).issues), ["E069"]);
    assertEquals((await checkNamaste(dir, "object", "")).issues, []);
  });
});

Deno.test("a missing object declaration is reported (E003)", async () => {
  await withTempDir(async (dir) => {
    assertEquals(codes((await checkNamaste(dir, "object", "")).issues), [
      "E003",
    ]);
  });
});

Deno.test("two declarations of the same kind are rejected (E003)", async () => {
  await withTempDir(async (dir) => {
    await writeNamaste(dir, "object", "1.0");
    await writeNamaste(dir, "object", "1.1");
    assertEquals(codes((await checkNamaste(dir, "object", "")).issues), [
      "E003",
    ]);
  });
});

Deno.test("wrong declaration contents are reported (E007/E080)", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/0=ocfl_object_1.1`, "ocfl_object_1.0\n");
    assertEquals(codes((await checkNamaste(dir, "object", "")).issues), [
      "E007",
    ]);

    await Deno.writeTextFile(`${dir}/0=ocfl_1.1`, "ocfl_1.1");
    assertEquals(codes((await checkNamaste(dir, "root", "")).issues), ["E080"]);
  });
});

Deno.test("a malformed declaration version is rejected (E006)", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/0=ocfl_object_x`, "ocfl_object_x\n");
    assertEquals(codes((await checkNamaste(dir, "object", "")).issues), [
      "E006",
    ]);
  });
});

Deno.test("readNamaste throws where checkNamaste reports", async () => {
  await withTempDir(async (dir) => {
    await assertRejects(() => readNamaste(dir, "object"));
    await writeNamaste(dir, "object", "1.1");
    assertEquals((await readNamaste(dir, "object")).version, "1.1");
  });
});
