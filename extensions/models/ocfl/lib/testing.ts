/**
 * Shared fixtures for the library tests.
 *
 * The write path is what most of this builds, but the read-path tests need
 * objects to read, so they build them the same way.
 *
 * Test-only. Nothing here is reachable from `mod.ts`, so it never enters the
 * extension bundle, and the filename does not match Deno's test-file patterns,
 * so importing it does not register anybody else's tests twice.
 *
 * @module
 */
import { commitVersion, planVersion } from "./commit.ts";
import { HASHED_N_TUPLE } from "./layout.ts";
import { parseOps } from "./ops.ts";
import { initStorageRoot, type StorageRoot } from "./root.ts";
import { LocalStorage } from "./storage/local.ts";
import { MemoryStorage } from "./storage/memory.ts";
import type { Storage } from "./storage/types.ts";

/** Backends every write-path test runs against. */
export const BACKENDS = ["memory", "local"] as const;

/** Which backend a harness is built on. */
export type Backend = typeof BACKENDS[number];

/** A disposable storage root plus scratch space outside it. */
export type Harness = {
  root: StorageRoot;
  /** Write a source file outside the storage root, and return its path. */
  source(name: string, contents: string): Promise<string>;
  /** Make a temp directory that is removed on cleanup. */
  scratch(prefix?: string): Promise<string>;
  cleanup(): Promise<void>;
};

/** Build a storage root on `backend`, with everything it creates tracked. */
export async function harness(backend: Backend): Promise<Harness> {
  const sourceDir = await Deno.makeTempDir({ prefix: "ocfl-src-" });
  const dirs = [sourceDir];

  let storage: Storage;
  if (backend === "memory") {
    storage = new MemoryStorage();
  } else {
    const rootDir = await Deno.makeTempDir({ prefix: "ocfl-root-" });
    dirs.push(rootDir);
    storage = new LocalStorage(rootDir);
  }

  const { root } = await initStorageRoot(storage, { layout: HASHED_N_TUPLE });
  return {
    root,
    async source(name, contents) {
      const path = `${sourceDir}/${name}`;
      await Deno.writeTextFile(path, contents);
      return path;
    },
    async scratch(prefix = "ocfl-scratch-") {
      const dir = await Deno.makeTempDir({ prefix });
      dirs.push(dir);
      return dir;
    },
    async cleanup() {
      for (const dir of dirs) {
        await Deno.remove(dir, { recursive: true }).catch(() => {});
      }
    },
  };
}

/** Provenance every test commit carries, since `planVersion` requires it. */
export const USER = {
  userName: "Test Agent",
  userAddress: "mailto:test@example.com",
};

/**
 * Plan and commit one version, with the required provenance filled in.
 *
 * Shared rather than copied per test file: it tracks `planVersion`'s required
 * arguments, so a second copy would drift the moment those change.
 */
export async function commit(
  root: StorageRoot,
  id: string,
  ops: string[],
  options: Record<string, unknown> = {},
) {
  const plan = await planVersion(root, {
    id,
    ops: parseOps(ops),
    ...USER,
    ...options,
  });
  await commitVersion(root, plan);
  return plan;
}

/** Register one test per backend, each with a fresh harness. */
export function forEachBackend(
  name: string,
  run: (harness: Harness) => Promise<void>,
): void {
  for (const backend of BACKENDS) {
    Deno.test(`${name} (${backend})`, async () => {
      const context = await harness(backend);
      try {
        await run(context);
      } finally {
        await context.cleanup();
      }
    });
  }
}
