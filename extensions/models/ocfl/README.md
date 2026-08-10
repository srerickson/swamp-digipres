# @crudec/ocfl-repository

A swamp model type for an [OCFL](https://ocfl.io) storage root, backed by either
a local filesystem or an S3-compatible object store.

- `init` — create a conformant OCFL 1.1 storage root, including its storage
  layout extension config
- `list` — index every object in the root, writing one resource per object
- `get` — resolve one object's logical paths to the content files holding them
- `export` — stage one object's content in a local directory, verified on the
  way past
- `create_version` — create a new version of an object, creating the object
  itself when it does not exist yet

Validation is deliberately **not** implemented yet.

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

### `export`

Copies an object's content out of the storage root and onto local disk, which is
what lets an external tool — a characterisation utility, a format migrator, a
third-party fixity checker — see the bytes at all. It is the only way to get
content out; `get` reports content _paths_, which are relative to an object root
that may not be on a filesystem.

```bash
swamp model method run my-repo export \
  --arg id=urn:example:object-1 \
  --arg dest=/work/staging/object-1
```

**`dest` is a directory, and it is the base the object's logical paths hang
off.** It must be absolute, and it is created if it does not exist. A logical
path of `images/001.jpg` lands at `/work/staging/object-1/images/001.jpg`,
subdirectories reconstructed. That is true with and without `only`:

```bash
# Still lands at <dest>/images/001.jpg, not <dest>/001.jpg
swamp model method run my-repo export \
  --arg id=urn:example:object-1 \
  --arg dest=/work/staging/object-1 \
  --arg only=images/001.jpg
```

One rule for both cases, and because `dest` is a base rather than a filename,
two logical paths can never contend for the same destination — there is no
collision rule to think about. `version` selects a non-head version and defaults
to head.

**`only` takes exact logical paths — one, or a list.** A string is always one
path and is never split, so a list arrives as an array:

```bash
--arg only=images/001.jpg                     # one path
--input 'only:json=["a.txt","docs/b.txt"]'    # several
--input-file export.yaml                      # YAML list under `only:`
```

Selecting several paths in one call is one export: one plan, one download pool,
one `export` resource. Any path the version does not hold is an error rather
than a silent zero-file success, and the error names _all_ of them, so a typo'd
list costs one failed run rather than one per bad path. A path listed twice is
one file, not two. An empty list is rejected — a computed selection that came
back empty is a caller's bug, and omitting `only` is how you ask for everything.
Selection changes nothing else: the files placed are ordered by logical path,
not by the order they were requested in, and deduplication still fetches shared
bytes once.

Files are downloaded `concurrency` at a time (4 by default), which is what makes
an object of many small files bearable on S3, where the round trip dominates.

#### What it guarantees

**Every file is verified**, unconditionally — there is no opt-out, because the
bytes pass through the hash on their way to disk anyway. A file is streamed to a
sibling temp path and renamed into place only once its digest matches the
manifest. A mismatch fails with `E092` and leaves _nothing_ at the destination,
so a partially written or corrupted file is never mistaken for content.

**Re-running is cheap and idempotent.** A destination file that already digests
to the expected value is left untouched and reported as `existing`; one whose
bytes differ is overwritten. Re-staging a large object costs local hashing
rather than a second transfer.

**Deduplicated content is fetched once.** Two logical paths sharing a digest
share one content file, so the bytes are read from storage once and the
duplicate becomes a local copy — reported as `copied`. A copy is not a cheaper
kind of write: it goes through the same temp-and-rename and the same digest
check as the fetch it duplicates, and is skipped on a re-run on the same terms.

**A version whose state is empty exports zero files**, rather than failing.
Removing every file leaves a legitimate OCFL version, and staging it means
writing nothing.

There is **no rollback**. Unlike a half-written OCFL version, a partly populated
staging directory is not invalid, and `dest` may hold files this run did not put
there — so a failure leaves what it already placed, reports how far it got, and
writes no `export` resource. Re-running picks up where it left off, since
everything already present is skipped.

### `create_version`

Creating an object and updating one are the same operation in OCFL: both mean
committing a new version. The caller does not supply a file listing — it
supplies edits against the previous version's logical state, applied in order.

Operations are objects, not strings. `--input key=value` does not accumulate
repeated keys, so a list arrives either in a YAML file or as JSON. The file form
is usually the one you want:

```yaml
# ingest.yaml
id: urn:example:object-1
version: 1
userName: Seth Erickson
userAddress: mailto:seth@crude.computer
message: initial deposit
ops:
  - op: add
    source: /ingest/spec.md
    logicalPath: docs/spec.md
```

```bash
swamp model method run my-repo create_version --input-file ingest.yaml
```

| Operation                        | Effect                                                      |
| -------------------------------- | ----------------------------------------------------------- |
| `{op: add, source, logicalPath}` | Copy a local file in at that logical path, superseding any  |
| `{op: remove, logicalPath}`      | Drop the path from the new state; content stays recoverable |
| `{op: rename, from, to}`         | Move a logical path; writes no content at all               |

Sources are absolute local paths. Unknown keys are rejected rather than ignored:
a misspelled `logicalPath` would otherwise leave the operand undefined and
deposit content somewhere other than where it was asked to go.

The same list as JSON, and the single-operation shorthand:

```bash
--input 'ops:json=[{"op":"add","source":"/a.txt","logicalPath":"a.txt"},{"op":"remove","logicalPath":"b.txt"}]'
--input 'ops:json={"op":"remove","logicalPath":"b.txt"}'   # one op, no list
```

Building these from a workflow needs no string assembly and no escaping, which
is the point — a logical path containing a colon is just a string here.

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

The write order is not negotiable: conformance declaration first for a new
object, then content, then `vN/inventory.json` and its sidecar, then the root
inventory and — as the single commit point — the root sidecar, with nothing
between those last two. Sources are digested at plan time and re-verified as
they are written, so a source that changed in between is a fatal error rather
than a silent substitution. The root inventory is re-read immediately before the
commit and compared against the digest seen at plan time; OCFL has no locking,
so this is what stands between a concurrent writer and a lost version.

A failure anywhere before the commit point rolls back, removing only paths under
the target version directory — and the object root itself only when this call
verified it was empty and claimed it. Content bytes are written directly to
their final paths rather than staged and moved, so an interrupted run leaves a
version directory a third-party validator would flag (E046) until rollback
completes. There is **no durable transaction log**: a crashed process does not
resume, and recovery is manual.

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
| `export` | `export-<sanitized-id>-<digest8>` | Where each logical path was staged, and its digest    |

`create_version` writes the same `object` resource as `get`, re-read from
storage after the commit rather than reported from the plan — so the resource
reflects an object that actually parses and verifies against its sidecar.

Instance names become storage paths, so ids are sanitized. Sanitization is
lossy, so a digest suffix keeps the mapping injective. For `export` that suffix
covers the destination as well as the id: re-exporting to the same directory
updates one manifest in place, while staging the same object in two directories
yields two resources rather than one silently replacing the other. The
destination is normalized first, so `/work/staging` and `/work/staging/` are one
directory and one resource, not two.

An `export` resource is what makes staged content addressable from a workflow —
a downstream step reads `destPath` out of `files` rather than reconstructing it:

```
${{ data.latest("my-repo", "export-...").attributes.files[0].destPath }}
```

Each entry records `logicalPath`, `destPath`, `digest`, `size`, `verified`, and
a `source` of `fetched`, `existing` (already on disk with the right bytes), or
`copied` (deduplicated from a sibling).

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

`lib/testing.ts` holds the disposable-storage-root harness the write-path tests
share. It is test-only and unreachable from `mod.ts`, so it never enters the
bundle, and its name does not match Deno's test-file patterns, so importing it
does not register anybody else's tests twice.

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
