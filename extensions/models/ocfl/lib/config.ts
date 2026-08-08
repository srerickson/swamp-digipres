/**
 * Turning a model's global arguments into a {@linkcode Storage}.
 *
 * Kept out of `mod.ts` so it can be unit-tested without loading the model.
 *
 * @module
 */
import { OcflError } from "./errors.ts";
import { LocalStorage } from "./storage/local.ts";
import { S3Storage } from "./storage/s3.ts";
import type { Storage } from "./storage/types.ts";

/** Global arguments relevant to storage selection. */
export type StorageConfig = {
  storage: "local" | "s3";
  path?: string;
  bucket?: string;
  prefix?: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  forcePathStyle?: boolean;
};

/** Read a credential from the arguments, falling back to the environment. */
function credential(
  value: string | undefined,
  envVar: string,
): string | undefined {
  if (value !== undefined && value.length > 0) return value;
  const fromEnv = Deno.env.get(envVar);
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
}

/**
 * Build the storage backend the model is configured for.
 *
 * Validation lives here rather than in the global-arguments schema: a Zod
 * `superRefine` would wrap the schema in `ZodEffects`, and swamp introspects
 * `globalArguments` field-by-field to render `swamp model create` and
 * `extension info`.
 *
 * @throws {OcflError} when the arguments do not describe a usable backend.
 */
export function createStorage(
  config: StorageConfig,
  signal?: AbortSignal,
): Storage {
  if (config.storage === "local") {
    const path = config.path;
    if (path === undefined || path.length === 0) {
      throw new OcflError("storage=local requires 'path' to be set");
    }
    if (!path.startsWith("/")) {
      throw new OcflError(
        `storage=local requires an absolute 'path'; got ${
          JSON.stringify(path)
        }`,
      );
    }
    return new LocalStorage(path);
  }

  const bucket = config.bucket;
  if (bucket === undefined || bucket.length === 0) {
    throw new OcflError("storage=s3 requires 'bucket' to be set");
  }

  const accessKeyId = credential(config.accessKeyId, "AWS_ACCESS_KEY_ID");
  const secretAccessKey = credential(
    config.secretAccessKey,
    "AWS_SECRET_ACCESS_KEY",
  );
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new OcflError(
      "storage=s3 requires 'accessKeyId' and 'secretAccessKey' (or the " +
        "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY environment variables). " +
        "Wire them with a vault.get(...) expression rather than literals.",
    );
  }

  return new S3Storage({
    bucket,
    prefix: config.prefix,
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId,
    secretAccessKey,
    sessionToken: credential(config.sessionToken, "AWS_SESSION_TOKEN"),
    forcePathStyle: config.forcePathStyle,
    signal,
  });
}
