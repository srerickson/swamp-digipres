/**
 * S3-compatible {@link StorageBackend} over SigV4-signed `fetch`.
 *
 * Uses `aws4fetch` for request signing only — no AWS SDK. Works against AWS
 * S3 (virtual-hosted URLs) and S3-compatible stores like MinIO and R2
 * (custom `endpoint`, path-style URLs).
 *
 * Semantics: a flat key namespace with no directories. `list` groups keys by
 * delimiter the way `ListObjectsV2` does and reports `null` for prefixes with
 * no keys (empty prefixes cannot exist). Conditional writes use `If-None-Match`
 * / `If-Match`, which AWS S3 enforces natively; stores answering
 * `501 Not Implemented` degrade to non-atomic check-then-write, reported via
 * `onWarning` — the residual race matches the library's documented sole-writer
 * contract.
 *
 * Uploads are buffered in memory and capped at {@link MAX_UPLOAD_BYTES};
 * multipart upload is not implemented, and larger files fail loudly rather
 * than buffering gigabytes.
 *
 * Retries: transient failures (network errors, 429/500/502/503/504) are
 * retried with jittered backoff, except conditional writes — a lost response
 * to a conditional PUT leaves its outcome ambiguous, and retrying could
 * misreport a precondition failure against our own landed write.
 *
 * @module
 */
import { AwsClient } from "npm:aws4fetch@1.0.20";
import { createHash } from "node:crypto";
import { OcflError } from "../errors.ts";
import type {
  BackendEntry,
  StorageBackend,
  WriteConditions,
} from "./backend.ts";
import { PreconditionFailedError } from "./backend.ts";

/** Largest single-request upload accepted before multipart would be needed. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Delete-objects batch size limit imposed by the S3 API. */
const DELETE_BATCH_SIZE = 1000;

/** Retry schedule for transient failures, in milliseconds (jitter added). */
const RETRY_DELAYS_MS = [200, 800, 3200];

/** Configuration for {@link S3Backend}. */
export interface S3Options {
  bucket: string;
  /** Key prefix of the storage root within the bucket; `""` for the whole bucket. */
  prefix: string;
  region: string;
  /** Custom endpoint origin for S3-compatible stores, e.g. `http://localhost:9000`. */
  endpoint?: string;
  /** Use path-style URLs (`endpoint/bucket/key`). Implied by `endpoint`. */
  forcePathStyle?: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Injectable transport for tests; defaults to global `fetch`. */
  fetchFn?: (request: Request) => Promise<Response>;
  /** Receives operational warnings, e.g. conditional-write degradation. */
  onWarning?: (message: string) => void;
}

/** RFC 3986 encoding of one key segment (encodeURIComponent plus `!'()*`). */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode a full key, preserving `/` separators. */
function encodeKey(key: string): string {
  return key.split("/").map(encodeSegment).join("/");
}

/** Decode an XML-escaped, URL-encoded value from an `encoding-type=url` listing. */
function decodeListValue(value: string): string {
  const unescaped = value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#13;", "\r")
    .replaceAll("&#10;", "\n")
    .replaceAll("&amp;", "&");
  return decodeURIComponent(unescaped.replaceAll("+", "%20"));
}

/** Extract every occurrence of a simple XML tag's text content. */
function xmlValues(xml: string, tag: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  for (const match of xml.matchAll(pattern)) {
    values.push(match[1]);
  }
  return values;
}

/** Whether a response status is worth retrying. */
function isTransient(status: number): boolean {
  return status === 429 || status === 500 || status === 502 ||
    status === 503 || status === 504;
}

/** Storage backend for an S3 bucket prefix. */
export class S3Backend implements StorageBackend {
  readonly kind = "s3" as const;
  readonly url: string;

  readonly #options: S3Options;
  readonly #client: AwsClient;
  readonly #fetch: (request: Request) => Promise<Response>;
  #warnedDegraded = false;

  constructor(options: S3Options) {
    this.#options = options;
    this.url = options.prefix === ""
      ? `s3://${options.bucket}`
      : `s3://${options.bucket}/${options.prefix}`;
    this.#client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
      region: options.region,
      service: "s3",
    });
    this.#fetch = options.fetchFn ?? ((request) => fetch(request));
  }

  /** Base URL addressing the bucket (no trailing slash). */
  get #bucketUrl(): string {
    const { bucket, region, endpoint, forcePathStyle } = this.#options;
    if (endpoint !== undefined) {
      return `${endpoint.replace(/\/+$/, "")}/${bucket}`;
    }
    if (forcePathStyle) {
      return `https://s3.${region}.amazonaws.com/${bucket}`;
    }
    return `https://${bucket}.s3.${region}.amazonaws.com`;
  }

  /** Full URL for a storage-root-relative key. */
  #keyUrl(key: string): string {
    const { prefix } = this.#options;
    const full = prefix === "" ? key : (key === "" ? prefix : `${prefix}/${key}`);
    return `${this.#bucketUrl}/${encodeKey(full)}`;
  }

  /** Bucket-relative key (with prefix applied) for listing comparisons. */
  #fullKey(key: string): string {
    const { prefix } = this.#options;
    return prefix === "" ? key : (key === "" ? prefix : `${prefix}/${key}`);
  }

  /** Sign and send a request, retrying transient failures when allowed. */
  async #request(
    url: string,
    init: RequestInit & { headers?: Record<string, string> },
    options: { retry?: boolean } = {},
  ): Promise<Response> {
    const retry = options.retry ?? true;
    let lastError: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        const base = RETRY_DELAYS_MS[attempt - 1];
        await new Promise((resolve) =>
          setTimeout(resolve, base + Math.random() * base)
        );
      }
      let response: Response;
      try {
        const signed = await this.#client.sign(url, init);
        response = await this.#fetch(signed);
      } catch (cause) {
        lastError = cause;
        if (!retry) throw cause;
        continue;
      }
      if (retry && isTransient(response.status)) {
        lastError = new OcflError(
          `S3 request failed with status ${response.status}: ${init.method} ${url}`,
        );
        await response.body?.cancel().catch(() => {});
        continue;
      }
      return response;
    }
    throw lastError instanceof Error ? lastError : new OcflError(
      `S3 request failed after retries: ${init.method} ${url}`,
    );
  }

  /** Read a response body fully, throwing a descriptive error on failure. */
  async #errorFor(response: Response, what: string): Promise<OcflError> {
    const body = await response.text().catch(() => "");
    const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
    return new OcflError(
      `${what} failed with status ${response.status}${
        code === undefined ? "" : ` (${code})`
      }`,
    );
  }

  async read(key: string): Promise<Uint8Array | null> {
    const result = await this.readWithMeta(key);
    return result === null ? null : result.data;
  }

  async readWithMeta(
    key: string,
  ): Promise<{ data: Uint8Array; etag?: string } | null> {
    const response = await this.#request(this.#keyUrl(key), { method: "GET" });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      throw await this.#errorFor(response, `reading ${key}`);
    }
    const etag = response.headers.get("etag")?.replaceAll('"', "");
    return {
      data: new Uint8Array(await response.arrayBuffer()),
      etag: etag ?? undefined,
    };
  }

  async readStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.#request(this.#keyUrl(key), { method: "GET" });
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => {});
      throw new OcflError(
        `reading ${key} failed with status ${response.status}`,
        { path: key },
      );
    }
    return response.body;
  }

  async write(
    key: string,
    data: Uint8Array,
    conditions?: WriteConditions,
  ): Promise<void> {
    const headers: Record<string, string> = {};
    if (conditions?.ifNoneMatch) headers["if-none-match"] = "*";
    if (conditions?.ifMatch !== undefined) {
      headers["if-match"] = `"${conditions.ifMatch}"`;
    }

    const conditional = conditions?.ifNoneMatch === true ||
      conditions?.ifMatch !== undefined;
    const response = await this.#request(this.#keyUrl(key), {
      method: "PUT",
      headers,
      body: data.slice().buffer,
    }, { retry: !conditional });

    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    if (conditional && response.status === 412) {
      await response.body?.cancel().catch(() => {});
      throw new PreconditionFailedError(key, conditions ?? {});
    }
    if (conditional && response.status === 501) {
      // The store does not implement conditional writes; degrade to a
      // non-atomic check-then-write under the sole-writer contract.
      await response.body?.cancel().catch(() => {});
      if (!this.#warnedDegraded) {
        this.#warnedDegraded = true;
        this.#options.onWarning?.(
          `${this.url} does not support conditional writes; degrading to check-then-write`,
        );
      }
      if (conditions?.ifNoneMatch && await this.exists(key)) {
        throw new PreconditionFailedError(key, conditions);
      }
      if (conditions?.ifMatch !== undefined) {
        const current = await this.readWithMeta(key);
        if (current === null || current.etag !== conditions.ifMatch) {
          throw new PreconditionFailedError(key, conditions);
        }
      }
      await this.write(key, data);
      return;
    }
    throw await this.#errorFor(response, `writing ${key}`);
  }

  async writeFromFile(key: string, sourcePath: string): Promise<void> {
    const info = await Deno.stat(sourcePath);
    if (info.size > MAX_UPLOAD_BYTES) {
      throw new OcflError(
        `${sourcePath} is ${info.size} bytes, over the ${MAX_UPLOAD_BYTES}-byte single-request upload limit; ` +
          "multipart upload is not implemented",
        { path: sourcePath },
      );
    }
    await this.write(key, await Deno.readFile(sourcePath));
  }

  /** One page of a ListObjectsV2 result. */
  async #listPage(
    query: Record<string, string>,
  ): Promise<{ xml: string }> {
    const params = new URLSearchParams({ "list-type": "2", ...query });
    const response = await this.#request(
      `${this.#bucketUrl}?${params}`,
      { method: "GET" },
    );
    if (!response.ok) {
      throw await this.#errorFor(response, "listing objects");
    }
    return { xml: await response.text() };
  }

  async list(prefix: string): Promise<BackendEntry[] | null> {
    const full = this.#fullKey(prefix);
    const childPrefix = full === "" ? "" : `${full}/`;
    const names = new Map<string, "file" | "dir">();

    let continuationToken: string | undefined;
    do {
      const query: Record<string, string> = {
        prefix: childPrefix,
        delimiter: "/",
        "encoding-type": "url",
      };
      if (continuationToken !== undefined) {
        query["continuation-token"] = continuationToken;
      }
      const { xml } = await this.#listPage(query);

      for (const raw of xmlValues(xml, "Key")) {
        const key = decodeListValue(raw);
        const name = key.slice(childPrefix.length);
        if (name !== "") names.set(name, "file");
      }
      for (const block of xmlValues(xml, "CommonPrefixes")) {
        for (const raw of xmlValues(block, "Prefix")) {
          const name = decodeListValue(raw)
            .slice(childPrefix.length)
            .replace(/\/$/, "");
          if (name !== "") names.set(name, "dir");
        }
      }
      continuationToken = xmlValues(xml, "NextContinuationToken")
        .map(decodeListValue)[0];
    } while (continuationToken !== undefined);

    if (names.size === 0) return null;
    return [...names.entries()].map(([name, kind]) => ({ name, kind }));
  }

  async prefixExists(prefix: string): Promise<boolean> {
    const full = this.#fullKey(prefix);
    const { xml } = await this.#listPage({
      prefix: full === "" ? "" : `${full}/`,
      "max-keys": "1",
    });
    return xmlValues(xml, "Key").length > 0;
  }

  async exists(key: string): Promise<boolean> {
    const response = await this.#request(this.#keyUrl(key), {
      method: "HEAD",
    });
    await response.body?.cancel().catch(() => {});
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new OcflError(
        `checking ${key} failed with status ${response.status}`,
        { path: key },
      );
    }
    return true;
  }

  async delete(key: string): Promise<void> {
    const response = await this.#request(this.#keyUrl(key), {
      method: "DELETE",
    });
    await response.body?.cancel().catch(() => {});
    if (!response.ok && response.status !== 404) {
      throw new OcflError(
        `deleting ${key} failed with status ${response.status}`,
        { path: key },
      );
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    const full = this.#fullKey(prefix);
    const childPrefix = full === "" ? "" : `${full}/`;

    // Collect every key under the prefix (no delimiter), across pages.
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const query: Record<string, string> = {
        prefix: childPrefix,
        "encoding-type": "url",
      };
      if (continuationToken !== undefined) {
        query["continuation-token"] = continuationToken;
      }
      const { xml } = await this.#listPage(query);
      keys.push(...xmlValues(xml, "Key").map(decodeListValue));
      continuationToken = xmlValues(xml, "NextContinuationToken")
        .map(decodeListValue)[0];
    } while (continuationToken !== undefined);

    for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
      const batch = keys.slice(start, start + DELETE_BATCH_SIZE);
      const body = new TextEncoder().encode(
        `<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>${
          batch.map((key) =>
            `<Object><Key>${
              key
                .replaceAll("&", "&amp;")
                .replaceAll("<", "&lt;")
                .replaceAll(">", "&gt;")
            }</Key></Object>`
          ).join("")
        }</Delete>`,
      );
      const md5 = createHash("md5").update(body).digest("base64");
      const response = await this.#request(`${this.#bucketUrl}?delete`, {
        method: "POST",
        headers: { "content-md5": md5 },
        body: body.slice().buffer,
      });
      const text = await response.text().catch(() => "");
      if (!response.ok) {
        throw new OcflError(
          `batch delete under ${prefix} failed with status ${response.status}`,
          { path: prefix },
        );
      }
      const errors = xmlValues(text, "Error");
      if (errors.length > 0) {
        throw new OcflError(
          `batch delete under ${prefix} reported ${errors.length} error(s): ${
            errors[0].slice(0, 200)
          }`,
          { path: prefix },
        );
      }
    }
  }
}
