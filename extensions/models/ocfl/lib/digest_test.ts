/**
 * Tests for the digest helpers.
 *
 * The streaming variants exist so a multi-gigabyte bitstream never lands in
 * memory whole, so the assertions that matter are that they agree with the
 * whole-buffer digest across arbitrary chunk boundaries.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  digestBytes,
  digestingStream,
  digestsEqual,
  digestStream,
  digestText,
  isSupportedAlgorithm,
} from "./digest.ts";

/** A stream over `size` pseudo-random bytes, delivered in `chunkSize` pieces. */
function stream(
  bytes: Uint8Array,
  chunkSize: number,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

/** Deterministic bytes, so a failure is reproducible. */
function sample(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = (index * 31 + 7) % 256;
  }
  return bytes;
}

Deno.test("isSupportedAlgorithm covers the OCFL tables", () => {
  for (const algorithm of ["md5", "sha1", "sha256", "sha512", "blake2b-512"]) {
    assert(isSupportedAlgorithm(algorithm), algorithm);
  }
  assertEquals(isSupportedAlgorithm("crc32"), false);
});

Deno.test("digestBytes matches a known sha512 vector", () => {
  // The empty string's sha512, which pins the encoding as lowercase hex.
  assertEquals(
    digestText("", "sha512"),
    "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce" +
      "47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e",
  );
});

Deno.test("digestStream agrees with digestBytes across chunk sizes", async () => {
  const bytes = sample(100_000);
  const expected = digestBytes(bytes, "sha512");
  // Chunk sizes chosen to be coprime with the length, so boundaries land
  // awkwardly rather than on convenient multiples.
  for (const chunkSize of [1, 7, 999, 65_536, 200_000]) {
    const result = await digestStream(stream(bytes, chunkSize), "sha512");
    assertEquals(result.digest, expected, `chunkSize=${chunkSize}`);
    assertEquals(result.size, bytes.byteLength);
  }
});

Deno.test("digestStream handles an empty stream", async () => {
  const result = await digestStream(stream(new Uint8Array(0), 16), "sha256");
  assertEquals(result.size, 0);
  assertEquals(result.digest, digestBytes(new Uint8Array(0), "sha256"));
});

Deno.test("digestStream rejects an unsupported algorithm", async () => {
  let threw = false;
  try {
    await digestStream(stream(sample(4), 4), "crc32");
  } catch (error) {
    threw = true;
    assert((error as Error).message.includes("unsupported"));
  }
  assertEquals(threw, true);
});

Deno.test("digestingStream digests the bytes it passes through", async () => {
  const bytes = sample(50_000);
  const digesting = digestingStream("sha512");

  const passed: number[] = [];
  await stream(bytes, 4096).pipeThrough(digesting.stream).pipeTo(
    new WritableStream({
      write(chunk) {
        passed.push(...chunk);
      },
    }),
  );

  // The bytes must arrive unchanged — this sits in the middle of every content
  // copy, so a mutation here would corrupt every ingest.
  assertEquals(new Uint8Array(passed), bytes);
  assertEquals(digesting.digest(), digestBytes(bytes, "sha512"));
  assertEquals(digesting.size(), bytes.byteLength);
});

Deno.test("digestingStream refuses to report a digest before it closes", () => {
  const digesting = digestingStream("sha256");
  assertThrows(
    () => digesting.digest(),
    Error,
    "before the stream finished",
  );
});

Deno.test("digestsEqual ignores case", () => {
  assert(digestsEqual("ABC123", "abc123"));
  assert(!digestsEqual("abc123", "abc124"));
});
