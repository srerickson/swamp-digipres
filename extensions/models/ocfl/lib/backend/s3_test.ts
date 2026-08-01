import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { OcflError } from "../errors.ts";
import { PreconditionFailedError, readText } from "./backend.ts";
import { MAX_UPLOAD_BYTES, S3Backend } from "./s3.ts";
import type { S3Options } from "./s3.ts";
import { withTempDir } from "../test_util.ts";

const encoder = new TextEncoder();

/** One recorded request seen by the fake transport. */
interface Seen {
  method: string;
  url: URL;
  headers: Headers;
  body: Uint8Array | null;
}

/** Build a backend whose transport is scripted by `handler`. */
function fakeBackend(
  handler: (seen: Seen) => Response | Promise<Response>,
  overrides: Partial<S3Options> = {},
): { backend: S3Backend; requests: Seen[] } {
  const requests: Seen[] = [];
  const backend = new S3Backend({
    bucket: "test-bucket",
    prefix: "roots/main",
    region: "us-east-1",
    accessKeyId: "AKIAFAKE",
    secretAccessKey: "secret",
    fetchFn: async (request) => {
      const body = request.body === null
        ? null
        : new Uint8Array(await request.arrayBuffer());
      const seen: Seen = {
        method: request.method,
        url: new URL(request.url),
        headers: request.headers,
        body,
      };
      requests.push(seen);
      return await handler(seen);
    },
    ...overrides,
  });
  return { backend, requests };
}

function xmlList(options: {
  keys?: string[];
  prefixes?: string[];
  nextToken?: string;
}): Response {
  const body = `<?xml version="1.0"?><ListBucketResult>${
    (options.keys ?? []).map((key) => `<Contents><Key>${key}</Key></Contents>`)
      .join("")
  }${
    (options.prefixes ?? []).map((prefix) =>
      `<CommonPrefixes><Prefix>${prefix}</Prefix></CommonPrefixes>`
    ).join("")
  }${
    options.nextToken === undefined
      ? ""
      : `<NextContinuationToken>${options.nextToken}</NextContinuationToken>`
  }</ListBucketResult>`;
  return new Response(body, { status: 200 });
}

Deno.test("virtual-hosted URLs address AWS; endpoint switches to path style", async () => {
  const { backend, requests } = fakeBackend(() =>
    new Response(null, { status: 404 })
  );
  await backend.read("a/file.txt");
  assertEquals(
    requests[0].url.href,
    "https://test-bucket.s3.us-east-1.amazonaws.com/roots/main/a/file.txt",
  );

  const custom = fakeBackend(() => new Response(null, { status: 404 }), {
    endpoint: "http://localhost:9000",
  });
  await custom.backend.read("a/file.txt");
  assertEquals(
    custom.requests[0].url.href,
    "http://localhost:9000/test-bucket/roots/main/a/file.txt",
  );
});

Deno.test("keys are RFC 3986 encoded per segment", async () => {
  const { backend, requests } = fakeBackend(() =>
    new Response(null, { status: 404 })
  );
  await backend.read("dir with spaces/naïve+file#1!().txt");
  assertEquals(
    requests[0].url.pathname,
    "/roots/main/dir%20with%20spaces/na%C3%AFve%2Bfile%231%21%28%29.txt",
  );
});

Deno.test("read returns bytes with etag, null on 404", async () => {
  const { backend } = fakeBackend((seen) => {
    if (seen.url.pathname.endsWith("/present.txt")) {
      return new Response("hello", {
        status: 200,
        headers: { etag: '"abc123"' },
      });
    }
    return new Response(null, { status: 404 });
  });
  const meta = await backend.readWithMeta("present.txt");
  assertEquals(new TextDecoder().decode(meta?.data), "hello");
  assertEquals(meta?.etag, "abc123");
  assertEquals(await backend.read("absent.txt"), null);
});

Deno.test("conditional writes send the right headers and map 412", async () => {
  const { backend, requests } = fakeBackend(() =>
    new Response(null, { status: 412 })
  );
  await assertRejects(
    () => backend.write("claim", encoder.encode("x"), { ifNoneMatch: true }),
    PreconditionFailedError,
  );
  assertEquals(requests[0].headers.get("if-none-match"), "*");

  await assertRejects(
    () => backend.write("root", encoder.encode("x"), { ifMatch: "etag99" }),
    PreconditionFailedError,
  );
  assertEquals(requests[1].headers.get("if-match"), '"etag99"');
});

Deno.test("501 degrades to check-then-write and warns once", async () => {
  const warnings: string[] = [];
  const stored = new Map<string, string>();
  const { backend } = fakeBackend((seen) => {
    const key = seen.url.pathname;
    if (seen.method === "PUT" && seen.headers.has("if-none-match")) {
      return new Response(null, { status: 501 });
    }
    if (seen.method === "HEAD") {
      return new Response(null, { status: stored.has(key) ? 200 : 404 });
    }
    if (seen.method === "PUT") {
      stored.set(key, new TextDecoder().decode(seen.body ?? new Uint8Array()));
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected ${seen.method}`);
  }, { onWarning: (message) => warnings.push(message) });

  // Key absent: the fallback re-checks then writes unconditionally.
  await backend.write("new-key", encoder.encode("v"), { ifNoneMatch: true });
  assertEquals(stored.size, 1);

  // Key now present: the fallback reports the precondition failure.
  await assertRejects(
    () => backend.write("new-key", encoder.encode("v2"), { ifNoneMatch: true }),
    PreconditionFailedError,
  );
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "conditional writes");
});

Deno.test("list paginates with continuation tokens and decodes url encoding", async () => {
  const { backend, requests } = fakeBackend((seen) => {
    const token = seen.url.searchParams.get("continuation-token");
    assertEquals(seen.url.searchParams.get("delimiter"), "/");
    assertEquals(seen.url.searchParams.get("prefix"), "roots/main/obj/");
    if (token === null) {
      return xmlList({
        keys: ["roots/main/obj/file%20one.txt"],
        prefixes: ["roots/main/obj/v1/"],
        nextToken: "token-2",
      });
    }
    assertEquals(token, "token-2");
    return xmlList({
      keys: ["roots/main/obj/a%26b.json"],
      prefixes: ["roots/main/obj/v2/"],
    });
  });

  const entries = await backend.list("obj");
  entries?.sort((a, b) => a.name.localeCompare(b.name));
  assertEquals(entries, [
    { name: "a&b.json", kind: "file" },
    { name: "file one.txt", kind: "file" },
    { name: "v1", kind: "dir" },
    { name: "v2", kind: "dir" },
  ]);
  assertEquals(requests.length, 2);
});

Deno.test("list returns null when nothing is under the prefix", async () => {
  const { backend } = fakeBackend(() => xmlList({}));
  assertEquals(await backend.list("empty"), null);
});

Deno.test("prefixExists asks for at most one key", async () => {
  const { backend, requests } = fakeBackend(() =>
    xmlList({ keys: ["roots/main/obj/inventory.json"] })
  );
  assertEquals(await backend.prefixExists("obj"), true);
  assertEquals(requests[0].url.searchParams.get("max-keys"), "1");

  const empty = fakeBackend(() => xmlList({}));
  assertEquals(await empty.backend.prefixExists("obj"), false);
});

Deno.test("deletePrefix lists every page and batches the delete", async () => {
  const deleted: string[] = [];
  const { backend } = fakeBackend(async (seen) => {
    if (seen.method === "GET") {
      const token = seen.url.searchParams.get("continuation-token");
      assertEquals(seen.url.searchParams.get("delimiter"), null);
      if (token === null) {
        return xmlList({
          keys: ["roots/main/gone/a.txt"],
          nextToken: "page-2",
        });
      }
      return xmlList({ keys: ["roots/main/gone/v1/b%26c.txt"] });
    }
    assertEquals(seen.method, "POST");
    assertEquals(seen.url.search, "?delete");
    assertEquals(seen.headers.has("content-md5"), true);
    const body = new TextDecoder().decode(seen.body ?? new Uint8Array());
    for (const match of body.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
      deleted.push(match[1]);
    }
    return await Promise.resolve(new Response("<DeleteResult/>", { status: 200 }));
  });

  await backend.deletePrefix("gone");
  assertEquals(deleted, ["roots/main/gone/a.txt", "roots/main/gone/v1/b&amp;c.txt"]);
});

Deno.test("deletePrefix surfaces per-key errors from the batch response", async () => {
  const { backend } = fakeBackend((seen) => {
    if (seen.method === "GET") {
      return xmlList({ keys: ["roots/main/gone/a.txt"] });
    }
    return new Response(
      "<DeleteResult><Error><Key>roots/main/gone/a.txt</Key><Code>AccessDenied</Code></Error></DeleteResult>",
      { status: 200 },
    );
  });
  await assertRejects(
    () => backend.deletePrefix("gone"),
    OcflError,
    "1 error(s)",
  );
});

Deno.test("transient failures are retried; conditional writes are not", async () => {
  let attempts = 0;
  const { backend } = fakeBackend(() => {
    attempts += 1;
    if (attempts === 1) return new Response(null, { status: 503 });
    return new Response("ok", { status: 200 });
  });
  assertEquals(await readText(backend, "file.txt"), "ok");
  assertEquals(attempts, 2);

  let conditionalAttempts = 0;
  const conditional = fakeBackend(() => {
    conditionalAttempts += 1;
    return new Response(null, { status: 503 });
  });
  await assertRejects(() =>
    conditional.backend.write("k", encoder.encode("x"), { ifNoneMatch: true })
  );
  assertEquals(conditionalAttempts, 1);
});

Deno.test("writeFromFile refuses files over the single-request limit", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/big.bin`;
    await Deno.writeFile(path, new Uint8Array(8));
    // Truncate-extend to fake a huge sparse file without writing 100MB.
    const file = await Deno.open(path, { write: true });
    await file.truncate(MAX_UPLOAD_BYTES + 1);
    file.close();

    const { backend } = fakeBackend(() => new Response(null, { status: 200 }));
    await assertRejects(
      () => backend.writeFromFile("big.bin", path),
      OcflError,
      "multipart upload is not implemented",
    );
  });
});
