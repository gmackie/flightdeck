# 07 Operations: replay, reconciliation, diagnostics

## 7.1 Service levels (proposed)

| SLI | Target | Measured by |
|---|---|---|
| Ingest availability (non-4xx responses that are not 503) | 99.9% monthly | Worker analytics on `/v1/lifecycle/events` and RPC error logs |
| Projection lag: `projected_at − last_received_at` per case | p95 < 10 s, p99 < 60 s | `li_ops_minute` (§7.6) |
| Reconciled completeness: hours with `status = ok` among closed receipt hours older than 2 h | ≥ 99.5% weekly | `li_reconcile_runs` |
| Erasure: request to read-model erased | < 1 h | `li_erasures` |
| D1-served API latency | see 12 | Worker analytics |

## 7.2 Replay

Replay rebuilds CaseDOs and D1 from raw evidence. It is the **only** sanctioned way to repair or
reshape the read model.

Inputs: `app_id`, optional `process_id`, optional case list, `since`/`until` on `received_at`, and
`mode`:

| Mode | Effect |
|---|---|
| `verify` | Fold from raw evidence and compare with the current projection. Writes nothing; reports differences. |
| `merge` | Append raw events missing from the CaseDO log, then re-fold and re-project. Safe at any time. |
| `rebuild` | Erase the CaseDO and D1 rows for the selected cases, then append all raw events. Used after semantics changes in B's engine. |

Mechanics:

1. **Enumerate cases** with Basin SQL over `lifecycle_events`, deduped on `(app_id, event_id)`:
   `SELECT DISTINCT process_id, case_id FROM … WHERE app_id = ? AND received_at BETWEEN ? AND ?`.
2. **Fetch each case's events** (`WHERE app_id = ? AND process_id = ? AND case_id = ?`, ordered by
   `received_at`) in pages of at most 2,000 rows.
3. **Call `CaseDO.replay(rows, mode)`.** It skips erased cases, uses the same append path as ingest
   (so dedupe and conflicts behave identically) and projects once at the end rather than per page.
4. **Checkpoint** progress in `li_replay_jobs(job_id, cursor, done, failed, started_at, finished_at)`
   so a job resumes after a Worker restart.

Runner: a Workflow (Cloudflare Workflows, one step per page of cases) is preferred, because its
steps retry on their own and survive restarts. If Workflows isn't available in the deployment, the
cron trigger processes up to 200 cases per tick from the job cursor. Either way, replay is
rate-limited to 50 CaseDO calls per second per app so it doesn't starve live ingest.

Erased cases: replay consults `li_erasures` and never resurrects an erased case, even though its raw
rows may still exist (06 §6.6).

## 7.3 Cron schedule (proposed `triggers.crons` in `wrangler.jsonc`)

| Schedule | Job | Reads | Writes |
|---|---|---|---|
| `*/5 * * * *` | Aggregate dirty days → `li_daily_*`; evaluate alerts (09) | `li_dirty_days`, `li_cases`, `li_stage_instances` | `li_daily_*`, `li_alert_state` |
| `17 * * * *` | Reconcile the receipt hour that ended 2 h ago (§7.4) | Basin SQL; `li_cases` | `li_reconcile_runs`, replay jobs |
| `40 3 * * *` | Retention sweep (06 §6.5); stale DO cleanup | D1 | D1 deletes |
| `0 6 * * 1` | Weekly scorecard snapshots (09) | `li_daily_*` | `li_scorecard_snapshots` |

Each job takes a lease row (`li_leases(job, holder, until)`) so overlapping ticks never run the same
job twice.

## 7.4 Reconciliation

Goal: prove that every accepted raw event reached the read model, without trusting the read model.

For receipt hour H (closed at least 2 h ago, so Iceberg files have rolled; the sink roll interval
is 60 s on `main`):

1. **Raw side** (Basin SQL):
   `SELECT process_id, case_id, count(DISTINCT event_id) AS n FROM lifecycle_events
   WHERE app_id = ? AND received_at >= H AND received_at < H + 1h GROUP BY process_id, case_id`.
2. **Projected side**: for the same `(process_id, case_id)` set, ask each CaseDO for
   `countReceivedBetween(H, H + 1h)`. Use D1 (`li_cases.last_received_at`) only to skip cases whose
   last receipt is before H. Batch: at most 500 cases per hour per app; above that, sample 500 and
   record `sampled: true`.
3. **Compare.** If equal → `ok`. If raw > projected → enqueue a `merge` replay for the differing
   cases → `replayed` once it finishes. If projected > raw → the evidence is missing from Iceberg
   (sink loss or a dropped send) → `mismatch`, alert operators (it means the store of record lost
   data).
4. Store `li_reconcile_runs` and expose it as `freshness.verified_through` (08).

If Basin SQL lacks `count(DISTINCT …)` or `GROUP BY` over these columns (G6), step 1 falls back to
fetching `(process_id, case_id, event_id)` rows for the hour and counting in the Worker, within the
budgets in 12.

## 7.5 Diagnostics catalog

Diagnostics are facts about data quality, attached to a case and stored in `li_diagnostics`. They
never block ingest (except where noted in 03), and they show up in the API and UI so producers can
fix their emitters.

| Code | Severity | Raised when | Fix |
|---|---|---|---|
| `conflicting_duplicate` | error | Same `eventId`, different payload | Producer bug: ids must be stable per fact; send `event.corrected` instead |
| `implicit_exit` | warn | `stage.entered` while another stage is open | Emit `stage.exited` explicitly |
| `exit_without_entry` | warn | Exit for an unknown instance | Check instance ids |
| `unblock_without_block` / `resume_without_pause` | warn | Unpaired end | Check `reason` pairing |
| `duplicate_block` / `duplicate_pause` | info | Second start while open | Usually harmless |
| `block_closed_by_exit` / `pause_closed_by_close` | info | Open interval ended by exit or close | Emit the end explicitly if timing matters |
| `orphan_correction` | warn | Correction target never arrived | Resend target or drop correction |
| `event_after_close` | warn | Stage event after close, no reopen | Send `case.reopened` or fix timestamps |
| `missing_case_created` | warn | No `case.created` | Emit it |
| `version_mismatch` | error | Event version ≠ pinned version | Use `case.migrated` (05 §5.4) or the pinned version |
| `deprecated_definition` | info | New case on a deprecated version | Move to the current version |
| `invalid_interval` | error | End < start after corrections | Fix timestamps |
| `parent_cycle` / `parent_depth` | error | Hierarchy violation | Fix parent links |
| `drift` | warn | A producer snapshot (§7.8) disagrees with the projection | Producer sends missing events or corrections |
| `retention_expired` | info | Open case force-closed by retention | Close cases in the producer |
| `late_arrival` | info | `received_at − occurredAt > 7 d` for a non-backfill source | Check the producer outbox |

## 7.6 Observability

- **Structured logs**, never payloads: `{ evt: "li.ingest", app, process, cases, events, duplicates,
  ms, status }`, `{ evt: "li.project", app, process, case_hash, lag_ms, rows }`. A case id is
  logged only as a truncated SHA-256 (`case_hash`), so logs never become a second copy of
  pseudonymous ids.
- **`li_ops_minute(app_id, minute, ingested, duplicates, rejected, projected, projection_lag_p95_ms,
  d1_errors)`**, written by a small per-app ops counter in the CaseDO projection path, flushed
  like `AppDO` minutes. It feeds `freshness.lag_p95_ms` and `create-flightdeck li doctor`.
- **Health**: `GET /api/apps/:app/li/health` (`owner`) returns the last reconcile status per hour
  for 48 h, the replay jobs, cases with `dirty_since` older than 5 min, and diagnostic counts by
  code.

## 7.7 Backups and the raw tier

- D1 Time Travel covers the read model, but restoring it is rarely needed: replay rebuilds it.
- The raw tier is the store of record. Operators should enable R2 bucket versioning or
  replication for the lifecycle bucket if they need protection from accidental deletion. Whether
  versioning interacts safely with Basin Catalog compaction is unverified (G6).
- **Retention and erasure rewrites** of Iceberg need an engine that can write Iceberg (Spark, or a
  DuckDB/PyIceberg job with catalog credentials). This RFC specifies the job's contract (delete rows
  `WHERE app_id = ? AND (received_at < cutoff OR case_id IN erased)`, then expire snapshots older
  than 7 days), not its implementation, until G6 settles what Basin offers natively (OQ-3).

## 7.8 Drift detection (optional)

A producer may periodically send a **snapshot**: `POST /api/apps/:app/li/snapshots` (`owner`
service key) with `[{ processId, caseId, status, currentStageId }]` from its own database. Flightdeck
compares it with `li_cases` and raises `drift` per mismatch. Flightdeck never changes the projection
to match the snapshot (02 §2.1, rule 1).

## 7.9 Runbooks

**Projection lag rising.** Check `li_ops_minute.d1_errors`. If D1 errors spike, CaseDO alarms back
off on their own; nothing to do unless it lasts more than 15 min. Then run
`create-flightdeck li doctor --app <app>` and look for hot cases (one case receiving thousands of
events, which hits `MAX_CASE_EVENTS`).

**Reconcile `mismatch` (projected > raw).** Stop and investigate: raw evidence is missing. Compare
stream metrics for the hour, check sink errors, and confirm whether the Pipeline was paused. Do not
replay `rebuild` for those cases; that would discard events that exist only in the CaseDO. Export
the CaseDO logs (`li export-case`) first.

**Semantics change in B's engine.** Bump `FOLD_VERSION`. CaseDOs re-fold lazily on next access, and
a `rebuild` replay per process over the retention window re-projects D1. Document the change in the
release notes, because historical numbers move.

**Producer sent garbage for a day.** The producer sends `event.corrected` retractions for the bad
`eventId`s. Do not delete raw rows.

**Erasure request.** 06 §6.6. Confirm the tombstone with `GET /api/apps/:app/li/erasures/:case`.
