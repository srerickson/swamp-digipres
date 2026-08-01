/**
 * Swamp model type for an OCFL 1.1 storage root.
 *
 * A native TypeScript OCFL client: reads objects, validates them against the
 * specification's E/W validation codes, and writes new versions atomically.
 * Storage roots live on a local filesystem or an S3-compatible object store
 * (`storageRoot: s3://bucket/prefix`). Methods are thin wrappers — all OCFL
 * logic lives in `lib/`.
 *
 * Operational contract: one swamp model instance is the sole writer to a given
 * storage root. OCFL has no locking, so concurrent writers from other tools are
 * not serialized.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { OcflError } from "./lib/errors.ts";
import type { StorageBackend } from "./lib/backend/backend.ts";
import { createBackend } from "./lib/backend/factory.ts";
import { commit as commitObject, initStorageRoot } from "./lib/commit.ts";
import { digestBytes } from "./lib/digest.ts";
import type { OcflObject, StorageRoot } from "./lib/object.ts";
import {
  getVersionState,
  listObjects,
  openStorageRoot,
  requireObject,
  versionFileCount,
  versionNames,
} from "./lib/object.ts";
import { checkNamaste } from "./lib/namaste.ts";
import { contentDirectoryOf } from "./lib/types.ts";
import { validateStorageRoot } from "./lib/validate.ts";

/** Global arguments shared by every method on the model. */
const GlobalArgsSchema = z.object({
  storageRoot: z.string().min(1).describe(
    "Absolute path to the OCFL storage root, or s3://bucket/prefix for an " +
      "S3-compatible object store",
  ),
  digestAlgorithm: z.enum(["sha512", "sha256"]).default("sha512").describe(
    "Digest algorithm for newly created objects; existing objects keep their own",
  ),
  stagingDir: z.string().optional().describe(
    "Local storage roots only: directory to stage new versions in; must be on " +
      "the same filesystem as the storage root. Defaults to a sibling of the " +
      "storage root. Rejected for s3:// roots, which stage nothing locally.",
  ),
  region: z.string().optional().describe(
    "S3 region for s3:// storage roots; falls back to AWS_REGION",
  ),
  endpoint: z.string().optional().describe(
    "Custom S3 endpoint origin for S3-compatible stores (MinIO, R2), " +
      "e.g. https://minio.example.com:9000",
  ),
  forcePathStyle: z.boolean().default(false).describe(
    "Use path-style S3 URLs (endpoint/bucket/key); implied when endpoint is set",
  ),
  accessKeyId: z.string().optional().describe(
    "S3 access key id; falls back to AWS_ACCESS_KEY_ID",
  ),
  secretAccessKey: z.string().optional().meta({ sensitive: true }).describe(
    'S3 secret access key; populate via ${{ vault.get(...) }}. Falls back to ' +
      "AWS_SECRET_ACCESS_KEY",
  ),
  sessionToken: z.string().optional().meta({ sensitive: true }).describe(
    "S3 session token for temporary credentials; falls back to AWS_SESSION_TOKEN",
  ),
});

/** Validated global arguments. */
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** One version's provenance metadata in an object snapshot. */
const VersionSummarySchema = z.object({
  name: z.string(),
  created: z.string(),
  message: z.string().optional(),
  userName: z.string().optional(),
  userAddress: z.string().optional(),
  fileCount: z.number().int(),
});

/** One logical file in the snapshot's resolved version state. */
const StateEntrySchema = z.object({
  logicalPath: z.string(),
  digest: z.string(),
  contentPaths: z.array(z.string()),
});

/** One manifest entry: a digest and the content paths holding it. */
const ManifestEntrySchema = z.object({
  digest: z.string(),
  contentPaths: z.array(z.string()),
});

/** Snapshot of a single OCFL object. */
const ObjectSnapshotSchema = z.object({
  id: z.string(),
  path: z.string(),
  head: z.string(),
  version: z.string(),
  digestAlgorithm: z.string(),
  contentDirectory: z.string(),
  versions: z.array(VersionSummarySchema),
  state: z.array(StateEntrySchema),
  manifest: z.array(ManifestEntrySchema),
  readAt: z.iso.datetime(),
});

/** One validation finding, keyed by its OCFL validation code. */
const ValidationIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["error", "warning"]),
  path: z.string(),
  message: z.string(),
});

/** Validation outcome for the storage root and every object checked. */
const ValidationSchema = z.object({
  storageRoot: z.string(),
  checkedAt: z.iso.datetime(),
  fullFixity: z.boolean(),
  valid: z.boolean(),
  objectCount: z.number().int(),
  invalidCount: z.number().int(),
  rootErrors: z.array(ValidationIssueSchema),
  rootWarnings: z.array(ValidationIssueSchema),
  objects: z.array(z.object({
    id: z.string().nullable(),
    path: z.string(),
    valid: z.boolean(),
    recoverable: z.boolean(),
    errors: z.array(ValidationIssueSchema),
    warnings: z.array(ValidationIssueSchema),
  })),
});

/** Index of every object in the storage root. */
const IndexSchema = z.object({
  storageRoot: z.string(),
  specVersion: z.string(),
  layout: z.string().nullable(),
  objectCount: z.number().int(),
  objects: z.array(z.object({
    id: z.string(),
    path: z.string(),
    head: z.string(),
    versionCount: z.number().int(),
  })),
  readAt: z.iso.datetime(),
});

/**
 * Build a storage-safe instance name for an object id.
 *
 * Object ids are URIs, but instance names map to filesystem paths, so they are
 * sanitized. Sanitization is lossy — two ids differing only in stripped
 * characters would collide — so a digest suffix makes the result injective.
 * The `object-` prefix keeps names distinct from other specs on this model.
 */
export function objectInstanceName(id: string): string {
  const sanitized = id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const suffix = digestBytes(new TextEncoder().encode(id), "sha256").slice(
    0,
    8,
  );
  return `object-${sanitized}-${suffix}`;
}

/** Build the snapshot payload for one object at one version. */
function buildSnapshot(
  object: OcflObject,
  version: string,
): z.infer<typeof ObjectSnapshotSchema> {
  const inventory = object.inventory;
  return {
    id: inventory.id,
    path: object.relativePath,
    head: inventory.head,
    version,
    digestAlgorithm: inventory.digestAlgorithm,
    contentDirectory: contentDirectoryOf(inventory),
    versions: versionNames(inventory).map((name) => {
      const block = inventory.versions[name];
      return {
        name,
        created: block.created,
        message: block.message,
        userName: block.user?.name,
        userAddress: block.user?.address,
        fileCount: versionFileCount(inventory, name),
      };
    }),
    state: getVersionState(inventory, version),
    manifest: Object.entries(inventory.manifest).map((
      [digest, contentPaths],
    ) => ({ digest, contentPaths })),
    readAt: new Date().toISOString(),
  };
}

/** A logger as swamp provides it to method and check executions. */
interface Logger {
  info: (message: string, properties?: unknown) => void;
}

/** Build the storage backend selected by the global arguments. */
function backendFor(globalArgs: GlobalArgs, logger?: Logger): StorageBackend {
  return createBackend(globalArgs, {
    onWarning: (message) => logger?.info(message),
  });
}

/** Open the configured storage root. */
function openRoot(
  globalArgs: GlobalArgs,
  logger?: Logger,
): Promise<StorageRoot> {
  return openStorageRoot(backendFor(globalArgs, logger));
}

/** Arguments for the `get` method. */
const GetArgsSchema = z.object({
  id: z.string().min(1).describe("Object id to read"),
  version: z.string().optional().describe(
    "Version to resolve state for; defaults to the object's head",
  ),
});

/** Arguments for the `list` method. */
const ListArgsSchema = z.object({});

/** Arguments for the `commit` method. */
const CommitArgsSchema = z.object({
  id: z.string().min(1).describe("Object id to create or add a version to"),
  sourcePath: z.string().min(1).describe(
    "Directory whose contents become the new version's complete logical state",
  ),
  message: z.string().optional().describe("Version message"),
  userName: z.string().optional().describe(
    "Name of the agent making the change",
  ),
  userEmail: z.string().optional().describe(
    "Email of the agent; recorded as a mailto: URI",
  ),
  allowDeletes: z.boolean().default(false).describe(
    "Permit paths present in the current version to be absent from sourcePath",
  ),
  fixityAlgorithms: z.array(
    z.enum(["md5", "sha1", "sha256", "sha512", "blake2b-512", "sha512/256"]),
  ).optional().describe(
    "Additional algorithms to record in the fixity block for content written by this commit",
  ),
});

/** Arguments for the `init` method. */
const InitArgsSchema = z.object({
  description: z.string().optional().describe(
    "Description recorded in ocfl_layout.json",
  ),
});

/** Arguments for the `validate` method. */
const ValidateArgsSchema = z.object({
  ids: z.array(z.string()).optional().describe(
    "Object ids to validate; defaults to every object in the storage root",
  ),
  fullFixity: z.boolean().default(false).describe(
    "Recompute every content file's digest — reads every byte in the object",
  ),
});

/** Model definition for an OCFL storage root. */
export const model = {
  type: "@crudec/ocfl-repository",
  version: "2026.08.01.1",
  description:
    "Read, validate, and version objects in an OCFL 1.1 storage root on a local filesystem or an S3-compatible object store",
  globalArguments: GlobalArgsSchema,
  resources: {
    "object": {
      description: "Snapshot of one OCFL object's inventory",
      schema: ObjectSnapshotSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "index": {
      description: "Index of every object in the storage root",
      schema: IndexSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "validation": {
      description: "Validation results for the storage root and its objects",
      schema: ValidationSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  checks: {
    "storage-root-declaration": {
      description:
        "The configured storage root is either absent (init will create it) or carries a valid OCFL conformance declaration",
      labels: ["policy"],
      execute: async (context: {
        globalArgs: GlobalArgs;
        logger: { info: (message: string, properties?: unknown) => void };
      }) => {
        const backend = backendFor(context.globalArgs, context.logger);
        let entries;
        try {
          entries = await backend.list("");
        } catch (cause) {
          if (cause instanceof OcflError) {
            // Local roots report "exists but is not a directory" this way.
            return { pass: false, errors: [cause.message] };
          }
          throw cause;
        }
        if (entries === null) {
          // Nothing there yet — `init` is the method that creates it.
          return { pass: true };
        }
        const { namaste, issues } = await checkNamaste(
          backend,
          "",
          "root",
          backend.url,
        );
        if (namaste === null) {
          return {
            pass: false,
            errors: issues.map((issue) => `${issue.code}: ${issue.message}`),
          };
        }
        return { pass: true };
      },
    },
  },
  methods: {
    init: {
      description:
        "Initialize an empty OCFL 1.1 storage root with the hashed n-tuple layout",
      arguments: InitArgsSchema,
      execute: async (
        args: z.infer<typeof InitArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger: { info: (message: string, properties?: unknown) => void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        await initStorageRoot(backendFor(context.globalArgs, context.logger), {
          description: args.description,
        });
        const root = await openRoot(context.globalArgs, context.logger);

        context.logger.info("Initialized OCFL storage root at {path}", {
          path: root.path,
        });
        const handle = await context.writeResource(
          "index",
          "objects",
          {
            storageRoot: root.path,
            specVersion: root.specVersion,
            layout: root.layout?.name ?? null,
            objectCount: 0,
            objects: [],
            readAt: new Date().toISOString(),
          } satisfies z.infer<typeof IndexSchema>,
        );
        return { dataHandles: [handle] };
      },
    },

    commit: {
      description:
        "Create a new version of an object from a source tree, creating the object if needed",
      arguments: CommitArgsSchema,
      execute: async (
        args: z.infer<typeof CommitArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger: { info: (message: string, properties?: unknown) => void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        context.logger.info("Committing {id} from {sourcePath}", {
          id: args.id,
          sourcePath: args.sourcePath,
        });
        const root = await openRoot(context.globalArgs, context.logger);

        // W009 wants a URI; ocfl-tools writes a nonstandard `email:mailto:`
        // double scheme. Emit the standard form, accept anything on read.
        const user = args.userName === undefined ? undefined : {
          name: args.userName,
          ...(args.userEmail === undefined
            ? {}
            : { address: `mailto:${args.userEmail}` }),
        };

        // Throws before anything is written on a no-op, an unpermitted
        // deletion, or a head conflict.
        const result = await commitObject(root, {
          id: args.id,
          sourcePath: args.sourcePath,
          message: args.message,
          user,
          allowDeletes: args.allowDeletes,
          fixityAlgorithms: args.fixityAlgorithms,
          stagingDir: context.globalArgs.stagingDir,
          digestAlgorithm: context.globalArgs.digestAlgorithm,
        });

        context.logger.info(
          "Committed {id}: {previousHead} -> {head} (+{added} ~{modified} -{deleted})",
          {
            id: result.id,
            previousHead: result.previousHead ?? "<new object>",
            head: result.head,
            added: result.addedPaths.length,
            modified: result.modifiedPaths.length,
            deleted: result.deletedPaths.length,
          },
        );

        // Re-read what actually landed rather than reporting what we intended.
        const object = await requireObject(
          await openRoot(context.globalArgs, context.logger),
          args.id,
        );
        const handle = await context.writeResource(
          "object",
          objectInstanceName(args.id),
          buildSnapshot(object, object.inventory.head),
        );
        return { dataHandles: [handle] };
      },
    },

    get: {
      description: "Read one object's inventory and resolved version state",
      arguments: GetArgsSchema,
      execute: async (
        args: z.infer<typeof GetArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger: { info: (message: string, properties?: unknown) => void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const root = await openRoot(context.globalArgs, context.logger);
        const object = await requireObject(root, args.id);
        const version = args.version ?? object.inventory.head;
        const snapshot = buildSnapshot(object, version);

        context.logger.info("Read OCFL object {id} at {version}", {
          id: snapshot.id,
          version,
        });
        const handle = await context.writeResource(
          "object",
          objectInstanceName(args.id),
          snapshot,
        );
        return { dataHandles: [handle] };
      },
    },

    list: {
      description: "Index every object in the storage root",
      arguments: ListArgsSchema,
      execute: async (
        _args: z.infer<typeof ListArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger: { info: (message: string, properties?: unknown) => void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const root = await openRoot(context.globalArgs, context.logger);
        const objects = await listObjects(root);

        const index: z.infer<typeof IndexSchema> = {
          storageRoot: root.path,
          specVersion: root.specVersion,
          layout: root.layout?.name ?? null,
          objectCount: objects.length,
          objects: objects.map((object) => ({
            id: object.id,
            path: object.relativePath,
            head: object.inventory.head,
            versionCount: versionNames(object.inventory).length,
          })),
          readAt: new Date().toISOString(),
        };

        context.logger.info("Indexed {count} OCFL objects", {
          count: objects.length,
        });
        const handle = await context.writeResource("index", "objects", index);
        return { dataHandles: [handle] };
      },
    },

    validate: {
      description:
        "Validate the storage root and its objects against OCFL 1.1, reporting E/W codes",
      arguments: ValidateArgsSchema,
      execute: async (
        args: z.infer<typeof ValidateArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info: (message: string, properties?: unknown) => void;
            warning: (message: string, properties?: unknown) => void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        context.logger.info(
          "Validating {scope} (fullFixity={fullFixity})",
          {
            scope: args.ids === undefined
              ? "every object in the storage root"
              : `${args.ids.length} requested object(s)`,
            fullFixity: args.fullFixity,
          },
        );

        // One fan-out execution covering every requested object, rather than
        // one method run per object — the model lock is acquired once.
        const result = await validateStorageRoot(
          backendFor(context.globalArgs, context.logger),
          {
            ids: args.ids,
            fullFixity: args.fullFixity,
          },
        );

        const invalid = result.objects.filter((object) => !object.valid);
        const payload: z.infer<typeof ValidationSchema> = {
          storageRoot: result.storageRoot,
          checkedAt: result.checkedAt,
          fullFixity: result.fullFixity,
          valid: result.valid,
          objectCount: result.objects.length,
          invalidCount: invalid.length,
          rootErrors: result.rootErrors,
          rootWarnings: result.rootWarnings,
          objects: result.objects.map((object) => ({
            id: object.id,
            path: object.path,
            valid: object.valid,
            recoverable: object.recoverable,
            errors: object.errors,
            warnings: object.warnings,
          })),
        };

        if (result.valid) {
          context.logger.info(
            "Validated {count} OCFL objects with no errors (fullFixity={fullFixity})",
            { count: result.objects.length, fullFixity: result.fullFixity },
          );
        } else {
          context.logger.warning(
            "Validation found errors in {invalid} of {count} objects",
            { invalid: invalid.length, count: result.objects.length },
          );
        }

        // Written whether or not validation passed: a failing report is the
        // method's product, not a failed execution.
        const handle = await context.writeResource(
          "validation",
          "validation-latest",
          payload,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
