import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  FLAT_DIRECT,
  FlatDirectLayout,
  HASHED_N_TUPLE,
  HashedNTupleConfigSchema,
  HashedNTupleLayout,
  loadLayout,
} from "./layout.ts";
import { OcflError } from "./errors.ts";
import { MemoryStorage } from "./storage/memory.ts";

/** The fixture's own layout config: sha256, 3 tuples of 3, full digest leaf. */
function fixtureLayout(): HashedNTupleLayout {
  return new HashedNTupleLayout(HashedNTupleConfigSchema.parse({
    extensionName: HASHED_N_TUPLE,
    digestAlgorithm: "sha256",
    tupleSize: 3,
    numberOfTuples: 3,
    shortObjectRoot: false,
  }));
}

Deno.test("0004 resolves the fixture ids to their real on-disk paths", () => {
  // Ground truth: these are the directories that exist in
  // testdata/fixtures/ocfl-root.
  const layout = fixtureLayout();
  assertEquals(
    layout.resolve("urn:swamp-premis:ocfl-spec"),
    "5b8/259/53a/5b825953afc3bbb6b2f5b774db30a1958870fe6bb2db9738775c211a2c4a25c0",
  );
  assertEquals(
    layout.resolve("urn:swamp-premis:premis-data-dictionary"),
    "c08/d71/02d/c08d7102d1c239658615505e00e364442e2fc001cb282dad067067a0b4772d01",
  );
  assertEquals(
    layout.resolve("urn:swamp-premis:premis-xsd"),
    "797/18e/66e/79718e66ecd28349e0f90e3789417383209c43ded1f531fea37f1051ee2773b6",
  );
});

Deno.test("0004 shortObjectRoot drops the consumed prefix", () => {
  const layout = new HashedNTupleLayout(HashedNTupleConfigSchema.parse({
    digestAlgorithm: "sha256",
    tupleSize: 3,
    numberOfTuples: 3,
    shortObjectRoot: true,
  }));
  assertEquals(
    layout.resolve("urn:swamp-premis:ocfl-spec"),
    "5b8/259/53a/fc3bbb6b2f5b774db30a1958870fe6bb2db9738775c211a2c4a25c0",
  );
});

Deno.test("0004 with zero tuples puts the object at the digest", () => {
  const layout = new HashedNTupleLayout(HashedNTupleConfigSchema.parse({
    digestAlgorithm: "sha256",
    tupleSize: 0,
    numberOfTuples: 0,
  }));
  assertEquals(
    layout.resolve("urn:swamp-premis:ocfl-spec"),
    "5b825953afc3bbb6b2f5b774db30a1958870fe6bb2db9738775c211a2c4a25c0",
  );
});

Deno.test("0004 rejects tuples longer than the digest", () => {
  const layout = new HashedNTupleLayout(HashedNTupleConfigSchema.parse({
    digestAlgorithm: "sha256",
    tupleSize: 32,
    numberOfTuples: 3,
  }));
  assertThrows(() => layout.resolve("x"), OcflError, "digest characters");
});

Deno.test("0004 rejects shortObjectRoot with no remainder", () => {
  // 8 tuples of 8 = 64 characters = the whole sha256 digest.
  const layout = new HashedNTupleLayout(HashedNTupleConfigSchema.parse({
    digestAlgorithm: "sha256",
    tupleSize: 8,
    numberOfTuples: 8,
    shortObjectRoot: true,
  }));
  assertThrows(() => layout.resolve("x"), OcflError, "no remainder");
});

Deno.test("0004 rejects an unsupported digest algorithm", () => {
  assertThrows(
    () =>
      new HashedNTupleLayout(
        HashedNTupleConfigSchema.parse({ digestAlgorithm: "crc32" }),
      ),
    OcflError,
    "unsupported digest algorithm",
  );
});

Deno.test("0002 uses the id unchanged, including punctuation", () => {
  const layout = new FlatDirectLayout();
  assertEquals(layout.resolve("object-01"), "object-01");
  // Straight from the extension spec's own example table.
  assertEquals(layout.resolve("..hor_rib:lé-$id"), "..hor_rib:lé-$id");
});

Deno.test("0002 rejects ids that cannot be one path segment", () => {
  const layout = new FlatDirectLayout();
  assertThrows(() => layout.resolve("info:fedora/object-01"), OcflError);
  assertThrows(() => layout.resolve(""), OcflError);
  assertThrows(() => layout.resolve("."), OcflError);
  assertThrows(() => layout.resolve(".."), OcflError);
  assertThrows(() => layout.resolve("a".repeat(256)), OcflError);
});

Deno.test("loadLayout reads the declaration and its config", async () => {
  const storage = MemoryStorage.from({
    "ocfl_layout.json": JSON.stringify({
      extension: HASHED_N_TUPLE,
      description: "swamp-premis test fixtures",
    }),
    [`extensions/${HASHED_N_TUPLE}/config.json`]: JSON.stringify({
      extensionName: HASHED_N_TUPLE,
      digestAlgorithm: "sha256",
      tupleSize: 3,
      numberOfTuples: 3,
      shortObjectRoot: false,
    }),
  });

  const loaded = await loadLayout(storage);
  assertEquals(loaded.declared, HASHED_N_TUPLE);
  assertEquals(loaded.description, "swamp-premis test fixtures");
  assertEquals(
    loaded.layout?.resolve("urn:swamp-premis:ocfl-spec"),
    "5b8/259/53a/5b825953afc3bbb6b2f5b774db30a1958870fe6bb2db9738775c211a2c4a25c0",
  );
});

Deno.test("loadLayout falls back to defaults when config is absent", async () => {
  const storage = MemoryStorage.from({
    "ocfl_layout.json": JSON.stringify({ extension: HASHED_N_TUPLE }),
  });
  const loaded = await loadLayout(storage);
  // Defaults are sha256/3x3, which is what the fixture uses.
  assertEquals(
    loaded.layout?.resolve("urn:swamp-premis:ocfl-spec"),
    "5b8/259/53a/5b825953afc3bbb6b2f5b774db30a1958870fe6bb2db9738775c211a2c4a25c0",
  );
});

Deno.test("loadLayout reports an undeclared layout without failing", async () => {
  const loaded = await loadLayout(MemoryStorage.from({}));
  assertEquals(loaded.declared, null);
  assertEquals(loaded.layout, undefined);
});

Deno.test("loadLayout reports an unsupported layout without failing", async () => {
  // Unsupported means "cannot compute paths", not "cannot read the root" —
  // listing still works by scanning.
  const storage = MemoryStorage.from({
    "ocfl_layout.json": JSON.stringify({
      extension: "0003-hash-and-id-n-tuple-storage-layout",
    }),
  });
  const loaded = await loadLayout(storage);
  assertEquals(loaded.declared, "0003-hash-and-id-n-tuple-storage-layout");
  assertEquals(loaded.layout, undefined);
});

Deno.test("loadLayout rejects a declaration with no extension key", async () => {
  const storage = MemoryStorage.from({
    "ocfl_layout.json": JSON.stringify({ description: "oops" }),
  });
  const error = await assertRejects(() => loadLayout(storage), OcflError);
  assertEquals(error.code, "E070");
});

Deno.test("FLAT_DIRECT and HASHED_N_TUPLE use registered names", () => {
  assertEquals(HASHED_N_TUPLE, "0004-hashed-n-tuple-storage-layout");
  assertEquals(FLAT_DIRECT, "0002-flat-direct-storage-layout");
});
