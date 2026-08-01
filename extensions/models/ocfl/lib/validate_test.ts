import { assertEquals } from "jsr:@std/assert@1";
import { validateObject, validateStorageRoot } from "./validate.ts";
import type { StorageBackend } from "./backend/backend.ts";
import { readText } from "./backend/backend.ts";
import { LocalBackend } from "./backend/local.ts";
import { digestBytes } from "./digest.ts";
import { sidecarFilename } from "./inventory.ts";
import {
  BACKEND_KINDS,
  FIXTURE_IDS,
  FIXTURE_PATHS,
  fixtureBackend,
  movePrefix,
  withFixtureBackend,
  withFixtureCopy,
} from "./test_util.ts";

const SPEC_PATH = FIXTURE_PATHS[FIXTURE_IDS.spec];
const encoder = new TextEncoder();

/** Error codes reported for one object in a mutable fixture root. */
async function objectErrorCodes(
  backend: StorageBackend,
  relativePath = SPEC_PATH,
): Promise<string[]> {
  const result = await validateObject(backend, relativePath);
  return result.errors.map((issue) => issue.code).sort();
}

/** Read, mutate, and rewrite an object's root inventory plus its sidecar. */
async function rewriteInventory(
  backend: StorageBackend,
  objectKey: string,
  mutate: (inventory: Record<string, unknown>) => void,
  options: { updateSidecar?: boolean; versionDir?: string } = {},
): Promise<void> {
  const dir = options.versionDir === undefined
    ? objectKey
    : `${objectKey}/${options.versionDir}`;
  const text = await readText(backend, `${dir}/inventory.json`);
  const inventory = JSON.parse(text ?? "null") as Record<string, unknown>;
  mutate(inventory);
  const bytes = encoder.encode(JSON.stringify(inventory, null, 2));
  await backend.write(`${dir}/inventory.json`, bytes);
  if (options.updateSidecar !== false) {
    await backend.write(
      `${dir}/${sidecarFilename("sha512")}`,
      encoder.encode(`${digestBytes(bytes, "sha512")} inventory.json\n`),
    );
  }
}

Deno.test("the checked-in fixture validates structurally with no errors", async () => {
  const result = await validateStorageRoot(fixtureBackend());
  assertEquals(result.rootErrors, []);
  for (const object of result.objects) {
    assertEquals(object.errors, [], `errors for ${object.path}`);
    assertEquals(object.warnings, [], `warnings for ${object.path}`);
  }
  assertEquals(result.valid, true);
  assertEquals(result.objects.length, 3);
});

Deno.test("validateStorageRoot filters to requested ids", async () => {
  const result = await validateStorageRoot(fixtureBackend(), {
    ids: [FIXTURE_IDS.xsd],
  });
  assertEquals(result.objects.map((object) => object.id), [FIXTURE_IDS.xsd]);
  assertEquals(result.valid, true);
});

Deno.test("an unknown requested id is reported", async () => {
  const result = await validateStorageRoot(fixtureBackend(), {
    ids: ["urn:swamp-premis:nope"],
  });
  assertEquals(result.valid, false);
  assertEquals(result.rootErrors.map((issue) => issue.code), ["E083"]);
});

for (const kind of BACKEND_KINDS) {
  Deno.test(`[${kind}] the fixture passes full fixity`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      const result = await validateStorageRoot(backend, { fullFixity: true });
      assertEquals(result.fullFixity, true);
      assertEquals(result.valid, true);
      for (const object of result.objects) {
        assertEquals(object.errors, [], `errors for ${object.path}`);
      }
    });
  });

  // Invariant 2 — root inventory must be a byte copy of the head version's.
  Deno.test(`[${kind}] a re-serialized root inventory is flagged even when semantically equal (E064)`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      // Reorder keys and change whitespace without changing meaning.
      await rewriteInventory(backend, SPEC_PATH, (inventory) => {
        const reordered: Record<string, unknown> = {};
        for (const key of Object.keys(inventory).reverse()) {
          reordered[key] = inventory[key];
        }
        for (const key of Object.keys(inventory)) delete inventory[key];
        Object.assign(inventory, reordered);
      });
      assertEquals(await objectErrorCodes(backend), ["E064"]);
    });
  });

  // Invariant 4 — prior version blocks carried forward unchanged.
  Deno.test(`[${kind}] a mutated prior version state is flagged (E066)`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await rewriteInventory(backend, SPEC_PATH, (inventory) => {
        const versions = inventory.versions as Record<
          string,
          { state: Record<string, string[]> }
        >;
        versions.v1.state = { ...versions.v2.state };
      });
      const codes = await objectErrorCodes(backend);
      assertEquals(codes.includes("E066"), true, codes.join(","));
    });
  });

  Deno.test(`[${kind}] a mutated prior version message is only a warning (W011)`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await rewriteInventory(backend, SPEC_PATH, (inventory) => {
        const versions = inventory.versions as Record<
          string,
          { message: string }
        >;
        versions.v1.message = "rewritten after the fact";
      });
      const result = await validateObject(backend, SPEC_PATH);
      // E064 also fires because the root copy no longer matches v2's.
      assertEquals(result.errors.map((issue) => issue.code), ["E064"]);
      assertEquals(result.warnings.map((issue) => issue.code), ["W011"]);
    });
  });

  // Invariant 5 — version naming and sequencing.
  Deno.test(`[${kind}] a gap in the version sequence is flagged (E010)`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await movePrefix(backend, `${SPEC_PATH}/v2`, `${SPEC_PATH}/v3`);
      await rewriteInventory(backend, SPEC_PATH, (inventory) => {
        const versions = inventory.versions as Record<string, unknown>;
        versions.v3 = versions.v2;
        delete versions.v2;
        inventory.head = "v3";
      });
      const codes = await objectErrorCodes(backend);
      assertEquals(codes.includes("E010"), true, codes.join(","));
    });
  });

  Deno.test(`[${kind}] mixed padded and non-padded version names are flagged (E013)`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await movePrefix(backend, `${SPEC_PATH}/v2`, `${SPEC_PATH}/v02`);
      await rewriteInventory(backend, SPEC_PATH, (inventory) => {
        const versions = inventory.versions as Record<string, unknown>;
        versions.v02 = versions.v2;
        delete versions.v2;
        inventory.head = "v02";
      });
      const codes = await objectErrorCodes(backend);
      assertEquals(codes.includes("E013"), true, codes.join(","));
    });
  });

  Deno.test(`[${kind}] a head that is not the highest version is flagged (E040)`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await rewriteInventory(backend, SPEC_PATH, (inventory) => {
        inventory.head = "v1";
      });
      const codes = await objectErrorCodes(backend);
      assertEquals(codes.includes("E040"), true, codes.join(","));
    });
  });

  // Invariant 6 — digests are unique per block regardless of case.
  Deno.test(`[${kind}] a digest repeated in different case is flagged (E096)`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await rewriteInventory(backend, SPEC_PATH, (inventory) => {
        const manifest = inventory.manifest as Record<string, string[]>;
        const [digest, paths] = Object.entries(manifest)[0];
        manifest[digest.toUpperCase()] = paths;
      });
      const codes = await objectErrorCodes(backend);
      assertEquals(codes.includes("E096"), true, codes.join(","));
    });
  });

  Deno.test(`[${kind}] state digests are matched case-insensitively, not flagged`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await rewriteInventory(backend, SPEC_PATH, (inventory) => {
        const versions = inventory.versions as Record<
          string,
          { state: Record<string, string[]> }
        >;
        const state = versions.v2.state;
        const [digest, paths] = Object.entries(state)[0];
        delete state[digest];
        state[digest.toUpperCase()] = paths;
      });
      const result = await validateObject(backend, SPEC_PATH);
      // Only E064/E066 from the edit itself — no E050 digest-resolution failure.
      assertEquals(result.errors.some((issue) => issue.code === "E050"), false);
    });
  });

  // Invariant 7 — path safety.
  Deno.test(`[${kind}] an unsafe logical path is flagged (E052)`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await rewriteInventory(backend, SPEC_PATH, (inventory) => {
        const versions = inventory.versions as Record<
          string,
          { state: Record<string, string[]> }
        >;
        const state = versions.v2.state;
        const digest = Object.keys(state)[0];
        state[digest] = ["../escape.md"];
      });
      const codes = await objectErrorCodes(backend);
      assertEquals(codes.includes("E052"), true, codes.join(","));
    });
  });

  Deno.test(`[${kind}] conflicting logical paths are flagged (E095)`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await rewriteInventory(backend, SPEC_PATH, (inventory) => {
        const versions = inventory.versions as Record<
          string,
          { state: Record<string, string[]> }
        >;
        const state = versions.v2.state;
        const digest = Object.keys(state)[0];
        state[digest] = ["docs", "docs/spec.md"];
      });
      const codes = await objectErrorCodes(backend);
      assertEquals(codes.includes("E095"), true, codes.join(","));
    });
  });

  // Invariant 8 — no stray files.
  Deno.test(`[${kind}] a stray file in the object root is flagged (E001)`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await backend.write(`${SPEC_PATH}/notes.txt`, encoder.encode("stray\n"));
      assertEquals(await objectErrorCodes(backend), ["E001"]);
    });
  });

  Deno.test(`[${kind}] a stray file in a version directory is flagged (E015)`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await backend.write(
        `${SPEC_PATH}/v1/notes.txt`,
        encoder.encode("stray\n"),
      );
      assertEquals(await objectErrorCodes(backend), ["E015"]);
    });
  });

  Deno.test(`[${kind}] an unmanifested content file is flagged (E023)`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await backend.write(
        `${SPEC_PATH}/v1/content/extra.md`,
        encoder.encode("not in the manifest\n"),
      );
      assertEquals(await objectErrorCodes(backend), ["E023"]);
    });
  });

  Deno.test(`[${kind}] a missing manifest content file is flagged (E092)`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await backend.delete(`${SPEC_PATH}/v1/content/spec.md`);
      const codes = await objectErrorCodes(backend);
      assertEquals(codes.includes("E092"), true, codes.join(","));
    });
  });

  Deno.test(`[${kind}] a file in an intermediate hierarchy directory is flagged (E072)`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await backend.write("5b8/259/junk.txt", encoder.encode("stray\n"));
      const result = await validateStorageRoot(backend);
      assertEquals(result.rootErrors.map((issue) => issue.code), ["E072"]);
      assertEquals(result.valid, false);
    });
  });

  Deno.test(`[${kind}] a missing object declaration is flagged (E003)`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await backend.delete(`${SPEC_PATH}/0=ocfl_object_1.1`);
      const result = await validateObject(backend, SPEC_PATH);
      assertEquals(result.errors.some((issue) => issue.code === "E003"), true);
    });
  });

  // Fixity tiers are genuinely separate.
  Deno.test(`[${kind}] a corrupted content file passes structural but fails full fixity`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      const contentKey = `${SPEC_PATH}/v1/content/spec.md`;
      const bytes = await backend.read(contentKey);
      if (bytes === null) throw new Error("expected fixture content");
      bytes[0] = bytes[0] ^ 0xff;
      await backend.write(contentKey, bytes);

      const structural = await validateObject(backend, SPEC_PATH);
      assertEquals(structural.errors, []);

      const fixity = await validateObject(backend, SPEC_PATH, {
        fullFixity: true,
      });
      assertEquals(fixity.errors.map((issue) => issue.code), ["E092"]);
      assertEquals(fixity.errors[0].message.includes("digest mismatch"), true);
    });
  });

  // The documented crash window between root inventory and root sidecar writes.
  Deno.test(`[${kind}] a stale root sidecar is reported as recoverable, not corruption`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await backend.write(
        `${SPEC_PATH}/${sidecarFilename("sha512")}`,
        encoder.encode(`${"0".repeat(128)} inventory.json\n`),
      );
      const result = await validateObject(backend, SPEC_PATH);
      assertEquals(result.errors.map((issue) => issue.code), ["E060"]);
      assertEquals(result.recoverable, true);
    });
  });

  Deno.test(`[${kind}] a corrupted root inventory is not treated as recoverable`, async () => {
    await withFixtureBackend(kind, async (backend) => {
      await rewriteInventory(backend, SPEC_PATH, (inventory) => {
        inventory.head = "v1";
      }, { updateSidecar: false });
      const result = await validateObject(backend, SPEC_PATH);
      assertEquals(result.recoverable, false);
      assertEquals(result.valid, false);
    });
  });
}

// Empty directories can only exist on a real filesystem, so E073 is
// local-only — on object stores the condition is unrepresentable.
Deno.test("an empty directory under the storage root is flagged (E073)", async () => {
  await withFixtureCopy(async (root) => {
    await Deno.mkdir(`${root}/abc/def`, { recursive: true });
    const result = await validateStorageRoot(new LocalBackend(root));
    assertEquals(result.rootErrors.map((issue) => issue.code), ["E073"]);
  });
});
