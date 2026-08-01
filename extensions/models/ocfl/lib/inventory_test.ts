import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  bytesEqual,
  checkInventory,
  parseInventory,
  parseSidecar,
  readInventoryVerified,
  serializeInventory,
  sidecarFilename,
  writeInventoryPair,
} from "./inventory.ts";
import { digestBytes } from "./digest.ts";
import { INVENTORY_TYPE_1_1 } from "./types.ts";
import type { StorageBackend } from "./backend/backend.ts";
import { readText } from "./backend/backend.ts";
import {
  BACKEND_KINDS,
  FIXTURE_IDS,
  FIXTURE_PATHS,
  fixtureBackend,
  withEmptyBackend,
} from "./test_util.ts";

const encoder = new TextEncoder();

const SPEC_KEY = FIXTURE_PATHS[FIXTURE_IDS.spec];

function codes(issues: { code: string }[]): string[] {
  return issues.map((issue) => issue.code);
}

function minimalInventory() {
  return {
    id: "urn:test:object",
    type: INVENTORY_TYPE_1_1,
    digestAlgorithm: "sha512" as const,
    head: "v1",
    manifest: { "abc": ["v1/content/a.txt"] },
    versions: {
      v1: {
        created: "2026-07-31T12:00:00Z",
        state: { "abc": ["a.txt"] },
      },
    },
  };
}

Deno.test("fixture inventories parse and verify against their sidecars", async () => {
  const result = await checkInventory(fixtureBackend(), SPEC_KEY, "object");
  assertEquals(result.issues, []);
  assertEquals(result.sidecarVerified, true);
  assertEquals(result.loaded?.inventory.id, FIXTURE_IDS.spec);
  assertEquals(result.loaded?.inventory.head, "v2");
});

Deno.test("root inventory is byte-identical to the head version's (E064)", async () => {
  const root = await readInventoryVerified(fixtureBackend(), SPEC_KEY);
  const head = await readInventoryVerified(fixtureBackend(), `${SPEC_KEY}/v2`);
  assertEquals(bytesEqual(root.bytes, head.bytes), true);
});

Deno.test("unknown inventory keys are rejected (E102)", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...minimalInventory(), extraKey: "nope" }),
  );
  const { inventory, issues } = parseInventory(bytes, "inv");
  assertEquals(inventory, null);
  assertEquals(codes(issues), ["E102"]);
});

Deno.test("an unsupported digestAlgorithm is rejected (E025)", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...minimalInventory(), digestAlgorithm: "md5" }),
  );
  const { issues } = parseInventory(bytes, "inv");
  assertEquals(codes(issues), ["E025"]);
});

Deno.test("a non-RFC3339 created timestamp is rejected (E049)", () => {
  const inventory = minimalInventory();
  inventory.versions.v1.created = "2026-07-31 12:00:00";
  const bytes = new TextEncoder().encode(JSON.stringify(inventory));
  const { issues } = parseInventory(bytes, "inv");
  assertEquals(codes(issues), ["E049"]);
});

Deno.test("a timestamp without a timezone is rejected (E049)", () => {
  const inventory = minimalInventory();
  inventory.versions.v1.created = "2026-07-31T12:00:00";
  const bytes = new TextEncoder().encode(JSON.stringify(inventory));
  assertEquals(codes(parseInventory(bytes, "inv").issues), ["E049"]);
});

Deno.test("a wrong inventory type is reported (E038)", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      ...minimalInventory(),
      type: "https://ocfl.io/1.0/spec/#inventory",
    }),
  );
  const { inventory, issues } = parseInventory(bytes, "inv");
  assertEquals(inventory?.id, "urn:test:object");
  assertEquals(codes(issues), ["E038"]);
});

Deno.test("malformed JSON is reported (E033)", () => {
  const { issues } = parseInventory(new TextEncoder().encode("{nope"), "inv");
  assertEquals(codes(issues), ["E033"]);
});

Deno.test("parseSidecar accepts spaces and tabs, rejects other shapes (E061)", () => {
  assertEquals(parseSidecar("abc123 inventory.json\n", "s").digest, "abc123");
  assertEquals(parseSidecar("abc123\tinventory.json", "s").digest, "abc123");
  assertEquals(parseSidecar("abc123   inventory.json", "s").digest, "abc123");
  assertEquals(codes(parseSidecar("abc123", "s").issues), ["E061"]);
  assertEquals(codes(parseSidecar("abc123 other.json", "s").issues), ["E061"]);
});

for (const kind of BACKEND_KINDS) {
  Deno.test(`[${kind}] writeInventoryPair writes a sidecar matching the exact bytes`, async () => {
    await withEmptyBackend(kind, async (backend) => {
      const bytes = serializeInventory(minimalInventory());
      await writeInventoryPair(backend, "", bytes, "sha512");

      const written = await backend.read("inventory.json");
      assertEquals(written !== null && bytesEqual(written, bytes), true);

      const sidecar = await readText(backend, sidecarFilename("sha512"));
      assertEquals(sidecar, `${digestBytes(bytes, "sha512")} inventory.json\n`);
    });
  });
}

for (const kind of BACKEND_KINDS) {
  Deno.test(`[${kind}] a corrupted sidecar digest is reported (E060)`, async () => {
    await withEmptyBackend(kind, async (backend) => {
      await writeInventoryPair(
        backend,
        "",
        serializeInventory(minimalInventory()),
        "sha512",
      );
      await backend.write(
        sidecarFilename("sha512"),
        encoder.encode(`${"0".repeat(128)} inventory.json\n`),
      );
      const result = await checkInventory(backend, "", "object");
      assertEquals(codes(result.issues), ["E060"]);
      assertEquals(result.sidecarVerified, false);
      // Still loadable — this is the recoverable crash-window condition.
      assertEquals(result.loaded?.inventory.id, "urn:test:object");
      await assertRejects(() => readInventoryVerified(backend, ""));
    });
  });
}

async function renameKey(
  backend: StorageBackend,
  from: string,
  to: string,
): Promise<void> {
  const data = await backend.read(from);
  if (data === null) throw new Error(`no such key: ${from}`);
  await backend.write(to, data);
  await backend.delete(from);
}

for (const kind of BACKEND_KINDS) {
  Deno.test(`[${kind}] a sidecar whose algorithm disagrees is reported (E059)`, async () => {
    await withEmptyBackend(kind, async (backend) => {
      const bytes = serializeInventory(minimalInventory());
      await writeInventoryPair(backend, "", bytes, "sha512");
      await renameKey(
        backend,
        sidecarFilename("sha512"),
        sidecarFilename("sha256"),
      );
      assertEquals(
        codes((await checkInventory(backend, "", "object")).issues),
        ["E059"],
      );
    });
  });

  Deno.test(`[${kind}] a missing sidecar is reported (E058)`, async () => {
    await withEmptyBackend(kind, async (backend) => {
      await backend.write(
        "inventory.json",
        serializeInventory(minimalInventory()),
      );
      assertEquals(
        codes((await checkInventory(backend, "", "object")).issues),
        ["E058"],
      );
    });
  });

  Deno.test(`[${kind}] a missing inventory is reported (E063)`, async () => {
    await withEmptyBackend(kind, async (backend) => {
      assertEquals(
        codes((await checkInventory(backend, "", "object")).issues),
        ["E063"],
      );
    });
  });
}

Deno.test("serializeInventory emits keys in specification order", () => {
  const text = new TextDecoder().decode(serializeInventory(minimalInventory()));
  const keys = Object.keys(JSON.parse(text));
  assertEquals(keys, [
    "id",
    "type",
    "digestAlgorithm",
    "head",
    "manifest",
    "versions",
  ]);
});
