import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { OcflError } from "../errors.ts";
import { PreconditionFailedError, readText } from "./backend.ts";
import { MemoryBackend } from "./memory.ts";

const encoder = new TextEncoder();

Deno.test("read/write round-trips and missing keys read as null", async () => {
  const backend = new MemoryBackend();
  await backend.write("a/b/file.txt", encoder.encode("hello"));
  assertEquals(await readText(backend, "a/b/file.txt"), "hello");
  assertEquals(await backend.read("a/b/other.txt"), null);
});

Deno.test("list groups keys by delimiter like ListObjectsV2", async () => {
  const backend = new MemoryBackend();
  await backend.write("root/file.txt", encoder.encode("f"));
  await backend.write("root/sub/nested.txt", encoder.encode("n"));
  await backend.write("root/sub/deeper/again.txt", encoder.encode("d"));

  const entries = await backend.list("root");
  entries?.sort((a, b) => a.name.localeCompare(b.name));
  assertEquals(entries, [
    { name: "file.txt", kind: "file" },
    { name: "sub", kind: "dir" },
  ]);

  const top = await backend.list("");
  assertEquals(top, [{ name: "root", kind: "dir" }]);
});

Deno.test("empty prefixes do not exist: list returns null, never []", async () => {
  const backend = new MemoryBackend();
  assertEquals(await backend.list(""), null);
  assertEquals(await backend.list("nothing"), null);

  await backend.write("root/file.txt", encoder.encode("f"));
  await backend.delete("root/file.txt");
  assertEquals(await backend.list("root"), null);
});

Deno.test("listing a file key finds nothing under it", async () => {
  const backend = new MemoryBackend();
  await backend.write("root/file.txt", encoder.encode("f"));
  assertEquals(await backend.list("root/file.txt"), null);
});

Deno.test("exists is exact-key; prefixExists covers descendants", async () => {
  const backend = new MemoryBackend();
  await backend.write("root/sub/file.txt", encoder.encode("f"));
  assertEquals(await backend.exists("root/sub/file.txt"), true);
  assertEquals(await backend.exists("root/sub"), false);
  assertEquals(await backend.prefixExists("root/sub"), true);
  assertEquals(await backend.prefixExists("root"), true);
  assertEquals(await backend.prefixExists("other"), false);
});

Deno.test("ifNoneMatch enforces first-writer-wins", async () => {
  const backend = new MemoryBackend();
  await backend.write("claim", encoder.encode("first"), { ifNoneMatch: true });
  await assertRejects(
    () => backend.write("claim", encoder.encode("second"), { ifNoneMatch: true }),
    PreconditionFailedError,
  );
  assertEquals(await readText(backend, "claim"), "first");
});

Deno.test("ifMatch succeeds on the current etag and fails after a change", async () => {
  const backend = new MemoryBackend();
  await backend.write("key", encoder.encode("one"));
  const meta = await backend.readWithMeta("key");
  const etag = meta?.etag;
  if (etag === undefined) throw new Error("expected an etag");

  await backend.write("key", encoder.encode("two"), { ifMatch: etag });
  await assertRejects(
    () => backend.write("key", encoder.encode("three"), { ifMatch: etag }),
    PreconditionFailedError,
  );
  assertEquals(await readText(backend, "key"), "two");
});

Deno.test("ifMatch fails when the key is missing", async () => {
  const backend = new MemoryBackend();
  await assertRejects(
    () => backend.write("gone", encoder.encode("x"), { ifMatch: "etag" }),
    PreconditionFailedError,
  );
});

Deno.test("deletePrefix removes every descendant and nothing else", async () => {
  const backend = new MemoryBackend();
  await backend.write("a/one.txt", encoder.encode("1"));
  await backend.write("a/sub/two.txt", encoder.encode("2"));
  await backend.write("ab/three.txt", encoder.encode("3"));
  await backend.deletePrefix("a");
  assertEquals(await backend.list("a"), null);
  assertEquals(await readText(backend, "ab/three.txt"), "3");
});

Deno.test("onWrite fires before conditional checks; failNextWrite is one-shot", async () => {
  const backend = new MemoryBackend();

  // A "concurrent writer" claims the key inside our conditional write.
  backend.onWrite = (key) => {
    if (key !== "raced") return;
    backend.onWrite = undefined;
    backend.objects.set("raced", {
      data: encoder.encode("winner"),
      etag: "w",
    });
  };
  await assertRejects(
    () => backend.write("raced", encoder.encode("loser"), { ifNoneMatch: true }),
    PreconditionFailedError,
  );
  assertEquals(await readText(backend, "raced"), "winner");

  backend.failNextWrite((key) => key === "flaky");
  await assertRejects(
    () => backend.write("flaky", encoder.encode("x")),
    OcflError,
    "simulated write failure",
  );
  await backend.write("flaky", encoder.encode("x"));
  assertEquals(await readText(backend, "flaky"), "x");
});

Deno.test("readStream streams stored bytes and rejects missing keys", async () => {
  const backend = new MemoryBackend();
  await backend.write("s.txt", encoder.encode("streamed"));
  const chunks: Uint8Array[] = [];
  for await (const chunk of await backend.readStream("s.txt")) {
    chunks.push(chunk);
  }
  assertEquals(new TextDecoder().decode(chunks[0]), "streamed");
  await assertRejects(() => backend.readStream("missing"));
});
