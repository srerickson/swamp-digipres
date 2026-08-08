# @crudec/ocfl-repository

A swamp model type for an [OCFL](https://ocfl.io) storage root, backed by either
a local filesystem or an S3-compatible object store.

- `init` — create a conformant OCFL 1.1 storage root, including its storage
  layout extension config
- `list` — index every object in the root, writing one resource per object
- `get` — resolve one object's logical paths to the content files holding them
- `create_version` — create a new version of an object, creating the object
  itself when it does not exist yet

Validation and content download are deliberately **not** implemented yet.

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

`aws4fetch` rather than `@aws-sdk/client-s3` is a deliberate trade: swamp
inlines npm packages into the extension bundle, and aws4fetch is a few kilobytes
with no dependencies where the SDK is megabytes. Multipart upload is therefore
hand-rolled against the S3 REST API (`lib/storage/s3.ts`), which is roughly 150
lines — see [Large files](#large-files).

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

### `create_version`

Creating an object and updating one are the same operation in OCFL: both mean
committing a new version. The caller does not supply a file listing — it
supplies edits against the previous version's logical state, applied in order.

```bash
swamp model method run my-repo create_version \
  --input id=urn:example:object-1 \
  --input version=1 \
  --input 'ops:json=["add:/ingest/spec.md:docs/spec.md"]' \
  --input userName="Seth Erickson" \
  --input userAddress=mailto:seth@crude.computer \
  --input message="initial deposit"
```

| Operation                    | Effect                                                      |
| ---------------------------- | ----------------------------------------------------------- |
| `add:<source>:<logicalPath>` | Copy a local file in at that logical path, superseding any  |
| `remove:<logicalPath>`       | Drop the path from the new state; content stays recoverable |
| `rename:<from>:<to>`         | Move a logical path; writes no content at all               |

Sources are absolute local paths. Escape a literal colon as `\:`.

`--input key=value` does not accumulate repeated keys, so a list of operations
arrives one of three ways — all parse identically:

```bash
--input 'ops:json=["add:/a.txt:a.txt","remove:b.txt"]'   # JSON array
--input ops=$'add:/a.txt:a.txt\nremove:b.txt'            # newline-delimited
--input-file ingest.yaml                                  # YAML list under `ops:`
```

**`version` is an assertion, not an instruction.** It is the unpadded number the
call expects to produce — `1` for a new object, `head+1` otherwise — checked
before anything is written, and the object's own zero-padding convention is
applied when naming the directory (E011–E013). Omit it to take `head+1`; supply
it to catch a stale caller, a concurrent writer, or a typo'd id that would
otherwise silently deposit a brand-new object.

`userName` and `userAddress` are required. W007 wants both, and a version
committed without an agent is a provenance defect that cannot be corrected
afterwards. `message` is optional.

New objects default to `sha512` and a `content` content directory, both
overridable; for an existing object these are fixed properties and a conflicting
argument is rejected rather than ignored. A version whose state matches its
predecessor's is refused unless `allowNoChange=true`. `dryRun=true` reports the
full plan — content files to write, bytes to transfer — and writes nothing.

#### What it guarantees

Deduplication is automatic: only digests absent from the manifest get content
files, so an unchanged file in a new version resolves back to its original
version's content path, and a `rename` transfers no bytes.

The write order follows `references/transactions.md` §8 and is not negotiable:
conformance declaration first for a new object, then content, then
`vN/inventory.json` and its sidecar, then the root inventory and — as the single
commit point — the root sidecar, with nothing between those last two. Sources
are digested at plan time and re-verified as they are written, so a source that
changed in between is a fatal error rather than a silent substitution. The root
inventory is re-read immediately before the commit and compared against the
digest seen at plan time; OCFL has no locking, so this is what stands between a
concurrent writer and a lost version.

A failure anywhere before the commit point rolls back, removing only paths under
the target version directory — and the object root itself only when this call
verified it was empty and claimed it. Content bytes are written directly to
their final paths rather than staged and moved, so an interrupted run leaves a
version directory a third-party validator would flag (E046) until rollback
completes. There is **no durable transaction log**: a crashed process does not
resume, and recovery is manual per `references/transactions.md` §11.

## Large files

Content is streamed, never buffered whole. On S3 a source larger than the part
size (16 MiB by default) becomes a multipart upload: `CreateMultipartUpload`,
`UploadPart` per part with bounded concurrency, then `CompleteMultipartUpload`,
with `AbortMultipartUpload` on any failure so orphaned parts do not accrue
storage charges.

Two constraints drive the implementation. Every part but the last is exactly the
same size, because Cloudflare R2 rejects uneven non-final parts where AWS
tolerates them. And when the source size is known, the part size scales up so
the upload stays within the 10,000-part API ceiling.

S3 deployments should still set a lifecycle rule to abort incomplete multipart
uploads: this code aborts its own failures, but a killed process cannot.

## Resources

| Spec     | Instance name                     | Contents                                              |
| -------- | --------------------------------- | ----------------------------------------------------- |
| `root`   | `root`                            | Backend, location, spec version, layout, object count |
| `object` | `object-<sanitized-id>-<digest8>` | Versions, and the resolved state at one version       |

`create_version` writes the same `object` resource as `get`, re-read from
storage after the commit rather than reported from the plan — so the resource
reflects an object that actually parses and verifies against its sidecar.

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

`commit_test.ts` asserts through the _read_ path: every write is verified by
re-opening the object with `openObjectAt` / `readInventory` / `resolveState`
rather than by inspecting what the writer believed it did. Since `readInventory`
checks each inventory against its sidecar (E058–E061), a successful read-back is
itself the assertion that the commit produced a coherent object.

`lib/storage/multipart_test.ts` stubs the global `fetch` that `aws4fetch` calls,
so the multipart protocol is asserted request by request without a live bucket.

The `MECHANICAL:` tests in `mod_test.ts` enforce the adversarial review gate's
schema-write conformance checks. Swamp only _warns_ when written data does not
match a resource schema, so those assertions are what actually catch drift.

No OCFL validator is bundled. To check output against a third-party
implementation:

```bash
go install github.com/srerickson/ocfl-tools/cmd/ocfl@latest
ocfl validate --root /path/to/storage-root
```
