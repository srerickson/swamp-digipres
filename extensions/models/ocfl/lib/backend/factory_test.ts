import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { OcflError } from "../errors.ts";
import { createBackend, parseS3Url } from "./factory.ts";
import { LocalBackend } from "./local.ts";
import { S3Backend } from "./s3.ts";

Deno.test("parseS3Url splits bucket and prefix", () => {
  assertEquals(parseS3Url("/data/ocfl-root"), null);
  assertEquals(parseS3Url("s3://bucket"), { bucket: "bucket", prefix: "" });
  assertEquals(parseS3Url("s3://bucket/a/b/"), {
    bucket: "bucket",
    prefix: "a/b",
  });
  assertThrows(() => parseS3Url("s3://"), OcflError, "missing bucket");
});

Deno.test("a plain path selects the local backend", () => {
  const backend = createBackend({ storageRoot: "/data/ocfl-root" });
  assertEquals(backend instanceof LocalBackend, true);
  assertEquals(backend.url, "/data/ocfl-root");
});

Deno.test("an s3 url with explicit settings selects the S3 backend", () => {
  const backend = createBackend({
    storageRoot: "s3://bucket/prefix",
    region: "eu-central-1",
    accessKeyId: "AKIAFAKE",
    secretAccessKey: "secret",
  });
  assertEquals(backend instanceof S3Backend, true);
  assertEquals(backend.url, "s3://bucket/prefix");
});

Deno.test("missing region or credentials fail with actionable messages", () => {
  // Clear the AWS_* fallbacks for the duration of this test.
  const saved = new Map<string, string | undefined>();
  for (
    const name of [
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]
  ) {
    saved.set(name, Deno.env.get(name) ?? undefined);
    Deno.env.delete(name);
  }
  try {
    assertThrows(
      () => createBackend({ storageRoot: "s3://bucket" }),
      OcflError,
      "needs a region",
    );
    assertThrows(
      () => createBackend({ storageRoot: "s3://bucket", region: "us-east-1" }),
      OcflError,
      "needs credentials",
    );
  } finally {
    for (const [name, value] of saved) {
      if (value !== undefined) Deno.env.set(name, value);
    }
  }
});
