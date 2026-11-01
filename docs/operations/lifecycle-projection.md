# Lifecycle projection (integrated vertical slice, not deployed)

How accepted lifecycle events become the served read model: ingest (FLIG-19, FLIG-25) → D1
evidence log → replay engine (FLIG-16) → serving tables (FLIG-21) → read API under read grants
(FLIG-18) → dashboard (FLIG-15). Code: `apps/flightdeck/src/lifecycle-projection`. Migration:
`0030_lifecycle_projection.sql`. Nothing here has been applied remotely or deployed.

## Roles of each store

| Store | Role |
| --- | --- |
| The producing domain app | Operational source of truth. Flightdeck never writes back. |
| `lifecycle_event_log` (D1) | Commit point for accepted events and the projector's replay input. |
| Basin `LIFECYCLE_EVENTS` | Long-term historical evidence, fed from the log's outbox columns. |
| `lifecycle_*` serving tables (0020) | Derived, rebuildable snapshots. Safe to drop and replay. |

## Flow

1. `POST /v1/lifecycle/events` or `ingestLifecycleBatch` validates the batch (schema, registered
   process version, definition conformance) and, in **one D1 transaction**, appends it to
   `lifecycle_event_log` (exact retries dedupe on `(app_id, event_id, payload fingerprint)`) and
   queues its cases in `lifecycle_projection_queue`. That transaction is the commit point.
2. The batch is forwarded to Basin at once if the stream is bound; otherwise it stays pending in
   the outbox. Projection then runs after the response (`waitUntil`).
3. The projector replays each queued case from **its full stored history** through the engine,
   maps the result to a snapshot (stage attempts split into active/blocked/paused segments) and
   writes it with provenance `(generation, source_watermark, as_of, reducer_version)`. Late,
   reordered and corrected events need no special path: the whole case is replayed.
4. An app that was never projected is **rebuilt**: a new generation is written from the log and
   activated at once. `LifecycleProjector.rebuild(appId)` repeats that on demand (for example
   after bumping `REDUCER_VERSION`).
5. A cron (`*/5 * * * *`, `src/lifecycle-projection/schedule.ts`) retries due projection work
   and forwards pending outbox rows.

## Canonical vocabulary

`src/lifecycle-projection/vocabulary.ts` is normative. In short:

- **Ordering:** `sourceSequence` is authoritative per case, across producer names. Events in the
  same millisecond are ordered by it, never by event id.
- **Case start/end:** `case.started` opens an episode. `case.created` registers the case only.
  `case.completed` ends it as `completed`. `case.terminated` must carry `reason` set to one of
  `rejected`, `withdrawn`, `cancelled`, `failed`, `expired`. The served outcome is the `outcome`
  dimension when present (a domain code such as `hired`), else the reason.
- **Terminal stages:** the engine never infers a terminal class from A's `terminal: true`. A
  terminal stage whose id is a class name (`completed`, `cancelled`, ...) closes the case with
  that class, and the stage key becomes the outcome. Any other terminal stage does not close the
  case; entering it is reported as `terminal_stage_unclassified`. Follow-up: add an explicit class
  to `ProcessDefinitionV1` stages.
- **Stage attempts:** every entry is a new `stageInstanceId`. `stage.exited.reason` becomes the
  attempt's outcome.
- **Interruptions:** one active pause per case; one active block and one active pause per stage
  instance.
- **Relations:** `{ type: "child_of", objectType: "case" }` is the parent link. Other relations to
  `objectType: "case"` are typed edges. Relations to other object types are tracked by the engine
  but not served (counted as `object_relation_not_served`).
- **Corrections:** `retract` removes the target; `amend` may change only its time and dimensions.
  To change what happened, retract it and send new evidence. Corrections of corrections are
  reported, not applied.
- **Ids:** producer case ids that do not fit the serving id shape (`[A-Za-z0-9_-]{1,64}`, for
  example `deploy:web:42`) are served as `x-` + base64url(SHA-256(id)).

Nothing is dropped silently: every event that cannot be applied, and every fact the read model
cannot serve, is counted per case in `lifecycle_projection_diagnostics` (codes and counts only)
and summed by `GET /api/apps/:app/lifecycle/diagnostics`.

## Freshness

`data_freshness` on every read: `status` (`unavailable` until a generation is committed, then
`fresh`/`stale` from `as_of`), `projection`, `generation`, `source_watermark` and
`pending_cases`. The watermark is the highest log `seq` below every still-queued case, so all
evidence at or below it is reflected. `diagnostics` adds retrying cases and their error codes,
the outbox backlog and the engine/adapter diagnostic counts.

## Retries

A failed case projection stays queued with exponential backoff (1 s doubling, capped at 1 h) and
an error code (`projection_error`, `snapshot_invalid`, `snapshot_cycle`, `snapshot_generation`).
One bad case never blocks the rest of its app, or a rebuild (during a rebuild it is hidden
until its retry succeeds). A queue entry is only cleared if
the projection covered the newest event for that case.

## Basin outbox

`lifecycle_event_log.forwarded_at IS NULL` marks pending rows. A failing send increments
`forward_attempts`, sets `forward_error = 'send_failed'` and backs off. An unbound stream is not a
failure: rows wait without backoff. No stream id or credential is committed. Binding the real
`LIFECYCLE_EVENTS` stream is an operator step (docs/operations/lifecycle-ingestion.md).

## Erasure

`eraseCase(db, appId, caseId, servedId, reason, now)` (operator action, no API) deletes the
case's evidence, queue entry, diagnostics and served rows, and records a tombstone. Later
deliveries or backfills of that case are accepted but never stored, forwarded or projected
(counted as `erased_case_event`). This holds even if the erasure comes before the case was ever
projected, which closes the serving model's tombstone-before-first-projection gap for this path.
**Not covered:** rows already forwarded to Basin. A rebuild from Basin must consult
`lifecycle_case_tombstones`, and Basin-side deletion needs its own procedure (release blocker
for real personal-data processes).

## Known limits

- The D1 evidence log keeps every accepted event (it is the replay input). Retention and size
  limits (D1 database size) need a policy before production; compaction would require rebuilds
  from Basin.
- A rebuild runs in one invocation. Large apps will need it moved to a Workflow or Durable
  Object, paging through cases.
- The serving model's own limits (FLIG-21) still apply: per-group suppression only, with
  differencing risk across overlapping cohorts, and a 366-day aggregate window.
- Fixture correctness is proven against FLIG-20 synthetic data only. No real records were used.
