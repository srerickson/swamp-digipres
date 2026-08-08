/**
 * One conformance suite run against every non-network backend.
 *
 * The OCFL layer above only ever sees the {@linkcode Storage} interface, so
 * these tests are what guarantee the backends are actually interchangeable.
 * S3 is excluded here because it needs a live endpoint; its parsing logic is
 * covered in `xml_test.ts` and the backend itself by the end-to-end run.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { isNotFound } from "../errors.ts";
import { LocalStorage } from "./local.ts";
import { MemoryStorage } from "./memory.ts";
import type { Storage } from "./types.ts";
import { joinPath } from "./types.ts";

type Backend = {
  name: string;
  create: () => Promise<{ storage: Storage; cleanup: () => Promise<void> }>;
};

const backends: Backend[] = [
  {
    name: "memory",
    create: () =>
      Promise.resolve({
        storage: new MemoryStorage(),
        cleanup: () => Promise.resolve(),
      }),
  },
  {
    name: "local",
    create: async () => {
      const dir = await Deno.makeTempDir({ prefix: "ocfl-storage-" });
      return {
        storage: new LocalStorage(dir),
        cleanup: () => Deno.remove(dir, { recursive: true }),
      };
    },
  },
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Register one test per backend. */
function forEachBackend(
  name: string,
  run: (storage: Storage) => Promise<void>,
): void {
  for (const backend of backends) {
    Deno.test(`${name} (${backend.name})`, async () => {
      const { storage, cleanup } = await backend.create();
      try {
        await run(storage);
      } finally {
        await cleanup();
      }
    });
  }
}

forEachBackend("write then read round-trips", async (storage) => {
  await storage.write("a/b/c.txt", encoder.encode("hello"));
  assertEquals(decoder.decode(await storage.read("a/b/c.txt")), "hello");
});

forEachBackend("write creates intermediate directories", async (storage) => {
  await storage.write("deep/nest/ed/file.txt", encoder.encode("x"));
  assertEquals(await storage.exists("deep/nest/ed/file.txt"), true);
});

forEachBackend("read of a missing path throws NotFound", async (storage) => {
  const error = await assertRejects(() => storage.read("nope.txt"));
  assert(isNotFound(error), `expected NotFoundError, got ${error}`);
});

forEachBackend("exists is false for missing paths", async (storage) => {
  assertEquals(await storage.exists("nope.txt"), false);
});

forEachBackend("exists is false for directories", async (storage) => {
  await storage.write("dir/file.txt", encoder.encode("x"));
  assertEquals(await storage.exists("dir"), false);
});

forEachBackend("listDir separates files from directories", async (storage) => {
  await storage.write("root/0=ocfl_1.1", encoder.encode("ocfl_1.1\n"));
  await storage.write("root/ocfl_layout.json", encoder.encode("{}"));
  await storage.write("root/5b8/259/inventory.json", encoder.encode("{}"));

  assertEquals(await storage.listDir("root"), [
    { name: "0=ocfl_1.1", type: "file" },
    { name: "5b8", type: "dir" },
    { name: "ocfl_layout.json", type: "file" },
  ]);
});

forEachBackend("listDir of a missing directory is empty", async (storage) => {
  // Absence and emptiness are indistinguishable on S3; every backend matches.
  assertEquals(await storage.listDir("does/not/exist"), []);
});

forEachBackend("listDir of the root uses an empty path", async (storage) => {
  await storage.write("top.txt", encoder.encode("x"));
  assertEquals(await storage.listDir(""), [{ name: "top.txt", type: "file" }]);
});

forEachBackend("walkFiles yields every nested file", async (storage) => {
  await storage.write("r/0=ocfl_1.1", encoder.encode("ocfl_1.1\n"));
  await storage.write("r/a/b/c/one.txt", encoder.encode("1"));
  await storage.write("r/a/two.txt", encoder.encode("2"));

  const found: string[] = [];
  for await (const path of storage.walkFiles("r")) found.push(path);
  found.sort();

  assertEquals(found, ["r/0=ocfl_1.1", "r/a/b/c/one.txt", "r/a/two.txt"]);
});

forEachBackend("paths are normalized, not doubled", async (storage) => {
  await storage.write("/a//b.txt", encoder.encode("v"));
  assertEquals(decoder.decode(await storage.read("a/b.txt")), "v");
});

Deno.test("joinPath drops empty segments", () => {
  assertEquals(joinPath("", "inventory.json"), "inventory.json");
  assertEquals(joinPath("a", "b/c", ""), "a/b/c");
  assertEquals(joinPath("", ""), "");
  assertEquals(joinPath("a/", "/b"), "a/b");
});
