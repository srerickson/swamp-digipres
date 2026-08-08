import { assertEquals } from "jsr:@std/assert@1";
import { decodeXmlEntities, parseListObjectsV2 } from "./xml.ts";

Deno.test("parseListObjectsV2 separates keys from common prefixes", () => {
  // The top-level <Prefix> echoes the request and must not be mistaken for a
  // result — that is the whole reason CommonPrefixes is read as a block.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Name>swamp-test</Name>
  <Prefix>ocfl-test/</Prefix>
  <Delimiter>/</Delimiter>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>ocfl-test/0=ocfl_1.1</Key><Size>9</Size></Contents>
  <Contents><Key>ocfl-test/ocfl_layout.json</Key><Size>80</Size></Contents>
  <CommonPrefixes><Prefix>ocfl-test/5b8/</Prefix></CommonPrefixes>
  <CommonPrefixes><Prefix>ocfl-test/extensions/</Prefix></CommonPrefixes>
</ListBucketResult>`;

  const result = parseListObjectsV2(xml);
  assertEquals(result.keys, [
    "ocfl-test/0=ocfl_1.1",
    "ocfl-test/ocfl_layout.json",
  ]);
  assertEquals(result.commonPrefixes, [
    "ocfl-test/5b8/",
    "ocfl-test/extensions/",
  ]);
  assertEquals(result.nextContinuationToken, undefined);
});

Deno.test("parseListObjectsV2 reads the continuation token when truncated", () => {
  const xml = `<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=</NextContinuationToken>
  <Contents><Key>a</Key></Contents>
</ListBucketResult>`;
  assertEquals(
    parseListObjectsV2(xml).nextContinuationToken,
    "1ueGcxLPRx1Tr/XYExHnhbYLgveDs2J/wm36Hy4vbOwM=",
  );
});

Deno.test("parseListObjectsV2 ignores a token on a complete response", () => {
  const xml = `<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <NextContinuationToken></NextContinuationToken>
</ListBucketResult>`;
  assertEquals(parseListObjectsV2(xml).nextContinuationToken, undefined);
});

Deno.test("parseListObjectsV2 decodes escaped keys exactly once", () => {
  // The literal key is `a&amp;b <c>`; S3 escapes it as shown. Decoding the
  // enclosing <Contents> block before extracting <Key> would decode twice and
  // yield `a&b <c>`.
  const xml = `<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  <Contents><Key>a&amp;amp;b &lt;c&gt;</Key></Contents>
</ListBucketResult>`;
  assertEquals(parseListObjectsV2(xml).keys, ["a&amp;b <c>"]);
});

Deno.test("decodeXmlEntities handles named and numeric references", () => {
  assertEquals(decodeXmlEntities("&lt;&gt;&amp;&quot;&apos;"), `<>&"'`);
  assertEquals(decodeXmlEntities("&#65;&#x42;"), "AB");
  assertEquals(decodeXmlEntities("&notanentity;"), "&notanentity;");
});

Deno.test("parseListObjectsV2 returns empty results for an empty bucket", () => {
  const xml = `<ListBucketResult>
  <Name>swamp-test</Name>
  <IsTruncated>false</IsTruncated>
</ListBucketResult>`;
  const result = parseListObjectsV2(xml);
  assertEquals(result.keys, []);
  assertEquals(result.commonPrefixes, []);
});
