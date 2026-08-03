# Transactional OCFL Object Mutation

How to model creating or updating an OCFL object as a transaction that can be
**interrupted at any point** and later either **resumed** or **reverted**,
against either a POSIX filesystem or S3-compatible object storage.

This document is normative for automations in this repository. It fixes the
decisions that make interruption safe; where a choice is genuinely deployment
dependent it is called out as a knob.

## 1. The problem

An OCFL version commit is inherently a multi-object write:

- 0..n content files under `vN/<contentDirectory>/`
- `vN/inventory.json` + `vN/inventory.json.<alg>`
- root `inventory.json` + root `inventory.json.<alg>`
- for a new object, `0=ocfl_object_<spec>`

Neither POSIX nor S3 offers multi-object atomicity. Therefore a "transaction"
here does **not** mean the object is never observably mid-change. It means:

1. There is exactly **one** unambiguous commit point.
2. Every step before it is **idempotent** and **replayable**.
3. Every incomplete state is **decidable** — recovery can always tell
   roll-forward from roll-back without guessing.
4. The window during which the object would fail third-party validation is
   **bounded, documented, and recoverable**.

## 2. Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Staging | **Write directly to final paths** (no staging tree, no rename-into-place) | One code path for POSIX and S3. S3 has no rename; emulating it costs a server-side COPY per key (multipart copy above 5 GiB). Cost is a bounded invalid window (§8). |
| Commit point | **Root `inventory.json.<alg>` sidecar write** | The only marker that works when version directories lack inventories (§3). |
| Inventory | **Serialize once at prepare time, cache the bytes, never re-serialize** | Resume becomes byte replay; no key-order / whitespace / timestamp drift can break the sidecar or E064. |
| Version inventories | **Always write `vN/inventory.json` + sidecar**, even if prior versions lack them | W010 is a SHOULD, but writing it makes journal-free recovery decidable (§3, §11). |
| Log | **External to the OCFL root**, satisfying the properties in §5 | A log file inside a storage root violates E072/E088. Technology is a knob. |
| Concurrency | One active transaction per (storage root, object id), lease + epoch fencing | OCFL has no locking (§10). |

### Terminology

- **Transaction (txn)** — one prepared mutation of one object: create v1, or add
  version N+1.
- **Base head** — the object's head version at prepare time (`null` for a new
  object).
- **Target version** — `vN+1` (or `v1`), named per the object's existing
  padding convention (E011–E013).
- **Log** — the durable record of transaction intent and phase. Abstract; see §5.
- **Cached inventory** — the exact bytes of the target version's
  `inventory.json`, frozen at prepare time.

## 3. Why the commit point is the root sidecar

A version directory is **not required** to contain an inventory: §3.7 makes the
root inventory a MUST (E063) but the version inventory only a SHOULD (W010).
E064 ("root inventory MUST be the same as the most recent version's") is
*conditional* on version inventories existing.

Consequence: you cannot in general recover head by scanning for the
highest version directory with a valid inventory — a legitimate object may have
none. Given an object with `head: vN` in the root inventory and a `vN+1/`
directory present, "orphaned junk from an aborted attempt" and "committed but
root swap unfinished" are indistinguishable from storage alone.

So:

- **The root sidecar is the commit marker.** Before it lands, the transaction is
  uncommitted and `vN+1/` is disposable. After it lands, the version exists.
- **Mitigation, and it is load-bearing:** our writer always writes
  `vN+1/inventory.json` + sidecar before touching the root. That is a valid
  OCFL inventory whose `head` is `vN+1` — a self-describing, storage-side
  record of intent. It makes recovery decidable even with the log destroyed
  (§11), and it is a second durable copy of the cached inventory bytes.

Uniformity is not required: adding version inventories to an object whose
earlier versions lack them is legal, and E064 stays satisfied because the root
will equal the head version's copy byte for byte.

## 4. Phase model

Phases are monotonic. Each transition is a single durable log record update.

```
                 planned ──▶ content ──▶ prepared ──▶ committing ──▶ committed
                    │           │            │             │
                    └───────────┴────────────┘             │  (roll forward only)
                                │                          │
                                ▼                          ▼
                            aborting ──▶ aborted       committed
```

| Phase | Means | Storage may contain | Recovery |
|---|---|---|---|
| `planned` | Log record durable, **no storage writes yet** | nothing new | roll forward or back, both trivial |
| `content` | Writing content files | some/all of `vN+1/<contentDirectory>/` | roll forward or back |
| `prepared` | All content written and verified; `vN+1/inventory.json` + sidecar written | complete `vN+1/` | roll forward or back |
| `committing` | Root inventory write authorized/underway | root inventory may be new bytes with stale sidecar | **roll forward only** |
| `committed` | Root sidecar written | valid object at `vN+1` | done; only logical revert (§9.3) |
| `aborting` | Rollback underway | partial `vN+1/` | continue rollback |
| `aborted` | `vN+1/` removed, root restored | nothing new | terminal |

`committing` is roll-forward-only for two reasons: the root inventory may
already be the new bytes (rolling back means restoring old bytes, which is
possible but pointless), and while the root inventory and sidecar disagree the
object fails validation wholesale (E060) — the fastest exit is one write
forward.

### Write-ahead discipline

The invariant that makes crash-anywhere safe:

> **Record intent durably before performing the storage action it authorizes.
> Record completion after. Make every action idempotent so a crash in the gap
> is resolved by replay.**

Concretely:
- `planned` durable **before** the first content write.
- `prepared` durable **after** `vN+1/inventory.json.<alg>` is written.
- `committing` durable **before** the root `inventory.json` write.
- `committed` durable **after** the root sidecar is written.

A crash between "durable phase" and "action complete" is always safe: replaying
the action is a no-op or an overwrite with identical bytes.

## 5. Required properties of the log

The log is an interface, not a technology. Any implementation satisfying L1–L10
is acceptable.

**L1 — Atomic phase update.** A phase transition is all-or-nothing. A reader
must never observe a torn or partially updated transaction record. (Rules out a
plain multi-line text file rewritten in place.)

**L2 — Durability on demand.** After a transition returns, the new phase
survives process death, and — for the `prepared → committing → committed`
transitions — host power loss. Buffered writes that are merely "usually
flushed" are insufficient at the commit boundary.

**L3 — Write-ahead ordering.** The implementation must let the caller force a
record durable *before* the corresponding storage operation begins. A log that
can only be written asynchronously cannot provide §4's discipline.

**L4 — Enumerability of non-terminal work.** Recovery must be able to ask "list
all transactions not in `committed`/`aborted`" without knowing their ids. A
crashed process leaves no in-memory handle.

**L5 — Keyed exclusion.** At most one non-terminal transaction per
(storage root, object id), enforced by the log, not by convention. Two
concurrent attempts would both target `vN+1/` and interleave content writes
indistinguishably.

**L6 — Opaque payload storage.** Must durably hold the cached inventory bytes
(kilobytes to low megabytes) and the content plan, or hold stable references to
another durable store. If the payload can be lost independently of the phase
record, resume from `content` breaks.

**L7 — Compare-and-set / fencing.** Ownership must be claimable and revocable:
a lease holder plus a monotonically increasing epoch, with conditional update
("set phase to X only if epoch is still E"). Without this, a process that
stalls past its lease and resumes can clobber a transaction another worker
adopted — which is precisely the scenario interruptibility invites.

**L8 — Append-only history alongside mutable phase.** Keep the current phase
*and* an ordered record of transitions with timestamps and actors. The phase
drives recovery; the history drives audit and PREMIS events (§12). Do not
overwrite history.

**L9 — Located outside the OCFL storage root.** Anything under a storage root
that is not part of an OCFL object violates E072/E088, and empty directories
violate E073. The log's own consistency and durability must not depend on the
repository it is describing.

**L10 — Declared consistency domain.** The set of workers sharing one log is
the set of workers that are mutually excluded. This must be stated explicitly.
Two orchestrators with independent logs have **no** mutual exclusion, no matter
how strong each log is individually.

### Candidate implementations

| Implementation | Notes |
|---|---|
| **SQLite file beside the orchestrator** (recommended default) | Satisfies L1–L8 directly. Use WAL mode; `synchronous=FULL` at least for the commit-boundary transitions. Enforce L5 with a unique partial index on non-terminal phases. L10 = one host. Never on NFS. |
| PostgreSQL / MySQL | Same, plus multi-host L10. Adds an availability dependency on the commit path. |
| DynamoDB (or similar KV with conditional writes) | Good L7 via conditional expressions; natural fit when the orchestrator is already serverless/multi-host. Watch item-size limits against L6 — store inventory bytes in S3 (outside the OCFL root) and reference them. |
| Directory of per-transaction files, one file per txn, updated by atomic rename | Satisfies L1–L4 and L6 on POSIX; L5 via `O_EXCL` create; L7 is awkward. Viable for single-writer deployments with no database dependency. |

### Anti-patterns

- Log inside the OCFL storage root (violates L9 and E072).
- Append-only text log with no atomic current-phase record (violates L1/L4 —
  recovery must replay and interpret, and a torn final line is ambiguous).
- Log entries keyed only by transaction id with no object-id index (violates
  L5 — cannot detect a competing transaction).
- Inferring phase from storage state instead of recording it (§3 shows this is
  undecidable in general).
- Deriving durability from the OCFL storage backend itself (circular; the whole
  point is to describe a repository that may be mid-write).

## 6. Transaction record contents

Field names are illustrative; the *content* is required.

**Identity and phase**
- `txn_id`, `storage_root`, `object_id`, `phase`, `created`, `updated`
- `actor` (who requested it), `lease_owner`, `lease_expires`, `epoch`

**Base state (for rollback and for the pre-commit head check)**
- `base_head` (`null` for new object), `is_new_object`
- `base_inventory_bytes` + `base_inventory_digest` — exact bytes to restore on
  rollback from `committing`, and the value compared immediately before commit
  to prove head has not moved
- `spec_version` of the object (and of the storage root)

**Target state**
- `target_version` (with the object's padding convention applied)
- `new_inventory_bytes` + `new_inventory_digest` — the frozen cache. The sidecar
  is derivable: `<digest> inventory.json\n`
- `digest_algorithm`, `content_directory`

**Content plan** — one entry per content file to write. The inventory manifest
says *what* content paths must exist; it does not say where the bytes come
from. Per entry:
- `content_path` (relative to object root, under `target_version/`)
- `digest` (manifest key), `size`
- `source_uri`
- `source_size`, `source_mtime`, `source_digest` (see §7)
- `status` (`pending` / `written` / `verified`)
- backend scratch, e.g. S3 `multipart_upload_id`

Deduplicated files — those whose digest already appears in the base manifest —
produce **no** content-plan entry. Their digest resolves via the manifest to an
earlier version's content path.

## 7. Source drift policy

The cached inventory bytes are frozen; the files they were computed from are
not. A resume hours or days later must not silently write different bytes than
the digests promise.

**At prepare time**, for every content-plan entry, record `source_digest`,
`source_size` and `source_mtime`.

**Before copying** any source (initial run or resume): stat the source and
compare size and mtime against the recorded values. A mismatch is a **fatal
error** — fail the transaction, do not write. Rationale: the source is no
longer the artifact the inventory describes; guessing is worse than stopping.
Report it as a drift error naming the path, the recorded triple and the
observed triple, and require an operator decision (abort and re-prepare, or
point the plan at a corrected source).

**On resume**, optionally re-digest sources before copying (knob:
`resume_redigest`, default on for long-interrupted transactions, e.g. lease
expired or age over a threshold; off for a fast in-process retry). mtime+size
is a cheap heuristic and misses same-size same-mtime edits; re-digesting is the
only real proof. Cost is one full read of the remaining sources.

**Always digest while writing.** Compute the digest of the stream as it is
written and compare to the manifest digest before marking the entry `verified`.
This catches drift that slipped past the stat check and corruption in transit,
and it is nearly free. A mismatch here is fatal for the same reason.

**Alternative for high-drift environments** (knob): copy sources into a
client-side content-addressed staging area at prepare time, and set
`source_uri` to the CAS path. This eliminates drift entirely at the cost of
doubling write I/O and needing CAS garbage collection. Prefer stat+verify
unless sources are known to be volatile.

## 8. Execution and write order

### Prepare (`→ planned`)

1. Resolve the object path from the storage root layout; verify
   `inventory.json`'s `id` matches the requested id — never trust the path
   (§ "Locate an object" in SKILL.md).
2. Read and verify the root inventory: sidecar digest matches bytes, `head` is
   consistent. Record bytes + digest as the base.
3. Determine `target_version` using the object's existing naming convention
   (padded vs not, same width, no gaps — E011–E013). New object: `v1`.
4. Compute the new logical state; digest all new files; determine which digests
   are already in the base manifest (dedupe) and which need content writes.
5. Build the new inventory: carry prior `version` blocks forward **unchanged**
   (E066, W011), append the new block with RFC 3339 `created` including
   timezone, `message`, and `user` (`name` + `address`), update `head`, add
   manifest and optional fixity entries. Content paths use the real version
   directory name.
6. **Serialize it once. Cache the bytes and their digest.**
7. Write the whole record — txn, cached inventory, content plan — durably in
   one atomic log operation (L1), acquiring keyed exclusion (L5) and a lease
   (L7). **No storage writes have occurred.** If this step fails, nothing has
   happened.

### Content (`planned → content`)

Idempotent, resumable, parallelizable. For each `pending` entry:

1. Stat the source; compare size+mtime (§7). Optionally re-digest.
2. If the destination already exists, it is either a completed write from a
   previous attempt or a partial one. Cheapest correct check: compare size, and
   re-digest if size matches but the entry is not `verified`. Overwriting is
   always safe — destinations are digest-addressed and belong to this txn
   alone.
3. Write, digesting the stream. Compare against the manifest digest.
4. Mark `written` / `verified` in the log.

No content path may be a prefix of another (E101), no path element may be `.`,
`..` or empty (E099), and no leading/trailing `/` (E100) — validate the plan at
prepare time, not here.

### Prepared (`content → prepared`)

1. Assert every content-plan entry is `verified`.
2. Write `target_version/inventory.json` (the cached bytes, atomically — §8.1).
3. Write `target_version/inventory.json.<alg>`.
4. Record `prepared`.

The object is now spec-invalid in exactly one way: `target_version/` exists but
is not named in the root inventory's `versions` (E046). It is, however,
completely self-describing.

### Commit (`prepared → committing → committed`)

1. Renew the lease; assert epoch unchanged (L7).
2. **Re-read the root inventory and compare its digest to
   `base_inventory_digest`.** If it differs, another writer moved head: abort
   (§9.1). OCFL has no locking; this check is mandatory.
3. Pre-stage whatever the backend allows so steps 5 and 6 are adjacent (POSIX:
   write both temp files now).
4. Record `committing` durably.
5. Write root `inventory.json` (cached bytes).
6. Write root `inventory.json.<alg>`. **← commit point**
7. Record `committed`.

**Nothing may happen between 5 and 6.** In that window the root sidecar digests
the previous inventory bytes, so E060 fails and the object is rejected
wholesale — not merely flagged. On POSIX this is two back-to-back renames
(microseconds). On S3 it is two PUTs; that is the floor.

For a **new object**, write `0=ocfl_object_<spec>` **first**, before any content
(and content of exactly `ocfl_object_<spec>\n`, E007). A crash then leaves a
namaste-declared object root with no root inventory: invalid (E063) but
unambiguously an incomplete ingest, and discoverable by the same namaste walk
that finds every other object. Namaste-last would leave an anonymous directory
in the storage hierarchy — both an E072/E088 violation and invisible to
recovery.

### 8.1 Per-file atomicity is now the client's job

Writing directly to final paths means a torn write to the root `inventory.json`
destroys the object's head. Required:

- **POSIX:** write to a temp file **outside the object root** (inside it would
  violate E001), `fsync` it, `rename` into place, then `fsync` the parent
  directory. Never write in place. Note `rename` is only atomic within a
  filesystem — place scratch accordingly.
- **S3:** a `PUT` is atomic and read-after-write is strongly consistent; write
  directly. Do not use multi-step emulations of rename.

### 8.2 Validation windows (accepted cost of writing in place)

| Window | Third-party validator sees |
|---|---|
| content writing | E046 (`vN+1/` not in `versions`), E023 (content files not in the referenced inventory's manifest) |
| `prepared` | E046 |
| between root inventory and root sidecar | **E060** — sidecar digest does not match inventory bytes; object rejected |

Automations that validate a repository must consult the log and exclude objects
with non-terminal transactions, or treat these specific codes on those objects
as expected.

## 9. Undoing

Three distinct operations. Never conflate them; always verify `inventory.json`'s
`id` before any of them.

### 9.1 Abort (uncommitted)

Valid from `planned`, `content`, `prepared`, and from `committing` **only** if
the root inventory still digests to `base_inventory_digest` (i.e. step 5 had not
landed).

1. Record `aborting`.
2. Delete everything under `target_version/`, then the directory itself.
3. If `is_new_object`, remove the object root, including the namaste file.
4. POSIX: prune parent directories that are now empty (E073), stopping at the
   storage root. S3: nothing to do, prefixes are not directories.
5. If the root inventory was already overwritten, restore `base_inventory_bytes`
   and its sidecar.
6. Record `aborted`.

This is provably safe: every path deleted is under `target_version/`, and no
entry in the *base* manifest can reference that version directory, so all of it
belongs to this transaction. Keyed exclusion (L5) is what guarantees no other
transaction also owns those paths.

### 9.2 Destructive rollback (committed) — discouraged

Removing a committed version is outside the spec. Only defensible when the
object is provably unpublished and unreplicated. It leaves no audit trail — you
must record it externally (§12). Requires explicit operator confirmation.
Impossible under S3 Object Lock / retention, and unreliable with cross-region
replication.

### 9.3 Logical revert (committed) — the default

Create a **new** version whose `state` restores the previous logical state. This
is an ordinary transaction: run §8 with the target state copied from the version
being reverted to. Content is already in the manifest, so typically zero content
writes. This is the only spec-native answer and should be the default response
to "undo that commit".

Note the same distinction for deletion generally: a logical delete is a new
version omitting the paths; a purge is destructive and out of scope for the
spec.

## 10. Concurrency and fencing

OCFL provides no locking. Writers must be serialized externally.

- **Keyed exclusion (L5)** prevents two transactions on one object within one
  log's consistency domain.
- **Lease + epoch (L7)** prevents a stalled worker from resurrecting. Every
  mutating step re-checks the lease and asserts the epoch. Adoption of an
  abandoned transaction bumps the epoch; the original worker's next write
  fails.
- **Pre-commit head check** (§8 commit step 2) is the backstop that catches
  writers outside the log's domain — including humans and other tools.
- **If multiple orchestrators share a repository but not a log** (L10), add a
  repository-side lock as an explicit upgrade: S3 conditional
  `PUT If-None-Match: *` for compare-and-swap acquisition and `If-Match` on
  ETag for renewal; POSIX `O_EXCL` create with owner + expiry, or `flock` where
  supported. Store such a lock outside the storage root, or accept it as a
  registered storage-root extension — never as a loose file in the object
  hierarchy.

## 11. Recovery without the log

Because the log lives outside the repository, it can be lost. Recovery must
still be possible, and §3's "always write version inventories" rule is what
makes it decidable. Scan-based reconciliation:

For each object root found by walking for `0=ocfl_object_*`:

1. **No root `inventory.json`** → incomplete new-object ingest (E063). Remove
   the object root and, on POSIX, now-empty parents.
2. **Root inventory and sidecar disagree (E060)** → crash inside the commit
   window. If `vN+1/inventory.json` exists and is valid, the correct root
   content is that file's bytes: copy it and write the matching sidecar (roll
   forward). Otherwise recompute the sidecar from the root inventory bytes only
   if the root inventory is self-consistent with storage; if not, escalate.
3. **A version directory exists that is not in `versions`** →
   - It contains a valid `inventory.json` + sidecar whose `head` is that
     version, whose prior version blocks agree with the current root inventory
     (E066), and whose manifest matches the files present → **roll forward**:
     copy that inventory and sidecar to the object root.
   - Otherwise → **roll back**: delete the version directory (and empty
     parents).
4. **Multiple version directories beyond head** → escalate to an operator;
   this indicates concurrent writers, not a simple crash.

Also reconcile in the other direction: enumerate non-terminal transactions in
the log (L4) and, for any whose storage state shows the commit landed, advance
them to `committed` rather than rolling back a good version.

Backend housekeeping: S3 deployments must set a lifecycle rule to abort
incomplete multipart uploads, or aborted transactions leak storage cost
invisibly. Multipart uploads are themselves a useful prepared-transaction
primitive — an upload left open across an interruption can be rediscovered with
`ListMultipartUploads` and completed later, which gives resumability for large
bitstreams for free.

## 12. Provenance

The log is operational state; it is not the provenance record. Phase history
(L8) should be projected into durable PREMIS events — ingestion start/end,
fixity check, validation, deaccession — with outcomes, so that pruning
completed transactions does not erase the audit trail. On commit, the surviving
object's `logs/` directory is an appropriate destination for a local record.

This matters most for the operations the spec deliberately does not cover:
destructive rollback and purge produce no OCFL-visible trace, so the external
record is the only evidence they happened.

## 13. Implementation checklist

Prepare
- [ ] Object id verified against `inventory.json`, not inferred from the path
- [ ] Root inventory verified against its sidecar before use
- [ ] Base inventory bytes + digest cached
- [ ] Target version name follows the object's existing padding convention
- [ ] `contentDirectory` honored (not assumed to be `content`)
- [ ] Prior version blocks carried forward byte-identically
- [ ] `created` is RFC 3339 with timezone
- [ ] Inventory serialized **once**; bytes cached
- [ ] Content paths validated for prefix/element/slash safety
- [ ] Source digest + size + mtime recorded per entry
- [ ] Whole record committed atomically before any storage write

Execute
- [ ] Source size+mtime checked before every copy; mismatch is fatal
- [ ] Digest computed while writing and compared to the manifest
- [ ] Content writes idempotent and safely re-runnable
- [ ] Namaste written first for a new object
- [ ] Version inventory + sidecar written before touching the root
- [ ] Phase recorded durably before the actions it authorizes

Commit
- [ ] Lease renewed, epoch asserted
- [ ] Root inventory re-read and compared to the cached base digest
- [ ] `committing` durable before the root inventory write
- [ ] Root inventory and sidecar writes adjacent, nothing between them
- [ ] All inventory/sidecar writes atomic (temp+rename on POSIX)
- [ ] Temp files outside the object root

Undo
- [ ] Abort deletes only paths under the target version directory
- [ ] Empty parent directories pruned on POSIX
- [ ] Root inventory restored from cached base bytes if it was overwritten
- [ ] Committed versions reverted logically by default; destructive rollback
      gated behind explicit confirmation and externally logged
