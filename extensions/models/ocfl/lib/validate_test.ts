import { assertEquals } from "jsr:@std/assert@1";
import { validateObject, validateStorageRoot } from "./validate.ts";
import type { ObjectValidationResult } from "./validate.ts";
import { digestBytes } from "./digest.ts";
import { sidecarFilename } from "./inventory.ts";
import {
  FIXTURE_IDS,
  FIXTURE_PATHS,
  FIXTURE_ROOT,
  withFixtureCopy,
} from "./test_util.ts";

const SPEC_PATH = FIXTURE_PATHS[FIXTURE_IDS.spec];

/** Error codes reported for one object in a fixture-copy root. */
async function objectErrorCodes(
  root: string,
  relativePath = SPEC_PATH,
): Promise<string[]> {
  const result = await validateObject(`${root}/${relativePath}`, relativePath);
  return result.errors.map((issue) => issue.code).sort();
}

/** Read, mutate, and rewrite an object's root inventory plus its sidecar. */
async function rewriteInventory(
  objectPath: string,
  mutate: (inventory: Record<string, unknown>) => void,
  options: { updateSidecar?: boolean; versionDir?: string } = {},
): Promise<void> {
  const dir = options.versionDir === undefined
    ? objectPath
    : `${objectPath}/${options.versionDir}`;
  const inventory = JSON.parse(
    await Deno.readTextFile(`${dir}/inventory.json`),
  ) as Record<string, unknown>;
  mutate(inventory);
  const bytes = new TextEncoder().encode(JSON.stringify(inventory, null, 2));
  await Deno.writeFile(`${dir}/inventory.json`, bytes);
  if (options.updateSidecar !== false) {
    await Deno.writeTextFile(
      `${dir}/${sidecarFilename("sha512")}`,
      `${digestBytes(bytes, "sha512")} inventory.json\n`,
    );
  }
}

Deno.test("the checked-in fixture validates structurally with no errors", async () => {
  const result = await validateStorageRoot(FIXTURE_ROOT);
  assertEquals(result.rootErrors, []);
  for (const object of result.objects) {
    assertEquals(object.errors, [], `errors for ${object.path}`);
    assertEquals(object.warnings, [], `warnings for ${object.path}`);
  }
  assertEquals(result.valid, true);
  assertEquals(result.objects.length, 3);
});

Deno.test("the checked-in fixture passes full fixity", async () => {
  const result = await validateStorageRoot(FIXTURE_ROOT, { fullFixity: true });
  assertEquals(result.fullFixity, true);
  assertEquals(result.valid, true);
  for (const object of result.objects) {
    assertEquals(object.errors, [], `errors for ${object.path}`);
  }
});

Deno.test("validateStorageRoot filters to requested ids", async () => {
  const result = await validateStorageRoot(FIXTURE_ROOT, {
    ids: [FIXTURE_IDS.xsd],
  });
  assertEquals(result.objects.map((object) => object.id), [FIXTURE_IDS.xsd]);
  assertEquals(result.valid, true);
});

Deno.test("an unknown requested id is reported", async () => {
  const result = await validateStorageRoot(FIXTURE_ROOT, {
    ids: ["urn:swamp-premis:nope"],
  });
  assertEquals(result.valid, false);
  assertEquals(result.rootErrors.map((issue) => issue.code), ["E083"]);
});

// Invariant 2 — root inventory must be a byte copy of the head version's.
Deno.test("a re-serialized root inventory is flagged even when semantically equal (E064)", async () => {
  await withFixtureCopy(async (root) => {
    const objectPath = `${root}/${SPEC_PATH}`;
    // Reorder keys and change whitespace without changing meaning.
    await rewriteInventory(objectPath, (inventory) => {
      const reordered: Record<string, unknown> = {};
      for (const key of Object.keys(inventory).reverse()) {
        reordered[key] = inventory[key];
      }
      for (const key of Object.keys(inventory)) delete inventory[key];
      Object.assign(inventory, reordered);
    });
    assertEquals(await objectErrorCodes(root), ["E064"]);
  });
});

// Invariant 4 — prior version blocks carried forward unchanged.
Deno.test("a mutated prior version state is flagged (E066)", async () => {
  await withFixtureCopy(async (root) => {
    const objectPath = `${root}/${SPEC_PATH}`;
    await rewriteInventory(objectPath, (inventory) => {
      const versions = inventory.versions as Record<
        string,
        { state: Record<string, string[]> }
      >;
      versions.v1.state = { ...versions.v2.state };
    });
    const codes = await objectErrorCodes(root);
    assertEquals(codes.includes("E066"), true, codes.join(","));
  });
});

Deno.test("a mutated prior version message is only a warning (W011)", async () => {
  await withFixtureCopy(async (root) => {
    const objectPath = `${root}/${SPEC_PATH}`;
    await rewriteInventory(objectPath, (inventory) => {
      const versions = inventory.versions as Record<
        string,
        { message: string }
      >;
      versions.v1.message = "rewritten after the fact";
    });
    const result = await validateObject(objectPath, SPEC_PATH);
    // E064 also fires because the root copy no longer matches v2's.
    assertEquals(result.errors.map((issue) => issue.code), ["E064"]);
    assertEquals(result.warnings.map((issue) => issue.code), ["W011"]);
  });
});

// Invariant 5 — version naming and sequencing.
Deno.test("a gap in the version sequence is flagged (E010)", async () => {
  await withFixtureCopy(async (root) => {
    const objectPath = `${root}/${SPEC_PATH}`;
    await Deno.rename(`${objectPath}/v2`, `${objectPath}/v3`);
    await rewriteInventory(objectPath, (inventory) => {
      const versions = inventory.versions as Record<string, unknown>;
      versions.v3 = versions.v2;
      delete versions.v2;
      inventory.head = "v3";
    });
    const codes = await objectErrorCodes(root);
    assertEquals(codes.includes("E010"), true, codes.join(","));
  });
});

Deno.test("mixed padded and non-padded version names are flagged (E013)", async () => {
  await withFixtureCopy(async (root) => {
    const objectPath = `${root}/${SPEC_PATH}`;
    await Deno.rename(`${objectPath}/v2`, `${objectPath}/v02`);
    await rewriteInventory(objectPath, (inventory) => {
      const versions = inventory.versions as Record<string, unknown>;
      versions.v02 = versions.v2;
      delete versions.v2;
      inventory.head = "v02";
    });
    const codes = await objectErrorCodes(root);
    assertEquals(codes.includes("E013"), true, codes.join(","));
  });
});

Deno.test("a head that is not the highest version is flagged (E040)", async () => {
  await withFixtureCopy(async (root) => {
    const objectPath = `${root}/${SPEC_PATH}`;
    await rewriteInventory(objectPath, (inventory) => {
      inventory.head = "v1";
    });
    const codes = await objectErrorCodes(root);
    assertEquals(codes.includes("E040"), true, codes.join(","));
  });
});

// Invariant 6 — digests are unique per block regardless of case.
Deno.test("a digest repeated in different case is flagged (E096)", async () => {
  await withFixtureCopy(async (root) => {
    const objectPath = `${root}/${SPEC_PATH}`;
    await rewriteInventory(objectPath, (inventory) => {
      const manifest = inventory.manifest as Record<string, string[]>;
      const [digest, paths] = Object.entries(manifest)[0];
      manifest[digest.toUpperCase()] = paths;
    });
    const codes = await objectErrorCodes(root);
    assertEquals(codes.includes("E096"), true, codes.join(","));
  });
});

Deno.test("state digests are matched case-insensitively, not flagged", async () => {
  await withFixtureCopy(async (root) => {
    const objectPath = `${root}/${SPEC_PATH}`;
    await rewriteInventory(objectPath, (inventory) => {
      const versions = inventory.versions as Record<
        string,
        { state: Record<string, string[]> }
      >;
      const state = versions.v2.state;
      const [digest, paths] = Object.entries(state)[0];
      delete state[digest];
      state[digest.toUpperCase()] = paths;
    });
    const result = await validateObject(objectPath, SPEC_PATH);
    // Only E064/E066 from the edit itself — no E050 digest-resolution failure.
    assertEquals(result.errors.some((issue) => issue.code === "E050"), false);
  });
});

// Invariant 7 — path safety.
Deno.test("an unsafe logical path is flagged (E052)", async () => {
  await withFixtureCopy(async (root) => {
    const objectPath = `${root}/${SPEC_PATH}`;
    await rewriteInventory(objectPath, (inventory) => {
      const versions = inventory.versions as Record<
        string,
        { state: Record<string, string[]> }
      >;
      const state = versions.v2.state;
      const digest = Object.keys(state)[0];
      state[digest] = ["../escape.md"];
    });
    const codes = await objectErrorCodes(root);
    assertEquals(codes.includes("E052"), true, codes.join(","));
  });
});

Deno.test("conflicting logical paths are flagged (E095)", async () => {
  await withFixtureCopy(async (root) => {
    const objectPath = `${root}/${SPEC_PATH}`;
    await rewriteInventory(objectPath, (inventory) => {
      const versions = inventory.versions as Record<
        string,
        { state: Record<string, string[]> }
      >;
      const state = versions.v2.state;
      const digest = Object.keys(state)[0];
      state[digest] = ["docs", "docs/spec.md"];
    });
    const codes = await objectErrorCodes(root);
    assertEquals(codes.includes("E095"), true, codes.join(","));
  });
});

// Invariant 8 — no stray files or empty directories.
Deno.test("a stray file in the object root is flagged (E001)", async () => {
  await withFixtureCopy(async (root) => {
    await Deno.writeTextFile(`${root}/${SPEC_PATH}/notes.txt`, "stray\n");
    assertEquals(await objectErrorCodes(root), ["E001"]);
  });
});

Deno.test("a stray file in a version directory is flagged (E015)", async () => {
  await withFixtureCopy(async (root) => {
    await Deno.writeTextFile(`${root}/${SPEC_PATH}/v1/notes.txt`, "stray\n");
    assertEquals(await objectErrorCodes(root), ["E015"]);
  });
});

Deno.test("an unmanifested content file is flagged (E023)", async () => {
  await withFixtureCopy(async (root) => {
    await Deno.writeTextFile(
      `${root}/${SPEC_PATH}/v1/content/extra.md`,
      "not in the manifest\n",
    );
    assertEquals(await objectErrorCodes(root), ["E023"]);
  });
});

Deno.test("a missing manifest content file is flagged (E092)", async () => {
  await withFixtureCopy(async (root) => {
    await Deno.remove(`${root}/${SPEC_PATH}/v1/content/spec.md`);
    const codes = await objectErrorCodes(root);
    assertEquals(codes.includes("E092"), true, codes.join(","));
  });
});

Deno.test("a file in an intermediate hierarchy directory is flagged (E072)", async () => {
  await withFixtureCopy(async (root) => {
    await Deno.writeTextFile(`${root}/5b8/259/junk.txt`, "stray\n");
    const result = await validateStorageRoot(root);
    assertEquals(result.rootErrors.map((issue) => issue.code), ["E072"]);
    assertEquals(result.valid, false);
  });
});

Deno.test("an empty directory under the storage root is flagged (E073)", async () => {
  await withFixtureCopy(async (root) => {
    await Deno.mkdir(`${root}/abc/def`, { recursive: true });
    const result = await validateStorageRoot(root);
    assertEquals(result.rootErrors.map((issue) => issue.code), ["E073"]);
  });
});

Deno.test("a missing object declaration is flagged (E003)", async () => {
  await withFixtureCopy(async (root) => {
    await Deno.remove(`${root}/${SPEC_PATH}/0=ocfl_object_1.1`);
    const result = await validateObject(`${root}/${SPEC_PATH}`, SPEC_PATH);
    assertEquals(result.errors.some((issue) => issue.code === "E003"), true);
  });
});

// Fixity tiers are genuinely separate.
Deno.test("a corrupted content file passes structural but fails full fixity", async () => {
  await withFixtureCopy(async (root) => {
    const contentPath = `${root}/${SPEC_PATH}/v1/content/spec.md`;
    const bytes = await Deno.readFile(contentPath);
    bytes[0] = bytes[0] ^ 0xff;
    await Deno.writeFile(contentPath, bytes);

    const structural = await validateObject(`${root}/${SPEC_PATH}`, SPEC_PATH);
    assertEquals(structural.errors, []);

    const fixity = await validateObject(`${root}/${SPEC_PATH}`, SPEC_PATH, {
      fullFixity: true,
    });
    assertEquals(fixity.errors.map((issue) => issue.code), ["E092"]);
    assertEquals(fixity.errors[0].message.includes("digest mismatch"), true);
  });
});

// The documented crash window between root inventory and root sidecar writes.
Deno.test("a stale root sidecar is reported as recoverable, not corruption", async () => {
  await withFixtureCopy(async (root) => {
    const objectPath = `${root}/${SPEC_PATH}`;
    await Deno.writeTextFile(
      `${objectPath}/${sidecarFilename("sha512")}`,
      `${"0".repeat(128)} inventory.json\n`,
    );
    const result: ObjectValidationResult = await validateObject(
      objectPath,
      SPEC_PATH,
    );
    assertEquals(result.errors.map((issue) => issue.code), ["E060"]);
    assertEquals(result.recoverable, true);
  });
});

Deno.test("a corrupted root inventory is not treated as recoverable", async () => {
  await withFixtureCopy(async (root) => {
    const objectPath = `${root}/${SPEC_PATH}`;
    await rewriteInventory(objectPath, (inventory) => {
      inventory.head = "v1";
    }, { updateSidecar: false });
    const result = await validateObject(objectPath, SPEC_PATH);
    assertEquals(result.recoverable, false);
    assertEquals(result.valid, false);
  });
});
