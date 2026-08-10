/**
 * Tests for staging object content on disk.
 *
 * The checked-in fixture has neither nested logical paths nor two logical paths
 * sharing a digest within one version, so most tests here build the object they
 * export through the write path, the way `commit_test.ts` does. One test reads
 * the real fixture, to prove the export path works against bytes this code did
 * not write.
 *
 * Run against both backends: an export from S3 and an export from local disk
 * must produce the same tree.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { digestBytes } from "./digest.ts";
import { OcflError } from "./errors.ts";
import { planExport, runExport } from "./export.ts";
import { findObject } from "./object.ts";
import { openStorageRoot, type StorageRoot } from "./root.ts";
import { LocalStorage } from "./storage/local.ts";
import type { Bytes, Entry, Storage } from "./storage/types.ts";
import { joinPath } from "./storage/types.ts";
import { commit as commitTo, forEachBackend, type Harness } from "./testing.ts";

const ID = "urn:example:export-1";

const FIXTURE =
  new URL("../../../../testdata/fixtures/ocfl-root", import.meta.url).pathname;

/** Commit a version, against this file's object. */
function commit(
  root: StorageRoot,
  ops: string[],
  options: Record<string, unknown> = {},
) {
  return commitTo(root, ID, ops, options);
}

/** Plan and run an export in one step. */
async function exportTo(
  root: StorageRoot,
  dest: string,
  options: { version?: string; only?: string; concurrency?: number } = {},
) {
  const plan = await planExport(root, {
    id: ID,
    dest,
    version: options.version,
    only: options.only,
  });
  return await runExport(root, plan, { concurrency: options.concurrency });
}

/** Every file beneath `dir`, as `/`-separated paths relative to it, sorted. */
async function tree(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string, prefix: string) => {
    for await (const entry of Deno.readDir(current)) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(`${current}/${entry.name}`, relative);
      } else {
        found.push(relative);
      }
    }
  };
  await walk(dir, "");
  return found.sort();
}

/** A storage wrapper that counts content reads. */
function counting(storage: Storage): Storage & { readStreams: () => number } {
  let readStreams = 0;
  return {
    readStreams: () => readStreams,
    backend: storage.backend,
    location: storage.location,
    read: (path: string): Promise<Bytes> => storage.read(path),
    readStream: (path: string) => {
      readStreams += 1;
      return storage.readStream(path);
    },
    exists: (path: string): Promise<boolean> => storage.exists(path),
    listDir: (path: string): Promise<Entry[]> => storage.listDir(path),
    walkFiles: (prefix: string) => storage.walkFiles(prefix),
    write: (path: string, bytes: Bytes) => storage.write(path, bytes),
    writeAtomic: (path: string, bytes: Bytes) =>
      storage.writeAtomic(path, bytes),
    writeStream: (
      path: string,
      body: ReadableStream<Uint8Array>,
      options?: { size?: number },
    ) => storage.writeStream(path, body, options),
    remove: (path: string) => storage.remove(path),
    pruneEmptyDirs: (prefix: string) =>
      storage.pruneEmptyDirs?.(prefix) ??
        Promise.resolve(),
  };
}

/** Re-open a harness's root through a read-counting storage wrapper. */
async function countingRoot(harness: Harness) {
  const storage = counting(harness.root.storage);
  return { storage, root: await openStorageRoot(storage) };
}

forEachBackend(
  "exports a whole version, reconstructing nested logical paths",
  async ({ root, source, scratch }) => {
    await commit(root, [
      `add:${await source("a.txt", "alpha")}:a.txt`,
      `add:${await source("b.txt", "bravo")}:docs/b.txt`,
      `add:${await source("c.txt", "charlie")}:docs/deep/c.txt`,
    ]);

    const dest = await scratch();
    const files = await exportTo(root, dest);

    assertEquals(await tree(dest), ["a.txt", "docs/b.txt", "docs/deep/c.txt"]);
    assertEquals(await Deno.readTextFile(`${dest}/docs/deep/c.txt`), "charlie");
    assertEquals(files.map((file) => file.logicalPath), [
      "a.txt",
      "docs/b.txt",
      "docs/deep/c.txt",
    ]);
    assertEquals(files.map((file) => file.destPath), [
      `${dest}/a.txt`,
      `${dest}/docs/b.txt`,
      `${dest}/docs/deep/c.txt`,
    ]);
    assertEquals(files.map((file) => file.source), [
      "fetched",
      "fetched",
      "fetched",
    ]);
    assert(files.every((file) => file.verified));
    assertEquals(files.map((file) => file.size), [5, 5, 7]);
  },
);

forEachBackend(
  "only exports one logical path, at its full logical path",
  async ({ root, source, scratch }) => {
    await commit(root, [
      `add:${await source("a.txt", "alpha")}:a.txt`,
      `add:${await source("b.txt", "bravo")}:docs/b.txt`,
    ]);

    const dest = await scratch();
    const files = await exportTo(root, dest, { only: "docs/b.txt" });

    // Not `${dest}/b.txt` — dest is the object-root base with or without `only`.
    assertEquals(await tree(dest), ["docs/b.txt"]);
    assertEquals(files.length, 1);
    assertEquals(files[0].destPath, `${dest}/docs/b.txt`);
  },
);

forEachBackend(
  "only naming a path the version does not hold is an error",
  async ({ root, source, scratch }) => {
    await commit(root, [`add:${await source("a.txt", "alpha")}:a.txt`]);
    const dest = await scratch();

    const error = await assertRejects(
      () => exportTo(root, dest, { only: "docs/nope.txt" }),
      OcflError,
    );
    assert(error.message.includes("docs/nope.txt"));
    assert(error.message.includes("1 file(s)"));
    // Silently succeeding with zero files is the failure mode this prevents.
    assertEquals(await tree(dest), []);
  },
);

forEachBackend(
  "exports a non-head version, and head by default",
  async ({ root, source, scratch }) => {
    await commit(root, [`add:${await source("a.txt", "first")}:a.txt`]);
    await commit(root, [`add:${await source("a2.txt", "second")}:a.txt`]);

    const head = await scratch();
    await exportTo(root, head);
    assertEquals(await Deno.readTextFile(`${head}/a.txt`), "second");

    const v1 = await scratch();
    await exportTo(root, v1, { version: "v1" });
    assertEquals(await Deno.readTextFile(`${v1}/a.txt`), "first");
  },
);

forEachBackend(
  "an unknown version is rejected before anything is written",
  async ({ root, source, scratch }) => {
    await commit(root, [`add:${await source("a.txt", "alpha")}:a.txt`]);
    const dest = await scratch();

    await assertRejects(
      () => exportTo(root, dest, { version: "v9" }),
      OcflError,
    );
    assertEquals(await tree(dest), []);
  },
);

forEachBackend(
  "two logical paths sharing a digest cause one read, not two",
  async (harness) => {
    const { root, source, scratch } = harness;
    // Same bytes at two logical paths: one manifest entry, one content file.
    const identical = "identical bytes";
    await commit(root, [
      `add:${await source("one.txt", identical)}:one.txt`,
      `add:${await source("two.txt", identical)}:copies/two.txt`,
    ]);

    const dest = await scratch();
    const { storage, root: counted } = await countingRoot(harness);
    const plan = await planExport(counted, { id: ID, dest });
    const files = await runExport(counted, plan);

    assertEquals(storage.readStreams(), 1);
    // Sorted by logical path, so `copies/two.txt` is first and does the fetch.
    assertEquals(files.map((file) => file.logicalPath), [
      "copies/two.txt",
      "one.txt",
    ]);
    assertEquals(files.map((file) => file.source), ["fetched", "copied"]);
    assertEquals(await tree(dest), ["copies/two.txt", "one.txt"]);
    assertEquals(await Deno.readTextFile(`${dest}/one.txt`), identical);
    assertEquals(await Deno.readTextFile(`${dest}/copies/two.txt`), identical);
    assert(files.every((file) => file.verified));
  },
);

forEachBackend(
  "re-exporting leaves a deduplicated copy alone too",
  async (harness) => {
    const { root, source, scratch } = harness;
    const identical = "identical bytes";
    await commit(root, [
      `add:${await source("one.txt", identical)}:one.txt`,
      `add:${await source("two.txt", identical)}:copies/two.txt`,
    ]);

    const dest = await scratch();
    await exportTo(root, dest);
    const before = await Promise.all(
      ["one.txt", "copies/two.txt"].map(async (path) =>
        (await Deno.stat(`${dest}/${path}`)).mtime?.getTime()
      ),
    );

    // The copy is subject to the same skip-if-already-right rule as the fetch
    // it duplicates; re-running must not rewrite it.
    const { storage, root: counted } = await countingRoot(harness);
    const plan = await planExport(counted, { id: ID, dest });
    const files = await runExport(counted, plan);

    assertEquals(storage.readStreams(), 0);
    assertEquals(files.map((file) => file.source), ["existing", "existing"]);
    const after = await Promise.all(
      ["one.txt", "copies/two.txt"].map(async (path) =>
        (await Deno.stat(`${dest}/${path}`)).mtime?.getTime()
      ),
    );
    assertEquals(after, before);
  },
);

forEachBackend(
  "a corrupted deduplicated copy is replaced, not reported as existing",
  async ({ root, source, scratch }) => {
    const identical = "identical bytes";
    await commit(root, [
      `add:${await source("one.txt", identical)}:one.txt`,
      `add:${await source("two.txt", identical)}:copies/two.txt`,
    ]);

    const dest = await scratch();
    await exportTo(root, dest);
    // `one.txt` is the duplicate: truncate it the way an interrupted write
    // would have.
    await Deno.writeTextFile(`${dest}/one.txt`, "ident");

    const files = await exportTo(root, dest);

    assertEquals(files.map((file) => file.source), ["existing", "copied"]);
    assertEquals(await Deno.readTextFile(`${dest}/one.txt`), identical);
    assertEquals(await tree(dest), ["copies/two.txt", "one.txt"]);
  },
);

forEachBackend(
  "a deduplicated copy is verified, and a bad one places nothing",
  async ({ root, source, scratch }) => {
    const identical = "identical bytes";
    await commit(root, [
      `add:${await source("one.txt", identical)}:one.txt`,
      `add:${await source("two.txt", identical)}:copies/two.txt`,
    ]);

    const dest = await scratch();
    const plan = await planExport(root, { id: ID, dest });

    // Point the copy at bytes that are not the ones the manifest records — what
    // a source modified between the fetch pass and the copy pass looks like.
    // Copies used to inherit their source's verification on trust.
    const copy = plan.entries.find((entry) => entry.copyFrom !== undefined);
    assert(copy !== undefined);
    copy.copyFrom = await source("tampered.txt", "not the identical bytes");

    const error = await assertRejects(() => runExport(root, plan), OcflError);
    assertEquals(error.code, "E092");
    assert(error.message.includes("one.txt"));

    // The fetch landed; the copy left neither a bad file nor a temp file.
    const placed = await tree(dest);
    assertEquals(placed, ["copies/two.txt"]);
    assertEquals(placed.filter((path) => path.includes(".part")), []);
  },
);

forEachBackend(
  "a version whose state is empty exports no files",
  async ({ root, source, scratch }) => {
    await commit(root, [`add:${await source("a.txt", "alpha")}:a.txt`]);
    await commit(root, ["remove:a.txt"]);

    const dest = await scratch();
    const plan = await planExport(root, { id: ID, dest });
    assertEquals(plan.version, "v2");
    assertEquals(plan.entries, []);

    // Removing every file leaves a legitimate version, not an unexportable one.
    assertEquals(await runExport(root, plan), []);
    assertEquals(await tree(dest), []);
  },
);

forEachBackend(
  "a directory sitting at a logical file's destination is reported by path",
  async ({ root, source, scratch }) => {
    await commit(root, [`add:${await source("a.txt", "alpha")}:a.txt`]);

    const dest = await scratch();
    // Left behind by staging a version where `a.txt` was itself a directory.
    await Deno.mkdir(`${dest}/a.txt`);

    const error = await assertRejects(() => exportTo(root, dest), OcflError);
    assert(error.message.includes("a.txt"));
    assert(error.message.includes("is a directory"));
  },
);

forEachBackend(
  "a destination is one destination however it is spelled",
  async ({ root, source, scratch }) => {
    await commit(root, [`add:${await source("a.txt", "alpha")}:a.txt`]);
    const dest = await scratch();

    // The export resource's instance name digests `plan.dest`, so a trailing
    // or doubled slash must not mint a second manifest for one directory.
    for (const spelling of [dest, `${dest}/`, `${dest}//`, `${dest}/`]) {
      const plan = await planExport(root, { id: ID, dest: spelling });
      assertEquals(plan.dest, dest);
      assertEquals(plan.entries[0].destPath, `${dest}/a.txt`);
    }
  },
);

forEachBackend(
  "a digest mismatch fails and leaves nothing at the destination",
  async ({ root, source, scratch }) => {
    const plan = await commit(root, [
      `add:${await source("a.txt", "alpha")}:a.txt`,
      `add:${await source("b.txt", "bravo")}:b.txt`,
    ]);

    // Corrupt one content file behind the inventory's back — exactly what an
    // export is expected to catch on the way past.
    const corrupt = plan.content.find((entry) =>
      entry.contentPath.endsWith("a.txt")
    );
    assert(corrupt !== undefined);
    await root.storage.write(
      joinPath(plan.objectPath, corrupt.contentPath),
      new TextEncoder().encode("tampered") as Bytes,
    );

    const dest = await scratch();
    const error = await assertRejects(
      () => exportTo(root, dest, { concurrency: 1 }),
      OcflError,
    );
    assertEquals(error.code, "E092");

    // The bad file is absent, and no partial write survives it.
    const placed = await tree(dest);
    assertEquals(placed.includes("a.txt"), false);
    assertEquals(placed.filter((path) => path.includes(".part")), []);
  },
);

forEachBackend(
  "re-exporting skips files already present, without re-reading them",
  async (harness) => {
    const { root, source, scratch } = harness;
    await commit(root, [
      `add:${await source("a.txt", "alpha")}:a.txt`,
      `add:${await source("b.txt", "bravo")}:docs/b.txt`,
    ]);

    const dest = await scratch();
    await exportTo(root, dest);
    const before = await Promise.all(
      ["a.txt", "docs/b.txt"].map(async (path) =>
        (await Deno.stat(`${dest}/${path}`)).mtime?.getTime()
      ),
    );

    const { storage, root: counted } = await countingRoot(harness);
    const plan = await planExport(counted, { id: ID, dest });
    const files = await runExport(counted, plan);

    assertEquals(storage.readStreams(), 0);
    assertEquals(files.map((file) => file.source), ["existing", "existing"]);
    assert(files.every((file) => file.verified));
    const after = await Promise.all(
      ["a.txt", "docs/b.txt"].map(async (path) =>
        (await Deno.stat(`${dest}/${path}`)).mtime?.getTime()
      ),
    );
    assertEquals(after, before);
  },
);

forEachBackend(
  "a destination file whose bytes differ is overwritten",
  async ({ root, source, scratch }) => {
    await commit(root, [`add:${await source("a.txt", "alpha")}:a.txt`]);

    const dest = await scratch();
    await Deno.writeTextFile(`${dest}/a.txt`, "stale contents");

    const files = await exportTo(root, dest);
    assertEquals(await Deno.readTextFile(`${dest}/a.txt`), "alpha");
    assertEquals(files[0].source, "fetched");
    assertEquals(await tree(dest), ["a.txt"]);
  },
);

forEachBackend(
  "a destination that is a regular file is rejected at plan time",
  async ({ root, source, scratch }) => {
    await commit(root, [`add:${await source("a.txt", "alpha")}:a.txt`]);
    const dir = await scratch();
    const dest = `${dir}/not-a-directory`;
    await Deno.writeTextFile(dest, "occupied");

    const error = await assertRejects(
      () => planExport(root, { id: ID, dest }),
      OcflError,
    );
    assert(error.message.includes("not a directory"));
    assertEquals(await Deno.readTextFile(dest), "occupied");
  },
);

forEachBackend(
  "a relative destination is rejected",
  async ({ root, source }) => {
    await commit(root, [`add:${await source("a.txt", "alpha")}:a.txt`]);
    const error = await assertRejects(
      () => planExport(root, { id: ID, dest: "relative/staging" }),
      OcflError,
    );
    assert(error.message.includes("absolute"));
  },
);

forEachBackend(
  "a missing object fails before the destination is created",
  async ({ root, scratch }) => {
    const dir = await scratch();
    const dest = `${dir}/never-created`;
    await assertRejects(
      () => planExport(root, { id: "urn:example:nope", dest }),
      OcflError,
    );
    assertEquals(await tree(dir), []);
  },
);

forEachBackend(
  "concurrent downloads preserve manifest order and clean up on failure",
  async ({ root, source, scratch }) => {
    const ops: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const name = `file-${String(index).padStart(2, "0")}.txt`;
      ops.push(`add:${await source(name, `contents ${index}`)}:docs/${name}`);
    }
    const plan = await commit(root, ops);

    const dest = await scratch();
    const files = await exportTo(root, dest, { concurrency: 6 });

    // Completion order is not plan order, but the manifest must be.
    const logicalPaths = files.map((file) => file.logicalPath);
    assertEquals(logicalPaths, [...logicalPaths].sort());
    assertEquals(logicalPaths.length, 12);
    assertEquals((await tree(dest)).length, 12);

    // Now corrupt two of them and fail a concurrent run part-way through.
    const failing = await scratch();
    for (const entry of plan.content.slice(0, 2)) {
      await root.storage.write(
        joinPath(plan.objectPath, entry.contentPath),
        new TextEncoder().encode("tampered") as Bytes,
      );
    }
    await assertRejects(
      () => exportTo(root, failing, { concurrency: 6 }),
      OcflError,
    );
    const survivors = await tree(failing);
    assertEquals(survivors.filter((path) => path.includes(".part")), []);
    assert(
      survivors.length < 12,
      "the corrupted files must not have been placed",
    );
  },
);

Deno.test("exports a real fixture object, verifying against its inventory", async () => {
  const root = await openStorageRoot(new LocalStorage(FIXTURE));
  const id = "urn:swamp-premis:premis-data-dictionary";
  const dest = await Deno.makeTempDir({ prefix: "ocfl-export-fixture-" });
  try {
    const plan = await planExport(root, { id, dest });
    const files = await runExport(root, plan);

    assertEquals(plan.version, "v2");
    assertEquals(await tree(dest), [
      "data-dictionary.pdf",
      "hierarchical-outline.md",
    ]);

    // The digest recorded in the manifest is the digest of what landed.
    const object = await findObject(root, id);
    for (const file of files) {
      const bytes = await Deno.readFile(file.destPath);
      assertEquals(
        digestBytes(bytes, object.inventory.digestAlgorithm),
        file.digest.toLowerCase(),
      );
      assertEquals(bytes.byteLength, file.size);
      assert(file.verified);
    }
  } finally {
    await Deno.remove(dest, { recursive: true });
  }
});
