# @crudec/ocfl-repository

A swamp model type for an [OCFL](https://ocfl.io) storage root, backed by either
a local filesystem or an S3-compatible object store.

This iteration covers the **read path plus storage root initialization**:

- `init` — create a conformant OCFL 1.1 storage root, including its storage
  layout extension config
- `list` — index every object in the root, writing one resource per object
- `get` — resolve one object's logical paths to the content files holding them

Writing objects (ingest, new versions), validation, and content download are
deliberately **not** implemented yet.

## Storage backends

Everything in `lib/` talks to the `Storage` interface in `lib/storage/types.ts`,
never to `Deno.*` or `fetch` directly — that is what lets one implementation of
the OCFL logic serve both backends.

| Backend | Implementation         | Notes                                              |
| ------- | ---------------------- | -------------------------------------------------- |
| `local` | `lib/storage/local.ts` | Deno filesystem APIs                               |
| `s3`    | `lib/storage/s3.ts`    | SigV4 via `aws4fetch`; `ListObjectsV2` for listing |

S3 has no directories — a "directory" is just a set of keys sharing a prefix.
Code above the storage layer never assumes a directory exists as an entity, so
empty-directory rules (E073) are not enforced on either backend.

## Configuration

Global arguments select and configure the backend:

```bash
# Local
swamp model create @crudec/ocfl-repository my-repo \
  --global-arg storage=local \
  --global-arg path=/srv/ocfl-root

# S3-compatible (Cloudflare R2 shown)
swamp model create @crudec/ocfl-repository my-r2-repo \
  --global-arg storage=s3 \
  --global-arg bucket=my-bucket \
  --global-arg prefix=ocfl \
  --global-arg endpoint=https://<account>.r2.cloudflarestorage.com \
  --global-arg region=auto \
  --global-arg 'accessKeyId=${{ vault.get(my-vault, R2_ACCESS_KEY_ID) }}' \
  --global-arg 'secretAccessKey=${{ vault.get(my-vault, R2_SECRET_ACCESS_KEY) }}'
```

Credentials are resolved fresh on every run when wired through `vault.get(...)`.
Reading a secret and passing the literal value freezes it at model-creation time
and defeats rotation. When the arguments are omitted, `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` are used.

## Methods

### `init`

```bash
swamp model method run my-repo init \
  --arg layout=0004-hashed-n-tuple-storage-layout \
  --arg description="Preservation repository"
```

Writes `0=ocfl_1.1`, `ocfl_layout.json`, and `extensions/<layout>/config.json`.
Supported layouts are `0004-hashed-n-tuple-storage-layout` (default) and
`0002-flat-direct-storage-layout`; the `0004` parameters `digestAlgorithm`,
`tupleSize`, `numberOfTuples`, and `shortObjectRoot` are all settable.

Re-running with the same layout is a no-op. Re-running with a _different_ layout
fails: rewriting `ocfl_layout.json` would orphan every object already stored
under the old mapping. Initializing a non-empty directory that is not already a
storage root also fails.

### `list`

```bash
swamp model method run my-repo list
```

A factory method — one execution writes the `root` resource plus one `object`
resource per object, so the per-model lock is acquired once rather than once per
object. Objects are found by scanning for `0=ocfl_object_N.M` declarations,
because a layout maps a _known_ id to a path and cannot enumerate.

Cost is linear in object count, since each object's root inventory is read and
verified against its sidecar.

### `get`

```bash
swamp model method run my-repo get --arg id=urn:example:object-1
swamp model method run my-repo get --arg id=urn:example:object-1 --arg version=v1
```

Resolves the object's state at a version to
`{ logicalPath, digest,
contentPaths }`. Deduplicated files resolve to content
under an _earlier_ version directory — that is normal OCFL, not an error.

When the root declares a layout this model can compute, the path is derived
directly; otherwise every object root is scanned. Either way the inventory's own
`id` is checked against the requested one — the path is never taken as proof of
identity.

## Resources

| Spec     | Instance name                     | Contents                                              |
| -------- | --------------------------------- | ----------------------------------------------------- |
| `root`   | `root`                            | Backend, location, spec version, layout, object count |
| `object` | `object-<sanitized-id>-<digest8>` | Versions, and the resolved state at one version       |

Instance names become storage paths, so ids are sanitized. Sanitization is
lossy, so a digest suffix keeps the mapping injective.

## Development

Deno lives at `~/.swamp/deno/deno` (confirm with
`swamp doctor extensions --json` → `denoPath`).

```bash
~/.swamp/deno/deno check extensions/models/ocfl/mod.ts
~/.swamp/deno/deno test -A extensions/models/ocfl/
```

Tests run the OCFL layer against a local filesystem _and_ an in-memory backend
seeded from the same fixture — if a test passes on both, the OCFL code genuinely
does not depend on the backend. `testdata/fixtures/ocfl-root` is real
`ocfl-tools` output and is never mutated; tests that write use
`Deno.makeTempDir()`.

The `MECHANICAL:` tests in `mod_test.ts` enforce the adversarial review gate's
schema-write conformance checks. Swamp only _warns_ when written data does not
match a resource schema, so those assertions are what actually catch drift.
