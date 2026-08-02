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
 * Uploads: `writeFromFile` sends sources at or under
 * {@link DEFAULT_MULTIPART_THRESHOLD_BYTES} in one PUT and larger ones through
 * multipart upload, so memory stays bounded at part size × concurrency
 * (~32 MiB by default) no matter how large the file is. Part size scales up
 * automatically to keep any object within S3's 10,000-part limit. A crash
 * between `CreateMultipartUpload` and `CompleteMultipartUpload` leaves parts
 * that no listing shows and that `deletePrefix` cannot reach; the backend
 * aborts the upload on every failure it observes, but buckets should also
 * carry an `AbortIncompleteMultipartUpload` lifecycle rule to reap the rest.
 *
 * `write` stays a single PUT on purpose: it is the only conditional-write path,
 * and a multipart object's entity tag is `md5(concat(part md5s))-N` rather than
 * the object's MD5, which would break the `If-Match` handshake the commit
 * finalizer performs against the root inventory.
 *
 * Retries: transient failures (network errors, 429/500/502/503/504) are
 * retried with jittered backoff, except conditional writes — a lost response
 * to a conditional PUT leaves its outcome ambiguous, and retrying could
 * misreport a precondition failure against our own landed write. Part uploads
 * are idempotent (re-sending a part number replaces it) and keep retries;
 * `CompleteMultipartUpload` does not, since a retry after a partly-applied
 * complete is ambiguous.
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

/** Default size of one multipart part; at or above S3's 5 MiB minimum. */
export const DEFAULT_PART_SIZE_BYTES = 8 * 1024 * 1024;

/** Sources at or under this size upload in a single PUT. */
export const DEFAULT_MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024;

/** Parts uploaded concurrently; peak buffered bytes is this times part size. */
export const DEFAULT_UPLOAD_CONCURRENCY = 4;

/** Parts per multipart upload, limited by the S3 API. */
const MAX_PARTS = 10_000;

/** Smallest part S3 accepts for any part but the last. */
const MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;

/** Largest part S3 accepts. */
const MAX_PART_SIZE_BYTES = 5 * 1024 * 1024 * 1024;

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
  /**
   * Size of one multipart part. Defaults to {@link DEFAULT_PART_SIZE_BYTES};
   * must be at least S3's 5 MiB minimum. Scaled up per upload when a file
   * would otherwise need more than 10,000 parts.
   */
  partSizeBytes?: number;
  /**
   * Sources at or under this size upload in a single PUT. Defaults to
   * {@link DEFAULT_MULTIPART_THRESHOLD_BYTES}.
   */
  multipartThresholdBytes?: number;
  /**
   * Parts uploaded concurrently. Defaults to
   * {@link DEFAULT_UPLOAD_CONCURRENCY}; peak buffered bytes is this times the
   * effective part size.
   */
  uploadConcurrency?: number;
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

/** Escape text for inclusion in an XML request body. */
function xmlEscape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Part size for a source of `size` bytes.
 *
 * Grows past the configured size when the file would otherwise need more than
 * {@link MAX_PARTS} parts, rounding up to a whole MiB so the arithmetic stays
 * legible in error messages and logs.
 */
function effectivePartSize(size: number, configured: number): number {
  const needed = Math.ceil(size / MAX_PARTS);
  if (needed <= configured) return configured;
  const mib = 1024 * 1024;
  const scaled = Math.ceil(needed / mib) * mib;
  if (scaled > MAX_PART_SIZE_BYTES) {
    throw new OcflError(
      `${size} bytes needs ${scaled}-byte parts to stay within ${MAX_PARTS} parts, ` +
        `over S3's ${MAX_PART_SIZE_BYTES}-byte part limit`,
    );
  }
  return scaled;
}

/**
 * Fill `buffer` from `file`, returning the number of bytes read.
 *
 * `FsFile.read` is a short-read API: it may return fewer bytes than the buffer
 * holds well before end of file, so every caller has to loop.
 */
async function readExactly(
  file: Deno.FsFile,
  buffer: Uint8Array,
): Promise<number> {
  let filled = 0;
  while (filled < buffer.length) {
    const read = await file.read(buffer.subarray(filled));
    if (read === null) break;
    filled += read;
  }
  return filled;
}

/** Storage backend for an S3 bucket prefix. */
export class S3Backend implements StorageBackend {
  readonly kind = "s3" as const;
  readonly url: string;

  readonly #options: S3Options;
  readonly #client: AwsClient;
  readonly #fetch: (request: Request) => Promise<Response>;
  readonly #partSize: number;
  readonly #multipartThreshold: number;
  readonly #concurrency: number;
  #warnedDegraded = false;

  constructor(options: S3Options) {
    this.#options = options;
    this.url = options.prefix === ""
      ? `s3://${options.bucket}`
      : `s3://${options.bucket}/${options.prefix}`;

    this.#partSize = options.partSizeBytes ?? DEFAULT_PART_SIZE_BYTES;
    this.#multipartThreshold = options.multipartThresholdBytes ??
      DEFAULT_MULTIPART_THRESHOLD_BYTES;
    this.#concurrency = options.uploadConcurrency ?? DEFAULT_UPLOAD_CONCURRENCY;
    if (!Number.isInteger(this.#partSize) || this.#partSize < 1) {
      throw new OcflError(`partSizeBytes must be a positive integer`);
    }
    if (this.#partSize > MAX_PART_SIZE_BYTES) {
      throw new OcflError(
        `partSizeBytes ${this.#partSize} is over S3's ${MAX_PART_SIZE_BYTES}-byte part limit`,
      );
    }
    if (!Number.isInteger(this.#concurrency) || this.#concurrency < 1) {
      throw new OcflError(`uploadConcurrency must be a positive integer`);
    }
    if (this.#partSize < MIN_PART_SIZE_BYTES) {
      // Only tests set a part size this small; a real store rejects every
      // part but the last, so say so rather than failing deep in an upload.
      options.onWarning?.(
        `partSizeBytes ${this.#partSize} is under S3's ${MIN_PART_SIZE_BYTES}-byte minimum; ` +
          "real S3-compatible stores will reject all but the final part",
      );
    }
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
    const full = prefix === ""
      ? key
      : (key === "" ? prefix : `${prefix}/${key}`);
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
    if (info.size <= this.#multipartThreshold) {
      await this.write(key, await Deno.readFile(sourcePath));
      return;
    }
    await this.#multipartUpload(key, sourcePath, info.size);
  }

  /**
   * Upload a local file to a key in parts.
   *
   * Once the upload is created every failure path aborts it: parts that
   * belong to an incomplete upload are invisible to `list` and unreachable by
   * `deletePrefix`, so nothing else in the library can clean them up.
   */
  async #multipartUpload(
    key: string,
    sourcePath: string,
    size: number,
  ): Promise<void> {
    const partSize = effectivePartSize(size, this.#partSize);
    const partCount = Math.max(1, Math.ceil(size / partSize));
    const uploadId = await this.#createMultipartUpload(key);

    try {
      const etags = await this.#uploadParts(
        key,
        sourcePath,
        uploadId,
        partSize,
        partCount,
      );
      await this.#completeMultipartUpload(key, uploadId, etags);
    } catch (cause) {
      await this.#abortMultipartUpload(key, uploadId);
      throw cause;
    }
  }

  /** Start a multipart upload, returning its upload id. */
  async #createMultipartUpload(key: string): Promise<string> {
    const response = await this.#request(`${this.#keyUrl(key)}?uploads`, {
      method: "POST",
    });
    if (!response.ok) {
      throw await this.#errorFor(
        response,
        `starting multipart upload of ${key}`,
      );
    }
    const uploadId = xmlValues(await response.text(), "UploadId")[0];
    if (uploadId === undefined || uploadId === "") {
      throw new OcflError(
        `starting multipart upload of ${key} returned no upload id`,
        { path: key },
      );
    }
    return uploadId;
  }

  /**
   * Upload every part, `uploadConcurrency` at a time.
   *
   * Each worker holds its own file handle so concurrent reads never share a
   * cursor, and reuses one part-sized buffer, keeping peak memory at
   * concurrency × part size regardless of the file's size.
   *
   * The first failure stops the others from claiming further parts, and every
   * worker settles before this returns: the caller aborts the upload on the
   * way out, and an abort racing parts still in flight would strand them.
   *
   * @returns Entity tags indexed by part number minus one.
   */
  async #uploadParts(
    key: string,
    sourcePath: string,
    uploadId: string,
    partSize: number,
    partCount: number,
  ): Promise<string[]> {
    const etags = new Array<string>(partCount);
    let nextPart = 0;
    let failure: { error: unknown } | undefined;

    const worker = async () => {
      let file: Deno.FsFile | undefined;
      try {
        file = await Deno.open(sourcePath, { read: true });
        const buffer = new Uint8Array(partSize);
        for (;;) {
          if (failure !== undefined) return;
          const index = nextPart++;
          if (index >= partCount) return;
          await file.seek(index * partSize, Deno.SeekMode.Start);
          const filled = await readExactly(file, buffer);
          etags[index] = await this.#uploadPart(
            key,
            uploadId,
            index + 1,
            buffer.subarray(0, filled),
          );
        }
      } catch (error) {
        failure ??= { error };
      } finally {
        file?.close();
      }
    };

    const running: Promise<void>[] = [];
    for (let slot = 0; slot < Math.min(this.#concurrency, partCount); slot++) {
      running.push(worker());
    }
    await Promise.all(running);
    if (failure !== undefined) throw failure.error;
    return etags;
  }

  /** Upload one part. Retried like any other request: parts are idempotent. */
  async #uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    data: Uint8Array,
  ): Promise<string> {
    const query = new URLSearchParams({
      partNumber: String(partNumber),
      uploadId,
    });
    const response = await this.#request(`${this.#keyUrl(key)}?${query}`, {
      method: "PUT",
      body: data.slice().buffer,
    });
    if (!response.ok) {
      throw await this.#errorFor(
        response,
        `uploading part ${partNumber} of ${key}`,
      );
    }
    await response.body?.cancel().catch(() => {});
    const etag = response.headers.get("etag");
    if (etag === null) {
      throw new OcflError(
        `part ${partNumber} of ${key} was stored without an entity tag`,
        { path: key },
      );
    }
    return etag.replaceAll('"', "");
  }

  /**
   * Assemble the uploaded parts into the final object.
   *
   * S3 can report failure here as an `<Error>` document under a `200 OK` —
   * the status alone does not mean the object landed.
   */
  async #completeMultipartUpload(
    key: string,
    uploadId: string,
    etags: readonly string[],
  ): Promise<void> {
    const body = new TextEncoder().encode(
      `<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>${
        etags.map((etag, index) =>
          `<Part><PartNumber>${index + 1}</PartNumber><ETag>"${
            xmlEscape(etag)
          }"</ETag></Part>`
        ).join("")
      }</CompleteMultipartUpload>`,
    );
    const response = await this.#request(
      `${this.#keyUrl(key)}?${new URLSearchParams({ uploadId })}`,
      { method: "POST", body: body.slice().buffer },
      // A complete that may have partly applied cannot be safely repeated.
      { retry: false },
    );
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      const code = /<Code>([^<]*)<\/Code>/.exec(text)?.[1];
      throw new OcflError(
        `completing multipart upload of ${key} failed with status ${response.status}${
          code === undefined ? "" : ` (${code})`
        }`,
        { path: key },
      );
    }
    const errorCode = xmlValues(text, "Code")[0];
    if (errorCode !== undefined) {
      throw new OcflError(
        `completing multipart upload of ${key} failed: ${errorCode}`,
        { path: key },
      );
    }
  }

  /** Discard an upload and its parts, best-effort. */
  async #abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      const response = await this.#request(
        `${this.#keyUrl(key)}?${new URLSearchParams({ uploadId })}`,
        { method: "DELETE" },
      );
      await response.body?.cancel().catch(() => {});
      if (!response.ok && response.status !== 404) {
        this.#options.onWarning?.(
          `aborting multipart upload of ${key} failed with status ${response.status}; ` +
            "its parts remain until a bucket lifecycle rule reaps them",
        );
      }
    } catch (cause) {
      this.#options.onWarning?.(
        `aborting multipart upload of ${key} failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
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
          batch.map((key) => `<Object><Key>${xmlEscape(key)}</Key></Object>`)
            .join("")
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
