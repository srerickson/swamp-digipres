import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { OcflError } from "../errors.ts";
import { withTempDir } from "../test_util.ts";
import { PreconditionFailedError, readText } from "./backend.ts";
import { LocalBackend } from "./local.ts";

const encoder = new TextEncoder();

Deno.test("read returns bytes for existing keys and null for absent ones", async () => {
  await withTempDir(async (dir) => {
    const backend = new LocalBackend(dir);
    await backend.write("a/b/file.txt", encoder.encode("hello"));
    assertEquals(await readText(backend, "a/b/file.txt"), "hello");
    assertEquals(await backend.read("a/b/missing.txt"), null);
    assertEquals(await backend.read("missing/deep/file.txt"), null);
  });
});

Deno.test("write creates parent directories implicitly", async () => {
  await withTempDir(async (dir) => {
    const backend = new LocalBackend(dir);
    await backend.write("x/y/z/file.txt", encoder.encode("deep"));
    const info = await Deno.stat(`${dir}/x/y/z/file.txt`);
    assertEquals(info.isFile, true);
  });
});

Deno.test("readWithMeta returns data without an etag", async () => {
  await withTempDir(async (dir) => {
    const backend = new LocalBackend(dir);
    await backend.write("file.txt", encoder.encode("meta"));
    const result = await backend.readWithMeta("file.txt");
    assertEquals(new TextDecoder().decode(result?.data), "meta");
    assertEquals(result?.etag, undefined);
    assertEquals(await backend.readWithMeta("absent.txt"), null);
  });
});

Deno.test("readStream streams a key's bytes", async () => {
  await withTempDir(async (dir) => {
    const backend = new LocalBackend(dir);
    await backend.write("file.txt", encoder.encode("streamed"));
    const stream = await backend.readStream("file.txt");
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = new TextDecoder().decode(
      chunks.reduce((all, chunk) => {
        const merged = new Uint8Array(all.length + chunk.length);
        merged.set(all);
        merged.set(chunk, all.length);
        return merged;
      }, new Uint8Array()),
    );
    assertEquals(text, "streamed");
    await assertRejects(() => backend.readStream("absent.txt"));
  });
});

Deno.test("list returns entries, [] for empty directories, null when absent", async () => {
  await withTempDir(async (dir) => {
    const backend = new LocalBackend(dir);
    await backend.write("root/file.txt", encoder.encode("f"));
    await backend.write("root/sub/nested.txt", encoder.encode("n"));
    const entries = await backend.list("root");
    entries?.sort((a, b) => a.name.localeCompare(b.name));
    assertEquals(entries, [
      { name: "file.txt", kind: "file" },
      { name: "sub", kind: "dir" },
    ]);

    await Deno.mkdir(`${dir}/empty`);
    assertEquals(await backend.list("empty"), []);
    assertEquals(await backend.list("absent"), null);
  });
});

Deno.test("list classifies symlinks as files", async () => {
  await withTempDir(async (dir) => {
    const backend = new LocalBackend(dir);
    await backend.write("root/target.txt", encoder.encode("t"));
    await Deno.symlink(`${dir}/root/target.txt`, `${dir}/root/link`);
    const entries = await backend.list("root");
    const link = entries?.find((entry) => entry.name === "link");
    assertEquals(link?.kind, "file");
  });
});

Deno.test("list throws OcflError when the prefix is a file", async () => {
  await withTempDir(async (dir) => {
    const backend = new LocalBackend(dir);
    await backend.write("file.txt", encoder.encode("f"));
    await assertRejects(() => backend.list("file.txt"), OcflError);
  });
});

Deno.test("prefixExists follows directory semantics", async () => {
  await withTempDir(async (dir) => {
    const backend = new LocalBackend(dir);
    await backend.write("root/file.txt", encoder.encode("f"));
    assertEquals(await backend.prefixExists("root"), true);
    assertEquals(await backend.prefixExists("root/file.txt"), false);
    assertEquals(await backend.prefixExists("absent"), false);
  });
});

Deno.test("exists uses lstat so dangling symlinks exist", async () => {
  await withTempDir(async (dir) => {
    const backend = new LocalBackend(dir);
    await Deno.symlink(`${dir}/nowhere`, `${dir}/dangling`);
    assertEquals(await backend.exists("dangling"), true);
    assertEquals(await backend.exists("absent"), false);
  });
});

Deno.test("delete ignores missing keys; deletePrefix removes trees", async () => {
  await withTempDir(async (dir) => {
    const backend = new LocalBackend(dir);
    await backend.write("root/a.txt", encoder.encode("a"));
    await backend.write("root/sub/b.txt", encoder.encode("b"));
    await backend.delete("root/a.txt");
    assertEquals(await backend.read("root/a.txt"), null);
    await backend.delete("root/a.txt");

    await backend.deletePrefix("root");
    assertEquals(await backend.list("root"), null);
    await backend.deletePrefix("root");
  });
});

Deno.test("write with ifNoneMatch fails atomically when the key exists", async () => {
  await withTempDir(async (dir) => {
    const backend = new LocalBackend(dir);
    await backend.write("claim.txt", encoder.encode("first"), {
      ifNoneMatch: true,
    });
    await assertRejects(
      () =>
        backend.write("claim.txt", encoder.encode("second"), {
          ifNoneMatch: true,
        }),
      PreconditionFailedError,
    );
    assertEquals(await readText(backend, "claim.txt"), "first");
  });
});

Deno.test("write with ifMatch is unsupported locally", async () => {
  await withTempDir(async (dir) => {
    const backend = new LocalBackend(dir);
    await backend.write("file.txt", encoder.encode("f"));
    await assertRejects(
      () => backend.write("file.txt", encoder.encode("g"), { ifMatch: "etag" }),
      OcflError,
    );
  });
});

Deno.test("writeFromFile copies a local file into the root", async () => {
  await withTempDir(async (dir) => {
    const backend = new LocalBackend(`${dir}/root`);
    await Deno.writeTextFile(`${dir}/source.txt`, "copied");
    await backend.writeFromFile("a/b/target.txt", `${dir}/source.txt`);
    assertEquals(await readText(backend, "a/b/target.txt"), "copied");
  });
});

Deno.test("url and resolve reflect the root directory", async () => {
  await withTempDir(async (dir) => {
    const backend = new LocalBackend(dir);
    assertEquals(backend.url, dir);
    assertEquals(backend.resolve(""), dir);
    assertEquals(backend.resolve("a/b"), `${dir}/a/b`);
  });
});
