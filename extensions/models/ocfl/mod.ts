/**
 * Swamp model type for an OCFL storage root, on local disk or in S3.
 *
 * `init` creates a conformant root with a layout extension, `list` indexes
 * every object in it, `get` resolves one object's logical paths to the content
 * files that hold them, `export` stages those bytes on local disk, and
 * `create_version` deposits a new version — creating the object too when it
 * does not exist yet, since in OCFL those are the same operation. Validation
 * remains out of scope.
 *
 * Methods are thin: they parse arguments, call into `lib/`, and map the result
 * onto resources. All OCFL knowledge lives in `lib/`, and everything there
 * talks to a storage interface rather than to a filesystem, which is what lets
 * one implementation serve both backends.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { commitVersion, planVersion, type VersionPlan } from "./lib/commit.ts";
import { createStorage } from "./lib/config.ts";
import { digestText } from "./lib/digest.ts";
import {
  DEFAULT_CONCURRENCY,
  type ExportedFile,
  type ExportPlan,
  planExport,
  runExport,
} from "./lib/export.ts";
import { contentDirectoryOf, versionNames } from "./lib/inventory.ts";
import { parseOps } from "./lib/ops.ts";
import {
  FLAT_DIRECT,
  HASHED_N_TUPLE,
  type SupportedLayout,
} from "./lib/layout.ts";
import {
  findObject,
  listObjects,
  type OcflObject,
  openObjectAt,
  resolveState,
  versionFileCount,
} from "./lib/object.ts";
import {
  initStorageRoot,
  openStorageRoot,
  type StorageRoot,
} from "./lib/root.ts";
import { readNamaste } from "./lib/namaste.ts";

/** Global arguments shared by every method. */
const GlobalArgsSchema = z.object({
  storage: z.enum(["local", "s3"]).default("local").describe(
    "Storage backend holding the OCFL storage root",
  ),
  path: z.string().optional().describe(
    "storage=local: absolute path to the OCFL storage root",
  ),
  bucket: z.string().optional().describe(
    "storage=s3: bucket containing the storage root",
  ),
  prefix: z.string().optional().describe(
    "storage=s3: key prefix locating the storage root inside the bucket",
  ),
  endpoint: z.string().optional().describe(
    "storage=s3: S3-compatible endpoint, e.g. a Cloudflare R2 account URL. " +
      "Defaults to AWS S3 in the configured region.",
  ),
  region: z.string().default("auto").describe(
    "storage=s3: signing region. R2 expects 'auto'.",
  ),
  accessKeyId: z.string().optional().meta({ sensitive: true }).describe(
    "storage=s3: access key ID; overrides AWS_ACCESS_KEY_ID. Wire with a " +
      "vault.get(...) expression to source it from a vault.",
  ),
  secretAccessKey: z.string().optional().meta({ sensitive: true }).describe(
    "storage=s3: secret access key; overrides AWS_SECRET_ACCESS_KEY. Wire " +
      "with a vault.get(...) expression to source it from a vault.",
  ),
  sessionToken: z.string().optional().meta({ sensitive: true }).describe(
    "storage=s3: session token for temporary credentials; overrides " +
      "AWS_SESSION_TOKEN.",
  ),
  forcePathStyle: z.boolean().default(true).describe(
    "storage=s3: address the bucket as a path segment rather than a " +
      "subdomain. Required by R2 and most S3-compatible services.",
  ),
});

/** Validated global arguments. */
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Summary of the storage root itself. Exported for conformance tests. */
export const RootSchema = z.object({
  backend: z.string(),
  location: z.string(),
  specVersion: z.string(),
  layout: z.string().nullable(),
  layoutDescription: z.string().nullable(),
  layoutSupported: z.boolean(),
  objectCount: z.number().int(),
  readAt: z.iso.datetime(),
});

/** One version's provenance within an object snapshot. */
const VersionSummarySchema = z.object({
  name: z.string(),
  created: z.string(),
  message: z.string().nullable(),
  userName: z.string().nullable(),
  userAddress: z.string().nullable(),
  fileCount: z.number().int(),
});

/** One logical file resolved to the content that holds it. */
const StateEntrySchema = z.object({
  logicalPath: z.string(),
  digest: z.string(),
  contentPaths: z.array(z.string()),
});

/** Snapshot of one OCFL object at one version. Exported for conformance tests. */
export const ObjectSchema = z.object({
  id: z.string(),
  path: z.string(),
  head: z.string(),
  version: z.string(),
  specVersion: z.string(),
  digestAlgorithm: z.string(),
  contentDirectory: z.string(),
  versionCount: z.number().int(),
  versions: z.array(VersionSummarySchema),
  state: z.array(StateEntrySchema),
  readAt: z.iso.datetime(),
});

/** One exported file, as actually placed on disk. */
const ExportedFileSchema = z.object({
  logicalPath: z.string(),
  destPath: z.string(),
  digest: z.string(),
  size: z.number().int(),
  source: z.enum(["fetched", "existing", "copied"]),
  verified: z.boolean(),
});

/**
 * Manifest of one export. Exported for conformance tests.
 *
 * This is what makes an export usable from a workflow: the next step reads
 * `destPath` from here rather than reconstructing it from `dest` and a logical
 * path.
 */
export const ExportSchema = z.object({
  id: z.string(),
  path: z.string(),
  version: z.string(),
  dest: z.string(),
  fileCount: z.number().int(),
  byteCount: z.number().int(),
  files: z.array(ExportedFileSchema),
  exportedAt: z.iso.datetime(),
});

/**
 * Build a storage-safe instance name.
 *
 * Ids are URIs but instance names become storage paths, so they are sanitized.
 * Sanitization is lossy — two ids differing only in stripped characters would
 * collide — so a digest suffix makes the mapping injective again.
 *
 * @param label Resource-spec prefix, e.g. `"object"`.
 * @param id Id shown in the name.
 * @param key Value the digest suffix is taken over. Defaults to `id`.
 */
function instanceName(label: string, id: string, key: string = id): string {
  const sanitized = id
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${label}-${sanitized}-${digestText(key, "sha256").slice(0, 8)}`;
}

/** Instance name for an object id. */
export function objectInstanceName(id: string): string {
  return instanceName("object", id);
}

/**
 * Instance name for one object staged at one destination.
 *
 * The digest covers the destination as well as the id, so re-exporting to the
 * same directory updates its manifest in place while exporting the same object
 * to two directories yields two resources rather than one silently replacing
 * the other.
 */
export function exportInstanceName(id: string, dest: string): string {
  return instanceName("export", id, `${id}\n${dest}`);
}

/** Map an opened object onto the `object` resource shape. */
export function objectSnapshot(
  object: OcflObject,
  version: string,
): z.infer<typeof ObjectSchema> {
  const inventory = object.inventory;
  return {
    id: inventory.id,
    path: object.path,
    head: inventory.head,
    version,
    specVersion: object.specVersion,
    digestAlgorithm: inventory.digestAlgorithm,
    contentDirectory: contentDirectoryOf(inventory),
    versionCount: versionNames(inventory).length,
    versions: versionNames(inventory).map((name) => {
      const block = inventory.versions[name];
      return {
        name,
        created: block.created,
        message: block.message ?? null,
        userName: block.user?.name ?? null,
        userAddress: block.user?.address ?? null,
        fileCount: versionFileCount(inventory, name),
      };
    }),
    state: resolveState(inventory, version),
    readAt: new Date().toISOString(),
  };
}

/** Map a finished export onto the `export` resource shape. */
export function exportSnapshot(
  plan: ExportPlan,
  files: ExportedFile[],
): z.infer<typeof ExportSchema> {
  return {
    id: plan.id,
    path: plan.objectPath,
    version: plan.version,
    dest: plan.dest,
    fileCount: files.length,
    byteCount: files.reduce((total, file) => total + file.size, 0),
    files,
    exportedAt: new Date().toISOString(),
  };
}

/** Map an opened storage root onto the `root` resource shape. */
export function rootSnapshot(
  root: StorageRoot,
  objectCount: number,
): z.infer<typeof RootSchema> {
  return {
    backend: root.storage.backend,
    location: root.storage.location,
    specVersion: root.specVersion,
    layout: root.layout.declared,
    layoutDescription: root.layout.description ?? null,
    layoutSupported: root.layout.layout !== undefined,
    objectCount,
    readAt: new Date().toISOString(),
  };
}

/** Context fields the methods use. */
type MethodContext = {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  logger: {
    info: (message: string, properties?: unknown) => void;
    warning: (message: string, properties?: unknown) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

const InitArgsSchema = z.object({
  layout: z.enum([HASHED_N_TUPLE, FLAT_DIRECT]).default(HASHED_N_TUPLE)
    .describe("Storage layout extension the new root will declare"),
  description: z.string().optional().describe(
    "Description recorded in ocfl_layout.json",
  ),
  digestAlgorithm: z.enum(["sha256", "sha512"]).default("sha256").describe(
    "0004 only: algorithm applied to object ids to derive their paths",
  ),
  tupleSize: z.number().int().min(0).max(32).default(3).describe(
    "0004 only: characters per intermediate directory name",
  ),
  numberOfTuples: z.number().int().min(0).max(32).default(3).describe(
    "0004 only: number of intermediate directories",
  ),
  shortObjectRoot: z.boolean().default(false).describe(
    "0004 only: name the object root with the unused digest remainder only",
  ),
});

const ListArgsSchema = z.object({});

const GetArgsSchema = z.object({
  id: z.string().min(1).describe("Object id to resolve"),
  version: z.string().optional().describe(
    "Version to resolve state for; defaults to the object's head",
  ),
});

const ExportArgsSchema = z.object({
  id: z.string().min(1).describe("Object id to export content from"),
  dest: z.string().min(1).describe(
    "Absolute path to the local directory content is staged in, created if " +
      "it does not exist. It stands in for the object root: logical paths " +
      "are reconstructed beneath it, subdirectories and all.",
  ),
  version: z.string().optional().describe(
    "Version to export; defaults to the object's head",
  ),
  only: z.string().optional().describe(
    "Export this one logical path instead of the whole version state. It " +
      "still lands at its full logical path under 'dest', not at the top.",
  ),
  concurrency: z.number().int().min(1).max(64).default(DEFAULT_CONCURRENCY)
    .describe("Files to download simultaneously"),
});

const CreateVersionArgsSchema = z.object({
  id: z.string().min(1).describe(
    "Object id. Created if it does not exist yet, otherwise extended.",
  ),
  ops: z.union([z.array(z.string()), z.string()]).describe(
    "Operations building the new version's state, applied in order: " +
      "'add:<source>:<logicalPath>', 'remove:<logicalPath>', " +
      "'rename:<from>:<to>'. Sources are absolute local paths. Escape a " +
      "literal colon as '\\:'. Pass as ops:json=[...], a YAML list via " +
      "--input-file, or one newline-delimited string.",
  ),
  version: z.number().int().positive().optional().describe(
    "Version number this call expects to create, unpadded (1 for a new " +
      "object). Asserted against the object's actual head before anything is " +
      "written; omit to take head+1.",
  ),
  message: z.string().optional().describe(
    "Message recorded in the new version block",
  ),
  userName: z.string().min(1).describe(
    "Name of the agent recorded against the new version",
  ),
  userAddress: z.string().min(1).describe(
    "Address of that agent, ideally a mailto: or ORCID URI",
  ),
  digestAlgorithm: z.enum(["sha512", "sha256"]).optional().describe(
    "New objects only: inventory digest algorithm. Defaults to sha512; an " +
      "existing object's algorithm is fixed and cannot be changed.",
  ),
  contentDirectory: z.string().optional().describe(
    "New objects only: content directory name. Defaults to 'content'; it is " +
      "fixed at v1 and never changes.",
  ),
  allowNoChange: z.boolean().default(false).describe(
    "Permit a version whose state is identical to its predecessor's. Legal " +
      "OCFL, but almost always a mistake, so it is refused by default.",
  ),
  dryRun: z.boolean().default(false).describe(
    "Plan the version and report it without writing anything",
  ),
});

/** Model definition for an OCFL storage root. */
export const model = {
  type: "@crudec/ocfl-repository",
  version: "2026.08.08.1",
  description:
    "Initialize, index, and resolve content in an OCFL storage root on local disk or S3",
  globalArguments: GlobalArgsSchema,
  resources: {
    "root": {
      description: "Summary of the OCFL storage root",
      schema: RootSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "object": {
      description: "One OCFL object's versions and resolved content paths",
      schema: ObjectSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    "export": {
      description:
        "Manifest of one object's content staged in a local directory",
      schema: ExportSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  checks: {
    "storage-root-declaration": {
      description:
        "The configured storage root is either absent, so init can create it, or carries a valid OCFL conformance declaration",
      labels: ["live"],
      execute: async (context: {
        globalArgs: GlobalArgs;
        signal?: AbortSignal;
      }) => {
        let storage;
        try {
          storage = createStorage(context.globalArgs, context.signal);
        } catch (error) {
          return {
            pass: false,
            errors: [error instanceof Error ? error.message : String(error)],
          };
        }

        try {
          // Absent is fine — `init` is the method that creates a root. Present
          // but malformed is not, and readNamaste throws in exactly that case.
          await readNamaste(storage, "", "root");
          return { pass: true };
        } catch (error) {
          return {
            pass: false,
            errors: [error instanceof Error ? error.message : String(error)],
          };
        }
      },
    },
  },
  methods: {
    init: {
      description:
        "Create an OCFL 1.1 storage root with a layout extension, or accept one that already matches",
      arguments: InitArgsSchema,
      execute: async (
        args: z.infer<typeof InitArgsSchema>,
        context: MethodContext,
      ) => {
        const storage = createStorage(context.globalArgs, context.signal);
        context.logger.info(
          "Initializing OCFL storage root at {location} with layout {layout}",
          { location: storage.location, layout: args.layout },
        );
        const { root, created } = await initStorageRoot(storage, {
          layout: args.layout as SupportedLayout,
          description: args.description,
          layoutConfig: {
            digestAlgorithm: args.digestAlgorithm,
            tupleSize: args.tupleSize,
            numberOfTuples: args.numberOfTuples,
            shortObjectRoot: args.shortObjectRoot,
          },
        });

        if (created) {
          context.logger.info(
            "Initialized OCFL {specVersion} storage root at {location} with layout {layout}",
            {
              specVersion: root.specVersion,
              location: root.storage.location,
              layout: args.layout,
            },
          );
        } else {
          context.logger.info(
            "Storage root at {location} already declares layout {layout}; nothing to do",
            { location: root.storage.location, layout: args.layout },
          );
        }

        const handle = await context.writeResource(
          "root",
          "root",
          rootSnapshot(root, (await listObjects(root)).length),
        );
        return { dataHandles: [handle] };
      },
    },

    list: {
      description:
        "Index every object in the storage root, writing one resource per object",
      arguments: ListArgsSchema,
      execute: async (
        _args: z.infer<typeof ListArgsSchema>,
        context: MethodContext,
      ) => {
        const storage = createStorage(context.globalArgs, context.signal);
        context.logger.info("Indexing OCFL storage root at {location}", {
          location: storage.location,
        });
        const root = await openStorageRoot(storage);
        const objects = await listObjects(root);

        if (root.layout.layout === undefined && root.layout.declared !== null) {
          context.logger.warning(
            "Storage root declares layout {layout}, which this model cannot " +
              "compute paths for; objects were found by scanning instead",
            { layout: root.layout.declared },
          );
        }

        // One execution writes every object, so the per-model lock is taken
        // once rather than once per object.
        const handles = [
          await context.writeResource(
            "root",
            "root",
            rootSnapshot(root, objects.length),
          ),
        ];
        for (const object of objects) {
          handles.push(
            await context.writeResource(
              "object",
              objectInstanceName(object.inventory.id),
              objectSnapshot(object, object.inventory.head),
            ),
          );
        }

        context.logger.info(
          "Indexed {count} OCFL object(s) in {location}",
          { count: objects.length, location: root.storage.location },
        );
        return { dataHandles: handles };
      },
    },

    get: {
      description:
        "Resolve one object's logical paths to the content files holding them",
      arguments: GetArgsSchema,
      execute: async (
        args: z.infer<typeof GetArgsSchema>,
        context: MethodContext,
      ) => {
        const storage = createStorage(context.globalArgs, context.signal);
        context.logger.info("Resolving OCFL object {id} in {location}", {
          id: args.id,
          location: storage.location,
        });
        const root = await openStorageRoot(storage);
        const object = await findObject(root, args.id);
        const version = args.version ?? object.inventory.head;
        const snapshot = objectSnapshot(object, version);

        context.logger.info(
          "Resolved {id} at {version}: {files} logical file(s) under {path}",
          {
            id: snapshot.id,
            version,
            files: snapshot.state.length,
            path: snapshot.path,
          },
        );

        const handle = await context.writeResource(
          "object",
          objectInstanceName(args.id),
          snapshot,
        );
        return { dataHandles: [handle] };
      },
    },

    export: {
      description:
        "Stage one object's content in a local directory, verifying every file as it is written",
      arguments: ExportArgsSchema,
      execute: async (
        args: z.infer<typeof ExportArgsSchema>,
        context: MethodContext,
      ) => {
        const storage = createStorage(context.globalArgs, context.signal);
        const root = await openStorageRoot(storage);
        const plan = await planExport(root, {
          id: args.id,
          dest: args.dest,
          version: args.version,
          only: args.only,
        });

        context.logger.info(
          "Exporting {files} file(s) from {id} at {version} to {dest}",
          {
            files: plan.entries.length,
            id: plan.id,
            version: plan.version,
            dest: plan.dest,
          },
        );

        const files = await runExport(root, plan, {
          concurrency: args.concurrency,
          logger: context.logger,
        });

        const fetched = files.filter((file) => file.source === "fetched");
        context.logger.info(
          "Exported {id} at {version} to {dest}: {fetched} file(s) " +
            "downloaded, {existing} already present, {copied} deduplicated, " +
            "{bytes} byte(s) on disk",
          {
            id: plan.id,
            version: plan.version,
            dest: plan.dest,
            fetched: fetched.length,
            existing: files.filter((file) => file.source === "existing").length,
            copied: files.filter((file) => file.source === "copied").length,
            bytes: files.reduce((total, file) => total + file.size, 0),
          },
        );

        const handle = await context.writeResource(
          "export",
          exportInstanceName(plan.id, plan.dest),
          exportSnapshot(plan, files),
        );
        return { dataHandles: [handle] };
      },
    },

    create_version: {
      description:
        "Create a new version of an OCFL object, creating the object itself when it does not exist yet",
      arguments: CreateVersionArgsSchema,
      execute: async (
        args: z.infer<typeof CreateVersionArgsSchema>,
        context: MethodContext,
      ) => {
        const storage = createStorage(context.globalArgs, context.signal);
        const root = await openStorageRoot(storage);
        const plan = await planVersion(root, {
          id: args.id,
          ops: parseOps(args.ops),
          version: args.version,
          message: args.message,
          userName: args.userName,
          userAddress: args.userAddress,
          digestAlgorithm: args.digestAlgorithm,
          contentDirectory: args.contentDirectory,
          allowNoChange: args.allowNoChange,
        });

        context.logger.info(
          "Planned {version} of {id} at {path}: {files} logical file(s), " +
            "{writes} content file(s) to write, {deduped} deduplicated",
          {
            version: plan.version,
            id: plan.id,
            path: plan.objectPath,
            files: plan.logicalPaths.length,
            writes: plan.content.length,
            deduped: plan.logicalPaths.length - plan.content.length,
          },
        );
        for (const entry of plan.content) {
          context.logger.info("  {source} -> {contentPath}", {
            source: entry.source,
            contentPath: entry.contentPath,
          });
        }

        if (args.dryRun) {
          context.logger.info(
            "Dry run: nothing was written. {summary}",
            { summary: planSummary(plan) },
          );
          return { dataHandles: [] };
        }

        await commitVersion(root, plan, { logger: context.logger });

        // Re-open rather than trusting the plan: this verifies the conformance
        // declaration, re-reads the inventory, and checks it against the
        // sidecar that was just written.
        const object = await openObjectAt(root, plan.objectPath);
        context.logger.info(
          "Committed {version} of {id} ({files} logical file(s)) at {path}",
          {
            version: plan.version,
            id: plan.id,
            files: plan.logicalPaths.length,
            path: plan.objectPath,
          },
        );

        const handle = await context.writeResource(
          "object",
          objectInstanceName(args.id),
          objectSnapshot(object, plan.version),
        );
        return { dataHandles: [handle] };
      },
    },
  },
};

/** One-line description of a plan, for the dry-run log. */
function planSummary(plan: VersionPlan): string {
  const bytes = plan.content.reduce((total, entry) => total + entry.size, 0);
  return `${plan.isNew ? "create" : "update"} ${plan.id} as ${plan.version} ` +
    `(${plan.digestAlgorithm}, ${plan.content.length} content file(s), ` +
    `${bytes} byte(s) to transfer)`;
}
