# Implementation Plan: Native TypeScript OCFL Client as a Swamp Extension Model Type

Produced by: Fable (Plan subagent), 2026-07-31. Grounded in the `swamp` extension guide,
the OCFL 1.1 spec (`.claude/skills/ocfl/references/ocfl-spec-1.1.md`), and the ground-truth
fixture at `testdata/fixtures/ocfl-root` (3 objects under `0004-hashed-n-tuple-storage-layout`,
sha512 object digests, sha256/3x3 layout config, `urn:swamp-premis:*` ids, non-padded versions,
second-granularity RFC 3339 timestamps with numeric offsets).

## 0. Layout on disk

```
extensions/models/ocfl/
├── mod.ts                  # export const model — the ONLY file with a model export
└── lib/
    ├── types.ts            # zod schemas + inferred types (Inventory, Version, User, ValidationIssue)
    ├── digest.ts            # streaming sha512/sha256 (+ legacy fixity algs later)
    ├── namaste.ts           # 0=ocfl_1.1 / 0=ocfl_object_1.1 read/write/verify
    ├── layout.ts             # storage layout resolution (0004 first)
    ├── paths.ts              # logical/content path safety
    ├── inventory.ts          # parse, serialize, sidecar, byte-identity helpers
    ├── object.ts             # locate + read one object (id-verified)
    ├── state.ts              # staged-tree walker, dedup, next-state builder
    ├── commit.ts             # atomic version writer (ingest + update unified)
    ├── validate.ts           # structural + full-fixity validator
    └── errors.ts             # OcflError / ValidationIssue keyed by E###/W###
```

Swamp discovers only files exporting `const model`; `lib/*` helpers and colocated `lib/*_test.ts`
files are ignored by the loader, so the OCFL library stays cleanly separable from the wrapper.
All imports are static and relative; the only external import is `npm:zod@4` in
`mod.ts`/`types.ts`. Digests use **`node:crypto` `createHash`** (built into Deno, streams,
supports sha512/sha256/sha1/md5) — no npm dependency, no Web Crypto non-streaming limitation,
nothing for the bundler to inline. Validation tooling: `~/.swamp/deno/deno check` / `test`
(resolve via `swamp doctor extensions --json` → `denoPath`).

## 1. Module breakdown (OCFL core, wrapper-independent)

### `types.ts`
- Zod schemas: `UserSchema` (`name` required E054, `address` optional W008/W009),
  `VersionSchema` (`created` RFC 3339 with tz + seconds granularity E049; `state`; optional
  `message`/`user` W007), `InventorySchema` (`id` E036/E037, `type` E038, `digestAlgorithm`
  enum `sha512|sha256` E025, `head` E040, `manifest` E041, `versions`, optional
  `contentDirectory`, optional `fixity` §3.5.4). Use `.strict()` objects so unknown keys fail —
  implements E102 directly at parse time.
- `ValidationIssue = { code: "E###"|"W###", severity, path, message }`.
- Digest values normalized helper type: comparisons always via `lowercase(a) === lowercase(b)`
  (§3.4 non-normative note, E096/E097) but original casing preserved for byte-identity of
  inventories.

### `digest.ts`
- `digestFile(path, alg): Promise<string>` — stream file through `createHash`, hex lowercase
  output (E029–E031).
- `digestBytes(bytes, alg)` for inventory sidecars.
- `digestsEqual(a, b)` — case-insensitive (E096/E097).
- Later phase: md5/sha1/blake2b for the `fixity` block (E026/E027; blake2b needs a decision —
  `node:crypto` supports `blake2b512` on OpenSSL-backed builds; verify under Deno or mark
  unsupported-and-ignored per E028).

### `namaste.ts`
- `readNamaste(dir)` → `{kind: "root"|"object", version}`; verifies exactly one
  `0=ocfl[_object]_N.M` file and exact content `dvalue\n` (E002–E007 object, E075–E080 root).
- `writeObjectNamaste(dir, "1.1")` for commit.

### `layout.ts`
- Interface: `StorageLayout { name: string; resolve(id: string): string }` (E083 deterministic
  mapping).
- `loadLayout(root)` — read `ocfl_layout.json` (E070/E071), then `extensions/<name>/config.json`;
  fall back to namaste-walk discovery (scan for `0=ocfl_object_*`) when layout is absent — the
  walk doubles as the `list()` engine and the validator's "find every object" pass.
- Implement `0004-hashed-n-tuple-storage-layout`: digest the id with `config.digestAlgorithm`
  (fixture: sha256), split into `numberOfTuples` tuples of `tupleSize` (fixture: 3×3), object
  dir = full digest (or truncated remainder if `shortObjectRoot`). Verified against fixture:
  sha256(`urn:swamp-premis:ocfl-spec`) = `5b825953...` → `5b8/259/53a/5b8259…c0`. ✓ matches
  on-disk layout.
- **Effort to add others:** `0002-flat-direct` is trivial (id = dirname, plus id-charset check);
  `0003-hash-and-id-n-tuple` reuses the tuple splitter but the leaf is a percent-encoded id
  (needs the extension's encoding table and a max-length truncation rule). Both are ~50-line
  additional `StorageLayout` impls behind the same interface — deferred, not architectural.

### `paths.ts`
- `validateLogicalPath` / `validateContentPath`: split on `/`, reject `.`/`..`/empty elements,
  reject leading/trailing slash (E051–E053 logical, E098–E100 content).
- `checkNoPrefixConflicts(paths)`: sort + adjacent prefix check with `/` boundary (E095 within a
  version's state, E101 within manifest).
- `contentDirectory` name checks: no `/`, not `.`/`..` (E017/E018/E108).

### `inventory.ts`
- `parseInventory(bytes)` → typed inventory + raw bytes retained.
- `readInventoryVerified(dir, alg?)` — read `inventory.json`, read sidecar
  `inventory.json.<alg>` (E058/E059), parse `DIGEST inventory.json` format (E060/E061), verify
  digest of the bytes.
- `serializeInventory(inv)` → canonical bytes used for **both** the version copy and the root
  copy — root inventory is a byte copy of head's, never re-serialized (E064; pitfall:
  whitespace/key-order drift).
- `writeInventoryPair(dir, bytes, alg)` — write `inventory.json`, then compute digest of those
  exact bytes, then write sidecar **last** (E062).

### `object.ts`
- `locateObject(root, layout, id)` — resolve path, verify namaste, read+verify root inventory,
  and **confirm `inventory.id === requested id`** (never trust the path — skill "Locate an
  object").
- `readObject(root, id)` → `{ path, inventory }`; `getVersionState(inv, versionName?)` resolves a
  version's state via the manifest.

### `state.ts`
- `walkSource(sourcePath)` — recursive walk producing `{logicalPath, absPath}`; **reject
  symlinks** (E090) and empty dirs (E024 has no representation in state); apply `paths.ts`
  validation to every logical path.
- `buildNextState(prevInventory, stagedFiles, alg)` — digest each staged file; for each,
  case-insensitive lookup in existing manifest: hit → reuse existing digest key (content dedup,
  no new content file); miss → schedule copy to `vN+1/<contentDirectory>/<logicalPath>` with
  manifest path using the **actual version directory name** (E014). Returns
  `{ state, newContent: [{src, contentPath, digest}], changed: boolean }`. Semantics:
  **full-state replacement** — `sourcePath` is the complete desired logical tree; paths absent
  from it are logically deleted (the OCFL-native delete; skill "Delete: logical deletion").

### `commit.ts` — atomic version writer
Unified create-or-update, mirroring `ocfl commit`:
1. Resolve object path via layout. If absent → ingest (`v1`); intermediate dirs must contain no
   files (E084). If present → `locateObject` (id check), verify sidecar, determine next version
   name **following the object's existing convention** (padded width detection; E011–E013; new
   objects use non-padded `v1` per W001).
2. Build next state via `state.ts`; carry **all prior `versions` blocks forward byte-for-byte
   from the parsed head inventory** (E066/W011) — never rebuild them.
3. Stage the whole new version directory in a temp dir (`vN+1/content/...` copies →
   `vN+1/inventory.json` + sidecar) on the **same filesystem** as the object root so the final
   move is an atomic `rename(2)`.
4. **Head re-verification**: immediately before finalizing, re-read the root sidecar and confirm
   `head` hasn't moved (OCFL has no locking; skill Update step 7). Abort with a typed conflict
   error if it has.
5. Finalize order (skill Update step 6): move `vN+1` into the object root → overwrite root
   `inventory.json` → write root sidecar last. For ingest: stage the entire object root and
   `rename` it into the layout path in one move (namaste, v1, root inventory all land together —
   skill Ingest step 4).
6. `created`: RFC 3339 UTC `Z`, second granularity (E049; matches W-conformant fixture style).
- Refuse no-op commits (`changed === false`) by default — flagged as an open question below.

### `validate.ts`
Two tiers, matching the skill's "cheapest first" ordering, each check emitting
`ValidationIssue`s rather than throwing, so one object's report is complete:
- **Structural** (default): root namaste (E069, E075–E080); per object: object namaste
  (E001–E007), inventory parse + required keys + no unknown keys (E033–E048, E102), sidecar
  verification for every inventory copy (E058–E061), version sequence `v1..head` continuous and
  convention-consistent (E008–E013, E104, E105), root inventory byte-identical to head version's
  (E064), every state digest resolves in manifest (E050), every manifest content path exists on
  disk and every file under each `content/` is in the manifest (E023, E092), no stray files in
  object root/version dirs (E001, E015), path safety (E051–E053, E095, E098–E101),
  digest-uniqueness regardless of case (E096/E097), prior-version inventories agree on prior
  states (E066, W011), storage-hierarchy checks: no files in intermediate dirs (E072/E084), no
  empty dirs (E073).
- **Full fixity** (opt-in `fullFixity: true`): recompute the digest of every manifest content
  path against the manifest key, plus every `fixity` block entry (E093) for supported algorithms
  (unsupported ignored, E028). Separately schedulable by design — it's the expensive pass.

## 2. Swamp model wrapper (`mod.ts`)

```
type: "@<collective>/ocfl-repository"        # collective TBD — ask user (swamp auth whoami)
globalArguments: z.object({
  storageRoot: z.string(),                   # absolute path to the OCFL storage root
  digestAlgorithm: z.enum(["sha512","sha256"]).default("sha512"),  # for NEW objects only
})
resources:
  object:      trimmed inventory snapshot (schema below), lifetime infinite, gc ~10
  validation:  batch result { checkedAt, fullFixity, results: [{id, valid, errors[], warnings[]}] }
  index:       output of list() — { objects: [{id, path, head}] }
```

All four methods are **thin wrappers** — parse args, call `lib/`, map results to
`writeResource`, throw before writing on failure (per the model API error-handling rule):

| Method | Arguments (zod) | Library calls | Output writes |
|---|---|---|---|
| `commit` | `{ id, sourcePath, message, user: {name, email} }` | `layout.loadLayout` → `commit.commit()` → `object.readObject` (re-read what landed) | `writeResource("object", instanceName(id), snapshot)` |
| `get` | `{ id, version? }` | `object.locateObject` + snapshot builder | same as above |
| `list` | `{}` | layout walk / namaste scan | `writeResource("index", "objects", …)` |
| `validate` | `{ ids?: string[], fullFixity?: boolean }` | fan-out inside one execution over all (or listed) objects, `validate.validateObject` each, sequentially | `writeResource("validation", "latest", batch)` — single fan-out write, honoring the repo's per-model-lock rule |

Object snapshot schema (`object` resource): `{ id, head, digestAlgorithm, path, versions:
[{name, created, message?, user?, fileCount}], manifest: [{digest, contentPaths, logicalPaths}] }`
— fields declared explicitly (not passthrough) so downstream CEL (`data.latest(...).attributes.head`)
validates.

**Instance-name sanitization:** ids are URIs (`urn:swamp-premis:ocfl-spec`); instance names map
to storage paths and must be unique across specs. Plan: `"object-" + sanitize(id) + "-" +
first8(sha256(id))` — spec-name prefix avoids cross-spec collisions, digest suffix makes
sanitization collision-proof (two ids differing only in stripped characters).

`user.email` maps to OCFL `user.address` as `mailto:<email>` (W009). `commit` also logs the
head→new-head transition via `context.logger`. No pre-flight `checks` in MVP beyond an optional
cheap one: storage root exists and has a valid root namaste (labeled so it can be skipped).

## 3. Test matrix

Two fixture strategies:
- **Read-path**: run directly against `testdata/fixtures/ocfl-root` (never mutated; it exercises
  v2-adds-file, v2-modifies-file, single-version, and the 0004 layout with sha256/3/3 config).
- **Write-path & negative**: `Deno.makeTempDir()` per test; write-path tests build roots from
  scratch; negative validator tests **copy** the checked-in fixture into the temp dir and
  corrupt one thing per test.

### Per-invariant matrix (invariant numbers = the ocfl skill's "Invariants automations must never violate")

| # | Invariant (spec codes) | Test(s) |
|---|---|---|
| 1 | Version dirs immutable | `commit` v2 into temp root; snapshot v1 tree (paths+digests+mtimes) before/after → identical. Unit: `commit.ts` throws if computed content path targets an existing `vN`. |
| 2 | Root inventory = head copy (E064) | After commit: byte-compare root `inventory.json` vs `vN/inventory.json`. Validator: rewrite root inventory with re-serialized (key-reordered) JSON → must flag E064 even though semantically equal. |
| 3 | Sidecar written last, matches final bytes (E062, E060/E061) | Unit on `writeInventoryPair`: sidecar digest == digest of written bytes, format `DIGEST inventory.json\n`. Crash-safety: inject a failure hook between finalize steps in `commit.ts` (test-only callback) → interrupted commit leaves the previous consistent state readable and re-validatable (staged temp dir orphaned, never a half-written root inventory+sidecar pair except in the final 2-file window, which the test documents). |
| 4 | Prior version blocks carried forward (E066, W011) | Commit v3 in temp root; deep-equal `versions.v1/v2` against pre-commit inventory. Validator: fixture-copy with mutated prior `state` in root inventory vs `v1/inventory.json` → E066; mutated `message` only → W011. |
| 5 | Version naming fixed at v1 (E011–E013, E104, E105, E009/E010) | Build temp object with `v0001`; `commit` must produce `v0002` (convention detection). Validator: root with `v1,v3` → E010; mixed `v1,v02` → E012; `v10000` in 5-digit padded object → E011. |
| 6 | Case-insensitive digests, unique per block (E096/E097) | `state.ts`: staged file whose digest exists uppercase in manifest → dedup (no `newContent`). Validator: manifest containing the same digest twice in different case → E096; same in fixity block → E097. |
| 7 | Path safety (E051–E053, E095, E098–E101) | Pure unit tests on `paths.ts`: each forbidden element (`.`, `..`, ``, leading/trailing `/`), and prefix conflict (`a/b` vs `a/b/c`) in both state and manifest. `state.ts`: source tree containing a symlink → rejected (E090). |
| 8 | No stray files/empty dirs (E001, E015, E023, E072, E073) | Validator on fixture-copies: extra file in object root → E001; extra file in a `vN/` → E015; file under `content/` missing from manifest → E023; file in an intermediate hierarchy dir (`5b8/259/junk.txt`) → E072; empty dir under root → E073. |

### Read-path suite (against the checked-in fixture, no copies)
- `layout.resolve` of each of the 3 ids equals the known on-disk path (ground truth for the 0004
  implementation).
- `list()` returns exactly the 3 ids; `get` per object returns correct `head` (`v2`,`v1`,`v2`),
  version metadata matching the inventories, and the dedup case: `premis-data-dictionary` v2
  state contains the v1 digest resolving to `v1/content/data-dictionary.pdf`.
- `validate` (structural and `fullFixity`) over the whole fixture → zero errors, zero warnings.
- Fixity-negative (on a temp copy): flip one byte in a content file → fullFixity reports the
  digest mismatch; structural pass still succeeds (proves the tiers are actually separate).

### Write-path round-trips (temp roots)
- Ingest v1 (fresh root init: root namaste + `ocfl_layout.json` + extension config when creating
  a brand-new storage root) → self-validate clean.
- v2 add-file / v2 modify-file / v2 unchanged-file-dedup (mirror the three fixture shapes) →
  self-validate clean; unchanged file produced **no** `v2/content` copy.
- Logical delete: `sourcePath` omitting a file → new state lacks it, manifest retains it, prior
  versions untouched.
- Head-moved conflict: simulate a concurrent commit between read and finalize (advance head
  manually) → typed conflict error, no writes landed.
- **Dev-time oracle (optional, not CI-gating):** run the locally installed Go `ocfl` CLI
  (`ocfl --root <tmp> validate`/`ls`) against roots our writer produced — cross-implementation
  check that costs nothing while the binary exists on this machine, without being a runtime
  dependency of the extension.

### Wrapper-level
- `deno check` clean; adversarial-review mechanical checks (resource spec/writeResource name
  agreement — swamp only *warns* on schema mismatch, so tests must assert snapshot objects parse
  under `OutputSchema` themselves).
- Smoke test per the smoke-testing protocol, pointed at a **temp copy** of the fixture root
  (protocol rule: never touch pre-existing resources — and never point smoke tests at the
  checked-in fixture since `commit` mutates the root).

## 4. Phasing

1. **Phase 0 — scaffold**: `extensions/models/ocfl/` tree, `lib/types.ts` + `errors.ts`, deno
   check/test wired via `denoPath`. No behavior.
2. **Phase 1 — read path (MVP part 1)**: `digest`, `namaste`, `paths`, `inventory`, `layout`
   (0004 + namaste-walk fallback), `object`; model wrapper with `get` + `list`. Tests: full
   read-path suite against the fixture. *Exit: `swamp model method run <m> get --arg
   id=urn:swamp-premis:ocfl-spec` returns a correct snapshot.*
3. **Phase 2 — structural validate**: `validate.ts` structural tier + `validate` method (fan-out,
   no `fullFixity`); all invariant-matrix validator rows. This lands before commit deliberately:
   the validator is the safety net the commit tests rely on.
4. **Phase 3 — commit (MVP complete)**: `state.ts` + `commit.ts`; ingest + update, dedup,
   convention detection, head re-verify, atomic staging; write-path round-trips + invariant rows
   1–5; fresh-root initialization; smoke test; adversarial review gate.
5. **Phase 4 — fixity depth**: `fullFixity` recompute, `fixity` block verification (E093) with
   md5/sha1 legacy support, optional multi-algorithm fixity emission on commit.
6. **Phase 5+ (deferred)**: layouts `0002-flat-direct` / `0003-hash-and-id-n-tuple`; zero-padded
   creation (reading padded objects already works from Phase 2/3); OCFL 1.0 read + upgrade path
   (E081/E103); a storage-backend interface (local FS now; S3 later — significant, since atomic
   rename disappears and the finalize protocol must be redesigned around conditional puts);
   `purge` as an explicit, confirmed, separate method (never overloaded onto `commit`); publish
   via manifest + `swamp-extension-publish`.

## 5. Risks and open questions for the human

1. **Concurrent writers / locking scope.** Swamp's per-model lock serializes commits *only
   within this swamp repo*. An external tool (or a second swamp repo) pointing at the same
   storage root is not serialized — OCFL itself has no locking. Plan: rely on (a)
   one-model-per-root convention, (b) mandatory head re-verification before finalize, (c) atomic
   rename. This narrows but does not close the race (TOCTOU window between re-verify and the two
   root-inventory writes). If multi-writer is a real deployment scenario, we need an out-of-band
   lock (e.g. a lock file *outside* the storage root, since a lock file inside it violates
   E001/E088). **Decision needed: is "one swamp model is the sole writer" an acceptable
   operational contract?**
2. **Staging directory location.** Atomic `rename` requires same-filesystem staging, but any
   extra directory *inside* the storage root violates E088/E073 for a validator that runs
   mid-commit. Options: sibling dir next to the root (`<parent>/.<rootname>-staging`, may lack
   write permission), or a `stagingDir` global argument with a same-device check at commit time.
   **Recommend the global argument with a runtime same-device assertion; needs sign-off.**
3. **Crash window on root inventory replacement.** The final step is two file writes (root
   `inventory.json`, then sidecar) that cannot be jointly atomic on POSIX. A crash between them
   leaves an E060-failing object that is fully recoverable from `vN/inventory.json`. Plan:
   document the recovery procedure and have `validate` distinguish "root sidecar mismatch but
   head version consistent" as a recoverable condition. Silent-corruption risk is low but
   nonzero — worth explicit acknowledgment.
4. **`commit` = full-state replacement.** `sourcePath` is the complete desired logical tree;
   anything missing is logically deleted in the new version. This matches `ocfl commit` but makes
   an accidental empty/partial `sourcePath` a silent mass-delete (recoverable, but a bad v-bump
   in a preservation repo). **Proposed guard: refuse a commit that empties the state or drops >N%
   of files without an explicit `allowDeletes: true` argument. Confirm the guard and its shape.**
5. **No-op commits**: refuse by default (avoids junk versions from re-run workflows and keeps
   `commit` naturally idempotent for swamp guard expressions) — confirm.
6. **Snapshot resource size.** The `object` resource embeds the manifest; a 100k-file object
   makes a very large JSON resource. Options: cap/omit `manifest` behind a `get` argument, or
   store per-version `fileCount` only. Fine for the PREMIS pipeline's expected object sizes, but
   flagging before the schema ossifies into downstream CEL.
7. **Collective/type name** for `@<collective>/ocfl-repository` — requires `swamp auth whoami`;
   must ask before manifest creation (placeholder prefixes are rejected at push).
8. **`user.address` format**: fixture uses `email:mailto:seth@crude.computer` (the Go tool's
   quirk — a nonstandard double scheme). W009 wants a plain `mailto:` URI. Plan: emit
   `mailto:<email>`, accept anything on read. Confirm we shouldn't mimic the Go tool for
   byte-level consistency (we shouldn't — prior blocks are carried forward anyway, so mixed
   styles coexist fine).
9. **blake2b-512 fixity support** (E027 says clients MUST support all table algorithms): verify
   `node:crypto` exposes `blake2b512` under Deno; if not, we're technically nonconformant on that
   one read-side algorithm and must ignore-with-warning (E028 covers optional algs, but blake2b
   is in the MUST table) — may need a small pure-TS blake2b as a pinned npm dep in Phase 4.

## 6. Decisions (resolved 2026-07-31)

1. **Collective**: `crudec` — extension type is `@crudec/ocfl-repository`.
2. **Concurrency**: sole-writer contract accepted. Documented as an operational constraint (one
   swamp model instance is the sole writer to a given storage root); no out-of-band lock built.
3. **Staging directory**: `stagingDir` global argument with a runtime same-device assertion
   before commit finalization.
4. **Delete guard**: any `commit` that would remove a path from state requires `allowDeletes:
   true` explicitly — no threshold, no exceptions. Omitting a file from `sourcePath` without the
   flag is an error, not a silent deletion.
5. **No-op commits**: refused by default. A `commit` whose resulting state is identical to the
   current head errors instead of creating an empty version.
6. **Manifest resource size**: ship the full manifest in the `object` snapshot for MVP; revisit
   capping/omitting it behind a `get` argument only if real objects prove large. Deferred, not
   blocking.
7. **`user.address`**: emit standard `mailto:<email>` on write; accept any string on read (no
   mimicry of ocfl-tools' nonstandard `email:mailto:` double-scheme).
8. **blake2b-512 fixity**: confirmed available via the bundled Deno's `node:crypto`
   (`getHashes()` includes `blake2b512` and `blake2s256`) — no additional npm dependency needed;
   implement in Phase 4 as planned.
9. **Crash window** between writing the root `inventory.json` and its sidecar: accepted as a
   documented residual risk (POSIX can't make two file writes jointly atomic). Phase 2's
   `validate` should special-case "root sidecar mismatch but head version internally consistent"
   as a recoverable condition rather than a generic corruption error.

### Critical Files for Implementation
- `extensions/models/ocfl/mod.ts` (new — model wrapper: type, globalArguments, resources, 4 methods)
- `extensions/models/ocfl/lib/commit.ts` (new — atomic version writer; highest-risk module)
- `extensions/models/ocfl/lib/inventory.ts` (new — parse/serialize/sidecar/byte-identity; everything depends on it)
- `extensions/models/ocfl/lib/validate.ts` (new — E/W-coded structural + fixity validator; safety net for all write tests)
- `testdata/fixtures/ocfl-root/ocfl_layout.json` (existing — ground-truth fixture root anchoring the read-path suite and layout-0004 resolution tests)
