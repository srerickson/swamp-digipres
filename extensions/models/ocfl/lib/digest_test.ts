import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  digestBytes,
  digestFile,
  digestsEqual,
  isDigestAlgorithmSupported,
  normalizeDigest,
} from "./digest.ts";
import {
  FIXTURE_IDS,
  FIXTURE_PATHS,
  FIXTURE_ROOT,
  withTempDir,
} from "./test_util.ts";

const EMPTY_SHA512 =
  "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce" +
  "47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e";

Deno.test("digestBytes matches known vectors", () => {
  assertEquals(digestBytes(new Uint8Array(0), "sha512"), EMPTY_SHA512);
  assertEquals(
    digestBytes(new TextEncoder().encode("abc"), "sha256"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assertEquals(
    digestBytes(new TextEncoder().encode(FIXTURE_IDS.spec), "sha256"),
    FIXTURE_PATHS[FIXTURE_IDS.spec].split("/").pop(),
  );
});

Deno.test("digestFile streams a file and matches the fixture manifest", async () => {
  const object = `${FIXTURE_ROOT}/${FIXTURE_PATHS[FIXTURE_IDS.spec]}`;
  const inventory = JSON.parse(
    await Deno.readTextFile(`${object}/inventory.json`),
  ) as { manifest: Record<string, string[]> };

  for (const [digest, contentPaths] of Object.entries(inventory.manifest)) {
    for (const contentPath of contentPaths) {
      assertEquals(
        await digestFile(`${object}/${contentPath}`, "sha512"),
        digest,
        contentPath,
      );
    }
  }
});

Deno.test("digestFile handles content larger than one read chunk", async () => {
  await withTempDir(async (dir) => {
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const path = `${dir}/large.bin`;
    await Deno.writeFile(path, bytes);
    assertEquals(
      await digestFile(path, "sha512"),
      digestBytes(bytes, "sha512"),
    );
  });
});

Deno.test("digest comparison is case-insensitive (E096/E097)", () => {
  assertEquals(digestsEqual("ABCdef", "abcDEF"), true);
  assertEquals(digestsEqual("abc", "abd"), false);
  assertEquals(normalizeDigest("ABCdef"), "abcdef");
});

Deno.test("every OCFL fixity algorithm is supported by the runtime", () => {
  for (
    const algorithm of [
      "md5",
      "sha1",
      "sha256",
      "sha512",
      "blake2b-512",
      "sha512/256",
    ]
  ) {
    assertEquals(isDigestAlgorithmSupported(algorithm), true, algorithm);
  }
  assertEquals(isDigestAlgorithmSupported("not-an-algorithm"), false);
});

Deno.test("digesting with an unknown algorithm throws", () => {
  assertThrows(() => digestBytes(new Uint8Array(0), "not-an-algorithm"));
});
