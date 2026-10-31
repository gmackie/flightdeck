# Lifecycle serving read model (not live)

Status: **library only.** The tables, repository and route handler exist and are tested against
D1, but nothing writes to them and nothing routes to them. No projector, ingestion source or
reducer is connected, and `/api/*` does not dispatch to these routes. Nothing here works
end-to-end yet.

## What it is

A derived, rebuildable D1 read model for lifecycle process analytics
(`apps/flightdeck/migrations/0020_lifecycle_serving.sql`, `apps/flightdeck/src/lifecycle-serving/`).
It stores snapshots a projector computes from lifecycle evidence. It is never the source of truth:
`LifecycleSnapshotRepository.dropApp()` followed by a replay must always be safe. The one
exception is deletions: tombstones (migration 0021) persist through rebuilds so a replay cannot
recreate a deleted case.

| Table | Holds |
| --- | --- |
| `lifecycle_projection_state` | per-app active/building/issued generation, source watermark, `as_of`, last run diagnostics (codes only) |
| `lifecycle_process_definitions` | process key, version, label, ordered stages |
| `lifecycle_case_snapshots` | one row per case: status (open/closed), outcome, current stage, parent, times, provenance |
| `lifecycle_stage_intervals` | per-case stage intervals (`active`/`paused`/`blocked`), open intervals have `exited_at = NULL` |
| `lifecycle_case_edges` | typed relations between cases (parent links live on the case row) |
| `lifecycle_replay_requests` | queued rebuild requests for a future projector |
| `lifecycle_case_tombstones` | persistent deletions: opaque case id, reason slug, deletion watermark, restore approval (migration 0021) |

Every key starts with `app_id`. Ids are opaque tokens (`[A-Za-z0-9_-]{1,64}`, so no emails);
keys/outcomes/relations are lowercase slugs; labels are definition metadata with a narrow charset.
Projectors must still derive ids with a keyed hash rather than reuse names.

## Projector contract (`repository.ts`)

1. `beginRebuild(app)` issues generation N (never reused, even after a failure).
2. Write `upsertProcessDefinition` / `upsertCase` / `tombstoneCase` with provenance
   `{ generation: N, source_watermark, as_of, reducer_version }`.
3. `commitRebuild(app, provenance)` activates N and soft-deletes (`superseded`) rows from older
   generations that were not rewritten; or `failRebuild(app, N, code)`.
4. Between rebuilds, write incremental updates with the active generation, then
   `advanceWatermark`. During a rebuild, write them with the building generation: rows from the
   active generation that the rebuild does not rewrite are superseded on commit.

A write lands only if it is not older than the stored row by `(generation, source_watermark)`;
otherwise it returns `stale`. Replaying the same snapshot is idempotent. A case write replaces its
intervals and outgoing relations atomically. Parent links that would form a cycle are rejected.
Retention: `applyRetention(app, closedBefore)` soft-deletes closed cases; `purgeDeleted` removes
soft-deleted rows for good.

### Deletion and restore

- `tombstoneCase(app, caseId, provenance, reason?)` removes the case row, its intervals and its
  outgoing relations immediately, and records a tombstone. It works for cases never projected
  (deletion arriving before the snapshot) and regardless of generation state, so an erasure is
  never refused. Re-deleting keeps the highest deletion watermark.
- While a tombstone is active, `upsertCase` returns `tombstoned` and writes nothing, for every
  generation and watermark, including an exact replay and a full rebuild.
- Tombstones survive `commitRebuild`, `purgeDeleted` and `dropApp`.
- `restoreCase(app, caseId, { reason, approval_ref }, authorize)` needs an injected
  `RestoreAuthorizer`; there is no default, and a checker that throws or returns false refuses
  the restore. After a restore only snapshots strictly newer than the deletion watermark land;
  the pre-deletion evidence stays refused. Deleting again re-arms the tombstone.
- Incoming relations from other cases to a deleted case are hidden by the read API; a child of a
  deleted parent reports the parent as `available: false`.

## Read API (`routes.ts`)

All `GET`, under `/api/apps/:app/lifecycle/`:

| Path | Capability | Notes |
| --- | --- | --- |
| `processes` | `lifecycle:read` | `process_key`, `limit` (≤100), `cursor` |
| `cases` | `lifecycle:read` | `process_key`, `version`, `status`, `outcome`, `stage`, `parent`, `started_after`, `started_before`, `limit`, `cursor` |
| `cases/:id` | `lifecycle:read` | intervals, parent (flagged when not projected), ≤100 children, relations, provenance |
| `summaries/stages` | `process:read` | dwell per stage/state; requires `process_key` + `version`; window ≤366 days (default last 30) |
| `summaries/outcomes` | `process:read` | closed cases by outcome plus open count; same filters |

Every response: `{ app_id, as_of, data_freshness, cohort, sample_count, suppressed, suppression,
data, page? }`. `data_freshness.status` is `unavailable` until a projection is committed, then
`fresh`/`stale`. Unknown or repeated parameters are 400s. Open intervals are censored: counted,
never included in dwell.

`suppression` labels exactly what was done:

| Endpoint | `policy` | `min_cohort` | `unit` | `sample_count_of` |
| --- | --- | --- | --- | --- |
| `summaries/*` | `min_cohort` | configured (default 5, floor 2) | `distinct_cases` | `released_groups` |
| `processes`, `cases` | `not_applicable` | `null` | `null` | `returned_rows` |
| `cases/:id` | `not_applicable` | `null` | `null` | `case` |

`withheld` (and its shorthand `suppressed`) is true when at least one aggregate group was
withheld. The number of withheld groups and their sizes are never disclosed. Case lists and
detail are not cohort-suppressed: they return individual opaque cases, which is what the
`lifecycle:read` capability grants.

Diagnostics (`repository.diagnostics`) return counts and codes only: no case ids, approval
references or snapshot content. Error and reason codes must be slugs.

## Integration hook

Authorization is injected and **denies by default**. Once the RBAC module (FLIG-18) lands, the
`/api/*` dispatcher wires it after `authenticate()`:

```ts
const served = await lifecycleServingRoutes(request, env, principal, {
  authorize: ({ principal, appId, capability }) =>
    authorizeLifecycleRead(env, principal, appId, capability),
});
if (served) return served;
```

The handler authorizes before validating anything, fails closed (503) if the checker throws,
and refuses a scope for a different app. A projector from the lifecycle reducer is the other
missing piece.
