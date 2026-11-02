# Lifecycle erasure and retention (FLIG-35, default off, not deployed)

Readiness for erasing and expiring lifecycle data. **Nothing here has been run against a real
Basin catalog, R2 bucket or remote D1, and no erasure has been performed.** The D1 side is
tested with synthetic data. The Iceberg side is a contract plus documented statements that no
one has executed. Until the gates at the end are closed, do not tell anyone data was erased from
Basin.

Code: `apps/flightdeck/src/lifecycle-erasure`. Migrations: `0041_lifecycle_erasure_retention.sql`
(tables, on main) and `0043_lifecycle_erasure_review_fixes.sql` (the independent-review fixes
below; additive columns, a writer-fence table and triggers). Both are inert while the modes are
`off`. Existing `eraseCase` behavior is unchanged.

**Migration order.** Main has `0031` (tombstones), `0032` (rebuild staging), `0040` (privacy
budget), `0041` and `0042` (serving retention). 0043 follows them; 0041 was already on main when
the review findings landed, so it was extended in a new file, never edited. **0043 deletes every
existing row of `lifecycle_retention_checkpoints`**: a checkpoint recorded under the old rule could
cover sequence numbers that did not exist yet, and cannot be told apart from an honest one.
Retention retires nothing for an app until it is reconciled again. Re-check `ls
apps/flightdeck/migrations` and open PRs for a new 0043 before merging.

## Where lifecycle data lives, and who can delete it

| Store | Holds | How it is deleted |
| --- | --- | --- |
| D1 `lifecycle_event_log`, queue, diagnostics, served `lifecycle_*` rows | Replay input and read model | D1 `DELETE` (this Worker). Immediate, but see "D1 backups" below. |
| D1 `lifecycle_case_tombstones`, `lifecycle_snapshot_tombstones` (0031) | Opaque case id + reason; block resurrection at ingest and in the read model | Kept on purpose. |
| Basin `LIFECYCLE_EVENTS` -> Iceberg table (data files + metadata in R2) | Forwarded copy of every accepted event | **Not from this Worker.** An Iceberg-compatible engine, through the catalog, in two phases below. |

Per the Cloudflare Basin Catalog docs (page last updated 2026-10-01) and Basin SQL limitations
(2026-10-21):

- Basin SQL is read-only (`INSERT/UPDATE/DELETE` return "only read-only queries are allowed").
  It can verify absence, never cause it.
- Deletes must go through the catalog in a transaction. Never delete R2 data or metadata files
  by hand: that can corrupt the catalog.
- An Iceberg `DELETE` (Spark) writes a **new snapshot** and marks files for cleanup. The old
  files, and the deleted rows, stay readable through older snapshots (time travel) until those
  snapshots are expired, and unreferenced files are removed by `expire_snapshots` /
  `remove_orphan_files`, or by the catalog's automatic snapshot expiration.
- `retain_last` keeps that many snapshots **regardless of age**. The docs' example uses
  `retain_last => 5`, and the automatic policy takes `--retain-last 5`. With those values the
  deleted rows survive until five newer snapshots exist. Erasure cleanup therefore needs
  `retain_last => 1`.

These are the only external facts relied on. They were read from the pages above on
2026-11-01 and should be re-read at release time.

## The erasure protocol

An operator requests erasure of `(app, case)`. There is no HTTP route, binding method or MCP tool
for this: a producer or dashboard user cannot trigger or influence it (a deliberate gate, below).

| Stage | Meaning | Advances when |
| --- | --- | --- |
| `requested` | Accepted. The request already wrote a tombstone and removed the case's log rows, queue entry, diagnostics and served rows in one atomic D1 batch. | Local residue check finds nothing left. |
| `local_hidden` | Hidden and held locally. New events for the case are accepted but dropped and counted (`erased_case_event`). | Settle time is scheduled. |
| `basin_pending` | Waiting for the **outbox writer fence** (no send for the case may still be in flight), then the drain bound after the last one (default 15 min, an assumption), then for the runner's **logical-delete receipt**. | A valid `logical_delete` receipt. |
| `basin_verified` | The Iceberg `DELETE` committed and the current snapshot holds no matching row. **Logical only: the data files still exist.** | Cleanup delay (default 1 h) passes. |
| `files_cleanup_pending` | Waiting for the **physical-cleanup receipt**. | A valid `physical_cleanup` receipt. |
| `complete` | The deleted bytes are gone: the DELETE was materialized, the data files that held the rows are absent from every retained snapshot and from storage, no delete file applies, older snapshots expired, orphans removed, all after the cleanup deadline; and the local holds were re-verified at that moment. The only state that may be reported as erased. | -- |
| `failed` | Retries exhausted (8, backing off 1 min doubling to 6 h) or a non-retryable error. The local hold stays. | An operator reopens it. |

Properties, all covered by `test/erasure-*.test.ts`:

- **Idempotent.** Repeating the request returns the same job. `repurge` opens generation N+1 only
  after N completed. Erasing a case never seen before, or one erased earlier by `eraseCase`,
  works; a legacy tombstone is upgraded to a tracked job.
- **Never complete without receipts.** The state machine reaches `complete` only from
  `files_cleanup_pending` on an accepted physical receipt, and D1 `CHECK`s on the table refuse a
  `complete` row without both receipt checksums.
- **Fail-closed executor.** `BasinErasureExecutor` (`executor.ts`) is an interface with no shipped
  implementation. The default throws `executor_unconfigured`: the job waits (no attempt spent) and
  `health` shows `executor_configured: false`. Whatever an executor returns is untrusted until
  verified.
- **Backoff and leases.** One stage per claim, a version-checked lease per job, so overlapping cron
  runs never double-dispatch.
- **Machine-only audit.** `lifecycle_erasure_events` stores stage, a `[a-z0-9_.:-]` code, the
  hashed case identity, actor kind/opaque id, `last_verified_at`, policy version and evidence
  checksum (enforced by `CHECK`). No case id, payload, receipt body or error message is stored or
  logged.
- **Authorization.** Requests, receipts and reopen need an operator actor scoped to the app. The
  scheduled job can only advance existing jobs. Every query binds `app_id`.

## Receipts: proof of deletion vs "not verified"

A receipt is `{ payload, signature, key_id }`. The runner signs the canonical payload with
**Ed25519**; the Worker holds only the **public** key (`LIFECYCLE_ERASURE_RECEIPT_KEYS`, JSON
`{ "<key_id>": "<base64 raw 32-byte key>" }`). A caller, a leaked Worker config or a compromised
Worker therefore cannot mint one. With no key configured every receipt is rejected.
A receipt is bound to one job by `app_id`, the hashed case identity, `purge_generation` and a
random per-request `nonce`, so it cannot be replayed for another case or generation. The two kinds
are not interchangeable.

**What each receipt must attest.** A DELETE that leaves zero query-visible rows is not physical
deletion: with merge-on-read the original data file keeps the bytes behind a delete file, and older
snapshots keep referencing the files. So:

- `logical_delete`: the DELETE snapshot and commit time; `rows_remaining = 0` in the current
  snapshot; `delete_mode` (`copy_on_write` | `merge_on_read`); and `affected_files_digest`, the
  hash of the sorted paths of the data files that held the rows, read **before** the DELETE.
  Its commit must be after the writer fence and drain (below). Stage: `basin_verified`, logical only.
- `physical_cleanup`: the same `delete_mode` and `affected_files_digest`; `materialized_at`, the
  commit of the rewrite that dropped the bytes (for merge-on-read a **separate commit after** the
  DELETE; for copy-on-write the DELETE itself); `affected_files_remaining = 0` and
  `delete_files_applying = 0`; `expired_at`/`expired_before` and `orphans_removed_at`, each **at or
  after the cleanup deadline** (logical commit + cleanup delay), in order
  `materialized <= expired <= orphans removed <= issued`; `oldest_retained_committed_at` and
  `expired_before` not earlier than the materializing commit; `retained_snapshots_with_rows = 0`.
  A receipt that only reports zero visible rows plus removed orphans is refused.

Sample **fake** receipts (synthetic; the signatures are not valid for any key):

```jsonc
{ "payload": { "v": 1, "kind": "logical_delete", "app_id": "app_demo",
    "case_digest": "<64 hex>", "purge_generation": 1, "nonce": "<32 hex>",
    "table": "r2dc.flightdeck.lifecycle_events", "issued_at": 1900000100000,
    "predicate": "digest_v1", "snapshot_id": "7000000000000000001",
    "committed_at": 1900000050000, "rows_deleted": 3, "rows_remaining": 0,
    "delete_mode": "merge_on_read", "affected_files_digest": "<64 hex>", "affected_files": 2 },
  "signature": "<88-char base64>", "key_id": "runner-2026-11" }

{ "payload": { "v": 1, "kind": "physical_cleanup", "app_id": "app_demo",
    "case_digest": "<64 hex>", "purge_generation": 1, "nonce": "<32 hex>",
    "table": "r2dc.flightdeck.lifecycle_events", "issued_at": 1900003900000,
    "logical_receipt_checksum": "<sha256 of the canonical logical payload>",
    "snapshot_id": "7000000000000000001", "delete_mode": "merge_on_read",
    "affected_files_digest": "<same 64 hex>", "materialized_at": 1900001000000,
    "affected_files_remaining": 0, "delete_files_applying": 0,
    "expired_at": 1900003700000, "expired_before": 1900001000000,
    "oldest_retained_committed_at": 1900001000000, "retained_snapshots_with_rows": 0,
    "orphans_removed_at": 1900003800000 },
  "signature": "<88-char base64>", "key_id": "runner-2026-11" }
```

| What you can say | Required evidence |
| --- | --- |
| "Erased from D1 and hidden" | Job at `local_hidden` or later. |
| "Logically deleted from Iceberg; **not** physically erased" | `proof: "logical_only"` (`basin_verified`, `files_cleanup_pending`, or `failed` after a logical receipt). |
| "Physically erased from Basin storage" | `proof: "physical_verified"` (`complete`) **and** the runner is trusted. |
| "Not verified" | Everything else, including `executor_unconfigured`, `failed`, and any job whose receipts were rejected. |

What verification does **not** prove: that the runner really executed the SQL, listed the files
correctly, or that no other copy exists. A valid receipt means a holder of the runner's private key
attests it. See the gates.

### Outbox writer fence

Deleting D1 rows does not cancel a send already handed to Pipelines. While erasure is not `off`,
`forwardOutbox` claims each case of a batch (refusing tombstoned cases in the same statement)
before sending, and releases the claim afterwards (`lifecycle_forward_claims`). A job stays in
`basin_pending` while a claim is live, and the DELETE is accepted only after the last release (or
lease expiry, 15 min) plus the drain bound (`LIFECYCLE_ERASURE_DRAIN_MS`, default 15 min, for
Pipelines to commit what it accepted). The drain bound and lease are assumptions, not measurements.
With erasure `off` no claims are written.

### Completion re-checks the local holds

Before a logical or physical receipt is accepted, and before the runner is called, the job
re-verifies that no log, queue, diagnostic, served, interval or edge row exists for the case and
that both the ingest tombstone and an unrestored serving tombstone are present. If an in-flight
projection or a lost tombstone broke that, it re-hides the case and refuses (`local_fence_broken`).

## Statements for the external runner (unverified, never run by Flightdeck)

Rendered by `spark.ts`; the case id never appears in the text. Run in an Iceberg-compatible engine
(Spark) against the catalog, with `spark.sql.session.timeZone=UTC`. `:case_digest` is
`sha256("flightdeck.erasure.v1|<app_id>|<case_id>")` in lowercase hex.

```sql
-- 0. BEFORE the DELETE: the data files that hold the identity's rows. Record sha256 of the sorted
--    paths as affected_files_digest.
SELECT DISTINCT input_file_name() AS file_path FROM r2dc.flightdeck.lifecycle_events
WHERE app_id = :app_id
  AND sha2(concat_ws('|', 'flightdeck.erasure.v1', app_id, case_id), 256) = :case_digest
ORDER BY file_path;

-- 1. Logical deletion. No-op when nothing matches, so re-runs are safe.
DELETE FROM r2dc.flightdeck.lifecycle_events
WHERE app_id = :app_id
  AND sha2(concat_ws('|', 'flightdeck.erasure.v1', app_id, case_id), 256) = :case_digest;

-- Verify (also valid Basin SQL, which is read-only):
SELECT count(*) AS rows_remaining FROM r2dc.flightdeck.lifecycle_events
WHERE app_id = :app_id
  AND sha2(concat_ws('|', 'flightdeck.erasure.v1', app_id, case_id), 256) = :case_digest;

-- 2. Merge-on-read only: materialize the delete as its own commit. (Copy-on-write already
--    rewrote the files; the table property write.delete.mode = 'copy-on-write' avoids this step.)
CALL r2dc.system.rewrite_data_files(table => 'flightdeck.lifecycle_events',
  where => "app_id = '<app_id>'", options => map('delete-file-threshold', '1'));
CALL r2dc.system.rewrite_position_delete_files(table => 'flightdeck.lifecycle_events',
  options => map('rewrite-all', 'true'));

-- 3. Physical cleanup, with older_than = the materializing commit's time (the DELETE's for
--    copy-on-write), at or after the cleanup deadline.
CALL r2dc.system.expire_snapshots(table => 'flightdeck.lifecycle_events',
  older_than => TIMESTAMP '<materialized_at, UTC>', retain_last => 1);
CALL r2dc.system.remove_orphan_files(table => 'flightdeck.lifecycle_events');
```

Then the runner must check that none of the recorded files exists in any retained snapshot
(for example Iceberg's `all_data_files` metadata table) or under the table's R2 prefix, that no
delete file applies, and that no branch or tag pins an older snapshot. `rewrite_data_files`
options, the `all_data_files` check and file-level removal are **unverified against a real
Basin catalog**. Cost: the predicate hashes `case_id`, so it cannot prune files by case: it scans
the app's files per DELETE and rewrites the files that contain a match. Batching many cases into
one run is a runner optimization not built here.

**Timing.** Physical deletion is not immediate. Earliest completion is the writer fence and drain
(default 15 min after the last in-flight send), then the DELETE, then `cleanup delay` (1 h) before
cleanup may run, plus the runner's schedule; if the catalog's automatic snapshot expiration is used
instead, it is its configured age (the docs' example is 30 days) **and** its `retain-last`, and it
does not materialize merge-on-read deletes. Set these to values the privacy policy accepts, or run
manual cleanup. **D1 backups:** D1 Time Travel can restore a database to a past point, so D1
deletions persist in backups for their retention period (verify the current period for the plan in
use).

## Retention (D1 replay log), default off

`LIFECYCLE_RETENTION_MODE`: `off` (default, inert) | `dry_run` (report only) | `enforce`.
Anything else, or any invalid policy value, is `off` and listed in `config_problems`. Periods have
no defaults: `LIFECYCLE_RETENTION_POLICY_VERSION`, `..._CLOSED_DAYS` (>= 366, the served window),
`..._LOG_DAYS` (>= closed days), optional `..._BATCH` (default 200).

A case's log rows are retired, whole case at a time and only if **all** hold (re-checked inside the
deleting transaction): closed in the committed read-model generation and reflected by it; closed
and last received longer ago than the policy; nothing queued; every row forwarded; every row at or
below a **signed Basin reconciliation checkpoint**; no tombstone. Retiring writes a
`retention_expired` tombstone, so a late event, retry or backfill is dropped and counted
(`retention_expired_case_event`) instead of resurrecting a partial case. It leaves the served
snapshot alone, and a later rebuild carries retired cases over unchanged (their replay log is gone,
so they cannot be recomputed).

**Reconciliation checkpoints** (`recordReconciliation`, same Ed25519 scheme) cover a range
`(after_seq, through_seq]` of the app's log rows and are checked against D1 when recorded:

- `through_seq` and the attested `allocated_seq` may not exceed the highest sequence ever
  allocated (`sqlite_sequence`), which never goes down. A checkpoint therefore cannot cover rows
  that do not exist yet, and an empty app's checkpoint covers nothing that is ingested later.
- The range must start at or below the current checkpoint (no unattested gap) and must advance it.
- `event_count` **and** `rows_digest` must match the rows now in D1, and none may be unforwarded.
  The digest is a hash chain over `seq|event_id|fingerprint`, 500 rows a page (`rowsDigest`), so a
  runner can recompute it from what Basin holds. Ranges are limited to 20,000 rows per attestation.

**Scanning.** A run resumes from a persisted cursor (`scan_cursor`), examining up to 2,000 cases
in id order and stopping once `batch` are eligible. Blocked cases cost scan budget, not batch
slots, so one case that stays blocked cannot hide the ones after it.

| | Reversible | Physical |
| --- | --- | --- |
| Serving soft-delete (`LifecycleSnapshotRepository.applyRetention`, existing, not scheduled) | Yes (`deleted_at`) | No |
| Log retirement (this work) | No: Basin holds the only copy afterwards | D1 rows deleted |
| Erasure | No | D1 now; Basin only via receipts |

Retention never deletes from Basin, and is not erasure. `inspectRetention` (any mode) reports
eligible cases/events/bytes, blockers by reason and checkpoint age, with no ids. Erasure health
(`erasureHealth`) reports jobs per stage, proof levels, blocked and overdue counts.
Not built: scheduled serving soft-delete/purge, a retention schedule for Basin tables, legal holds.

## Release playbook

1. **Review.** Privacy: confirm case ids are opaque (the ingest denylist is best-effort, see
   lifecycle-ingestion.md). Cost: DELETE scan/rewrite per case, snapshot and R2 retention until
   cleanup, D1 rows. Record both in the issue.
2. **Approve.** A named operator and a second approver sign off on the retention schedule and the
   `retain_last`/expiration settings. Record the policy version.
3. **Runner.** Build the runner outside this Worker (gate 1). It signs receipts with a private key
   held only by it; add the public key to `LIFECYCLE_ERASURE_RECEIPT_KEYS`.
4. **Migrate staging D1** (`wrangler d1 migrations apply ... --env staging`), set
   `LIFECYCLE_BASIN_TABLE`, `LIFECYCLE_ERASURE_POLICY_VERSION`, then
   `LIFECYCLE_ERASURE_MODE=dry_run`. Before the first real request, set it to `enforce` and wait
   longer than the sender lease (15 min): the outbox writer fence only exists once the mode is on,
   and sends that started before it are covered only by that wait.
5. **Drills (staging, synthetic data only).** (a) dry run: plan shows statements, writes nothing;
   (b) erase a synthetic case with the executor unconfigured: job waits, `proof: none`;
   (c) with the runner: logical receipt -> `logical_only`; confirm via Basin SQL that the rows are
   gone from the current snapshot yet readable by time travel; (d) cleanup -> `complete`; confirm
   old snapshots and files are gone; (e) forge a receipt with a wrong key and with a changed
   nonce: both rejected; (f) kill the runner mid-job: backoff, then `failed`, then reopen.
6. **Production** only when every gate is closed and the operator approval is recorded.

## Integration gates (all open)

1. **No runner exists.** The Spark/Iceberg statements and the receipt contract are untested
   against a real catalog. Not verified: the `sha2(concat_ws(...))` predicate on Basin's table,
   whether `rewrite_data_files` with `delete-file-threshold` materializes merge-on-read deletes
   there, snapshot expiration semantics, branches/tags, and how the runner derives the file
   digest, `affected_files_remaining`, `delete_files_applying`, `oldest_retained_committed_at` and
   `retained_snapshots_with_rows`.
2. **No operator surface.** There is deliberately no route or CLI to request erasure, submit
   receipts or reopen jobs. It needs an authenticated, audited operator entry point.
3. **Receipt trust is external.** Key custody, rotation (single active key set, no overlap
   handling) and runner integrity are unreviewed.
4. **Reconciliation source.** `recordReconciliation` accepts a signed attestation; nothing
   produces one yet.
5. **Rebuilds from Basin** must consult `lifecycle_case_tombstones`; no such rebuild exists yet.
6. **Other copies** (D1 backups, Pipelines buffers/DLQ, exports, logs) are out of scope.
7. **Fence assumptions.** The 15-minute sender lease and drain bound are assumptions about
   Worker invocation lifetime and Pipelines commit latency, not measurements. A sender running
   without the fence (started before erasure was enabled) is covered only by that bound.
8. Staging drills above have not been run.
