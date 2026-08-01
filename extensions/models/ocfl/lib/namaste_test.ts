import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  checkNamaste,
  namasteContent,
  namasteFilename,
  readNamaste,
  writeNamaste,
} from "./namaste.ts";
import {
  BACKEND_KINDS,
  FIXTURE_IDS,
  FIXTURE_PATHS,
  fixtureBackend,
  withEmptyBackend,
} from "./test_util.ts";

const encoder = new TextEncoder();

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
  const backend = fixtureBackend();
  const root = await checkNamaste(backend, "", "root", "");
  assertEquals(root.issues, []);
  assertEquals(root.namaste?.version, "1.1");

  const objectKey = FIXTURE_PATHS[FIXTURE_IDS.spec];
  const object = await checkNamaste(backend, objectKey, "object", "object");
  assertEquals(object.issues, []);
  assertEquals(object.namaste?.version, "1.1");
});

for (const kind of BACKEND_KINDS) {
  Deno.test(`[${kind}] a root declaration is not matched by an object declaration`, async () => {
    await withEmptyBackend(kind, async (backend) => {
      await writeNamaste(backend, "", "object", "1.1");
      assertEquals(
        codes((await checkNamaste(backend, "", "root", "")).issues),
        ["E069"],
      );
      assertEquals((await checkNamaste(backend, "", "object", "")).issues, []);
    });
  });

  Deno.test(`[${kind}] a missing object declaration is reported (E003)`, async () => {
    await withEmptyBackend(kind, async (backend) => {
      await backend.write("placeholder.txt", encoder.encode("x"));
      assertEquals(
        codes((await checkNamaste(backend, "", "object", "")).issues),
        ["E003"],
      );
    });
  });

  Deno.test(`[${kind}] two declarations of the same kind are rejected (E003)`, async () => {
    await withEmptyBackend(kind, async (backend) => {
      await writeNamaste(backend, "", "object", "1.0");
      await writeNamaste(backend, "", "object", "1.1");
      assertEquals(
        codes((await checkNamaste(backend, "", "object", "")).issues),
        ["E003"],
      );
    });
  });

  Deno.test(`[${kind}] wrong declaration contents are reported (E007/E080)`, async () => {
    await withEmptyBackend(kind, async (backend) => {
      await backend.write(
        "0=ocfl_object_1.1",
        encoder.encode("ocfl_object_1.0\n"),
      );
      assertEquals(
        codes((await checkNamaste(backend, "", "object", "")).issues),
        ["E007"],
      );

      await backend.write("0=ocfl_1.1", encoder.encode("ocfl_1.1"));
      assertEquals(
        codes((await checkNamaste(backend, "", "root", "")).issues),
        ["E080"],
      );
    });
  });

  Deno.test(`[${kind}] a malformed declaration version is rejected (E006)`, async () => {
    await withEmptyBackend(kind, async (backend) => {
      await backend.write("0=ocfl_object_x", encoder.encode("ocfl_object_x\n"));
      assertEquals(
        codes((await checkNamaste(backend, "", "object", "")).issues),
        ["E006"],
      );
    });
  });

  Deno.test(`[${kind}] readNamaste throws where checkNamaste reports`, async () => {
    await withEmptyBackend(kind, async (backend) => {
      await assertRejects(() => readNamaste(backend, "", "object"));
      await writeNamaste(backend, "", "object", "1.1");
      assertEquals((await readNamaste(backend, "", "object")).version, "1.1");
    });
  });
}
