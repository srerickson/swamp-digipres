/**
 * Model-wrapper tests, including the mechanical schema-write conformance
 * checks the adversarial review gate requires.
 *
 * Swamp only *warns* when written data does not match a resource schema, so
 * these assertions are what actually catch a schema/write drift.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { z } from "npm:zod@4";
import {
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

Deno.test("objectInstanceName is stable, safe, and injective", () => {
  const name = objectInstanceName(SPEC_ID);
  assertEquals(name, objectInstanceName(SPEC_ID));
  assertEquals(/^[A-Za-z0-9._-]+$/.test(name), true);
  assert(name.startsWith("object-urn-swamp-premis-ocfl-spec-"));

  // Ids that sanitize identically must still get distinct instance names.
  assert(objectInstanceName("a:b") !== objectInstanceName("a/b"));
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
