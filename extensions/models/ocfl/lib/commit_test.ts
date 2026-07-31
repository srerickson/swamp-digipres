import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { commit, initStorageRoot, nowRfc3339 } from "./commit.ts";
import { HeadConflictError } from "./errors.ts";
import { bytesEqual } from "./inventory.ts";
import { openStorageRoot, requireObject } from "./object.ts";
import type { StorageRoot } from "./object.ts";
import { validateObject, validateStorageRoot } from "./validate.ts";
import { RFC3339_PATTERN } from "./types.ts";
import { withTempDir } from "./test_util.ts";

const USER = { name: "Test Runner", address: "mailto:test@example.com" };

/** Write a source tree from a `path -> contents` map. */
async function writeTree(
  base: string,
  files: Record<string, string>,
): Promise<string> {
  await Deno.remove(base, { recursive: true }).catch(() => {});
  for (const [path, contents] of Object.entries(files)) {
    const full = `${base}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, contents);
  }
  return base;
}

/** Set up an initialized storage root plus a scratch source directory. */
async function withRoot(
  body: (root: StorageRoot, source: string, rootPath: string) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const rootPath = `${dir}/root`;
    await initStorageRoot(rootPath);
    const root = await openStorageRoot(rootPath);
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await body(root, `${dir}/src`, rootPath);
  });
}

/** Snapshot every file under a directory as path -> digest-ish content. */
async function snapshotTree(dir: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  async function walk(current: string, prefix: string): Promise<void> {
    for await (const entry of Deno.readDir(current)) {
      const path = `${current}/${entry.name}`;
      const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory) await walk(path, key);
      else snapshot[key] = await Deno.readTextFile(path);
    }
  }
  await walk(dir, "");
  return snapshot;
}

Deno.test("nowRfc3339 emits second-granularity UTC (E049)", () => {
  const timestamp = nowRfc3339();
  assertEquals(RFC3339_PATTERN.test(timestamp), true, timestamp);
  assertEquals(timestamp.endsWith("Z"), true);
  assertEquals(timestamp.includes("."), false);
});

Deno.test("initStorageRoot produces a valid, empty storage root", async () => {
  await withTempDir(async (dir) => {
    const rootPath = `${dir}/root`;
    await initStorageRoot(rootPath);
    const result = await validateStorageRoot(rootPath);
    assertEquals(result.rootErrors, []);
    assertEquals(result.objects.length, 0);

    const root = await openStorageRoot(rootPath);
    assertEquals(root.specVersion, "1.1");
    assertEquals(root.layout?.name, "0004-hashed-n-tuple-storage-layout");
  });
});

Deno.test("initStorageRoot refuses a non-empty directory", async () => {
  await withTempDir(async (dir) => {
    await Deno.writeTextFile(`${dir}/existing.txt`, "hello\n");
    await assertRejects(() => initStorageRoot(dir));
  });
});

Deno.test("ingest creates a self-validating v1 object", async () => {
  await withRoot(async (root, source, rootPath) => {
    await writeTree(source, { "spec.md": "v1 body\n", "notes/a.txt": "a\n" });
    const result = await commit(root, {
      id: "urn:test:alpha",
      sourcePath: source,
      message: "Initial ingest",
      user: USER,
    });

    assertEquals(result.created, true);
    assertEquals(result.head, "v1");
    assertEquals(result.previousHead, null);
    assertEquals(result.addedPaths, ["notes/a.txt", "spec.md"]);
    assertEquals(result.newContentCount, 2);

    const validation = await validateStorageRoot(rootPath, {
      fullFixity: true,
    });
    assertEquals(validation.valid, true);
    for (const object of validation.objects) {
      assertEquals(object.errors, [], object.path);
      assertEquals(object.warnings, [], object.path);
    }

    const object = await requireObject(
      await openStorageRoot(rootPath),
      "urn:test:alpha",
    );
    assertEquals(object.inventory.head, "v1");
    assertEquals(object.inventory.versions.v1.message, "Initial ingest");
    assertEquals(object.inventory.versions.v1.user, USER);
    assertEquals(object.relativePath, root.layout!.resolve("urn:test:alpha"));
  });
});

Deno.test("the root inventory is a byte copy of the head version's (E064)", async () => {
  await withRoot(async (root, source, rootPath) => {
    await writeTree(source, { "a.txt": "one\n" });
    await commit(root, { id: "urn:test:beta", sourcePath: source, user: USER });

    const object = await requireObject(
      await openStorageRoot(rootPath),
      "urn:test:beta",
    );
    const rootBytes = await Deno.readFile(
      `${object.absolutePath}/inventory.json`,
    );
    const versionBytes = await Deno.readFile(
      `${object.absolutePath}/v1/inventory.json`,
    );
    assertEquals(bytesEqual(rootBytes, versionBytes), true);
  });
});

Deno.test("adding a file produces v2 and leaves v1 untouched", async () => {
  await withRoot(async (root, source, rootPath) => {
    await writeTree(source, { "a.txt": "one\n" });
    await commit(root, { id: "urn:test:add", sourcePath: source, user: USER });

    const reopened = await openStorageRoot(rootPath);
    const object = await requireObject(reopened, "urn:test:add");
    const before = await snapshotTree(`${object.absolutePath}/v1`);

    await writeTree(source, { "a.txt": "one\n", "b.txt": "two\n" });
    const result = await commit(reopened, {
      id: "urn:test:add",
      sourcePath: source,
      message: "Add b.txt",
      user: USER,
    });

    assertEquals(result.created, false);
    assertEquals(result.previousHead, "v1");
    assertEquals(result.head, "v2");
    assertEquals(result.addedPaths, ["b.txt"]);
    assertEquals(result.modifiedPaths, []);
    assertEquals(result.deletedPaths, []);
    assertEquals(result.newContentCount, 1);

    // Invariant 1: version directories are immutable.
    assertEquals(await snapshotTree(`${object.absolutePath}/v1`), before);
    assertEquals(
      (await validateStorageRoot(rootPath, { fullFixity: true })).valid,
      true,
    );
  });
});

Deno.test("modifying a file writes new content and keeps the old", async () => {
  await withRoot(async (root, source, rootPath) => {
    await writeTree(source, { "a.txt": "one\n" });
    await commit(root, { id: "urn:test:mod", sourcePath: source, user: USER });

    await writeTree(source, { "a.txt": "one modified\n" });
    const result = await commit(await openStorageRoot(rootPath), {
      id: "urn:test:mod",
      sourcePath: source,
      message: "Modify a.txt",
      user: USER,
    });

    assertEquals(result.modifiedPaths, ["a.txt"]);
    assertEquals(result.newContentCount, 1);

    const object = await requireObject(
      await openStorageRoot(rootPath),
      "urn:test:mod",
    );
    assertEquals(Object.keys(object.inventory.manifest).length, 2);
    assertEquals(
      await Deno.readTextFile(`${object.absolutePath}/v1/content/a.txt`),
      "one\n",
    );
    assertEquals(
      await Deno.readTextFile(`${object.absolutePath}/v2/content/a.txt`),
      "one modified\n",
    );
    assertEquals(
      (await validateStorageRoot(rootPath, { fullFixity: true })).valid,
      true,
    );
  });
});

Deno.test("unchanged content is deduplicated, writing no new content file", async () => {
  await withRoot(async (root, source, rootPath) => {
    await writeTree(source, { "keep.txt": "same\n" });
    await commit(root, {
      id: "urn:test:dedup",
      sourcePath: source,
      user: USER,
    });

    await writeTree(source, { "keep.txt": "same\n", "new.txt": "different\n" });
    const result = await commit(await openStorageRoot(rootPath), {
      id: "urn:test:dedup",
      sourcePath: source,
      user: USER,
    });

    assertEquals(result.newContentCount, 1);

    const object = await requireObject(
      await openStorageRoot(rootPath),
      "urn:test:dedup",
    );
    const v2Content = await snapshotTree(`${object.absolutePath}/v2/content`);
    assertEquals(Object.keys(v2Content), ["new.txt"]);

    // The unchanged file still resolves, via v1's content path.
    const state = object.inventory.versions.v2.state;
    const keepDigest = Object.entries(state).find(([, paths]) =>
      paths.includes("keep.txt")
    )![0];
    assertEquals(object.inventory.manifest[keepDigest], [
      "v1/content/keep.txt",
    ]);
    assertEquals((await validateStorageRoot(rootPath)).valid, true);
  });
});

Deno.test("two staged files with identical content share one content file", async () => {
  await withRoot(async (root, source, rootPath) => {
    await writeTree(source, { "one.txt": "same\n", "two.txt": "same\n" });
    const result = await commit(root, {
      id: "urn:test:twins",
      sourcePath: source,
      user: USER,
    });

    assertEquals(result.newContentCount, 1);
    const object = await requireObject(
      await openStorageRoot(rootPath),
      "urn:test:twins",
    );
    assertEquals(Object.keys(object.inventory.manifest).length, 1);
    assertEquals(Object.values(object.inventory.versions.v1.state)[0], [
      "one.txt",
      "two.txt",
    ]);
    assertEquals((await validateStorageRoot(rootPath)).valid, true);
  });
});

Deno.test("prior version blocks are carried forward unchanged (E066/W011)", async () => {
  await withRoot(async (root, source, rootPath) => {
    await writeTree(source, { "a.txt": "one\n" });
    await commit(root, {
      id: "urn:test:carry",
      sourcePath: source,
      message: "first",
      user: USER,
    });
    const first = await requireObject(
      await openStorageRoot(rootPath),
      "urn:test:carry",
    );
    const v1Block = structuredClone(first.inventory.versions.v1);

    await writeTree(source, { "a.txt": "one\n", "b.txt": "two\n" });
    await commit(await openStorageRoot(rootPath), {
      id: "urn:test:carry",
      sourcePath: source,
      message: "second",
      user: USER,
    });
    await writeTree(source, {
      "a.txt": "one\n",
      "b.txt": "two\n",
      "c.txt": "three\n",
    });
    await commit(await openStorageRoot(rootPath), {
      id: "urn:test:carry",
      sourcePath: source,
      message: "third",
      user: USER,
    });

    const third = await requireObject(
      await openStorageRoot(rootPath),
      "urn:test:carry",
    );
    assertEquals(third.inventory.head, "v3");
    assertEquals(third.inventory.versions.v1, v1Block);
    assertEquals((await validateStorageRoot(rootPath)).valid, true);
  });
});

Deno.test("a no-op commit is refused", async () => {
  await withRoot(async (root, source, rootPath) => {
    await writeTree(source, { "a.txt": "one\n" });
    await commit(root, { id: "urn:test:noop", sourcePath: source, user: USER });

    await assertRejects(
      async () =>
        commit(await openStorageRoot(rootPath), {
          id: "urn:test:noop",
          sourcePath: source,
          user: USER,
        }),
      Error,
      "identical to v1",
    );

    const object = await requireObject(
      await openStorageRoot(rootPath),
      "urn:test:noop",
    );
    assertEquals(object.inventory.head, "v1");
  });
});

Deno.test("a commit that drops a path is refused without allowDeletes", async () => {
  await withRoot(async (root, source, rootPath) => {
    await writeTree(source, { "a.txt": "one\n", "b.txt": "two\n" });
    await commit(root, { id: "urn:test:del", sourcePath: source, user: USER });

    await writeTree(source, { "a.txt": "one\n" });
    await assertRejects(
      async () =>
        commit(await openStorageRoot(rootPath), {
          id: "urn:test:del",
          sourcePath: source,
          user: USER,
        }),
      Error,
      "allowDeletes",
    );

    const object = await requireObject(
      await openStorageRoot(rootPath),
      "urn:test:del",
    );
    assertEquals(object.inventory.head, "v1");
    assertEquals(
      await Deno.readTextFile(`${object.absolutePath}/v1/content/b.txt`),
      "two\n",
    );
  });
});

Deno.test("allowDeletes performs an OCFL logical deletion", async () => {
  await withRoot(async (root, source, rootPath) => {
    await writeTree(source, { "a.txt": "one\n", "b.txt": "two\n" });
    await commit(root, {
      id: "urn:test:logdel",
      sourcePath: source,
      user: USER,
    });

    await writeTree(source, { "a.txt": "one\n" });
    const result = await commit(await openStorageRoot(rootPath), {
      id: "urn:test:logdel",
      sourcePath: source,
      message: "Remove b.txt",
      user: USER,
      allowDeletes: true,
    });
    assertEquals(result.deletedPaths, ["b.txt"]);

    const object = await requireObject(
      await openStorageRoot(rootPath),
      "urn:test:logdel",
    );
    const v2Paths = Object.values(object.inventory.versions.v2.state).flat();
    assertEquals(v2Paths, ["a.txt"]);

    // Content and prior state remain recoverable.
    const v1Paths = Object.values(object.inventory.versions.v1.state).flat()
      .sort();
    assertEquals(v1Paths, ["a.txt", "b.txt"]);
    assertEquals(
      await Deno.readTextFile(`${object.absolutePath}/v1/content/b.txt`),
      "two\n",
    );
    assertEquals(Object.keys(object.inventory.manifest).length, 2);
    assertEquals(
      (await validateStorageRoot(rootPath, { fullFixity: true })).valid,
      true,
    );
  });
});

Deno.test("committing an empty source tree to an existing object needs allowDeletes", async () => {
  await withRoot(async (root, source, rootPath) => {
    await writeTree(source, { "a.txt": "one\n" });
    await commit(root, {
      id: "urn:test:empty",
      sourcePath: source,
      user: USER,
    });

    await Deno.remove(source, { recursive: true });
    await Deno.mkdir(source, { recursive: true });
    await assertRejects(
      async () =>
        commit(await openStorageRoot(rootPath), {
          id: "urn:test:empty",
          sourcePath: source,
          user: USER,
        }),
      Error,
      "allowDeletes",
    );
  });
});

Deno.test("creating an object from an empty source tree is refused", async () => {
  await withRoot(async (root, source) => {
    await assertRejects(
      () =>
        commit(root, { id: "urn:test:void", sourcePath: source, user: USER }),
      Error,
      "empty source tree",
    );
  });
});

Deno.test("a symlink in the source tree is rejected (E090)", async () => {
  await withRoot(async (root, source) => {
    await writeTree(source, { "a.txt": "one\n" });
    await Deno.symlink(`${source}/a.txt`, `${source}/link.txt`);
    await assertRejects(
      () =>
        commit(root, { id: "urn:test:link", sourcePath: source, user: USER }),
      Error,
      "symbolic link",
    );
  });
});

Deno.test("an empty directory in the source tree is rejected (E024)", async () => {
  await withRoot(async (root, source) => {
    await writeTree(source, { "a.txt": "one\n" });
    await Deno.mkdir(`${source}/empty`, { recursive: true });
    await assertRejects(
      () =>
        commit(root, {
          id: "urn:test:emptydir",
          sourcePath: source,
          user: USER,
        }),
      Error,
      "empty directory",
    );
  });
});

Deno.test("commit follows a zero-padded version convention", async () => {
  await withRoot(async (root, source, rootPath) => {
    await writeTree(source, { "a.txt": "one\n" });
    await commit(root, {
      id: "urn:test:padded",
      sourcePath: source,
      user: USER,
    });

    // Rewrite the object to use v0001 naming, as another implementation might.
    const object = await requireObject(
      await openStorageRoot(rootPath),
      "urn:test:padded",
    );
    await Deno.rename(
      `${object.absolutePath}/v1`,
      `${object.absolutePath}/v0001`,
    );
    const inventory = JSON.parse(
      await Deno.readTextFile(`${object.absolutePath}/inventory.json`),
    );
    const text = JSON.stringify(inventory)
      .replaceAll('"v1"', '"v0001"')
      .replaceAll("v1/content/", "v0001/content/");
    const rewritten = JSON.parse(text);
    const { serializeInventory, writeInventoryPair } = await import(
      "./inventory.ts"
    );
    const bytes = serializeInventory(rewritten);
    await writeInventoryPair(object.absolutePath, bytes, "sha512");
    await writeInventoryPair(`${object.absolutePath}/v0001`, bytes, "sha512");
    assertEquals((await validateStorageRoot(rootPath)).objects[0].errors, []);

    await writeTree(source, { "a.txt": "one\n", "b.txt": "two\n" });
    const result = await commit(await openStorageRoot(rootPath), {
      id: "urn:test:padded",
      sourcePath: source,
      user: USER,
    });
    assertEquals(result.head, "v0002");
    assertEquals(
      (await validateStorageRoot(rootPath, { fullFixity: true })).valid,
      true,
    );
  });
});

Deno.test("a head that moves during staging aborts the commit", async () => {
  await withRoot(async (root, source, rootPath) => {
    await writeTree(source, { "a.txt": "one\n" });
    await commit(root, { id: "urn:test:race", sourcePath: source, user: USER });

    const reopened = await openStorageRoot(rootPath);
    const object = await requireObject(reopened, "urn:test:race");
    const beforeRace = await snapshotTree(object.absolutePath);

    await writeTree(source, { "a.txt": "one\n", "b.txt": "two\n" });
    const conflict = await assertRejects(
      () =>
        commit(reopened, {
          id: "urn:test:race",
          sourcePath: source,
          user: USER,
          onFinalizeStep: async (step) => {
            if (step !== "before-finalize") return;
            // Simulate a concurrent writer landing v2 first.
            const other = `${source}-other`;
            await writeTree(other, { "a.txt": "one\n", "c.txt": "three\n" });
            await commit(await openStorageRoot(rootPath), {
              id: "urn:test:race",
              sourcePath: other,
              user: USER,
            });
          },
        }),
      HeadConflictError,
    );
    assertEquals(conflict.expectedHead, "v1");

    // The losing commit wrote nothing of its own; the winner's v2 stands.
    const after = await requireObject(
      await openStorageRoot(rootPath),
      "urn:test:race",
    );
    assertEquals(after.inventory.head, "v2");
    const v2Paths = Object.values(after.inventory.versions.v2.state).flat()
      .sort();
    assertEquals(v2Paths, ["a.txt", "c.txt"]);
    assertEquals(Object.keys(beforeRace).length > 0, true);
    assertEquals((await validateStorageRoot(rootPath)).valid, true);
  });
});

Deno.test("a crash after moving the version directory leaves the old head readable", async () => {
  await withRoot(async (root, source, rootPath) => {
    await writeTree(source, { "a.txt": "one\n" });
    await commit(root, {
      id: "urn:test:crash",
      sourcePath: source,
      user: USER,
    });

    await writeTree(source, { "a.txt": "one\n", "b.txt": "two\n" });
    await assertRejects(async () =>
      commit(await openStorageRoot(rootPath), {
        id: "urn:test:crash",
        sourcePath: source,
        user: USER,
        onFinalizeStep: (step) => {
          if (step === "after-version-move") throw new Error("simulated crash");
        },
      })
    );

    // The root inventory still describes v1 and still verifies.
    const object = await requireObject(
      await openStorageRoot(rootPath),
      "urn:test:crash",
    );
    assertEquals(object.inventory.head, "v1");
    assertEquals(
      await Deno.readTextFile(`${object.absolutePath}/v1/content/a.txt`),
      "one\n",
    );
  });
});

Deno.test("a crash between root inventory and sidecar is reported as recoverable", async () => {
  await withRoot(async (root, source, rootPath) => {
    await writeTree(source, { "a.txt": "one\n" });
    await commit(root, {
      id: "urn:test:window",
      sourcePath: source,
      user: USER,
    });

    await writeTree(source, { "a.txt": "one\n", "b.txt": "two\n" });
    await assertRejects(async () =>
      commit(await openStorageRoot(rootPath), {
        id: "urn:test:window",
        sourcePath: source,
        user: USER,
        onFinalizeStep: (step) => {
          if (step === "after-root-inventory") {
            throw new Error("simulated crash");
          }
        },
      })
    );

    const objectPath = `${rootPath}/${root.layout!.resolve("urn:test:window")}`;
    const result = await validateObject(objectPath, "object");
    assertEquals(result.valid, false);
    assertEquals(result.errors.map((issue) => issue.code), ["E060"]);
    assertEquals(result.recoverable, true);
  });
});

Deno.test("a staging directory on another filesystem is rejected", async () => {
  await withRoot(async (root, source) => {
    await writeTree(source, { "a.txt": "one\n" });
    const otherDevice = "/dev/shm/ocfl-staging-test";
    const usable = await Deno.stat("/dev/shm").then((info) => info.isDirectory)
      .catch(() => false);
    if (!usable) return;

    const rootDevice = (await Deno.stat(root.path)).dev;
    const shmDevice = (await Deno.stat("/dev/shm")).dev;
    if (rootDevice === shmDevice) return;

    try {
      await assertRejects(
        () =>
          commit(root, {
            id: "urn:test:device",
            sourcePath: source,
            user: USER,
            stagingDir: otherDevice,
          }),
        Error,
        "different filesystem",
      );
    } finally {
      await Deno.remove(otherDevice, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("commit refuses when an intermediate directory holds a file (E084)", async () => {
  await withRoot(async (root, source, rootPath) => {
    const relative = root.layout!.resolve("urn:test:hierarchy");
    const intermediate = `${rootPath}/${relative.split("/")[0]}`;
    await Deno.mkdir(intermediate, { recursive: true });
    await Deno.writeTextFile(`${intermediate}/stray.txt`, "stray\n");

    await writeTree(source, { "a.txt": "one\n" });
    await assertRejects(
      () =>
        commit(root, {
          id: "urn:test:hierarchy",
          sourcePath: source,
          user: USER,
        }),
      Error,
      "intermediate directories",
    );
  });
});
