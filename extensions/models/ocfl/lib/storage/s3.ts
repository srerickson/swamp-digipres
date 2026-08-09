/**
 * S3-compatible {@linkcode Storage} backend, tested against Cloudflare R2.
 *
 * Signing uses `aws4fetch` rather than the AWS SDK: swamp inlines npm packages
 * into the extension bundle, and aws4fetch is a few kilobytes with no
 * dependencies where `@aws-sdk/client-s3` is megabytes.
 *
 * @module
 */
import { AwsClient } from "npm:aws4fetch@1.0.20";
import { NotFoundError, OcflError } from "../errors.ts";
import type { Bytes, Entry, Storage } from "./types.ts";
import {
  completeMultipartUploadBody,
  firstTag,
  parseListObjectsV2,
} from "./xml.ts";

/**
 * Bytes per multipart part, and the threshold below which a single `PUT` is
 * used instead.
 *
 * Comfortably above S3's 5 MiB minimum, and small enough that
 * {@linkcode MAX_PARTS} covers 160 GiB before any scaling is needed.
 */
const DEFAULT_PART_SIZE = 16 * 1024 * 1024;

/** Parts allowed in one multipart upload, per the S3 API. */
const MAX_PARTS = 10_000;

/** Part uploads allowed in flight at once. Peak memory is this × part size. */
const DEFAULT_CONCURRENCY = 4;

/** Connection settings for an S3-compatible storage root. */
export type S3StorageOptions = {
  /** Bucket holding the storage root. */
  bucket: string;
  /** Key prefix locating the storage root inside the bucket; may be empty. */
  prefix?: string;
  /** Service endpoint, e.g. an R2 account URL. Defaults to AWS in `region`. */
  endpoint?: string;
  /** Signing region. R2 accepts and expects `auto`. */
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /**
   * Address the bucket as a path segment rather than a subdomain. Required by
   * R2 and most other S3-compatible services.
   */
  forcePathStyle?: boolean;
  /** Abort signal propagated to every request. */
  signal?: AbortSignal;
  /** Bytes per multipart part. Defaults to 16 MiB. */
  partSize?: number;
  /** Part uploads in flight at once. Defaults to 4. */
  concurrency?: number;
  /**
   * Automatic retries for retryable responses, with exponential backoff.
   *
   * Defaults to aws4fetch's own default of 10. Worth lowering when a caller
   * would rather fail fast than have a transient 5xx stall a run for minutes.
   */
  retries?: number;
};

/** An OCFL storage root in an S3-compatible bucket. */
export class S3Storage implements Storage {
  readonly backend = "s3" as const;
  readonly location: string;
  readonly #client: AwsClient;
  readonly #baseUrl: string;
  readonly #prefix: string;
  readonly #signal: AbortSignal | undefined;
  readonly #partSize: number;
  readonly #concurrency: number;

  constructor(options: S3StorageOptions) {
    this.#client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
      service: "s3",
      region: options.region ?? "auto",
      ...(options.retries === undefined ? {} : { retries: options.retries }),
    });
    this.#prefix = normalizePrefix(options.prefix ?? "");
    this.#signal = options.signal;
    this.#partSize = options.partSize ?? DEFAULT_PART_SIZE;
    this.#concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

    const endpoint = (options.endpoint ??
      `https://s3.${options.region ?? "us-east-1"}.amazonaws.com`)
      .replace(/\/+$/, "");
    const pathStyle = options.forcePathStyle ?? true;
    this.#baseUrl = pathStyle
      ? `${endpoint}/${options.bucket}`
      : endpoint.replace("://", `://${options.bucket}.`);

    this.location = `s3://${options.bucket}/${this.#prefix}`;
  }

  /** Absolute key for a storage path, including the configured prefix. */
  #key(path: string): string {
    const relative = path.split("/").filter((segment) => segment.length > 0)
      .join("/");
    return this.#prefix.length === 0
      ? relative
      : relative.length === 0
      ? this.#prefix
      : `${this.#prefix}/${relative}`;
  }

  /** URL for an object key, escaping each segment individually. */
  #url(key: string): string {
    const escaped = key.split("/").map(encodeURIComponent).join("/");
    return `${this.#baseUrl}/${escaped}`;
  }

  async #send(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.#client.fetch(url, {
      ...init,
      signal: this.#signal,
    });
    return response;
  }

  /**
   * `GET` an object, leaving the body untouched for the caller to consume.
   *
   * Buffered and streaming reads share this so they issue the same request
   * through the same retry wrapper, and so a missing key fails identically.
   */
  async #get(path: string): Promise<Response> {
    const response = await this.#send(this.#url(this.#key(path)));
    if (response.status === 404) {
      // Drain so the connection can be reused.
      await response.body?.cancel();
      throw new NotFoundError(path);
    }
    if (!response.ok) {
      throw await s3Error("GET", path, response);
    }
    return response;
  }

  async read(path: string): Promise<Bytes> {
    const response = await this.#get(path);
    return new Uint8Array(await response.arrayBuffer());
  }

  async readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const response = await this.#get(path);
    // `fetch` omits the body on a zero-length response; the caller asked for a
    // stream either way.
    return response.body ?? emptyStream();
  }

  async exists(path: string): Promise<boolean> {
    const response = await this.#send(this.#url(this.#key(path)), {
      method: "HEAD",
    });
    await response.body?.cancel();
    if (response.status === 404) return false;
    if (!response.ok) {
      throw await s3Error("HEAD", path, response);
    }
    return true;
  }

  async listDir(path: string): Promise<Entry[]> {
    const key = this.#key(path);
    const prefix = key.length === 0 ? "" : `${key}/`;
    const entries: Entry[] = [];
    const seen = new Set<string>();

    for await (const page of this.#listPages(prefix, "/")) {
      for (const objectKey of page.keys) {
        // A "directory marker" — a zero-byte object at the prefix itself — is
        // not a child of the directory.
        if (objectKey === prefix) continue;
        const name = objectKey.slice(prefix.length);
        if (name.length === 0 || seen.has(name)) continue;
        seen.add(name);
        entries.push({ name, type: "file" });
      }
      for (const commonPrefix of page.commonPrefixes) {
        const name = commonPrefix.slice(prefix.length).replace(/\/+$/, "");
        if (name.length === 0 || seen.has(name)) continue;
        seen.add(name);
        entries.push({ name, type: "dir" });
      }
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries;
  }

  /**
   * Yield every file beneath `prefix`.
   *
   * Unlike the local backend this does not recurse through `listDir`: a flat
   * list costs one request per 1,000 keys regardless of hierarchy depth, which
   * is the difference between one request and hundreds when scanning a storage
   * root for object roots.
   */
  async *walkFiles(prefix: string): AsyncIterable<string> {
    const key = this.#key(prefix);
    const listPrefix = key.length === 0 ? "" : `${key}/`;
    const rootPrefix = this.#prefix.length === 0 ? "" : `${this.#prefix}/`;

    for await (const page of this.#listPages(listPrefix, undefined)) {
      for (const objectKey of page.keys) {
        if (objectKey.endsWith("/")) continue; // directory marker
        yield objectKey.slice(rootPrefix.length);
      }
    }
  }

  /** Page through `ListObjectsV2`, yielding each page's parsed body. */
  async *#listPages(prefix: string, delimiter: string | undefined) {
    let token: string | undefined;
    do {
      const url = new URL(this.#baseUrl);
      url.searchParams.set("list-type", "2");
      if (prefix.length > 0) url.searchParams.set("prefix", prefix);
      if (delimiter !== undefined) url.searchParams.set("delimiter", delimiter);
      if (token !== undefined) {
        url.searchParams.set("continuation-token", token);
      }

      const response = await this.#send(url.toString());
      if (!response.ok) {
        throw await s3Error("LIST", prefix, response);
      }
      const page = parseListObjectsV2(await response.text());
      yield page;
      token = page.nextContinuationToken;
    } while (token !== undefined);
  }

  async write(path: string, bytes: Bytes): Promise<void> {
    const response = await this.#send(this.#url(this.#key(path)), {
      method: "PUT",
      // Wrapped in a Blob because `BodyInit` does not accept the generic
      // `Uint8Array<ArrayBufferLike>` that `Deno.readFile` and friends return.
      body: new Blob([bytes]),
    });
    await response.body?.cancel();
    if (!response.ok) {
      throw await s3Error("PUT", path, response);
    }
  }

  /** A `PUT` is already indivisible, and read-after-write is consistent. */
  writeAtomic(path: string, bytes: Bytes): Promise<void> {
    return this.write(path, bytes);
  }

  /**
   * Stream a file in, using a multipart upload when it exceeds one part.
   *
   * The stream is consumed one part at a time, so a multi-gigabyte source
   * never lands in memory whole — peak usage is `concurrency × partSize`.
   */
  async writeStream(
    path: string,
    body: ReadableStream<Uint8Array>,
    options: { size?: number } = {},
  ): Promise<void> {
    const partSize = this.#partSizeFor(options.size);
    const parts = partition(body, partSize);

    // Peeking at the first part decides single-PUT vs multipart without
    // trusting a caller-supplied size, and works when there is no size at all.
    const first = await parts.next();
    if (first.done) {
      return await this.write(path, new Uint8Array(new ArrayBuffer(0)));
    }
    if (first.value.byteLength < partSize) {
      await parts.return(undefined);
      return await this.write(path, first.value);
    }

    await this.#multipartUpload(path, parts, first.value, partSize);
  }

  /**
   * Part size for a source, scaled up when the default would exceed the API's
   * part limit. Rounded to a whole MiB so parts stay uniform and legible.
   */
  #partSizeFor(size: number | undefined): number {
    if (size === undefined) return this.#partSize;
    const required = Math.ceil(size / MAX_PARTS);
    if (required <= this.#partSize) return this.#partSize;
    const mib = 1024 * 1024;
    return Math.ceil(required / mib) * mib;
  }

  /** Run a multipart upload to completion, aborting it on any failure. */
  async #multipartUpload(
    path: string,
    parts: AsyncGenerator<Bytes, void, undefined>,
    firstPart: Bytes,
    partSize: number,
  ): Promise<void> {
    const key = this.#key(path);
    const uploadId = await this.#createMultipartUpload(path, key);
    const uploaded: Array<{ partNumber: number; etag: string }> = [];
    const inFlight = new Set<Promise<void>>();

    const dispatch = (partNumber: number, bytes: Bytes): void => {
      const task = (async () => {
        const etag = await this.#uploadPart(
          path,
          key,
          uploadId,
          partNumber,
          bytes,
        );
        uploaded.push({ partNumber, etag });
      })();
      inFlight.add(task);
      // Settle the bookkeeping chain separately; `task` itself stays in the
      // set so a rejection still surfaces through race/all below.
      task.finally(() => inFlight.delete(task)).catch(() => {});
    };

    try {
      let partNumber = 0;
      let pending: Bytes | undefined = firstPart;
      while (pending !== undefined) {
        partNumber += 1;
        if (partNumber > MAX_PARTS) {
          throw new OcflError(
            `source exceeds the ${MAX_PARTS}-part multipart limit at a part ` +
              `size of ${partSize} bytes; supply a size so the part size can ` +
              `be scaled, or configure a larger partSize`,
            { path },
          );
        }
        dispatch(partNumber, pending);
        if (inFlight.size >= this.#concurrency) await Promise.race(inFlight);

        const next = await parts.next();
        pending = next.done ? undefined : next.value;
      }
      await Promise.all(inFlight);
      await this.#completeMultipartUpload(path, key, uploadId, uploaded);
    } catch (error) {
      // Drain in-flight work before aborting, so no part lands after the abort
      // and leaves billable storage behind.
      await Promise.allSettled(inFlight);
      await parts.return(undefined).catch(() => {});
      await this.#abortMultipartUpload(key, uploadId).catch(() => {});
      throw error;
    }
  }

  /** `CreateMultipartUpload`; returns the upload id. */
  async #createMultipartUpload(path: string, key: string): Promise<string> {
    const response = await this.#send(`${this.#url(key)}?uploads`, {
      method: "POST",
    });
    if (!response.ok) {
      throw await s3Error("POST ?uploads", path, response);
    }
    const uploadId = firstTag(await response.text(), "UploadId");
    if (uploadId === undefined) {
      throw new OcflError(
        "CreateMultipartUpload response carried no UploadId",
        { path },
      );
    }
    return uploadId;
  }

  /** `UploadPart`; returns the part's ETag, which Complete must echo back. */
  async #uploadPart(
    path: string,
    key: string,
    uploadId: string,
    partNumber: number,
    bytes: Bytes,
  ): Promise<string> {
    const url = `${this.#url(key)}?partNumber=${partNumber}` +
      `&uploadId=${encodeURIComponent(uploadId)}`;
    const response = await this.#send(url, {
      method: "PUT",
      body: new Blob([bytes]),
    });
    await response.body?.cancel();
    if (!response.ok) {
      throw await s3Error(`PUT part ${partNumber}`, path, response);
    }
    const etag = response.headers.get("etag");
    if (etag === null) {
      throw new OcflError(
        `UploadPart ${partNumber} response carried no ETag`,
        { path },
      );
    }
    return etag;
  }

  /** `CompleteMultipartUpload`. */
  async #completeMultipartUpload(
    path: string,
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; etag: string }>,
  ): Promise<void> {
    const url = `${this.#url(key)}?uploadId=${encodeURIComponent(uploadId)}`;
    const response = await this.#send(url, {
      method: "POST",
      headers: { "content-type": "application/xml" },
      body: completeMultipartUploadBody(parts),
    });
    if (!response.ok) {
      throw await s3Error("POST complete", path, response);
    }
    // S3 may report a failure inside a 200 response, because the connection is
    // held open while the parts are assembled.
    const text = await response.text();
    if (firstTag(text, "Error") !== undefined) {
      throw new OcflError(
        `CompleteMultipartUpload failed: ${text.slice(0, 500)}`,
        { path },
      );
    }
  }

  /** `AbortMultipartUpload`, so failed uploads do not leak stored parts. */
  async #abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    const url = `${this.#url(key)}?uploadId=${encodeURIComponent(uploadId)}`;
    const response = await this.#send(url, { method: "DELETE" });
    await response.body?.cancel();
  }

  async remove(path: string): Promise<void> {
    const response = await this.#send(this.#url(this.#key(path)), {
      method: "DELETE",
    });
    await response.body?.cancel();
    // S3 reports a delete of an absent key as success; 404 is here for the
    // implementations that do not.
    if (!response.ok && response.status !== 404) {
      throw await s3Error("DELETE", path, response);
    }
  }
}

/**
 * Split a stream into fixed-size parts.
 *
 * Every part but the last is exactly `partSize` bytes. That uniformity is not
 * cosmetic: Cloudflare R2 rejects a multipart upload whose non-final parts
 * differ in size, where AWS tolerates it. Each part gets its own buffer because
 * parts are uploaded concurrently and would otherwise be overwritten in place.
 */
async function* partition(
  stream: ReadableStream<Uint8Array>,
  partSize: number,
): AsyncGenerator<Bytes, void, undefined> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(new ArrayBuffer(partSize));
  let filled = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.byteLength) {
        const take = Math.min(partSize - filled, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === partSize) {
          yield buffer;
          buffer = new Uint8Array(new ArrayBuffer(partSize));
          filled = 0;
        }
      }
    }
    if (filled > 0) yield buffer.subarray(0, filled) as Bytes;
  } finally {
    reader.releaseLock();
  }
}

/** A stream that closes without yielding anything. */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/** Strip leading and trailing slashes from a configured key prefix. */
function normalizePrefix(prefix: string): string {
  return prefix.split("/").filter((segment) => segment.length > 0).join("/");
}

/** Build an error carrying the response body, which holds S3's error code. */
async function s3Error(
  operation: string,
  path: string,
  response: Response,
): Promise<OcflError> {
  const body = await response.text().catch(() => "");
  const detail = body.length > 0 ? ` ${body.slice(0, 500)}` : "";
  return new OcflError(
    `S3 ${operation} failed with ${response.status} ${response.statusText}${detail}`,
    { path },
  );
}
