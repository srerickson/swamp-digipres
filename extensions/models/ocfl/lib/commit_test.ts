/**
 * Round-trip tests for the write path.
 *
 * Every test builds a version and then reads it back through the *read* path —
 * `openObjectAt`, `readInventory`, `resolveState` — rather than inspecting what
 * the writer believes it did. `readInventory` verifies each inventory against
 * its sidecar (E058–E061), so a successful read-back is itself the assertion
 * that the commit produced a coherent object.
 *
 * Run against both backends, so the write path is proven not to depend on one.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { commitVersion, planVersion } from "./commit.ts";
import { digestBytes } from "./digest.ts";
import { OcflError } from "./errors.ts";
import { readInventory, sidecarName } from "./inventory.ts";
import { HASHED_N_TUPLE } from "./layout.ts";
import { openObjectAt, resolveState } from "./object.ts";
import { parseOps } from "./ops.ts";
import { initStorageRoot, type StorageRoot } from "./root.ts";
import { LocalStorage } from "./storage/local.ts";
import { MemoryStorage } from "./storage/memory.ts";
import type { Bytes, Entry, Storage } from "./storage/types.ts";
import { joinPath } from "./storage/types.ts";

const ID = "urn:example:obj-1";
const USER = { userName: "Test Agent", userAddress: "mailto:test@example.com" };

/** A disposable storage root plus a scratch directory to source files from. */
type Harness = {
  root: StorageRoot;
  /** Write a source file and return its absolute path. */
  source(name: string, contents: string): Promise<string>;
  cleanup(): Promise<void>;
};

async function harness(backend: "memory" | "local"): Promise<Harness> {
  const sourceDir = await Deno.makeTempDir({ prefix: "ocfl-src-" });
  const dirs = [sourceDir];

  let storage: Storage;
  if (backend === "memory") {
    storage = new MemoryStorage();
  } else {
    const rootDir = await Deno.makeTempDir({ prefix: "ocfl-root-" });
    dirs.push(rootDir);
    storage = new LocalStorage(rootDir);
  }

  const { root } = await initStorageRoot(storage, { layout: HASHED_N_TUPLE });
  return {
    root,
    async source(name, contents) {
      const path = `${sourceDir}/${name}`;
      await Deno.writeTextFile(path, contents);
      return path;
    },
    async cleanup() {
      for (const dir of dirs) {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
    },
  };
}

/** Register one test per backend. */
function forEachBackend(
  name: string,
  run: (harness: Harness) => Promise<void>,
): void {
  for (const backend of ["memory", "local"] as const) {
    Deno.test(`${name} (${backend})`, async () => {
      const context = await harness(backend);
      try {
        await run(context);
      } finally {
        await context.cleanup();
      }
    });
  }
}

/** Plan and commit in one step, with the required provenance filled in. */
async function commit(
  root: StorageRoot,
  ops: string[],
  options: Record<string, unknown> = {},
) {
  const plan = await planVersion(root, {
    id: ID,
    ops: parseOps(ops),
    ...USER,
    ...options,
  });
  await commitVersion(root, plan);
  return plan;
}

forEachBackend("creates a new object at v1", async ({ root, source }) => {
  const plan = await commit(root, [
    `add:${await source("a.txt", "alpha")}:a.txt`,
    `add:${await source("b.txt", "bravo")}:docs/b.txt`,
  ], { message: "initial deposit" });

  assertEquals(plan.isNew, true);
  assertEquals(plan.version, "v1");
  assertEquals(plan.specVersion, "1.1");
  assertEquals(plan.digestAlgorithm, "sha512");

  const object = await openObjectAt(root, plan.objectPath);
  assertEquals(object.inventory.id, ID);
  assertEquals(object.inventory.head, "v1");
  assertEquals(object.specVersion, "1.1");

  const state = resolveState(object.inventory, "v1");
  assertEquals(state.map((file) => file.logicalPath), ["a.txt", "docs/b.txt"]);
  assertEquals(state[0].contentPaths, ["v1/content/a.txt"]);
  assertEquals(state[1].contentPaths, ["v1/content/docs/b.txt"]);

  const block = object.inventory.versions["v1"];
  assertEquals(block.message, "initial deposit");
  assertEquals(block.user?.name, USER.userName);
  assertEquals(block.user?.address, USER.userAddress);
  // RFC 3339 with a timezone (§3.5.3, E049).
  assert(/T.*(Z|[+-]\d{2}:\d{2})$/.test(block.created), block.created);
});

forEachBackend(
  "writes content whose bytes match the manifest digest",
  async ({ root, source }) => {
    const plan = await commit(root, [
      `add:${await source("a.txt", "alpha")}:a.txt`,
    ]);
    const object = await openObjectAt(root, plan.objectPath);
    for (const [digest, paths] of Object.entries(object.inventory.manifest)) {
      for (const path of paths) {
        const bytes = await root.storage.read(joinPath(plan.objectPath, path));
        assertEquals(digestBytes(bytes, "sha512"), digest);
      }
    }
  },
);

forEachBackend(
  "root inventory is byte-identical to the head version's (E064)",
  async ({ root, source }) => {
    const plan = await commit(root, [
      `add:${await source("a.txt", "alpha")}:a.txt`,
    ]);
    const storage = root.storage;
    const rootBytes = await storage.read(
      joinPath(plan.objectPath, "inventory.json"),
    );
    const versionBytes = await storage.read(
      joinPath(plan.objectPath, "v1", "inventory.json"),
    );
    assertEquals(rootBytes, versionBytes);

    // Both sidecars must digest those exact bytes, and readInventory enforces
    // it — so reading both locations proves E058–E061 as well.
    const sidecar = sidecarName("sha512");
    assertEquals(
      new TextDecoder().decode(
        await storage.read(joinPath(plan.objectPath, sidecar)),
      ),
      new TextDecoder().decode(
        await storage.read(joinPath(plan.objectPath, "v1", sidecar)),
      ),
    );
    await readInventory(storage, plan.objectPath);
    await readInventory(storage, joinPath(plan.objectPath, "v1"));
  },
);

forEachBackend(
  "deduplicates an unchanged file into the earlier version",
  async ({ root, source }) => {
    const stable = await source("stable.txt", "unchanged across versions");
    await commit(root, [
      `add:${stable}:stable.txt`,
      `add:${await source("v1.txt", "first")}:changing.txt`,
    ]);

    const plan = await commit(root, [
      `add:${await source("v2.txt", "second")}:changing.txt`,
    ]);
    assertEquals(plan.version, "v2");
    // Only the changed file needs bytes; the untouched one is already in the
    // manifest from v1.
    assertEquals(plan.content.map((entry) => entry.contentPath), [
      "v2/content/changing.txt",
    ]);

    const object = await openObjectAt(root, plan.objectPath);
    const state = resolveState(object.inventory, "v2");
    assertEquals(state.map((file) => [file.logicalPath, file.contentPaths]), [
      ["changing.txt", ["v2/content/changing.txt"]],
      ["stable.txt", ["v1/content/stable.txt"]],
    ]);
    assertEquals(
      await root.storage.exists(
        joinPath(plan.objectPath, "v2/content/stable.txt"),
      ),
      false,
    );
  },
);

forEachBackend("rename writes no content at all", async ({ root, source }) => {
  await commit(root, [`add:${await source("a.txt", "alpha")}:a.txt`]);
  const plan = await commit(root, ["rename:a.txt:archive/a.txt"]);

  assertEquals(plan.content, []);
  const object = await openObjectAt(root, plan.objectPath);
  const state = resolveState(object.inventory, "v2");
  assertEquals(state.map((file) => file.logicalPath), ["archive/a.txt"]);
  // The bytes never moved: v1's content path still holds them.
  assertEquals(state[0].contentPaths, ["v1/content/a.txt"]);
});

forEachBackend(
  "remove drops the path but keeps the content recoverable",
  async ({ root, source }) => {
    await commit(root, [
      `add:${await source("a.txt", "alpha")}:a.txt`,
      `add:${await source("b.txt", "bravo")}:b.txt`,
    ]);
    const plan = await commit(root, ["remove:b.txt"]);

    assertEquals(plan.content, []);
    const object = await openObjectAt(root, plan.objectPath);
    assertEquals(
      resolveState(object.inventory, "v2").map((file) => file.logicalPath),
      ["a.txt"],
    );
    // Logical deletion only: v1 still resolves, and the content file survives.
    assertEquals(
      resolveState(object.inventory, "v1").map((file) => file.logicalPath),
      ["a.txt", "b.txt"],
    );
    assertEquals(
      await root.storage.exists(joinPath(plan.objectPath, "v1/content/b.txt")),
      true,
    );
  },
);

forEachBackend(
  "carries prior version blocks forward unchanged (E066/W011)",
  async ({ root, source }) => {
    await commit(root, [`add:${await source("a.txt", "alpha")}:a.txt`], {
      message: "first",
    });
    const first = (await openObjectAt(
      root,
      (await planVersion(root, {
        id: ID,
        ops: parseOps(["remove:a.txt"]),
        ...USER,
      })).objectPath,
    )).inventory.versions["v1"];

    const plan = await commit(root, [
      `add:${await source("b.txt", "bravo")}:b.txt`,
    ], { message: "second" });
    const after = (await openObjectAt(root, plan.objectPath)).inventory
      .versions["v1"];

    assertEquals(after, first);
    assertEquals(after.message, "first");
  },
);

forEachBackend(
  "two logical paths sharing content produce one content file",
  async ({ root, source }) => {
    const same = await source("same.txt", "identical bytes");
    const plan = await commit(root, [
      `add:${same}:one.txt`,
      `add:${same}:two.txt`,
    ]);

    assertEquals(plan.content.length, 1);
    const object = await openObjectAt(root, plan.objectPath);
    assertEquals(Object.keys(object.inventory.manifest).length, 1);
    const state = resolveState(object.inventory, "v1");
    assertEquals(state.map((file) => file.logicalPath), ["one.txt", "two.txt"]);
    assertEquals(state[0].contentPaths, state[1].contentPaths);
  },
);

forEachBackend("honors a custom contentDirectory", async ({ root, source }) => {
  const plan = await commit(root, [
    `add:${await source("a.txt", "alpha")}:a.txt`,
  ], { contentDirectory: "data" });

  assertEquals(plan.content[0].contentPath, "v1/data/a.txt");
  const object = await openObjectAt(root, plan.objectPath);
  assertEquals(object.inventory.contentDirectory, "data");
  assertEquals(
    resolveState(object.inventory, "v1")[0].contentPaths,
    ["v1/data/a.txt"],
  );

  // Fixed at v1: a later version cannot move it.
  const b = await source("b.txt", "bravo");
  await assertRejects(
    () => commit(root, [`add:${b}:b.txt`], { contentDirectory: "content" }),
    OcflError,
    "fixed at v1",
  );
});

forEachBackend(
  "an existing object's digest algorithm cannot be changed",
  async ({ root, source }) => {
    await commit(root, [`add:${await source("a.txt", "alpha")}:a.txt`], {
      digestAlgorithm: "sha256",
    });
    const object = await openObjectAt(
      root,
      root.layout.layout?.resolve(ID) as string,
    );
    assertEquals(object.inventory.digestAlgorithm, "sha256");

    const b = await source("b.txt", "bravo");
    await assertRejects(
      () => commit(root, [`add:${b}:b.txt`], { digestAlgorithm: "sha512" }),
      OcflError,
      "cannot be changed",
    );
  },
);

forEachBackend(
  "asserts the expected version number",
  async ({ root, source }) => {
    const a = await source("a.txt", "alpha");
    const b = await source("b.txt", "bravo");

    // A new object is v1, so any other expectation is a mistake worth catching
    // before anything is written.
    await assertRejects(
      () => commit(root, [`add:${a}:a.txt`], { version: 3 }),
      OcflError,
      "does not exist yet",
    );

    await commit(root, [`add:${a}:a.txt`], { version: 1 });
    await assertRejects(
      () => commit(root, [`add:${b}:b.txt`], { version: 5 }),
      OcflError,
      "its head is v1",
    );

    const plan = await commit(root, [`add:${b}:b.txt`], { version: 2 });
    assertEquals(plan.version, "v2");
  },
);

forEachBackend(
  "a failed version assertion writes nothing",
  async ({ root, source }) => {
    await commit(root, [`add:${await source("a.txt", "alpha")}:a.txt`]);
    const objectPath = root.layout.layout?.resolve(ID) as string;
    const before = await listAll(root.storage, objectPath);

    const b = await source("b.txt", "bravo");
    await assertRejects(() => commit(root, [`add:${b}:b.txt`], { version: 9 }));
    assertEquals(await listAll(root.storage, objectPath), before);
  },
);

forEachBackend(
  "refuses a version that changes nothing",
  async ({ root, source }) => {
    const a = await source("a.txt", "alpha");
    await commit(root, [`add:${a}:a.txt`]);

    await assertRejects(
      () => commit(root, [`add:${a}:a.txt`]),
      OcflError,
      "refusing to create a version that changes nothing",
    );

    // The escape hatch still works, and produces a real version.
    const plan = await commit(root, [`add:${a}:a.txt`], {
      allowNoChange: true,
    });
    assertEquals(plan.version, "v2");
    assertEquals(plan.content, []);
    const object = await openObjectAt(root, plan.objectPath);
    assertEquals(object.inventory.head, "v2");
  },
);

forEachBackend(
  "a source that changes after planning is fatal",
  async ({ root, source }) => {
    const path = await source("a.txt", "alpha");
    const plan = await planVersion(root, {
      id: ID,
      ops: parseOps([`add:${path}:a.txt`]),
      ...USER,
    });

    // Same size, different bytes, and a new mtime — the case a digest-only
    // check at write time would still catch, but a size check alone would not.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await Deno.writeTextFile(path, "ALPHA");

    await assertRejects(
      () => commitVersion(root, plan),
      OcflError,
      "changed after it was digested",
    );
    // Rolled back completely: the object was new, so nothing should remain.
    assertEquals(await listAll(root.storage, plan.objectPath), []);
  },
);

forEachBackend(
  "a mid-write failure leaves no trace of a new object",
  async ({ root, source }) => {
    const plan = await planVersion(root, {
      id: ID,
      ops: parseOps([
        `add:${await source("a.txt", "alpha")}:a.txt`,
        `add:${await source("b.txt", "bravo")}:b.txt`,
      ]),
      ...USER,
    });

    const failing = failOn(root.storage, "b.txt");
    await assertRejects(
      () => commitVersion({ ...root, storage: failing }, plan),
      Error,
      "injected failure",
    );
    assertEquals(await listAll(root.storage, plan.objectPath), []);
  },
);

forEachBackend(
  "a mid-write failure on an update leaves the previous version intact",
  async ({ root, source }) => {
    await commit(root, [`add:${await source("a.txt", "alpha")}:a.txt`]);
    const objectPath = root.layout.layout?.resolve(ID) as string;
    const before = await listAll(root.storage, objectPath);

    const plan = await planVersion(root, {
      id: ID,
      ops: parseOps([`add:${await source("b.txt", "bravo")}:b.txt`]),
      ...USER,
    });
    const failing = failOn(root.storage, "b.txt");
    await assertRejects(() =>
      commitVersion({ ...root, storage: failing }, plan)
    );

    // v2 is gone; v1 and the root inventory are untouched.
    assertEquals(await listAll(root.storage, objectPath), before);
    const object = await openObjectAt(root, objectPath);
    assertEquals(object.inventory.head, "v1");
  },
);

forEachBackend(
  "refuses to commit when another writer moved head",
  async ({ root, source }) => {
    await commit(root, [`add:${await source("a.txt", "alpha")}:a.txt`]);

    // Plan against v1...
    const plan = await planVersion(root, {
      id: ID,
      ops: parseOps([`add:${await source("b.txt", "bravo")}:b.txt`]),
      ...USER,
    });
    // ...then let someone else land v2 first.
    await commit(root, [`add:${await source("c.txt", "charlie")}:c.txt`]);

    await assertRejects(
      () => commitVersion(root, plan),
      OcflError,
      "changed while v2 was being prepared",
    );

    // The competing v2 survives intact.
    const object = await openObjectAt(root, plan.objectPath);
    assertEquals(object.inventory.head, "v2");
    assertEquals(
      resolveState(object.inventory, "v2").map((file) => file.logicalPath),
      ["a.txt", "c.txt"],
    );
  },
);

forEachBackend("rejects an unsafe logical path", async ({ root, source }) => {
  const path = await source("a.txt", "alpha");
  await assertRejects(
    () => commit(root, [`add:${path}:../escape.txt`]),
    OcflError,
    "E099",
  );
  await assertRejects(
    () => commit(root, [`add:${path}:docs`, `add:${path}:docs/spec.md`]),
    OcflError,
    "E101",
  );
});

forEachBackend("rejects a missing source file", async ({ root }) => {
  await assertRejects(
    () => commit(root, ["add:/nonexistent/nope.txt:a.txt"]),
    OcflError,
    "source file not found",
  );
});

Deno.test("refuses to write into a root with an uncomputable layout", async () => {
  const storage = MemoryStorage.from({
    "0=ocfl_1.1": "ocfl_1.1\n",
    "ocfl_layout.json": JSON.stringify({ extension: "9999-nonsense-layout" }),
  });
  const { openStorageRoot } = await import("./root.ts");
  const root = await openStorageRoot(storage);
  await assertRejects(
    () =>
      planVersion(root, {
        id: ID,
        ops: parseOps(["add:/tmp/a.txt:a.txt"]),
        ...USER,
      }),
    OcflError,
    "cannot compute object paths",
  );
});

Deno.test("refuses to create an object over a non-empty object root", async () => {
  const context = await harness("memory");
  try {
    const { root } = context;
    const objectPath = root.layout.layout?.resolve(ID) as string;
    await root.storage.write(
      joinPath(objectPath, "stray.txt"),
      new TextEncoder().encode("someone else's data"),
    );

    const plan = await planVersion(root, {
      id: ID,
      ops: parseOps([`add:${await context.source("a.txt", "alpha")}:a.txt`]),
      ...USER,
    });
    await assertRejects(
      () => commitVersion(root, plan),
      OcflError,
      "is not empty",
    );
    // The stray file is not ours to delete, so rollback must leave it alone.
    assertEquals(
      await root.storage.exists(joinPath(objectPath, "stray.txt")),
      true,
    );
  } finally {
    await context.cleanup();
  }
});

/** Every file beneath `prefix`, sorted — a stable picture of storage state. */
async function listAll(storage: Storage, prefix: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const path of storage.walkFiles(prefix)) paths.push(path);
  return paths.sort();
}

/** Wrap a storage so writing any path containing `needle` throws. */
function failOn(storage: Storage, needle: string): Storage {
  const guard = (path: string) => {
    if (path.includes(needle)) {
      throw new Error(`injected failure writing ${path}`);
    }
  };
  return {
    location: storage.location,
    backend: storage.backend,
    read: (path: string) => storage.read(path),
    exists: (path: string) => storage.exists(path),
    listDir: (path: string): Promise<Entry[]> => storage.listDir(path),
    walkFiles: (prefix: string) => storage.walkFiles(prefix),
    write: (path: string, bytes: Bytes) => {
      guard(path);
      return storage.write(path, bytes);
    },
    writeAtomic: (path: string, bytes: Bytes) => {
      guard(path);
      return storage.writeAtomic(path, bytes);
    },
    writeStream: (
      path: string,
      body: ReadableStream<Uint8Array>,
      options?: { size?: number },
    ) => {
      guard(path);
      return storage.writeStream(path, body, options);
    },
    remove: (path: string) => storage.remove(path),
    pruneEmptyDirs: storage.pruneEmptyDirs?.bind(storage),
  };
}
