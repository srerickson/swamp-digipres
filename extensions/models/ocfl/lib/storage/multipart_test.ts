/**
 * Tests for the S3 write path, driven through a stubbed `fetch`.
 *
 * `aws4fetch` signs and then calls the global `fetch`, so replacing it captures
 * exactly the request sequence a real bucket would receive. That is the only
 * thing worth asserting here: whether the multipart protocol is spoken
 * correctly, and whether a failure cleans up after itself.
 */
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { S3Storage } from "./s3.ts";
import { completeMultipartUploadBody, firstTag } from "./xml.ts";

const OPTIONS = {
  bucket: "test-bucket",
  endpoint: "https://example.r2.cloudflarestorage.com",
  region: "auto",
  accessKeyId: "key",
  secretAccessKey: "secret",
};

/** One captured request. */
type Call = {
  method: string;
  url: URL;
  bodySize: number;
  bodyText: string;
};

/** Install a fetch stub, returning the captured calls and a restore function. */
function stubFetch(
  respond: (call: Call, index: number) => Response,
): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;

  globalThis.fetch =
    (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request
        ? input
        : new Request(input, init);
      const buffer = await request.arrayBuffer();
      const call: Call = {
        method: request.method,
        url: new URL(request.url),
        bodySize: buffer.byteLength,
        bodyText: new TextDecoder().decode(buffer),
      };
      calls.push(call);
      return respond(call, calls.length - 1);
    }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** A stream over `size` bytes, delivered in awkward chunk sizes. */
function sourceStream(
  size: number,
  chunkSize = 7_000,
): ReadableStream<Uint8Array> {
  let produced = 0;
  return new ReadableStream({
    pull(controller) {
      if (produced >= size) {
        controller.close();
        return;
      }
      const take = Math.min(chunkSize, size - produced);
      // Chunk boundaries deliberately do not line up with part boundaries —
      // that is the case where a naive implementation emits uneven parts.
      controller.enqueue(new Uint8Array(take).fill(produced % 251));
      produced += take;
    },
  });
}

const xml = (body: string) =>
  new Response(body, {
    status: 200,
    headers: { "content-type": "application/xml" },
  });

Deno.test("writeStream uses a single PUT below the part size", async () => {
  const { calls, restore } = stubFetch(() =>
    new Response(null, { status: 200 })
  );
  try {
    const storage = new S3Storage({ ...OPTIONS, partSize: 5 * 1024 * 1024 });
    await storage.writeStream("v1/content/small.txt", sourceStream(1024), {
      size: 1024,
    });
  } finally {
    restore();
  }

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "PUT");
  assertEquals(calls[0].bodySize, 1024);
  assertEquals(calls[0].url.search, "");
});

Deno.test("writeStream PUTs an empty object for an empty source", async () => {
  const { calls, restore } = stubFetch(() =>
    new Response(null, { status: 200 })
  );
  try {
    await new S3Storage(OPTIONS).writeStream(
      "v1/content/empty",
      sourceStream(0),
      {
        size: 0,
      },
    );
  } finally {
    restore();
  }

  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "PUT");
  assertEquals(calls[0].bodySize, 0);
});

Deno.test("writeStream runs a multipart upload for a large source", async () => {
  const partSize = 5 * 1024 * 1024;
  const size = partSize * 2 + 1234; // two full parts and a short one
  const { calls, restore } = stubFetch((call) => {
    if (call.method === "POST" && call.url.searchParams.has("uploads")) {
      return xml(
        "<InitiateMultipartUploadResult><UploadId>upload-1</UploadId>" +
          "</InitiateMultipartUploadResult>",
      );
    }
    if (call.method === "PUT") {
      const part = call.url.searchParams.get("partNumber");
      return new Response(null, {
        status: 200,
        headers: { etag: `"etag-${part}"` },
      });
    }
    return xml(
      '<CompleteMultipartUploadResult><ETag>"final"</ETag>' +
        "</CompleteMultipartUploadResult>",
    );
  });

  try {
    const storage = new S3Storage({ ...OPTIONS, partSize, concurrency: 2 });
    await storage.writeStream("v1/content/big.bin", sourceStream(size), {
      size,
    });
  } finally {
    restore();
  }

  const create = calls.filter((call) =>
    call.method === "POST" && call.url.searchParams.has("uploads")
  );
  const parts = calls.filter((call) => call.method === "PUT");
  const complete = calls.filter((call) =>
    call.method === "POST" && call.url.searchParams.has("uploadId")
  );

  assertEquals(create.length, 1);
  assertEquals(parts.length, 3);
  assertEquals(complete.length, 1);

  // Every part but the last is exactly partSize. R2 rejects an upload whose
  // non-final parts differ in size, so this is a correctness requirement.
  assertEquals(parts.map((call) => call.bodySize), [partSize, partSize, 1234]);
  assertEquals(
    parts.map((call) => call.url.searchParams.get("partNumber")),
    ["1", "2", "3"],
  );
  for (const part of parts) {
    assertEquals(part.url.searchParams.get("uploadId"), "upload-1");
  }

  // Complete must list every part, in ascending order, with its ETag.
  const body = complete[0].bodyText;
  assertEquals(
    [...body.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => m[1]),
    ["1", "2", "3"],
  );
  assert(body.includes('<ETag>"etag-1"</ETag>'));
});

Deno.test("writeStream aborts the upload when a part fails", async () => {
  const partSize = 5 * 1024 * 1024;
  const { calls, restore } = stubFetch((call) => {
    if (call.method === "POST" && call.url.searchParams.has("uploads")) {
      return xml(
        "<InitiateMultipartUploadResult><UploadId>upload-2</UploadId>" +
          "</InitiateMultipartUploadResult>",
      );
    }
    if (call.method === "PUT") {
      if (call.url.searchParams.get("partNumber") === "2") {
        return new Response("<Error><Code>InternalError</Code></Error>", {
          status: 500,
        });
      }
      return new Response(null, { status: 200, headers: { etag: '"etag"' } });
    }
    return new Response(null, { status: 204 });
  });

  try {
    // retries: 0 so the injected 500 fails immediately; aws4fetch would
    // otherwise back off through ten attempts.
    const storage = new S3Storage({
      ...OPTIONS,
      partSize,
      concurrency: 1,
      retries: 0,
    });
    await assertRejects(
      () =>
        storage.writeStream("v1/content/big.bin", sourceStream(partSize * 3), {
          size: partSize * 3,
        }),
      Error,
      "S3 PUT part 2 failed",
    );
  } finally {
    restore();
  }

  // An orphaned multipart upload accrues storage charges invisibly, so the
  // abort is not optional.
  const abort = calls.filter((call) => call.method === "DELETE");
  assertEquals(abort.length, 1);
  assertEquals(abort[0].url.searchParams.get("uploadId"), "upload-2");
});

Deno.test("writeStream scales the part size to stay under the part limit", async () => {
  // 10,001 parts at the configured size; the part size must grow instead.
  const partSize = 1024;
  const size = partSize * 10_001;
  let uploadedParts = 0;
  const { restore } = stubFetch((call) => {
    if (call.method === "POST" && call.url.searchParams.has("uploads")) {
      return xml(
        "<InitiateMultipartUploadResult><UploadId>u</UploadId>" +
          "</InitiateMultipartUploadResult>",
      );
    }
    if (call.method === "PUT") {
      uploadedParts += 1;
      return new Response(null, { status: 200, headers: { etag: '"e"' } });
    }
    return xml("<CompleteMultipartUploadResult/>");
  });

  try {
    const storage = new S3Storage({ ...OPTIONS, partSize, concurrency: 4 });
    await storage.writeStream(
      "v1/content/many.bin",
      sourceStream(size, 65_536),
      {
        size,
      },
    );
  } finally {
    restore();
  }

  assert(
    uploadedParts <= 10_000,
    `expected at most 10,000 parts, uploaded ${uploadedParts}`,
  );
});

Deno.test("writeStream reports a CompleteMultipartUpload error inside a 200", async () => {
  const partSize = 5 * 1024 * 1024;
  const { restore } = stubFetch((call) => {
    if (call.method === "POST" && call.url.searchParams.has("uploads")) {
      return xml(
        "<InitiateMultipartUploadResult><UploadId>u</UploadId>" +
          "</InitiateMultipartUploadResult>",
      );
    }
    if (call.method === "PUT") {
      return new Response(null, { status: 200, headers: { etag: '"e"' } });
    }
    // S3 holds the connection open while assembling parts, so a failure can
    // arrive with a 200 status.
    return xml("<Error><Code>InternalError</Code></Error>");
  });

  try {
    const storage = new S3Storage({ ...OPTIONS, partSize });
    await assertRejects(
      () =>
        storage.writeStream("v1/content/big.bin", sourceStream(partSize * 2), {
          size: partSize * 2,
        }),
      Error,
      "CompleteMultipartUpload failed",
    );
  } finally {
    restore();
  }
});

Deno.test("remove tolerates an absent key", async () => {
  const { calls, restore } = stubFetch(() =>
    new Response(null, { status: 404 })
  );
  try {
    await new S3Storage(OPTIONS).remove("v1/content/gone.txt");
  } finally {
    restore();
  }
  assertEquals(calls[0].method, "DELETE");
});

Deno.test("completeMultipartUploadBody sorts parts and escapes text", () => {
  const body = completeMultipartUploadBody([
    { partNumber: 2, etag: '"b"' },
    { partNumber: 1, etag: '"a&b"' },
  ]);
  assertEquals(
    [...body.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => m[1]),
    ["1", "2"],
  );
  assert(body.includes("&amp;"));
});

Deno.test("firstTag reads a single element", () => {
  assertEquals(firstTag("<a><UploadId>xyz</UploadId></a>", "UploadId"), "xyz");
  assertEquals(firstTag("<a/>", "UploadId"), undefined);
});
