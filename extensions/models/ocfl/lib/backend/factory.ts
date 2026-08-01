/**
 * Backend selection from a model's global arguments.
 *
 * A `storageRoot` of `s3://bucket[/prefix]` selects the S3 backend (the same
 * convention the Go `ocfl` CLI uses for `--root`); anything else is treated
 * as a local directory path. S3 credentials and region come from the
 * arguments when set — populated via vault references in the instance YAML —
 * and fall back to the standard `AWS_*` environment variables.
 *
 * @module
 */
import { OcflError } from "../errors.ts";
import type { StorageBackend } from "./backend.ts";
import { LocalBackend } from "./local.ts";
import { S3Backend } from "./s3.ts";

/** Arguments the factory reads; a subset of the model's global arguments. */
export interface BackendArgs {
  storageRoot: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

/** Parse `s3://bucket[/prefix]`, or `null` when the root is not an S3 URL. */
export function parseS3Url(
  storageRoot: string,
): { bucket: string; prefix: string } | null {
  if (!storageRoot.startsWith("s3://")) return null;
  const rest = storageRoot.slice("s3://".length).replace(/\/+$/, "");
  const slash = rest.indexOf("/");
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const prefix = slash === -1 ? "" : rest.slice(slash + 1);
  if (bucket === "") {
    throw new OcflError(
      `invalid S3 storage root ${JSON.stringify(storageRoot)}: missing bucket`,
      { path: storageRoot },
    );
  }
  return { bucket, prefix };
}

/** Environment lookup that treats a missing env permission as unset. */
function envGet(name: string): string | undefined {
  try {
    return Deno.env.get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Build the storage backend selected by the global arguments. */
export function createBackend(
  args: BackendArgs,
  options: { onWarning?: (message: string) => void } = {},
): StorageBackend {
  const s3 = parseS3Url(args.storageRoot);
  if (s3 === null) {
    return new LocalBackend(args.storageRoot);
  }

  const region = args.region ?? envGet("AWS_REGION") ??
    envGet("AWS_DEFAULT_REGION");
  const accessKeyId = args.accessKeyId ?? envGet("AWS_ACCESS_KEY_ID");
  const secretAccessKey = args.secretAccessKey ??
    envGet("AWS_SECRET_ACCESS_KEY");
  const sessionToken = args.sessionToken ?? envGet("AWS_SESSION_TOKEN");

  if (region === undefined) {
    throw new OcflError(
      `S3 storage root ${args.storageRoot} needs a region: set the region argument or AWS_REGION`,
      { path: args.storageRoot },
    );
  }
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new OcflError(
      `S3 storage root ${args.storageRoot} needs credentials: set accessKeyId/secretAccessKey ` +
        "(e.g. via ${{ vault.get(...) }}) or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY",
      { path: args.storageRoot },
    );
  }

  return new S3Backend({
    bucket: s3.bucket,
    prefix: s3.prefix,
    region,
    endpoint: args.endpoint,
    forcePathStyle: args.forcePathStyle,
    accessKeyId,
    secretAccessKey,
    sessionToken,
    onWarning: options.onWarning,
  });
}
