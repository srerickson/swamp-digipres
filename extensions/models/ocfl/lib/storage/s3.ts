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
import { parseListObjectsV2 } from "./xml.ts";

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
};

/** An OCFL storage root in an S3-compatible bucket. */
export class S3Storage implements Storage {
  readonly backend = "s3" as const;
  readonly location: string;
  readonly #client: AwsClient;
  readonly #baseUrl: string;
  readonly #prefix: string;
  readonly #signal: AbortSignal | undefined;

  constructor(options: S3StorageOptions) {
    this.#client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
      service: "s3",
      region: options.region ?? "auto",
    });
    this.#prefix = normalizePrefix(options.prefix ?? "");
    this.#signal = options.signal;

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

  async read(path: string): Promise<Bytes> {
    const response = await this.#send(this.#url(this.#key(path)));
    if (response.status === 404) {
      // Drain so the connection can be reused.
      await response.body?.cancel();
      throw new NotFoundError(path);
    }
    if (!response.ok) {
      throw await s3Error("GET", path, response);
    }
    return new Uint8Array(await response.arrayBuffer());
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
