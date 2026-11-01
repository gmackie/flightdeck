# 08 Query serving and API

## 8.1 Which store answers which question (D13)

| Question | Store | Latency target | Why |
|---|---|---|---|
| Flow, stages, WIP, throughput, cohorts, scorecards over ≤ 400 days | D1 `li_daily_*` + `li_cases` / `li_stage_instances` | p95 < 300 ms (90 d), < 800 ms (400 d) | Millisecond reads, bounded rows |
| One case's timeline | CaseDO `timeline()` | p95 < 100 ms | Freshest; one object |
| Parent rollup (children by stage) | D1 `li_cases_parent` index | p95 < 200 ms | Indexed |
| Anything older than D1 retention, arbitrary SQL, raw audit, exports | Basin SQL over Iceberg, **async job** | seconds to minutes | Store of record, open format |
| Replay and reconciliation | Basin SQL | background | 07 |

Interactive endpoints never call Basin SQL. That keeps dashboard latency independent of Iceberg file
layout, and keeps scan costs out of the request path.

## 8.2 Basin SQL constraints to design around

What `main` proves about Basin SQL: the Phase 1 plan runs `wrangler basin sql query "$WAREHOUSE"
"SELECT name, count(*) … GROUP BY name"` against `flightdeck.events`
(`docs/plans/2026-10-30-flightdeck-phase-0-1-plan.html`, task 1.12). Nothing in the Worker calls
Basin SQL.

Everything else is **unverified**. [Gate G6](appendix-a-reconciliation.md#g6-basin-capability-matrix)
requires PR-02 to fill in this matrix by running each probe against a dev warehouse, and every design
choice that depends on a row has a fallback:

| Capability | Probe | Used by | Fallback if absent |
|---|---|---|---|
| Programmatic access from a Worker (REST + token) | Call the query API from a Worker with a read-only token | Replay, reconcile, Explore | Run replay and reconcile from the CLI on an operator machine |
| `GROUP BY` + `count(DISTINCT …)` | §7.4 step 1 | Reconcile | Fetch ids, count in the Worker |
| Window functions (`row_number() OVER`) | Dedupe query in 03 §3.5 | Explore, export | `GROUP BY app_id, event_id` + `min(received_at)`, or dedupe in the Worker |
| Joins | Self-join of corrections onto targets | Explore | Apply corrections in the Worker (they are rare) |
| Filtering a struct list (`relations`) | `WHERE EXISTS (… relations …)` | Explore | Filter in the Worker |
| Partition pruning on `app_id`, `received_at` | Compare scanned bytes for 1 h vs 30 d | All | Accept scan costs; tighten budgets |
| Result size limits | 100k-row query | Replay paging | Smaller pages |
| Query timeouts | 400-day scan | Explore | Split by month |
| Row-level `DELETE` or a table rewrite | Delete one row in a scratch table | Retention, erasure (06) | External Iceberg engine job (07 §7.7) |
| Consistency: visibility after sink roll | Write, then poll | Reconcile delay | Raise the 2 h delay |

Workstream "query analytics" (`packages/lifecycle-queries`, local worktree) already generates
registry-restricted `SELECT`s over a facts table and says its dialect must be validated per
deployment. It is the natural home for Explore query building once G6 is filled in.

## 8.3 Common response envelope

Every lifecycle read returns:

```jsonc
{
  "data": { /* endpoint-specific */ },
  "meta": {
    "app_id": "app_hiring",
    "process_id": "hiring.application",
    "query": { "from": "2026-07-06", "to": "2026-10-05", "cohort": "opened", "versions": [1, 2] },
    "as_of": 1791590400000,                 // the "now" used for open cases
    "freshness": {
      "source": "d1",                       // d1 | case_do | basin_job
      "projected_through": 1791590391000,   // max last_received_at already projected for this process
      "pending_cases": 0,                   // cases with dirty_since set
      "lag_p95_ms": 2100,                   // last 15 min, from li_ops_minute
      "aggregates_through": 1791590100000,  // last li_daily_* recompute
      "verified_through": "2026-10-09T21"   // last receipt hour reconciled ok, or null
    },
    "sample": {
      "n": 214, "n_closed": 168, "n_censored": 46,
      "n_excluded": 3, "excluded": { "invalid_interval": 1, "erased": 2 }
    },
    "comparability": {
      "class": "merged",                    // exact | merged | not_comparable | single_version
      "canonical": true,
      "notes": ["v2 splits onsite into technical_interview and team_interview"]
    },
    "suppression": { "k": 10, "rounded": true, "cells_suppressed": 2 },
    "method": { "percentiles": "exact", "censoring": "kaplan_meier" },
    "fold_version": 3,
    "warnings": ["2 cases in this window carry conflicting_duplicate diagnostics"]
  }
}
```

Rules:

- `n` counts distinct cases (or instances, for stage measures; the field name says which:
  `n_instances`).
- `freshness` describes data, not query execution. A client wanting "is this up to date?" compares
  `projected_through` with its own expectation and reads `pending_cases`.
- `warnings` are codes plus short fixed English strings, never data values.
- Responses are `Cache-Control: no-store` (same as `apps/flightdeck/src/api/http.ts`).

## 8.4 Endpoints

All under `/api/apps/:app/li`, all `GET` unless noted, all behind E's authorization (06 §6.4).
Common parameters:

| Param | Values | Default |
|---|---|---|
| `from`, `to` | UTC dates `YYYY-MM-DD`; `to` exclusive | last 90 days |
| `cohort` | `opened` \| `closed` \| `active` (overlapping the window) | endpoint-specific |
| `versions` | comma list, or `all` | `all` (pooled via canonical stages if comparable) |
| `stages` | `canonical` \| `version` | `canonical` when versions > 1 |
| `filter[dim]` | allowlisted dimension value | none |
| `breakdown` | one dimension with `breakdown: true` | none |
| `visits` | `all` \| `first` | `all` |
| `as_of` | epoch ms ≤ now | now |

Restricted processes enforce 06 §6.4: windows of at least 28 days aligned to weeks, one breakdown.

### `GET /processes`

Lists processes with current version, sensitivity and case counts (open/closed, suppressed per
rules). Role: `reader`.

### `GET /processes/:process/definitions[/:version]`

Definition bodies and comparability classes between versions. Role: `reader`.

### `POST /definitions` (`owner`)

Body: definition JSON. 201 created, 200 identical republish, 409 different body for an existing
version, 400 with validation problems.

### `GET /processes/:process/flow`

Where time goes, per stage group and stage, as additive sums and means. This feeds the nested
segmented bar (11).

```jsonc
"data": {
  "mode": "time_share",                       // time_share | mean_per_case
  "groups": [
    { "group": "interview_loop", "label": "Interview loop",
      "stages": [
        { "stage": "interview", "label": "Interview", "n_instances": 31, "n_cases": 29,
          "working_ms": 3.1e9, "blocked_ms": 1.4e9, "paused_ms": 2.6e8, "open_ms": 4.1e8,
          "blocked_by_reason": [{ "reason": "interviewer_availability", "ms": 9.1e8 },
                                { "reason": "awaiting_feedback", "ms": 4.9e8 }],
          "suppressed": false }
      ] }
  ],
  "between_ms": 2.2e8,
  "total_ms": 1.12e10
}
```

`open_ms` is the part of `working + blocked + paused` contributed by censored instances up to
`as_of`. The UI hatches it (11).

### `GET /processes/:process/stages`

Per stage: `n_instances`, `n_closed`, `n_censored`, `skipped`, `rework_cases`, `p50_ms`, `p90_ms`
(closed-only), `km_median_ms`, `km_median_reached`, `mean_active_ms`, `first_pass_yield` with a
Wilson 95% interval, and `age_limit_breaches_open`.

### `GET /processes/:process/funnel`

Canonical stages in order, with `reached`, `skipped`, `converted_to_next`, a rate and a Wilson
interval per step, and `mature: false` cells per 04 §4.8 when `within_days` is set.

### `GET /processes/:process/wip`

At `as_of`: open cases by current stage, with age percentiles in stage, counts above `ageLimitMs`,
and blocked and paused counts.

### `GET /processes/:process/throughput?bucket=day|week`

Closed cases per bucket by outcome; created per bucket; net WIP change.

### `GET /processes/:process/cohorts?bucket=week&within_days=14,30,60`

Opened cohorts by row; per column: converted-within share (success outcome), `n`, `n_mature`,
`mature`, Wilson interval.

### `GET /processes/:process/cases` (`analyst`, person)

Paged list (`limit` ≤ 200, cursor on `(created_at, case_id)`) with status, current stage, age,
outcome and diagnostic count. Never includes dimensions on restricted processes.

### `GET /processes/:process/cases/:case` (`analyst`, person)

Served from the CaseDO: stage instances, intervals with attribution, relations, children summary,
diagnostics, and the five-part decomposition. Restricted: writes the read audit.

### `GET /processes/:process/cases/:case/children`

Children grouped by process and stage, with counts and WIP ages (suppressed for `reader`).

### `GET /diagnostics?code=&process=`

Counts by code; with `analyst`, the case ids per code (06 §6.4).

### `POST /explore` and `GET /explore/:job` (`analyst`; `admin` on restricted)

Body: `{ "template": "stage_dwell_by_month", "params": { … } }`. Templates come from a registry;
**no free SQL in v1**. The job runs Basin SQL, applies suppression, and stores its result for 24 h.
Response: `{ job_id, status: queued|running|done|failed, result?, meta }`.

### Operations endpoints (`owner`/`admin`)

`GET /health`, `POST /replay`, `GET /replay/:job`, `POST /erasures`, `GET /erasures/:case`,
`POST /snapshots`. Specified in 06 and 07.

### Errors

The same `{ "error": "…" }` shape as `apps/flightdeck/src/api/http.ts`. 400 for invalid
parameters, with the parameter name. 403 for missing grants or unknown apps (indistinguishable,
per E). 404 for an unknown process or case **after** authorization passes. 409 for a definition
conflict. 422 when a restricted-process query violates the window or breakdown rules, with the rule
name. 503 for unavailable storage.

## 8.5 Computing answers from D1

- Window queries pick the source by cost. If the window touches ≤ 50,000 `li_stage_instances` rows
  (estimated from `li_daily_stage.entered` sums), compute exact nearest-rank percentiles and
  Kaplan–Meier from rows. Otherwise use `li_daily_*` sums and histograms, with
  `method.percentiles = "histogram"`, and Kaplan–Meier from histogram bins (closed) plus open ages
  from `li_cases` (WIP is always small enough to read exactly).
- Pooling across versions sums `li_daily_*` rows over canonical stages only when every included
  version pair is `exact` or `merged`. Otherwise it returns per-version series.
- Every query filters on `app_id` first. All `li_*` primary keys start with `app_id, process_id`,
  so cross-app reads would need an explicit app list that authorization has already approved.

## 8.6 Histogram format

`dwell_hist` and `lead_hist` are JSON objects mapping bucket index to count, where bucket
`i = floor(log(ms / 1000) / log(1.08))` for `ms ≥ 1000`, and bucket `-1` holds `< 1 s`. Bucket `i`
covers `[1000·1.08^i, 1000·1.08^(i+1))` ms. Reporting its geometric midpoint `1000·1.08^(i+0.5)`
keeps the relative error within √1.08 − 1 ≈ 3.9%, which is enough for p50/p90 on dashboards. A
30-day dwell needs bucket 191, so a histogram has at most a few hundred keys. Merging histograms is key-wise addition, so day buckets roll up to weeks and months
exactly.
