/**
 * Model-wrapper tests, including the mechanical schema-write conformance
 * checks the adversarial review gate requires.
 *
 * Swamp only *warns* when written data does not match a resource schema, so
 * these assertions are what actually catch a schema/write drift.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import {
  exportInstanceName,
  ExportSchema,
  model,
  objectInstanceName,
  ObjectSchema,
  objectSnapshot,
  RootSchema,
  rootSnapshot,
} from "./mod.ts";
import { createStorage } from "./lib/config.ts";
import { OcflError } from "./lib/errors.ts";
import { HASHED_N_TUPLE } from "./lib/layout.ts";
import { findObject, listObjects } from "./lib/object.ts";
import { openStorageRoot } from "./lib/root.ts";
import { LocalStorage } from "./lib/storage/local.ts";

const FIXTURE =
  new URL("../../../testdata/fixtures/ocfl-root", import.meta.url).pathname;
const SPEC_ID = "urn:swamp-premis:ocfl-spec";

/** Records what a method wrote, standing in for swamp's context. */
function fakeContext(globalArgs: Record<string, unknown>) {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const logs: string[] = [];
  return {
    writes,
    logs,
    context: {
      globalArgs: model.globalArguments.parse(globalArgs),
      logger: {
        info: (message: string) => logs.push(message),
        warning: (message: string) => logs.push(message),
      },
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        writes.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    },
  };
}

/** Parse method arguments the way swamp does before calling execute. */
function args<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value);
}

Deno.test("MECHANICAL: every writeResource spec name is a declared resource", async () => {
  const source = await Deno.readTextFile(
    new URL("./mod.ts", import.meta.url).pathname,
  );
  const specs = [...source.matchAll(/writeResource\(\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  assert(specs.length > 0, "expected writeResource calls in mod.ts");
  for (const spec of specs) {
    assert(
      spec in model.resources,
      `writeResource targets "${spec}", which is not a declared resource spec`,
    );
  }
});

Deno.test("MECHANICAL: resource spec names contain no hyphens", () => {
  for (const name of Object.keys(model.resources)) {
    assertEquals(
      name.includes("-"),
      false,
      `resource spec "${name}" must not contain a hyphen`,
    );
  }
});

Deno.test("MECHANICAL: rootSnapshot matches RootSchema exactly", async () => {
  const root = await openStorageRoot(new LocalStorage(FIXTURE));
  const snapshot = rootSnapshot(root, 3);

  RootSchema.parse(snapshot); // throws on a missing or mistyped field
  assertEquals(
    Object.keys(snapshot).sort(),
    Object.keys(RootSchema.shape).sort(),
    "snapshot fields and schema fields must correspond 1:1",
  );
});

Deno.test("MECHANICAL: objectSnapshot matches ObjectSchema exactly", async () => {
  const root = await openStorageRoot(new LocalStorage(FIXTURE));
  const object = await findObject(root, SPEC_ID);
  const snapshot = objectSnapshot(object, object.inventory.head);

  ObjectSchema.parse(snapshot);
  assertEquals(
    Object.keys(snapshot).sort(),
    Object.keys(ObjectSchema.shape).sort(),
    "snapshot fields and schema fields must correspond 1:1",
  );
});

Deno.test("MECHANICAL: every object in the fixture parses under ObjectSchema", async () => {
  const root = await openStorageRoot(new LocalStorage(FIXTURE));
  for (const object of await listObjects(root)) {
    ObjectSchema.parse(objectSnapshot(object, object.inventory.head));
  }
});

Deno.test("MECHANICAL: optional schema fields are actually populated", async () => {
  // Nullable fields are only honest if some code path fills them; the fixture
  // carries message and user on every version.
  const root = await openStorageRoot(new LocalStorage(FIXTURE));
  const snapshot = objectSnapshot(await findObject(root, SPEC_ID), "v2");
  assert(snapshot.versions.every((v) => v.message !== null));
  assert(snapshot.versions.every((v) => v.userName !== null));
  assert(snapshot.versions.every((v) => v.userAddress !== null));

  const rootData = rootSnapshot(root, 3);
  assertEquals(rootData.layoutDescription, "swamp-premis test fixtures");
});

Deno.test("list writes one root resource plus one per object", async () => {
  const { context, writes } = fakeContext({
    storage: "local",
    path: FIXTURE,
  });
  await model.methods.list.execute(
    args(model.methods.list.arguments, {}),
    context,
  );

  assertEquals(writes.filter((w) => w.spec === "root").length, 1);
  assertEquals(writes.filter((w) => w.spec === "object").length, 3);
  assertEquals(writes[0].name, "root");
  assertEquals((writes[0].data as { objectCount: number }).objectCount, 3);

  // Instance names must be unique — they map straight onto storage paths.
  const names = writes.map((w) => w.name);
  assertEquals(new Set(names).size, names.length);
});

Deno.test("get writes one object resource under a stable instance name", async () => {
  const { context, writes } = fakeContext({ storage: "local", path: FIXTURE });
  await model.methods.get.execute(
    args(model.methods.get.arguments, { id: SPEC_ID }),
    context,
  );

  assertEquals(writes.length, 1);
  assertEquals(writes[0].spec, "object");
  assertEquals(writes[0].name, objectInstanceName(SPEC_ID));
  const data = ObjectSchema.parse(writes[0].data);
  assertEquals(data.id, SPEC_ID);
  assertEquals(data.version, "v2");
  assertEquals(data.state.map((entry) => entry.logicalPath), ["spec.md"]);
});

Deno.test("get resolves an explicit version", async () => {
  const { context, writes } = fakeContext({ storage: "local", path: FIXTURE });
  await model.methods.get.execute(
    args(model.methods.get.arguments, { id: SPEC_ID, version: "v1" }),
    context,
  );
  const data = ObjectSchema.parse(writes[0].data);
  assertEquals(data.version, "v1");
  assertEquals(data.head, "v2");
  assertEquals(data.state[0].contentPaths, ["v1/content/spec.md"]);
});

Deno.test("get writes nothing when the object is missing", async () => {
  const { context, writes } = fakeContext({ storage: "local", path: FIXTURE });
  await assertRejects(() =>
    model.methods.get.execute(
      args(model.methods.get.arguments, { id: "urn:nope" }),
      context,
    )
  );
  // Throwing before any write is the contract — a failed run must not persist
  // a misleading snapshot.
  assertEquals(writes.length, 0);
});

Deno.test("init creates a root and reports it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ocfl-mod-init-" });
  try {
    const { context, writes } = fakeContext({ storage: "local", path: dir });
    await model.methods.init.execute(
      args(model.methods.init.arguments, { description: "smoke" }),
      context,
    );

    assertEquals(writes.length, 1);
    assertEquals(writes[0].spec, "root");
    const data = RootSchema.parse(writes[0].data);
    assertEquals(data.specVersion, "1.1");
    assertEquals(data.layout, HASHED_N_TUPLE);
    assertEquals(data.layoutDescription, "smoke");
    assertEquals(data.layoutSupported, true);
    assertEquals(data.objectCount, 0);
    assertEquals(data.backend, "local");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the storage-root-declaration check passes on the fixture", async () => {
  const result = await model.checks["storage-root-declaration"].execute({
    globalArgs: model.globalArguments.parse({
      storage: "local",
      path: FIXTURE,
    }),
  });
  assertEquals(result.pass, true);
});

Deno.test("the storage-root-declaration check fails on bad configuration", async () => {
  const result = await model.checks["storage-root-declaration"].execute({
    globalArgs: model.globalArguments.parse({ storage: "local" }),
  });
  assertEquals(result.pass, false);
  assert(result.errors?.[0].includes("requires 'path'"));
});

Deno.test("the storage-root-declaration check passes on an absent root", async () => {
  // Absent is fine — init is the method that creates it.
  const result = await model.checks["storage-root-declaration"].execute({
    globalArgs: model.globalArguments.parse({
      storage: "local",
      path: "/nonexistent/ocfl-root",
    }),
  });
  assertEquals(result.pass, true);
});

/** Export the fixture object into a temp directory, through the model method. */
async function exportFixture(
  overrides: Record<string, unknown> = {},
  id: string = SPEC_ID,
) {
  const dest = await Deno.makeTempDir({ prefix: "ocfl-mod-export-" });
  const { context, writes, logs } = fakeContext({
    storage: "local",
    path: FIXTURE,
  });
  const run = () =>
    model.methods.export.execute(
      args(model.methods.export.arguments, { id, dest, ...overrides }),
      context,
    );
  return {
    dest,
    writes,
    logs,
    run,
    cleanup: () => Deno.remove(dest, { recursive: true }).catch(() => {}),
  };
}

Deno.test("export writes one export resource naming what it placed", async () => {
  const run = await exportFixture();
  try {
    await run.run();

    assertEquals(run.writes.length, 1);
    assertEquals(run.writes[0].spec, "export");
    assertEquals(run.writes[0].name, exportInstanceName(SPEC_ID, run.dest));

    const data = ExportSchema.parse(run.writes[0].data);
    assertEquals(data.id, SPEC_ID);
    assertEquals(data.version, "v2");
    assertEquals(data.dest, run.dest);
    assertEquals(data.fileCount, 1);
    assertEquals(data.files[0].logicalPath, "spec.md");
    assertEquals(data.files[0].destPath, `${run.dest}/spec.md`);
    assertEquals(data.files[0].source, "fetched");
    assertEquals(data.files[0].verified, true);
    assertEquals(data.byteCount, data.files[0].size);
    assertEquals(
      (await Deno.stat(data.files[0].destPath)).size,
      data.byteCount,
    );
  } finally {
    await run.cleanup();
  }
});

Deno.test("MECHANICAL: export output matches ExportSchema exactly", async () => {
  const run = await exportFixture();
  try {
    await run.run();
    assertEquals(
      Object.keys(run.writes[0].data).sort(),
      Object.keys(ExportSchema.shape).sort(),
      "snapshot fields and schema fields must correspond 1:1",
    );
    const files = (run.writes[0].data as { files: Record<string, unknown>[] })
      .files;
    assertEquals(
      Object.keys(files[0]).sort(),
      ["destPath", "digest", "logicalPath", "size", "source", "verified"],
    );
  } finally {
    await run.cleanup();
  }
});

Deno.test("export resolves an explicit version", async () => {
  const run = await exportFixture({ version: "v1" });
  try {
    await run.run();
    const data = ExportSchema.parse(run.writes[0].data);
    assertEquals(data.version, "v1");
    // v1 and v2 of the fixture's spec.md differ, so this is a real selection.
    assertEquals(data.files[0].digest.length > 0, true);
  } finally {
    await run.cleanup();
  }
});

Deno.test("export writes no resource when the object is missing", async () => {
  const run = await exportFixture({}, "urn:nope");
  try {
    await assertRejects(run.run);
    assertEquals(run.writes.length, 0);
    // Nothing was staged, so the destination stays empty.
    const entries = [];
    for await (const entry of Deno.readDir(run.dest)) entries.push(entry.name);
    assertEquals(entries, []);
  } finally {
    await run.cleanup();
  }
});

Deno.test("export defaults concurrency rather than requiring it", () => {
  const parsed = model.methods.export.arguments.parse({
    id: SPEC_ID,
    dest: "/tmp/staging",
  });
  assertEquals(parsed.concurrency, 4);
  assertEquals(parsed.only, undefined);
  assertEquals(parsed.version, undefined);
});

Deno.test("export takes only as one path or as a list, unnormalized", () => {
  const parse = (only: unknown) =>
    model.methods.export.arguments.parse({
      id: SPEC_ID,
      dest: "/tmp/staging",
      only,
    }).only;

  // Normalizing is `lib/`'s job, so the schema keeps both shapes visible to
  // anyone reading the generated argument documentation.
  assertEquals(parse("spec.md"), "spec.md");
  assertEquals(parse(["spec.md", "docs/b.txt"]), ["spec.md", "docs/b.txt"]);
});

Deno.test("export accepts a list of logical paths end to end", async () => {
  const run = await exportFixture({ only: ["spec.md"] });
  try {
    await run.run();
    const data = ExportSchema.parse(run.writes[0].data);
    assertEquals(data.fileCount, 1);
    assertEquals(data.files[0].logicalPath, "spec.md");
    assertEquals(data.files[0].destPath, `${run.dest}/spec.md`);
  } finally {
    await run.cleanup();
  }
});

Deno.test("exportInstanceName distinguishes destinations", () => {
  const name = exportInstanceName(SPEC_ID, "/tmp/a");
  assertEquals(name, exportInstanceName(SPEC_ID, "/tmp/a"));
  assertEquals(/^[A-Za-z0-9._-]+$/.test(name), true);
  assert(name.startsWith("export-urn-swamp-premis-ocfl-spec-"));

  // Same object staged twice must not have one manifest overwrite the other.
  assert(name !== exportInstanceName(SPEC_ID, "/tmp/b"));
});

Deno.test("objectInstanceName is stable, safe, and injective", () => {
  const name = objectInstanceName(SPEC_ID);
  assertEquals(name, objectInstanceName(SPEC_ID));
  assertEquals(/^[A-Za-z0-9._-]+$/.test(name), true);
  assert(name.startsWith("object-urn-swamp-premis-ocfl-spec-"));

  // Ids that sanitize identically must still get distinct instance names.
  assert(objectInstanceName("a:b") !== objectInstanceName("a/b"));
});

/** A temp storage root plus a temp source directory, for the write tests. */
async function writableRepo() {
  const rootDir = await Deno.makeTempDir({ prefix: "ocfl-mod-write-" });
  const sourceDir = await Deno.makeTempDir({ prefix: "ocfl-mod-src-" });
  await model.methods.init.execute(
    args(model.methods.init.arguments, {}),
    fakeContext({ storage: "local", path: rootDir }).context,
  );
  return {
    rootDir,
    async source(name: string, contents: string) {
      const path = `${sourceDir}/${name}`;
      await Deno.writeTextFile(path, contents);
      return path;
    },
    async cleanup() {
      for (const dir of [rootDir, sourceDir]) {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
    },
  };
}

const AGENT = {
  userName: "Test Agent",
  userAddress: "mailto:test@example.com",
};

Deno.test("create_version writes one object resource for a new object", async () => {
  const repo = await writableRepo();
  try {
    const { context, writes } = fakeContext({
      storage: "local",
      path: repo.rootDir,
    });
    await model.methods.create_version.execute(
      args(model.methods.create_version.arguments, {
        id: "urn:example:new-1",
        ops: [`add:${await repo.source("a.txt", "alpha")}:docs/a.txt`],
        version: 1,
        message: "initial deposit",
        ...AGENT,
      }),
      context,
    );

    assertEquals(writes.length, 1);
    assertEquals(writes[0].spec, "object");
    assertEquals(writes[0].name, objectInstanceName("urn:example:new-1"));

    const data = ObjectSchema.parse(writes[0].data);
    assertEquals(data.id, "urn:example:new-1");
    assertEquals(data.head, "v1");
    assertEquals(data.version, "v1");
    assertEquals(data.versionCount, 1);
    assertEquals(data.digestAlgorithm, "sha512");
    assertEquals(data.state.map((entry) => entry.logicalPath), ["docs/a.txt"]);
    assertEquals(data.state[0].contentPaths, ["v1/content/docs/a.txt"]);
    assertEquals(data.versions[0].message, "initial deposit");
    assertEquals(data.versions[0].userName, AGENT.userName);
  } finally {
    await repo.cleanup();
  }
});

Deno.test("MECHANICAL: create_version output matches ObjectSchema exactly", async () => {
  const repo = await writableRepo();
  try {
    const { context, writes } = fakeContext({
      storage: "local",
      path: repo.rootDir,
    });
    await model.methods.create_version.execute(
      args(model.methods.create_version.arguments, {
        id: "urn:example:shape",
        ops: [`add:${await repo.source("a.txt", "alpha")}:a.txt`],
        ...AGENT,
      }),
      context,
    );
    assertEquals(
      Object.keys(writes[0].data).sort(),
      Object.keys(ObjectSchema.shape).sort(),
      "snapshot fields and schema fields must correspond 1:1",
    );
  } finally {
    await repo.cleanup();
  }
});

Deno.test("create_version updates an existing object and reports the new head", async () => {
  const repo = await writableRepo();
  try {
    const { context, writes } = fakeContext({
      storage: "local",
      path: repo.rootDir,
    });
    const create = args(model.methods.create_version.arguments, {
      id: "urn:example:obj-2",
      ops: [`add:${await repo.source("a.txt", "alpha")}:a.txt`],
      ...AGENT,
    });
    await model.methods.create_version.execute(create, context);

    await model.methods.create_version.execute(
      args(model.methods.create_version.arguments, {
        id: "urn:example:obj-2",
        ops: [`add:${await repo.source("b.txt", "bravo")}:b.txt`],
        version: 2,
        ...AGENT,
      }),
      context,
    );

    assertEquals(writes.length, 2);
    // Both runs write the same instance, so the resource tracks the object
    // rather than accumulating one entry per version.
    assertEquals(writes[0].name, writes[1].name);
    const data = ObjectSchema.parse(writes[1].data);
    assertEquals(data.head, "v2");
    assertEquals(data.versionCount, 2);
    assertEquals(data.state.map((entry) => entry.logicalPath), [
      "a.txt",
      "b.txt",
    ]);
  } finally {
    await repo.cleanup();
  }
});

Deno.test("create_version dry run writes no resource and no storage", async () => {
  const repo = await writableRepo();
  try {
    const { context, writes } = fakeContext({
      storage: "local",
      path: repo.rootDir,
    });
    await model.methods.create_version.execute(
      args(model.methods.create_version.arguments, {
        id: "urn:example:dry",
        ops: [`add:${await repo.source("a.txt", "alpha")}:a.txt`],
        dryRun: true,
        ...AGENT,
      }),
      context,
    );

    assertEquals(writes.length, 0);
    // The object must not exist afterwards — a dry run that deposited anything
    // would be worse than useless.
    const storage = new LocalStorage(repo.rootDir);
    const root = await openStorageRoot(storage);
    assertEquals((await listObjects(root)).length, 0);
  } finally {
    await repo.cleanup();
  }
});

Deno.test("create_version writes no resource when the commit fails", async () => {
  const repo = await writableRepo();
  try {
    const { context, writes } = fakeContext({
      storage: "local",
      path: repo.rootDir,
    });
    await assertRejects(() =>
      model.methods.create_version.execute(
        args(model.methods.create_version.arguments, {
          id: "urn:example:missing-source",
          ops: ["add:/nonexistent/nope.txt:a.txt"],
          ...AGENT,
        }),
        context,
      )
    );
    assertEquals(writes.length, 0);
  } finally {
    await repo.cleanup();
  }
});

Deno.test("create_version requires a user for provenance", () => {
  // W007 wants name and address, and an anonymous version cannot be corrected
  // after the fact — so the schema refuses rather than omitting the block.
  assertThrows(() =>
    model.methods.create_version.arguments.parse({
      id: "urn:example:anon",
      ops: ["add:/tmp/a.txt:a.txt"],
    })
  );
});

Deno.test("create_version accepts ops as one newline-delimited string", () => {
  const parsed = model.methods.create_version.arguments.parse({
    id: "urn:example:multiline",
    ops: "add:/tmp/a.txt:a.txt\nremove:b.txt",
    ...AGENT,
  });
  assertEquals(parsed.ops, "add:/tmp/a.txt:a.txt\nremove:b.txt");
  assertEquals(parsed.dryRun, false);
  assertEquals(parsed.allowNoChange, false);
});

Deno.test("createStorage rejects a local root without a path", () => {
  let threw = false;
  try {
    createStorage({ storage: "local" });
  } catch (error) {
    threw = true;
    assert(error instanceof OcflError);
  }
  assertEquals(threw, true);
});

Deno.test("createStorage rejects a relative local path", () => {
  let threw = false;
  try {
    createStorage({ storage: "local", path: "relative/root" });
  } catch (error) {
    threw = true;
    assert((error as Error).message.includes("absolute"));
  }
  assertEquals(threw, true);
});

Deno.test("createStorage rejects s3 without a bucket", () => {
  let threw = false;
  try {
    createStorage({ storage: "s3", accessKeyId: "k", secretAccessKey: "s" });
  } catch (error) {
    threw = true;
    assert((error as Error).message.includes("bucket"));
  }
  assertEquals(threw, true);
});

Deno.test("createStorage builds an S3 backend from explicit credentials", () => {
  const storage = createStorage({
    storage: "s3",
    bucket: "swamp-test",
    prefix: "ocfl-test",
    endpoint: "https://example.r2.cloudflarestorage.com",
    region: "auto",
    accessKeyId: "key",
    secretAccessKey: "secret",
  });
  assertEquals(storage.backend, "s3");
  assertEquals(storage.location, "s3://swamp-test/ocfl-test");
});
