import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { buildNextState, walkSource } from "./state.ts";
import { digestBytes } from "./digest.ts";
import type { Inventory } from "./types.ts";
import { INVENTORY_TYPE_1_1 } from "./types.ts";
import { withTempDir } from "./test_util.ts";

/** Build a source tree and return its walked files. */
async function stage(dir: string, files: Record<string, string>) {
  for (const [path, contents] of Object.entries(files)) {
    const full = `${dir}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, contents);
  }
  return await walkSource(dir);
}

/** A v1 inventory whose manifest holds `contents` under `logicalPath`. */
function inventoryWith(
  contents: string,
  logicalPath: string,
  options: { uppercaseDigest?: boolean } = {},
): Inventory {
  const digest = digestBytes(new TextEncoder().encode(contents), "sha512");
  const key = options.uppercaseDigest === true ? digest.toUpperCase() : digest;
  return {
    id: "urn:test:state",
    type: INVENTORY_TYPE_1_1,
    digestAlgorithm: "sha512",
    head: "v1",
    manifest: { [key]: [`v1/content/${logicalPath}`] },
    versions: {
      v1: {
        created: "2026-07-31T12:00:00Z",
        state: { [key]: [logicalPath] },
      },
    },
  };
}

Deno.test("walkSource produces sorted logical paths for nested trees", async () => {
  await withTempDir(async (dir) => {
    const files = await stage(dir, {
      "z.txt": "z\n",
      "a/b/c.txt": "c\n",
      "a/a.txt": "a\n",
    });
    assertEquals(files.map((file) => file.logicalPath), [
      "a/a.txt",
      "a/b/c.txt",
      "z.txt",
    ]);
  });
});

Deno.test("buildNextState dedups against an uppercase manifest digest", async () => {
  await withTempDir(async (dir) => {
    const files = await stage(dir, { "keep.txt": "same\n" });
    const previous = inventoryWith("same\n", "keep.txt", {
      uppercaseDigest: true,
    });

    const next = await buildNextState(
      previous,
      files,
      "v2",
      "content",
      "sha512",
    );

    // The existing uppercase key is reused, not duplicated in a new case.
    assertEquals(next.newContent, []);
    assertEquals(Object.keys(next.manifest).length, 1);
    assertEquals(
      Object.keys(next.manifest)[0],
      Object.keys(previous.manifest)[0],
    );
    assertEquals(next.changed, false);
  });
});

Deno.test("buildNextState classifies additions, modifications, and deletions", async () => {
  await withTempDir(async (dir) => {
    const previous = inventoryWith("one\n", "a.txt");
    const files = await stage(dir, { "a.txt": "changed\n", "b.txt": "new\n" });

    const next = await buildNextState(
      previous,
      files,
      "v2",
      "content",
      "sha512",
    );

    assertEquals(next.modifiedPaths, ["a.txt"]);
    assertEquals(next.addedPaths, ["b.txt"]);
    assertEquals(next.deletedPaths, []);
    assertEquals(next.changed, true);
    assertEquals(next.newContent.map((entry) => entry.contentPath).sort(), [
      "v2/content/a.txt",
      "v2/content/b.txt",
    ]);
  });
});

Deno.test("buildNextState reports deletions for omitted paths", async () => {
  await withTempDir(async (dir) => {
    const previous = inventoryWith("one\n", "a.txt");
    const files = await stage(dir, { "b.txt": "new\n" });

    const next = await buildNextState(
      previous,
      files,
      "v2",
      "content",
      "sha512",
    );
    assertEquals(next.deletedPaths, ["a.txt"]);
    assertEquals(next.addedPaths, ["b.txt"]);
    // Manifest keeps the old entry — content stays recoverable.
    assertEquals(Object.keys(next.manifest).length, 2);
  });
});

Deno.test("buildNextState honors a non-default content directory", async () => {
  await withTempDir(async (dir) => {
    const files = await stage(dir, { "a.txt": "one\n" });
    const next = await buildNextState(null, files, "v1", "payload", "sha512");
    assertEquals(next.newContent[0].contentPath, "v1/payload/a.txt");
  });
});

Deno.test("walkSource rejects symlinks anywhere in the tree", async () => {
  await withTempDir(async (dir) => {
    await stage(dir, { "nested/a.txt": "one\n" });
    await Deno.symlink(`${dir}/nested/a.txt`, `${dir}/nested/link.txt`);
    await assertRejects(() => walkSource(dir), Error, "symbolic link");
  });
});

Deno.test("walkSource accepts an entirely empty source root", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await walkSource(dir), []);
  });
});
