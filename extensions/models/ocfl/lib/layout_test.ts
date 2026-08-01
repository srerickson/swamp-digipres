import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  HASHED_N_TUPLE_LAYOUT,
  hashedNTupleLayout,
  loadLayout,
  scanObjectRoots,
} from "./layout.ts";
import {
  BACKEND_KINDS,
  FIXTURE_IDS,
  FIXTURE_PATHS,
  fixtureBackend,
  withFixtureBackend,
} from "./test_util.ts";

Deno.test("loadLayout reads the fixture's declared 0004 layout", async () => {
  const { layout, declaredExtension, reason } = await loadLayout(fixtureBackend());
  assertEquals(declaredExtension, HASHED_N_TUPLE_LAYOUT);
  assertEquals(reason, null);
  assertEquals(layout?.name, HASHED_N_TUPLE_LAYOUT);
});

Deno.test("0004 layout resolves every fixture id to its on-disk path", async () => {
  const { layout } = await loadLayout(fixtureBackend());
  if (layout === null) throw new Error("expected a resolved layout");
  for (const [id, expected] of Object.entries(FIXTURE_PATHS)) {
    assertEquals(layout.resolve(id), expected, `layout path for ${id}`);
  }
});

Deno.test("0004 layout honors shortObjectRoot", () => {
  const layout = hashedNTupleLayout({
    extensionName: HASHED_N_TUPLE_LAYOUT,
    digestAlgorithm: "sha256",
    tupleSize: 3,
    numberOfTuples: 3,
    shortObjectRoot: true,
  });
  const full = FIXTURE_PATHS[FIXTURE_IDS.spec].split("/").pop()!;
  assertEquals(
    layout.resolve(FIXTURE_IDS.spec),
    `5b8/259/53a/${full.slice(9)}`,
  );
});

Deno.test("0004 layout rejects a tuple span longer than the digest", () => {
  const layout = hashedNTupleLayout({
    extensionName: HASHED_N_TUPLE_LAYOUT,
    digestAlgorithm: "sha256",
    tupleSize: 32,
    numberOfTuples: 3,
    shortObjectRoot: false,
  });
  assertThrows(() => layout.resolve(FIXTURE_IDS.spec));
});

Deno.test("0004 layout rejects an unsupported digest algorithm", () => {
  assertThrows(() =>
    hashedNTupleLayout({
      extensionName: HASHED_N_TUPLE_LAYOUT,
      digestAlgorithm: "not-a-real-algorithm",
      tupleSize: 3,
      numberOfTuples: 3,
      shortObjectRoot: false,
    })
  );
});

for (const kind of BACKEND_KINDS) {
  Deno.test(`[${kind}] scanObjectRoots finds every object and skips root extensions`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      const found = await scanObjectRoots(backend);
      assertEquals(
        found.map((entry) => entry.relativePath).sort(),
        Object.values(FIXTURE_PATHS).sort(),
      );
    });
  });

  Deno.test(`[${kind}] loadLayout reads the declared 0004 layout`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      const { layout, declaredExtension, reason } = await loadLayout(backend);
      assertEquals(declaredExtension, HASHED_N_TUPLE_LAYOUT);
      assertEquals(reason, null);
      assertEquals(layout?.name, HASHED_N_TUPLE_LAYOUT);
    });
  });
}
