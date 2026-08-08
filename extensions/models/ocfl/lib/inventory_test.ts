import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { digestBytes } from "./digest.ts";
import { OcflError } from "./errors.ts";
import {
  contentDirectoryOf,
  formatVersionName,
  nextVersion,
  parseInventory,
  parseSidecar,
  readInventory,
  versionNames,
  versionPadding,
} from "./inventory.ts";
import { MemoryStorage } from "./storage/memory.ts";

const MINIMAL = {
  id: "urn:example:object-1",
  type: "https://ocfl.io/1.1/spec/#inventory",
  digestAlgorithm: "sha512",
  head: "v1",
  manifest: { "abc": ["v1/content/file.txt"] },
  versions: {
    v1: { created: "2026-08-08T12:00:00Z", state: { "abc": ["file.txt"] } },
  },
};

/** Build a storage root holding one inventory plus a matching sidecar. */
function withInventory(inventory: unknown, dir = "obj"): MemoryStorage {
  const bytes = new TextEncoder().encode(JSON.stringify(inventory));
  const storage = new MemoryStorage();
  storage.write(`${dir}/inventory.json`, bytes);
  storage.write(
    `${dir}/inventory.json.sha512`,
    new TextEncoder().encode(
      `${digestBytes(bytes, "sha512")} inventory.json\n`,
    ),
  );
  return storage;
}

Deno.test("parseInventory accepts a minimal valid inventory", () => {
  const inventory = parseInventory(
    new TextEncoder().encode(JSON.stringify(MINIMAL)),
    "inventory.json",
  );
  assertEquals(inventory.id, "urn:example:object-1");
  assertEquals(inventory.head, "v1");
  assertEquals(contentDirectoryOf(inventory), "content");
});

Deno.test("parseInventory honors an explicit contentDirectory", () => {
  const inventory = parseInventory(
    new TextEncoder().encode(
      JSON.stringify({ ...MINIMAL, contentDirectory: "data" }),
    ),
    "inventory.json",
  );
  assertEquals(contentDirectoryOf(inventory), "data");
});

Deno.test("parseInventory rejects unknown keys (E102)", () => {
  const error = assertThrows(
    () =>
      parseInventory(
        new TextEncoder().encode(
          JSON.stringify({ ...MINIMAL, unexpected: true }),
        ),
        "inventory.json",
      ),
    OcflError,
  );
  assertEquals(error.code, "E034");
});

Deno.test("parseInventory rejects a head not present in versions (E040)", () => {
  const error = assertThrows(
    () =>
      parseInventory(
        new TextEncoder().encode(JSON.stringify({ ...MINIMAL, head: "v2" })),
        "inventory.json",
      ),
    OcflError,
  );
  assertEquals(error.code, "E040");
});

Deno.test("parseInventory rejects an unsupported digestAlgorithm (E025)", () => {
  assertThrows(
    () =>
      parseInventory(
        new TextEncoder().encode(
          JSON.stringify({ ...MINIMAL, digestAlgorithm: "md5" }),
        ),
        "inventory.json",
      ),
    OcflError,
  );
});

Deno.test("parseInventory rejects malformed JSON (E033)", () => {
  const error = assertThrows(
    () => parseInventory(new TextEncoder().encode("{not json"), "inv.json"),
    OcflError,
  );
  assertEquals(error.code, "E033");
});

Deno.test("parseSidecar reads the digest from a well-formed sidecar", () => {
  assertEquals(parseSidecar("ABC123  inventory.json\n", "s"), "abc123");
});

Deno.test("parseSidecar rejects a malformed sidecar (E061)", () => {
  const error = assertThrows(
    () => parseSidecar("abc123 something-else.json\n", "s"),
    OcflError,
  );
  assertEquals(error.code, "E061");
});

Deno.test("readInventory verifies the inventory against its sidecar", async () => {
  const loaded = await readInventory(withInventory(MINIMAL), "obj");
  assertEquals(loaded.inventory.id, "urn:example:object-1");
  assertEquals(loaded.digest.length, 128); // sha512 hex
});

Deno.test("readInventory rejects a sidecar digest mismatch (E060)", async () => {
  const storage = withInventory(MINIMAL);
  // Rewrite the inventory without touching the sidecar — exactly what a torn
  // or tampered write looks like.
  await storage.write(
    "obj/inventory.json",
    new TextEncoder().encode(JSON.stringify({ ...MINIMAL, head: "v1" }) + " "),
  );
  const error = await assertRejects(
    () => readInventory(storage, "obj"),
    OcflError,
  );
  assertEquals(error.code, "E060");
});

Deno.test("readInventory rejects a missing sidecar (E058)", async () => {
  const storage = new MemoryStorage();
  await storage.write(
    "obj/inventory.json",
    new TextEncoder().encode(JSON.stringify(MINIMAL)),
  );
  const error = await assertRejects(
    () => readInventory(storage, "obj"),
    OcflError,
  );
  assertEquals(error.code, "E058");
});

Deno.test("versionNames sorts numerically, not lexically", () => {
  const inventory = parseInventory(
    new TextEncoder().encode(JSON.stringify({
      ...MINIMAL,
      head: "v10",
      versions: Object.fromEntries(
        ["v1", "v2", "v9", "v10"].map((name) => [name, {
          created: "2026-08-08T12:00:00Z",
          state: {},
        }]),
      ),
    })),
    "inventory.json",
  );
  assertEquals(versionNames(inventory), ["v1", "v2", "v9", "v10"]);
});

Deno.test("versionNames handles a zero-padded convention", () => {
  const inventory = parseInventory(
    new TextEncoder().encode(JSON.stringify({
      ...MINIMAL,
      head: "v0010",
      versions: Object.fromEntries(
        ["v0001", "v0002", "v0010"].map((name) => [name, {
          created: "2026-08-08T12:00:00Z",
          state: {},
        }]),
      ),
    })),
    "inventory.json",
  );
  assertEquals(versionNames(inventory), ["v0001", "v0002", "v0010"]);
});

/** Build an inventory whose versions are exactly `names`, head last. */
function withVersions(names: string[]) {
  return parseInventory(
    new TextEncoder().encode(JSON.stringify({
      ...MINIMAL,
      head: names[names.length - 1],
      versions: Object.fromEntries(
        names.map((name) => [name, {
          created: "2026-08-08T12:00:00Z",
          state: {},
        }]),
      ),
    })),
    "inventory.json",
  );
}

Deno.test("versionPadding reads the object's own convention", () => {
  assertEquals(versionPadding(withVersions(["v1", "v2"])), 0);
  assertEquals(versionPadding(withVersions(["v0001", "v0002"])), 4);
  assertEquals(versionPadding(withVersions(["v001"])), 3);
});

Deno.test("formatVersionName applies a padding width", () => {
  assertEquals(formatVersionName(3, 0), "v3");
  assertEquals(formatVersionName(3, 4), "v0003");
  assertEquals(formatVersionName(1234, 4), "v1234");
});

Deno.test("nextVersion extends the existing convention", () => {
  assertEquals(nextVersion(withVersions(["v1", "v2"])), {
    name: "v3",
    number: 3,
  });
  // Padding is fixed by v1 and must be carried forward, not re-decided.
  assertEquals(nextVersion(withVersions(["v0001", "v0002"])), {
    name: "v0003",
    number: 3,
  });
  // The 9 → 10 rollover keeps the width rather than growing it.
  const nine = Array.from({ length: 9 }, (_, i) => formatVersionName(i + 1, 4));
  assertEquals(nextVersion(withVersions(nine)), { name: "v0010", number: 10 });
});

Deno.test("nextVersion rejects a gap in the version sequence", () => {
  const error = assertThrows(
    () => nextVersion(withVersions(["v1", "v3"])),
    OcflError,
  );
  assertEquals(error.code, "E011");
  assertThrows(() => nextVersion(withVersions(["v1", "v0002"])), OcflError);
});

Deno.test("nextVersion rejects a head that disagrees with the versions", () => {
  const inventory = withVersions(["v1", "v2"]);
  const wrongHead = { ...inventory, head: "v1" };
  const error = assertThrows(() => nextVersion(wrongHead), OcflError);
  assertEquals(error.code, "E040");
});

Deno.test("nextVersion refuses to overflow a padded convention", () => {
  // v9999 -> v10000 would silently widen the names, breaking E011.
  const inventory = withVersions(["v9999"]);
  const padded = {
    ...inventory,
    versions: Object.fromEntries(
      Array.from({ length: 9999 }, (_, index) => [
        formatVersionName(index + 1, 4),
        { created: "2026-08-08T12:00:00Z", state: {} },
      ]),
    ),
  };
  const error = assertThrows(() => nextVersion(padded), OcflError);
  assertEquals(error.code, "E011");
});
