/**
 * Read-path tests against the checked-in fixture at
 * `testdata/fixtures/ocfl-root`, which is real OCFL 1.1 output from
 * `ocfl-tools`.
 *
 * The fixture is never mutated — every test here reads only. It is run through
 * both {@linkcode LocalStorage} and {@linkcode MemoryStorage} (seeded from
 * disk) so the OCFL layer is proven not to depend on the backend.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { OcflError } from "./errors.ts";
import { HASHED_N_TUPLE } from "./layout.ts";
import { findObject, listObjects, resolveState } from "./object.ts";
import { findObjectRoots, openStorageRoot, type StorageRoot } from "./root.ts";
import { LocalStorage } from "./storage/local.ts";
import { MemoryStorage } from "./storage/memory.ts";
import type { Storage } from "./storage/types.ts";

const FIXTURE =
  new URL("../../../../testdata/fixtures/ocfl-root", import.meta.url)
    .pathname;

const SPEC_ID = "urn:swamp-premis:ocfl-spec";
const DICTIONARY_ID = "urn:swamp-premis:premis-data-dictionary";
const XSD_ID = "urn:swamp-premis:premis-xsd";

/** Copy the on-disk fixture into an in-memory store. */
async function memoryFixture(): Promise<MemoryStorage> {
  const local = new LocalStorage(FIXTURE);
  const memory = new MemoryStorage(`memory://${FIXTURE}`);
  for await (const path of local.walkFiles("")) {
    await memory.write(path, await local.read(path));
  }
  return memory;
}

const backends: Array<{ name: string; create: () => Promise<Storage> }> = [
  { name: "local", create: () => Promise.resolve(new LocalStorage(FIXTURE)) },
  { name: "memory", create: memoryFixture },
];

/** Register one test per backend, given an opened fixture storage root. */
function forEachBackend(
  name: string,
  run: (root: StorageRoot) => Promise<void>,
): void {
  for (const backend of backends) {
    Deno.test(`${name} (${backend.name})`, async () => {
      await run(await openStorageRoot(await backend.create()));
    });
  }
}

forEachBackend("opens the fixture storage root", (root) => {
  assertEquals(root.specVersion, "1.1");
  assertEquals(root.layout.declared, HASHED_N_TUPLE);
  assertEquals(root.layout.description, "swamp-premis test fixtures");
  assert(root.layout.layout !== undefined, "layout should be resolvable");
  return Promise.resolve();
});

forEachBackend("finds exactly the three object roots", async (root) => {
  assertEquals(await findObjectRoots(root), [
    "5b8/259/53a/5b825953afc3bbb6b2f5b774db30a1958870fe6bb2db9738775c211a2c4a25c0",
    "797/18e/66e/79718e66ecd28349e0f90e3789417383209c43ded1f531fea37f1051ee2773b6",
    "c08/d71/02d/c08d7102d1c239658615505e00e364442e2fc001cb282dad067067a0b4772d01",
  ]);
});

forEachBackend("lists all three objects with correct heads", async (root) => {
  const objects = await listObjects(root);
  assertEquals(
    objects.map((object) => [object.inventory.id, object.inventory.head]),
    [
      [SPEC_ID, "v2"],
      [XSD_ID, "v1"],
      [DICTIONARY_ID, "v2"],
    ],
  );
  for (const object of objects) {
    assertEquals(object.specVersion, "1.1");
    assertEquals(object.inventory.digestAlgorithm, "sha512");
  }
});

forEachBackend("finds an object by id through the layout", async (root) => {
  const object = await findObject(root, SPEC_ID);
  assertEquals(object.inventory.id, SPEC_ID);
  assertEquals(
    object.path,
    "5b8/259/53a/5b825953afc3bbb6b2f5b774db30a1958870fe6bb2db9738775c211a2c4a25c0",
  );
  assertEquals(Object.keys(object.inventory.versions).sort(), ["v1", "v2"]);
});

forEachBackend("resolves head state to content paths", async (root) => {
  const object = await findObject(root, SPEC_ID);
  assertEquals(resolveState(object.inventory), [
    {
      logicalPath: "spec.md",
      digest:
        "72b207a3a023fef9350c45f66a5f31abab7e6918f2ca01b3a2ec9b4b4f303b165b66eda569dc848b0a9261eb5bfd04d59cb7843e597111965c0541c5566c73ef",
      contentPaths: ["v2/content/spec.md"],
    },
  ]);
});

forEachBackend("resolves an explicit earlier version", async (root) => {
  const object = await findObject(root, SPEC_ID);
  const state = resolveState(object.inventory, "v1");
  assertEquals(state.length, 1);
  assertEquals(state[0].logicalPath, "spec.md");
  assertEquals(state[0].contentPaths, ["v1/content/spec.md"]);
});

forEachBackend("resolves deduplicated content to its v1 path", async (root) => {
  // data-dictionary.pdf is unchanged in v2, so its v2 state entry must resolve
  // through the manifest to the content file written in v1 — no v2 copy exists.
  const object = await findObject(root, DICTIONARY_ID);
  const state = resolveState(object.inventory);
  assertEquals(state.map((file) => file.logicalPath), [
    "data-dictionary.pdf",
    "hierarchical-outline.md",
  ]);
  assertEquals(state[0].contentPaths, ["v1/content/data-dictionary.pdf"]);
  assertEquals(state[1].contentPaths, ["v2/content/hierarchical-outline.md"]);
});

forEachBackend("resolves a single-version object", async (root) => {
  const object = await findObject(root, XSD_ID);
  assertEquals(object.inventory.head, "v1");
  assertEquals(resolveState(object.inventory).map((f) => f.logicalPath), [
    "premis.xsd",
  ]);
});

forEachBackend("every content path in the manifest exists", async (root) => {
  for (const object of await listObjects(root)) {
    for (const paths of Object.values(object.inventory.manifest)) {
      for (const contentPath of paths) {
        assertEquals(
          await root.storage.exists(`${object.path}/${contentPath}`),
          true,
          `${object.inventory.id}: missing ${contentPath}`,
        );
      }
    }
  }
});

forEachBackend("rejects an unknown object id", async (root) => {
  await assertRejects(
    () => findObject(root, "urn:swamp-premis:does-not-exist"),
    OcflError,
  );
});

forEachBackend("rejects an unknown version name", async (root) => {
  const object = await findObject(root, XSD_ID);
  const error = await assertRejects(() =>
    Promise.resolve().then(() => resolveState(object.inventory, "v9"))
  );
  assert(error instanceof OcflError);
  assertEquals(error.code, "E010");
});

Deno.test("a directory with no root declaration is not a storage root", async () => {
  await assertRejects(
    () => openStorageRoot(MemoryStorage.from({ "some-file.txt": "x" })),
    OcflError,
    "conformance declaration",
  );
});
