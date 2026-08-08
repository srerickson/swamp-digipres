/**
 * Swamp model type for an OCFL storage root, on local disk or in S3.
 *
 * This iteration covers the read path plus storage root initialization:
 * `init` creates a conformant root with a layout extension, `list` indexes
 * every object in it, and `get` resolves one object's logical paths to the
 * content files that hold them. Nothing here writes an OCFL object — ingest,
 * new versions, and validation are deliberately out of scope.
 *
 * Methods are thin: they parse arguments, call into `lib/`, and map the result
 * onto resources. All OCFL knowledge lives in `lib/`, and everything there
 * talks to a storage interface rather than to a filesystem, which is what lets
 * one implementation serve both backends.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { createStorage } from "./lib/config.ts";
import { digestText } from "./lib/digest.ts";
import { contentDirectoryOf, versionNames } from "./lib/inventory.ts";
import {
  FLAT_DIRECT,
  HASHED_N_TUPLE,
  type SupportedLayout,
} from "./lib/layout.ts";
import {
  findObject,
  listObjects,
  type OcflObject,
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

/**
 * Build a storage-safe instance name for an object id.
 *
 * Ids are URIs but instance names become storage paths, so they are sanitized.
 * Sanitization is lossy — two ids differing only in stripped characters would
 * collide — so a digest suffix makes the mapping injective again.
 */
export function objectInstanceName(id: string): string {
  const sanitized = id
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `object-${sanitized}-${digestText(id, "sha256").slice(0, 8)}`;
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
  },
};
