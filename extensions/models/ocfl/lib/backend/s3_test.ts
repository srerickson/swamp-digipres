import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { OcflError } from "../errors.ts";
import { PreconditionFailedError, readText } from "./backend.ts";
import { S3Backend } from "./s3.ts";
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
    return await Promise.resolve(
      new Response("<DeleteResult/>", { status: 200 }),
    );
  });

  await backend.deletePrefix("gone");
  assertEquals(deleted, [
    "roots/main/gone/a.txt",
    "roots/main/gone/v1/b&amp;c.txt",
  ]);
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

/** What a scripted multipart S3 recorded across one upload. */
interface Multipart {
  /** Upload ids handed out by `CreateMultipartUpload`. */
  created: string[];
  /** Part bodies by part number, in the order they were received. */
  parts: Map<number, Uint8Array>;
  /** Part numbers listed in the `CompleteMultipartUpload` body, in order. */
  completed: number[];
  /** Upload ids passed to `AbortMultipartUpload`. */
  aborted: string[];
}

/**
 * A fake S3 that speaks the multipart protocol.
 *
 * `perPart` may override the response for a given part number — returning
 * `null` keeps the default success. Part sizes are deliberately tiny so tests
 * never need multi-megabyte fixtures.
 */
function multipartBackend(options: {
  partSizeBytes: number;
  uploadConcurrency?: number;
  perPart?: (partNumber: number, attempt: number) => Response | null;
  onComplete?: () => Response | null;
} = { partSizeBytes: 100 }): { backend: S3Backend; recorded: Multipart } {
  const recorded: Multipart = {
    created: [],
    parts: new Map(),
    completed: [],
    aborted: [],
  };
  const attempts = new Map<number, number>();

  const { backend } = fakeBackend((seen) => {
    const uploadId = seen.url.searchParams.get("uploadId");
    if (seen.method === "POST" && seen.url.search === "?uploads") {
      const id = `upload-${recorded.created.length + 1}`;
      recorded.created.push(id);
      return new Response(
        `<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        { status: 200 },
      );
    }
    if (seen.method === "PUT" && uploadId !== null) {
      const partNumber = Number(seen.url.searchParams.get("partNumber"));
      const attempt = (attempts.get(partNumber) ?? 0) + 1;
      attempts.set(partNumber, attempt);
      const override = options.perPart?.(partNumber, attempt);
      if (override !== null && override !== undefined) return override;
      recorded.parts.set(partNumber, seen.body ?? new Uint8Array());
      return new Response(null, {
        status: 200,
        headers: { etag: `"etag-${partNumber}"` },
      });
    }
    if (seen.method === "POST" && uploadId !== null) {
      const body = new TextDecoder().decode(seen.body ?? new Uint8Array());
      for (const match of body.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)) {
        recorded.completed.push(Number(match[1]));
      }
      const override = options.onComplete?.();
      if (override !== null && override !== undefined) return override;
      return new Response(
        `<?xml version="1.0"?><CompleteMultipartUploadResult><ETag>"final-1"</ETag></CompleteMultipartUploadResult>`,
        { status: 200 },
      );
    }
    if (seen.method === "DELETE" && uploadId !== null) {
      recorded.aborted.push(uploadId);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${seen.method} ${seen.url.href}`);
  }, {
    partSizeBytes: options.partSizeBytes,
    multipartThresholdBytes: options.partSizeBytes,
    uploadConcurrency: options.uploadConcurrency,
  });

  return { backend, recorded };
}

/** Write `size` bytes of recognizable content to a temp file. */
async function sourceFile(dir: string, size: number): Promise<string> {
  const path = `${dir}/source.bin`;
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index++) bytes[index] = index % 251;
  await Deno.writeFile(path, bytes);
  return path;
}

Deno.test("writeFromFile uploads a large source in ordered parts", async () => {
  await withTempDir(async (dir) => {
    const path = await sourceFile(dir, 250);
    const { backend, recorded } = multipartBackend({ partSizeBytes: 100 });
    await backend.writeFromFile("obj/v1/content/big.bin", path);

    assertEquals(recorded.created, ["upload-1"]);
    assertEquals([...recorded.parts.keys()].sort(), [1, 2, 3]);
    // Every part but the last is full; the last carries the remainder.
    assertEquals(recorded.parts.get(1)?.length, 100);
    assertEquals(recorded.parts.get(2)?.length, 100);
    assertEquals(recorded.parts.get(3)?.length, 50);

    // The parts reassemble into the source, byte for byte and in order.
    const source = await Deno.readFile(path);
    const assembled = new Uint8Array(250);
    assembled.set(recorded.parts.get(1)!, 0);
    assembled.set(recorded.parts.get(2)!, 100);
    assembled.set(recorded.parts.get(3)!, 200);
    assertEquals(assembled, source);

    assertEquals(recorded.completed, [1, 2, 3]);
    assertEquals(recorded.aborted, []);
  });
});

Deno.test("writeFromFile sends sources at or under the threshold in one PUT", async () => {
  await withTempDir(async (dir) => {
    const path = await sourceFile(dir, 100);
    const { backend, requests } = fakeBackend(
      () => new Response(null, { status: 200 }),
      { partSizeBytes: 100, multipartThresholdBytes: 100 },
    );
    await backend.writeFromFile("small.bin", path);

    assertEquals(requests.length, 1);
    assertEquals(requests[0].method, "PUT");
    assertEquals(requests[0].url.search, "");
    assertEquals(requests[0].body?.length, 100);
  });
});

Deno.test("a 200 response carrying an error body fails the upload", async () => {
  await withTempDir(async (dir) => {
    const path = await sourceFile(dir, 250);
    // S3 reports some CompleteMultipartUpload failures under a 200 status.
    const { backend, recorded } = multipartBackend({
      partSizeBytes: 100,
      onComplete: () =>
        new Response(
          `<?xml version="1.0"?><Error><Code>InternalError</Code></Error>`,
          { status: 200 },
        ),
    });

    await assertRejects(
      () => backend.writeFromFile("big.bin", path),
      OcflError,
      "InternalError",
    );
    assertEquals(recorded.aborted, ["upload-1"]);
  });
});

Deno.test("a failed part aborts the upload and stops the remaining parts", async () => {
  await withTempDir(async (dir) => {
    const path = await sourceFile(dir, 500);
    const { backend, recorded } = multipartBackend({
      partSizeBytes: 100,
      // One worker, so parts 3-5 are only reachable after part 2 fails.
      uploadConcurrency: 1,
      perPart: (partNumber) =>
        partNumber === 2 ? new Response("denied", { status: 403 }) : null,
    });

    await assertRejects(
      () => backend.writeFromFile("big.bin", path),
      OcflError,
      "uploading part 2",
    );
    // The failure stops the upload rather than pushing the rest of the file.
    assertEquals([...recorded.parts.keys()], [1]);
    assertEquals(recorded.aborted, ["upload-1"]);
    assertEquals(recorded.completed, []);
  });
});

Deno.test("part uploads retry transient failures", async () => {
  await withTempDir(async (dir) => {
    const path = await sourceFile(dir, 250);
    const { backend, recorded } = multipartBackend({
      partSizeBytes: 100,
      perPart: (partNumber, attempt) =>
        partNumber === 2 && attempt === 1
          ? new Response(null, { status: 503 })
          : null,
    });

    await backend.writeFromFile("big.bin", path);
    assertEquals(recorded.completed, [1, 2, 3]);
    assertEquals(recorded.parts.get(2)?.length, 100);
    assertEquals(recorded.aborted, []);
  });
});

Deno.test("part size scales up to stay within the 10,000-part limit", async () => {
  await withTempDir(async (dir) => {
    const path = `${dir}/huge.bin`;
    await Deno.writeFile(path, new Uint8Array(8));
    // Truncate-extend to fake a large sparse file without writing its bytes.
    const file = await Deno.open(path, { write: true });
    await file.truncate(2_000_000);
    file.close();

    // 2,000,000 bytes at the configured 100-byte parts would need 20,000
    // parts, so the backend must pick a larger part size on its own.
    const { backend, recorded } = multipartBackend({ partSizeBytes: 100 });
    await backend.writeFromFile("huge.bin", path);

    assertEquals(recorded.parts.size, 2);
    assertEquals(recorded.parts.get(1)?.length, 1024 * 1024);
    assertEquals(recorded.parts.get(2)?.length, 2_000_000 - 1024 * 1024);
    assertEquals(recorded.completed, [1, 2]);
  });
});

Deno.test("multipart requests carry the root prefix and encode the key", async () => {
  await withTempDir(async (dir) => {
    const path = await sourceFile(dir, 150);
    const { backend, requests } = fakeBackend((seen) => {
      if (seen.url.search === "?uploads") {
        return new Response(
          `<?xml version="1.0"?><InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>`,
          { status: 200 },
        );
      }
      if (seen.method === "PUT") {
        return new Response(null, { status: 200, headers: { etag: '"e"' } });
      }
      return new Response("<CompleteMultipartUploadResult/>", { status: 200 });
    }, { partSizeBytes: 100, multipartThresholdBytes: 100 });

    await backend.writeFromFile("dir with spaces/naïve.bin", path);

    const expected = "/roots/main/dir%20with%20spaces/na%C3%AFve.bin";
    for (const request of requests) {
      assertEquals(request.url.pathname, expected);
    }
    assertEquals(requests[0].url.search, "?uploads");

    // Parts go out concurrently, so assert on the set rather than the order.
    const parts = requests.filter((request) => request.method === "PUT");
    assertEquals(
      parts.map((request) => request.url.searchParams.get("partNumber")).sort(),
      ["1", "2"],
    );
    for (const part of parts) {
      assertEquals(part.url.searchParams.get("uploadId"), "u1");
    }

    const complete = requests[requests.length - 1];
    assertEquals(complete.method, "POST");
    assertEquals(complete.url.searchParams.get("uploadId"), "u1");
  });
});

Deno.test("invalid upload tuning is rejected at construction", () => {
  const base = {
    bucket: "b",
    prefix: "",
    region: "us-east-1",
    accessKeyId: "k",
    secretAccessKey: "s",
  };
  assertThrows(
    () => new S3Backend({ ...base, partSizeBytes: 0 }),
    OcflError,
    "partSizeBytes",
  );
  assertThrows(
    () => new S3Backend({ ...base, uploadConcurrency: 0 }),
    OcflError,
    "uploadConcurrency",
  );

  // A part size under S3's minimum is legal locally but warns: only the final
  // part of a real upload may be smaller.
  const warnings: string[] = [];
  new S3Backend({
    ...base,
    partSizeBytes: 100,
    onWarning: (message) => warnings.push(message),
  });
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "minimum");
});
