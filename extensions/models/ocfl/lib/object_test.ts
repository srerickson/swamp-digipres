/**
 * Tests for resolving a version's state against its manifest.
 *
 * The happy path is covered by the round-trips in `commit_test.ts`, which read
 * back through `resolveState`. What is left here is the manifest that a reader
 * cannot resolve — schema-valid JSON that still fails to name any bytes.
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { OcflError } from "./errors.ts";
import { parseInventory } from "./inventory.ts";
import { resolveState } from "./object.ts";

/** Parse an inventory-shaped object, the way a reader would off disk. */
function inventoryOf(inventory: unknown) {
  return parseInventory(
    new TextEncoder().encode(JSON.stringify(inventory)),
    "inventory.json",
  );
}

const BASE = {
  id: "urn:example:object-1",
  type: "https://ocfl.io/1.1/spec/#inventory",
  digestAlgorithm: "sha512",
  head: "v1",
};

Deno.test("resolveState resolves a state digest to its content paths", () => {
  const state = resolveState(inventoryOf({
    ...BASE,
    manifest: { abc: ["v1/content/file.txt"] },
    versions: {
      v1: { created: "2026-08-08T12:00:00Z", state: { abc: ["file.txt"] } },
    },
  }));

  assertEquals(state.length, 1);
  assertEquals(state[0].logicalPath, "file.txt");
  assertEquals(state[0].contentPaths, ["v1/content/file.txt"]);
});

Deno.test("resolveState rejects a state digest missing from the manifest (E050)", () => {
  const error = assertThrows(
    () =>
      resolveState(inventoryOf({
        ...BASE,
        manifest: { abc: ["v1/content/file.txt"] },
        versions: {
          v1: { created: "2026-08-08T12:00:00Z", state: { zzz: ["file.txt"] } },
        },
      })),
    OcflError,
  );
  assertEquals(error.code, "E050");
});

Deno.test("resolveState rejects a manifest digest naming no content path (E050)", () => {
  // The schema permits an empty array, so this parses. It names no bytes, which
  // is the same failure as a missing digest and must be reported the same way —
  // a reader that took `contentPaths[0]` on trust would get `undefined` and
  // crash somewhere further along.
  const error = assertThrows(
    () =>
      resolveState(inventoryOf({
        ...BASE,
        manifest: { abc: [] },
        versions: {
          v1: { created: "2026-08-08T12:00:00Z", state: { abc: ["file.txt"] } },
        },
      })),
    OcflError,
  );
  assertEquals(error.code, "E050");
  assertEquals(error.message.includes("abc"), true);
});

Deno.test("resolveState returns nothing for a version whose state is empty", () => {
  assertEquals(
    resolveState(inventoryOf({
      ...BASE,
      manifest: { abc: ["v1/content/file.txt"] },
      versions: { v1: { created: "2026-08-08T12:00:00Z", state: {} } },
    })),
    [],
  );
});
