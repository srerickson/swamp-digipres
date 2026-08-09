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
import { removeTree } from "./tree.ts";
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

/** Drain a stream, keeping each chunk's size alongside the joined bytes. */
async function collectChunked(
  stream: ReadableStream<Uint8Array>,
): Promise<{ bytes: Uint8Array; chunks: number[] }> {
  const parts: Uint8Array[] = [];
  const chunks: number[] = [];
  for await (const chunk of stream) {
    parts.push(chunk);
    chunks.push(chunk.byteLength);
  }
  const bytes = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return { bytes, chunks };
}

/** Drain a stream into one buffer. */
async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return (await collectChunked(stream)).bytes;
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

forEachBackend("readStream round-trips a small file", async (storage) => {
  await storage.write("a/b/c.txt", encoder.encode("hello"));
  const bytes = await collect(await storage.readStream("a/b/c.txt"));
  assertEquals(decoder.decode(bytes), "hello");
});

forEachBackend("readStream handles an empty file", async (storage) => {
  await storage.write("empty.txt", new Uint8Array(new ArrayBuffer(0)));
  const { bytes, chunks } = await collectChunked(
    await storage.readStream("empty.txt"),
  );
  assertEquals(bytes.byteLength, 0);
  // An empty file is zero chunks and a clean close, not a zero-length chunk
  // forever: a consumer looping until `done` must terminate.
  assertEquals(chunks.filter((size) => size > 0).length, 0);
});

forEachBackend(
  "readStream matches read over more than one chunk",
  async (storage) => {
    // Half a mebibyte of a non-repeating pattern: large enough that every
    // backend hands it back in several chunks, and structured so a truncated,
    // duplicated, or reordered chunk changes the bytes rather than hiding in a
    // run of identical ones.
    const source = new Uint8Array(new ArrayBuffer(512 * 1024));
    for (let index = 0; index < source.byteLength; index += 1) {
      source[index] = (index * 31 + (index >> 8)) & 0xff;
    }
    await storage.write("big.bin", source);

    const { bytes, chunks } = await collectChunked(
      await storage.readStream("big.bin"),
    );
    assert(
      chunks.length > 1,
      `expected more than one chunk, got ${chunks.length}`,
    );
    assertEquals(bytes, source);
    assertEquals(bytes, await storage.read("big.bin"));
  },
);

forEachBackend(
  "readStream of a missing path throws NotFound",
  async (storage) => {
    const error = await assertRejects(() => storage.readStream("nope.txt"));
    assert(isNotFound(error), `expected NotFoundError, got ${error}`);
  },
);

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

forEachBackend("writeAtomic round-trips and overwrites", async (storage) => {
  await storage.writeAtomic("obj/inventory.json", encoder.encode("first"));
  assertEquals(
    decoder.decode(await storage.read("obj/inventory.json")),
    "first",
  );
  await storage.writeAtomic("obj/inventory.json", encoder.encode("second"));
  assertEquals(
    decoder.decode(await storage.read("obj/inventory.json")),
    "second",
  );
});

forEachBackend("writeAtomic leaves no scratch file behind", async (storage) => {
  await storage.writeAtomic("obj/v1/inventory.json", encoder.encode("{}"));
  const found: string[] = [];
  for await (const path of storage.walkFiles("")) found.push(path);
  assertEquals(found, ["obj/v1/inventory.json"]);
});

forEachBackend("writeStream round-trips a chunked source", async (storage) => {
  const chunks = ["alpha", "-", "bravo", "-", "charlie"];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  await storage.writeStream("v1/content/a.txt", stream, { size: 21 });
  assertEquals(
    decoder.decode(await storage.read("v1/content/a.txt")),
    chunks.join(""),
  );
});

forEachBackend(
  "writeStream creates intermediate directories",
  async (storage) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("x"));
        controller.close();
      },
    });
    await storage.writeStream("deep/nest/ed/file.txt", stream);
    assertEquals(await storage.exists("deep/nest/ed/file.txt"), true);
  },
);

forEachBackend("writeStream handles an empty source", async (storage) => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  await storage.writeStream("empty.txt", stream, { size: 0 });
  assertEquals((await storage.read("empty.txt")).byteLength, 0);
});

forEachBackend("remove deletes a file", async (storage) => {
  await storage.write("a/b.txt", encoder.encode("x"));
  await storage.remove("a/b.txt");
  assertEquals(await storage.exists("a/b.txt"), false);
});

forEachBackend("remove of an absent path is not an error", async (storage) => {
  await storage.remove("never/existed.txt");
});

forEachBackend(
  "removeTree deletes everything beneath a prefix",
  async (storage) => {
    await storage.write("obj/v1/content/a.txt", encoder.encode("a"));
    await storage.write("obj/v1/content/deep/b.txt", encoder.encode("b"));
    await storage.write("obj/v1/inventory.json", encoder.encode("{}"));
    await storage.write("obj/inventory.json", encoder.encode("{}"));

    const removed = await removeTree(storage, "obj/v1");
    assertEquals(removed.length, 3);

    const left: string[] = [];
    for await (const path of storage.walkFiles("")) left.push(path);
    // Only the target subtree goes; a sibling at the same level survives.
    assertEquals(left, ["obj/inventory.json"]);
  },
);

forEachBackend("removeTree refuses an empty prefix", async (storage) => {
  await storage.write("a.txt", encoder.encode("x"));
  await assertRejects(() => removeTree(storage, ""), Error, "non-empty prefix");
  assertEquals(await storage.exists("a.txt"), true);
});

Deno.test("pruneEmptyDirs removes the skeleton a removed subtree left", async () => {
  // Only meaningful on a real filesystem: an empty directory under a storage
  // root is an E073 violation, where an S3 prefix simply ceases to exist.
  const dir = await Deno.makeTempDir({ prefix: "ocfl-prune-" });
  try {
    const storage = new LocalStorage(dir);
    await storage.write(
      "5b8/259/53a/obj/v1/content/a.txt",
      encoder.encode("a"),
    );
    await removeTree(storage, "5b8/259/53a/obj");
    for (let depth = 3; depth > 0; depth -= 1) {
      await storage.pruneEmptyDirs?.(
        ["5b8", "259", "53a"].slice(0, depth).join("/"),
      );
    }
    assertEquals(await Array.fromAsync(Deno.readDir(dir)), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("pruneEmptyDirs never removes the storage root", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ocfl-prune-root-" });
  try {
    await new LocalStorage(dir).pruneEmptyDirs?.("");
    assertEquals((await Deno.stat(dir)).isDirectory, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("joinPath drops empty segments", () => {
  assertEquals(joinPath("", "inventory.json"), "inventory.json");
  assertEquals(joinPath("a", "b/c", ""), "a/b/c");
  assertEquals(joinPath("", ""), "");
  assertEquals(joinPath("a/", "/b"), "a/b");
});
