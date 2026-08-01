import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { commit, initStorageRoot } from "./commit.ts";
import { digestBytes } from "./digest.ts";
import { serializeInventory, writeInventoryPair } from "./inventory.ts";
import { openStorageRoot, requireObject } from "./object.ts";
import { validateObject, validateStorageRoot } from "./validate.ts";
import { LocalBackend } from "./backend/local.ts";
import { withTempDir } from "./test_util.ts";

const USER = { name: "Fixity Test", address: "mailto:fixity@example.com" };

/** Initialize a root with one object whose content is `contents`. */
async function withObject(
  contents: string,
  fixityAlgorithms: readonly string[],
  body: (context: {
    rootPath: string;
    objectPath: string;
    fixity: Record<string, Record<string, string[]>> | undefined;
  }) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const rootPath = `${dir}/root`;
    const source = `${dir}/src`;
    await initStorageRoot(new LocalBackend(rootPath));
    await Deno.mkdir(source, { recursive: true });
    await Deno.writeTextFile(`${source}/a.txt`, contents);

    await commit(await openStorageRoot(new LocalBackend(rootPath)), {
      id: "urn:fixity:one",
      sourcePath: source,
      message: "Ingest",
      user: USER,
      fixityAlgorithms,
    });

    const object = await requireObject(
      await openStorageRoot(new LocalBackend(rootPath)),
      "urn:fixity:one",
    );
    await body({
      rootPath,
      objectPath: `${rootPath}/${object.relativePath}`,
      fixity: object.inventory.fixity,
    });
  });
}

Deno.test("commit records requested fixity algorithms for new content", async () => {
  const contents = "fixity content\n";
  await withObject(contents, ["md5", "sha1"], async ({ rootPath, fixity }) => {
    const bytes = new TextEncoder().encode(contents);
    assertEquals(Object.keys(fixity ?? {}).sort(), ["md5", "sha1"]);
    assertEquals(fixity!.md5[digestBytes(bytes, "md5")], ["v1/content/a.txt"]);
    assertEquals(fixity!.sha1[digestBytes(bytes, "sha1")], [
      "v1/content/a.txt",
    ]);

    const result = await validateStorageRoot(new LocalBackend(rootPath), { fullFixity: true });
    assertEquals(result.valid, true);
    assertEquals(result.objects[0].errors, []);
  });
});

Deno.test("blake2b-512 and sha512/256 fixity round-trip", async () => {
  const contents = "blake content\n";
  await withObject(
    contents,
    ["blake2b-512", "sha512/256"],
    async ({ rootPath, fixity }) => {
      const bytes = new TextEncoder().encode(contents);
      assertEquals(
        fixity!["blake2b-512"][digestBytes(bytes, "blake2b-512")],
        ["v1/content/a.txt"],
      );
      assertEquals(
        fixity!["sha512/256"][digestBytes(bytes, "sha512/256")],
        ["v1/content/a.txt"],
      );
      assertEquals(
        (await validateStorageRoot(new LocalBackend(rootPath), { fullFixity: true })).valid,
        true,
      );
    },
  );
});

Deno.test("a corrupted fixity digest is caught by full fixity only (E093)", async () => {
  await withObject("tamper me\n", ["md5"], async ({ objectPath }) => {
    const inventory = JSON.parse(
      await Deno.readTextFile(`${objectPath}/inventory.json`),
    );
    const md5 = inventory.fixity.md5 as Record<string, string[]>;
    const [digest, paths] = Object.entries(md5)[0];
    delete md5[digest];
    md5["0".repeat(32)] = paths;

    const bytes = serializeInventory(inventory);
    const backend = new LocalBackend(objectPath);
    await writeInventoryPair(backend, "", bytes, "sha512");
    await writeInventoryPair(backend, "v1", bytes, "sha512");

    assertEquals((await validateObject(backend, "")).errors, []);

    const fixity = await validateObject(backend, "", {
      fullFixity: true,
    });
    assertEquals(fixity.errors.map((issue) => issue.code), ["E093"]);
    assertEquals(
      fixity.errors[0].message.includes("md5 digest mismatch"),
      true,
    );
  });
});

Deno.test("an unsupported fixity algorithm is warned, not failed (E028)", async () => {
  await withObject("ignore me\n", [], async ({ objectPath }) => {
    const inventory = JSON.parse(
      await Deno.readTextFile(`${objectPath}/inventory.json`),
    );
    inventory.fixity = {
      "some-future-algorithm": { "abcdef": ["v1/content/a.txt"] },
    };
    const bytes = serializeInventory(inventory);
    const backend = new LocalBackend(objectPath);
    await writeInventoryPair(backend, "", bytes, "sha512");
    await writeInventoryPair(backend, "v1", bytes, "sha512");

    const result = await validateObject(backend, "", {
      fullFixity: true,
    });
    assertEquals(result.errors, []);
    assertEquals(result.warnings.map((issue) => issue.code), ["W004"]);
  });
});

Deno.test("a fixity path that does not exist is flagged (E093)", async () => {
  await withObject("missing path\n", [], async ({ objectPath }) => {
    const inventory = JSON.parse(
      await Deno.readTextFile(`${objectPath}/inventory.json`),
    );
    inventory.fixity = { md5: { "abcdef": ["v1/content/gone.txt"] } };
    const bytes = serializeInventory(inventory);
    const backend = new LocalBackend(objectPath);
    await writeInventoryPair(backend, "", bytes, "sha512");
    await writeInventoryPair(backend, "v1", bytes, "sha512");

    const result = await validateObject(backend, "", {
      fullFixity: true,
    });
    assertEquals(result.errors.map((issue) => issue.code), ["E093"]);
  });
});

Deno.test("fixity entries accumulate across versions", async () => {
  await withTempDir(async (dir) => {
    const rootPath = `${dir}/root`;
    const source = `${dir}/src`;
    await initStorageRoot(new LocalBackend(rootPath));
    await Deno.mkdir(source, { recursive: true });
    await Deno.writeTextFile(`${source}/a.txt`, "one\n");
    await commit(await openStorageRoot(new LocalBackend(rootPath)), {
      id: "urn:fixity:multi",
      sourcePath: source,
      user: USER,
      fixityAlgorithms: ["md5"],
    });

    await Deno.writeTextFile(`${source}/b.txt`, "two\n");
    await commit(await openStorageRoot(new LocalBackend(rootPath)), {
      id: "urn:fixity:multi",
      sourcePath: source,
      user: USER,
      fixityAlgorithms: ["md5"],
    });

    const object = await requireObject(
      await openStorageRoot(new LocalBackend(rootPath)),
      "urn:fixity:multi",
    );
    const md5 = object.inventory.fixity!.md5;
    assertEquals(Object.values(md5).flat().sort(), [
      "v1/content/a.txt",
      "v2/content/b.txt",
    ]);
    assertEquals(
      (await validateStorageRoot(new LocalBackend(rootPath), { fullFixity: true })).valid,
      true,
    );
  });
});

Deno.test("commit rejects an unsupported fixity algorithm", async () => {
  await withTempDir(async (dir) => {
    const rootPath = `${dir}/root`;
    const source = `${dir}/src`;
    await initStorageRoot(new LocalBackend(rootPath));
    await Deno.mkdir(source, { recursive: true });
    await Deno.writeTextFile(`${source}/a.txt`, "one\n");

    await assertRejects(
      async () =>
        commit(await openStorageRoot(new LocalBackend(rootPath)), {
          id: "urn:fixity:bad",
          sourcePath: source,
          user: USER,
          fixityAlgorithms: ["not-an-algorithm"],
        }),
      Error,
      "not supported",
    );
  });
});
