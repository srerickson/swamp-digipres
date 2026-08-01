import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { LocalBackend } from "./backend/local.ts";
import {
  getVersionState,
  listObjects,
  locateObject,
  openStorageRoot,
  requireObject,
  versionFileCount,
  versionNames,
} from "./object.ts";
import {
  BACKEND_KINDS,
  FIXTURE_IDS,
  FIXTURE_PATHS,
  FIXTURE_ROOT,
  fixtureBackend,
  movePrefix,
  withFixtureBackend,
} from "./test_util.ts";

for (const kind of BACKEND_KINDS) {
  Deno.test(`[${kind}] openStorageRoot verifies the declaration and resolves the layout`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      const root = await openStorageRoot(backend);
      assertEquals(root.specVersion, "1.1");
      assertEquals(root.layout?.name, "0004-hashed-n-tuple-storage-layout");
    });
  });

  Deno.test(`[${kind}] listObjects returns exactly the fixture's three objects`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      const root = await openStorageRoot(backend);
      const objects = await listObjects(root);
      assertEquals(
        objects.map((object) => object.id).sort(),
        [
          FIXTURE_IDS.spec,
          FIXTURE_IDS.dataDictionary,
          FIXTURE_IDS.xsd,
        ].sort(),
      );
    });
  });

  Deno.test(`[${kind}] locateObject resolves each id to the right object and head`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      const root = await openStorageRoot(backend);
      const expectedHeads: Record<string, string> = {
        [FIXTURE_IDS.spec]: "v2",
        [FIXTURE_IDS.dataDictionary]: "v2",
        [FIXTURE_IDS.xsd]: "v1",
      };
      for (const [id, head] of Object.entries(expectedHeads)) {
        const object = await requireObject(root, id);
        assertEquals(object.id, id);
        assertEquals(object.inventory.head, head);
        assertEquals(object.relativePath, FIXTURE_PATHS[id]);
      }
    });
  });

  Deno.test(`[${kind}] locateObject returns null for an unknown id`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      const root = await openStorageRoot(backend);
      assertEquals(
        await locateObject(root, "urn:swamp-premis:does-not-exist"),
        null,
      );
    });
  });

  Deno.test(`[${kind}] locateObject finds objects by scanning when no layout is declared`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await backend.delete("ocfl_layout.json");
      const root = await openStorageRoot(backend);
      assertEquals(root.layout, null);
      const object = await requireObject(root, FIXTURE_IDS.xsd);
      assertEquals(object.relativePath, FIXTURE_PATHS[FIXTURE_IDS.xsd]);
    });
  });

  Deno.test(`[${kind}] locateObject rejects an object whose inventory id contradicts its path`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      const root = await openStorageRoot(backend);
      const object = await requireObject(root, FIXTURE_IDS.xsd);
      // Swap the two objects' locations so the layout resolves to the wrong one.
      const specPath = FIXTURE_PATHS[FIXTURE_IDS.spec];
      await backend.deletePrefix(specPath);
      await movePrefix(backend, object.relativePath, specPath);
      await assertRejects(
        () => locateObject(root, FIXTURE_IDS.spec),
        Error,
        "declares id",
      );
    });
  });
}

Deno.test("openStorageRoot rejects a directory with no root declaration", async () => {
  await assertRejects(() =>
    openStorageRoot(new LocalBackend(`${FIXTURE_ROOT}/extensions`))
  );
});

Deno.test("getVersionState resolves logical paths through the manifest", async () => {
  const root = await openStorageRoot(fixtureBackend());
  const object = await requireObject(root, FIXTURE_IDS.spec);

  assertEquals(getVersionState(object.inventory, "v1"), [{
    logicalPath: "spec.md",
    digest:
      "57f930c112930b5c0bb4ec1ac4fc4dd3036d19f1a856ec7d47128a4d2238392558c15eec2a384feafc58b4d3a2537f9382576d43754ee916810b7e02c62fb747",
    contentPaths: ["v1/content/spec.md"],
  }]);

  const head = getVersionState(object.inventory);
  assertEquals(head.length, 1);
  assertEquals(head[0].contentPaths, ["v2/content/spec.md"]);
});

Deno.test("deduplicated content resolves to the earlier version's content path", async () => {
  const root = await openStorageRoot(fixtureBackend());
  const object = await requireObject(root, FIXTURE_IDS.dataDictionary);
  const state = getVersionState(object.inventory, "v2");

  assertEquals(state.map((entry) => entry.logicalPath), [
    "data-dictionary.pdf",
    "hierarchical-outline.md",
  ]);
  // Unchanged since v1 — no v2 content copy was made.
  assertEquals(state[0].contentPaths, ["v1/content/data-dictionary.pdf"]);
  assertEquals(state[1].contentPaths, ["v2/content/hierarchical-outline.md"]);
});

Deno.test("getVersionState rejects an unknown version", async () => {
  const root = await openStorageRoot(fixtureBackend());
  const object = await requireObject(root, FIXTURE_IDS.xsd);
  assertEquals(versionNames(object.inventory), ["v1"]);
  try {
    getVersionState(object.inventory, "v7");
    throw new Error("expected getVersionState to throw");
  } catch (cause) {
    assertEquals((cause as { code?: string }).code, "E046");
  }
});

Deno.test("versionFileCount counts logical files per version", async () => {
  const root = await openStorageRoot(fixtureBackend());
  const object = await requireObject(root, FIXTURE_IDS.dataDictionary);
  assertEquals(versionFileCount(object.inventory, "v1"), 1);
  assertEquals(versionFileCount(object.inventory, "v2"), 2);
});
