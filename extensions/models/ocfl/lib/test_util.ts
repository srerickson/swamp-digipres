/**
 * Shared helpers for the OCFL library test suite.
 *
 * Not a model file — it has no `export const model`, so swamp's loader skips
 * it, and nothing in `mod.ts` imports it so it is never bundled.
 *
 * @module
 */

/** Absolute path to the checked-in read-only fixture storage root. */
export const FIXTURE_ROOT = new URL(
  "../../../../testdata/fixtures/ocfl-root",
  import.meta.url,
).pathname;

/** Object ids present in the fixture root. */
export const FIXTURE_IDS = {
  spec: "urn:swamp-premis:ocfl-spec",
  dataDictionary: "urn:swamp-premis:premis-data-dictionary",
  xsd: "urn:swamp-premis:premis-xsd",
} as const;

/** Known on-disk object root paths in the fixture, relative to the root. */
export const FIXTURE_PATHS: Record<string, string> = {
  [FIXTURE_IDS.spec]:
    "5b8/259/53a/5b825953afc3bbb6b2f5b774db30a1958870fe6bb2db9738775c211a2c4a25c0",
  [FIXTURE_IDS.dataDictionary]:
    "c08/d71/02d/c08d7102d1c239658615505e00e364442e2fc001cb282dad067067a0b4772d01",
  [FIXTURE_IDS.xsd]:
    "797/18e/66e/79718e66ecd28349e0f90e3789417383209c43ded1f531fea37f1051ee2773b6",
};

/** Recursively copy a directory tree. */
export async function copyTree(source: string, target: string): Promise<void> {
  await Deno.mkdir(target, { recursive: true });
  for await (const entry of Deno.readDir(source)) {
    const from = `${source}/${entry.name}`;
    const to = `${target}/${entry.name}`;
    if (entry.isDirectory) {
      await copyTree(from, to);
    } else if (entry.isFile) {
      await Deno.copyFile(from, to);
    }
  }
}

/**
 * Run a test body against a disposable copy of the fixture storage root.
 *
 * Negative and write-path tests mutate their root, so they must never touch
 * the checked-in fixture.
 */
export async function withFixtureCopy(
  body: (root: string) => Promise<void>,
): Promise<void> {
  const temp = await Deno.makeTempDir({ prefix: "ocfl-fixture-" });
  try {
    const root = `${temp}/ocfl-root`;
    await copyTree(FIXTURE_ROOT, root);
    await body(root);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
}

/** Run a test body against an empty temporary directory. */
export async function withTempDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const temp = await Deno.makeTempDir({ prefix: "ocfl-temp-" });
  try {
    await body(temp);
  } finally {
    await Deno.remove(temp, { recursive: true });
  }
}
