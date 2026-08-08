/**
 * Minimal reader for the `ListObjectsV2` fields this extension uses.
 *
 * Deno has no built-in XML parser and swamp's bundler inlines npm packages, so
 * a general-purpose parser would be paid for on every model load to read four
 * fields out of one tightly-specified response shape. This reads exactly those
 * fields and nothing else.
 *
 * @module
 */

/** The subset of a `ListObjectsV2` response this extension reads. */
export type ListObjectsResult = {
  /** Object keys returned in `Contents`, in response order. */
  keys: string[];
  /** Prefixes returned in `CommonPrefixes`, in response order. */
  commonPrefixes: string[];
  /** Continuation token for the next page, or `undefined` when complete. */
  nextContinuationToken: string | undefined;
};

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decode the XML entities S3 uses when escaping keys. */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/**
 * Raw inner markup of every `<tag>` element in `xml`.
 *
 * Deliberately undecoded: these blocks still contain child elements, and
 * decoding here would decode leaf values twice once {@linkcode first} runs.
 */
function collectRaw(xml: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(pattern)].map((match) => match[1]);
}

/** Decoded text of the first `<tag>` element, or `undefined` if absent. */
function first(xml: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
  const match = xml.match(pattern);
  return match === null ? undefined : decodeXmlEntities(match[1].trim());
}

/**
 * Parse a `ListObjectsV2` response body.
 *
 * `<Key>` is read only from inside `<Contents>` and `<Prefix>` only from inside
 * `<CommonPrefixes>` — the response also carries a top-level `<Prefix>` echoing
 * the request, which would otherwise be mistaken for a result.
 */
export function parseListObjectsV2(xml: string): ListObjectsResult {
  const contents = collectRaw(xml, "Contents");
  const commonPrefixBlocks = collectRaw(xml, "CommonPrefixes");

  const keys = contents.flatMap((block) => {
    const key = first(block, "Key");
    return key === undefined ? [] : [key];
  });
  const commonPrefixes = commonPrefixBlocks.flatMap((block) => {
    const prefix = first(block, "Prefix");
    return prefix === undefined ? [] : [prefix];
  });

  // The token is only meaningful when the response is truncated; some
  // implementations emit an empty element rather than omitting it.
  const truncated = first(xml, "IsTruncated") === "true";
  const token = first(xml, "NextContinuationToken");
  const nextContinuationToken = truncated && token !== undefined &&
      token.length > 0
    ? token
    : undefined;

  return { keys, commonPrefixes, nextContinuationToken };
}
