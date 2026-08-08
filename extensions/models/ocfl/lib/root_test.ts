import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { OcflError } from "./errors.ts";
import { FLAT_DIRECT, HASHED_N_TUPLE } from "./layout.ts";
import { readNamaste } from "./namaste.ts";
import { initStorageRoot, openStorageRoot } from "./root.ts";
import { LocalStorage } from "./storage/local.ts";
import { MemoryStorage } from "./storage/memory.ts";
import type { Storage } from "./storage/types.ts";

const backends: Array<
  { name: string; create: () => Promise<[Storage, () => Promise<void>]> }
> = [
  {
    name: "memory",
    create: () =>
      Promise.resolve([new MemoryStorage(), () => Promise.resolve()]),
  },
  {
    name: "local",
    create: async () => {
      const dir = await Deno.makeTempDir({ prefix: "ocfl-init-" });
      return [
        new LocalStorage(dir),
        () => Deno.remove(dir, { recursive: true }),
      ];
    },
  },
];

/** Register one test per backend, given an empty storage. */
function forEachBackend(
  name: string,
  run: (storage: Storage) => Promise<void>,
): void {
  for (const backend of backends) {
    Deno.test(`${name} (${backend.name})`, async () => {
      const [storage, cleanup] = await backend.create();
      try {
        await run(storage);
      } finally {
        await cleanup();
      }
    });
  }
}

forEachBackend(
  "init creates a 0004 storage root that reopens",
  async (storage) => {
    const result = await initStorageRoot(storage, {
      layout: HASHED_N_TUPLE,
      description: "test root",
    });
    assertEquals(result.created, true);
    assertEquals(result.root.specVersion, "1.1");
    assertEquals(result.root.layout.declared, HASHED_N_TUPLE);
    assertEquals(result.root.layout.description, "test root");

    // Reopening from scratch must see the same thing — this is what proves the
    // files written are actually a conformant root, not just an in-memory view.
    const reopened = await openStorageRoot(storage);
    assertEquals(reopened.specVersion, "1.1");
    assertEquals(reopened.layout.declared, HASHED_N_TUPLE);
    assertEquals(
      reopened.layout.layout?.resolve("urn:swamp-premis:ocfl-spec"),
      "5b8/259/53a/5b825953afc3bbb6b2f5b774db30a1958870fe6bb2db9738775c211a2c4a25c0",
    );
  },
);

forEachBackend("init writes a conformant root declaration", async (storage) => {
  await initStorageRoot(storage, { layout: HASHED_N_TUPLE });
  const namaste = await readNamaste(storage, "", "root");
  assertEquals(namaste?.filename, "0=ocfl_1.1");
  assertEquals(namaste?.version, "1.1");
  assertEquals(
    new TextDecoder().decode(await storage.read("0=ocfl_1.1")),
    "ocfl_1.1\n",
  );
});

forEachBackend("init writes the layout extension config", async (storage) => {
  await initStorageRoot(storage, { layout: HASHED_N_TUPLE });
  const config = JSON.parse(
    new TextDecoder().decode(
      await storage.read(`extensions/${HASHED_N_TUPLE}/config.json`),
    ),
  );
  assertEquals(config, {
    extensionName: HASHED_N_TUPLE,
    digestAlgorithm: "sha256",
    tupleSize: 3,
    numberOfTuples: 3,
    shortObjectRoot: false,
  });
});

forEachBackend("init honors layout config overrides", async (storage) => {
  await initStorageRoot(storage, {
    layout: HASHED_N_TUPLE,
    layoutConfig: {
      tupleSize: 2,
      numberOfTuples: 2,
      digestAlgorithm: "sha512",
    },
  });
  const root = await openStorageRoot(storage);
  const segments = root.layout.layout?.resolve("x").split("/") ?? [];
  // Two tuples of two characters, then the full sha512 digest as the leaf.
  assertEquals(segments.length, 3);
  assertEquals(segments[0].length, 2);
  assertEquals(segments[1].length, 2);
  assertEquals(segments[2].length, 128);
  assertEquals(segments[2].startsWith(segments[0] + segments[1]), true);
});

forEachBackend("init creates a 0002 flat-direct root", async (storage) => {
  const result = await initStorageRoot(storage, { layout: FLAT_DIRECT });
  assertEquals(result.root.layout.declared, FLAT_DIRECT);
  assertEquals(result.root.layout.layout?.resolve("object-01"), "object-01");
});

forEachBackend(
  "init is a no-op when re-run with the same layout",
  async (storage) => {
    await initStorageRoot(storage, { layout: HASHED_N_TUPLE });
    const again = await initStorageRoot(storage, { layout: HASHED_N_TUPLE });
    assertEquals(again.created, false);
    assertEquals(again.root.layout.declared, HASHED_N_TUPLE);
  },
);

forEachBackend(
  "init refuses to change an existing root's layout",
  async (storage) => {
    await initStorageRoot(storage, { layout: HASHED_N_TUPLE });
    const error = await assertRejects(
      () => initStorageRoot(storage, { layout: FLAT_DIRECT }),
      OcflError,
    );
    // Rewriting the layout would orphan every object already stored under it.
    assert(error.message.includes("refusing to replace"));
  },
);

forEachBackend(
  "init refuses a non-empty directory that is not a root",
  async (storage) => {
    await storage.write("some-data.txt", new TextEncoder().encode("x"));
    await assertRejects(
      () => initStorageRoot(storage, { layout: HASHED_N_TUPLE }),
      OcflError,
      "refusing to initialize",
    );
  },
);
