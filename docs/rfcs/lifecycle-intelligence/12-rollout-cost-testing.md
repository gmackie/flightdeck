# 12 Rollout, provisioning, cost and performance budgets, testing

## 12.1 Feature flags (D16)

| Flag | Where | Values | Effect |
|---|---|---|---|
| `LIFECYCLE_MODE` | Worker var | `off` (default), `shadow`, `on` | `off`: lifecycle RPC methods throw `lifecycle disabled`, `/v1/lifecycle/events` returns 404, `/api/apps/:id/li/*` returns 404, crons skip lifecycle jobs. `shadow`: writes, projection, reconciliation and alerts-to-operator-channel run; reads are limited to `owner`/`admin`; the dashboard nav entry is hidden. `on`: everything, subject to grants. Invalid values fail closed to `off`. |
| `lifecycle.write` capability | D1 `app_capabilities` (A) | per app | Without it, an app can't write lifecycle events whatever the key says. |
| `lifecycle.write` key scope | D1 `server_ingest_keys.scopes` (A) | per key | HTTP producers need it. |
| `READ_AUTHZ_MODE` | Worker var (E) | `legacy`, `enforce` | Affects live/trends only; lifecycle reads always enforce (06 §6.4). |
| `features` in `GET /api/me` | API | list | The dashboard shows "Processes" only when the principal holds a lifecycle grant on the selected app and the mode is `on` (or `shadow` for owners). |

There is no flag that weakens suppression or the restricted-process rules.

## 12.2 Provisioning and migration order

Each step is idempotent; `create-flightdeck li doctor` checks all of them.

| # | Step | Owner PR | Command / change | Verify |
|---|---|---|---|---|
| 1 | Create stream `fd_lifecycle_events` (Worker binding only, HTTP disabled), sink to Iceberg table `flightdeck.lifecycle_events`, pipeline | PR-02 | extend `scripts/provision-dev.sh` `TABLES`; later the Phase 2 installer | `wrangler basin pipelines streams get fd_lifecycle_events` |
| 2 | Add `LIFECYCLE_EVENTS` binding with the **real** stream id (A: "no fake stream IDs") | PR-06 | `wrangler.jsonc` `pipelines` | `wrangler deploy --dry-run` |
| 3 | Apply D1 migrations: A's write scopes and capabilities, E's authz tables, this RFC's `li_*` tables | PR-04/05/06/07/09 | `wrangler d1 migrations apply flightdeck --remote` **before** deploying code that reads them | `li doctor` lists tables |
| 4 | Add the `CaseDO` binding and the `v2` DO migration (`new_sqlite_classes: ["CaseDO"]`) | PR-06 | `wrangler.jsonc` | deploy succeeds; `li doctor` pings a scratch CaseDO |
| 5 | Add `triggers.crons` (07 §7.3) | PR-09 | `wrangler.jsonc` | cron logs `li.cron` ticks |
| 6 | Access bypass policy for `/v1/lifecycle/events` only | PR-06 docs | Zero Trust dashboard | `curl` without Access gets 401 from the Worker, not an Access login page |
| 7 | Deploy with `LIFECYCLE_MODE=shadow` | PR-06+ | `pnpm run ship` (`apps/flightdeck`) | `/healthz`; `li doctor` |
| 8 | Grant `lifecycle.write` to the pilot app; mint a scoped key | ops | parameterized D1 statement (A) / `li keys add` | first events accepted |
| 9 | Publish the pilot definition; start the producer outbox relay | producer | `li definitions publish` | `li case` on a staging case |
| 10 | 7 days of shadow: reconcile ok ≥ 99.5%, lag p95 < 10 s, zero `mismatch` | ops | `li doctor` | recorded in the issue |
| 11 | Grant readers; set `LIFECYCLE_MODE=on` | ops | Worker var | dashboard shows Processes |

Migration numbering is unresolved: `main` ends at `0004`, A's branch adds `0005_lifecycle_write.sql`,
and E's PR #31 adds `0010_read_authorization.sql`. The rule for G3: **merge order decides the
numbers**, every PR renumbers to the next free number on rebase, and no migration may assume
another unmerged migration ran.

### Rollback

- `LIFECYCLE_MODE=off` stops all lifecycle behavior immediately; data stays.
- Migrations are additive (new tables, new columns with defaults), so code rollback doesn't need
  schema rollback.
- Dropping the read model is always safe (replay rebuilds it); dropping the stream or table is
  never part of a rollback.

## 12.3 Cost model

Prices change, so budgets are stated in **platform units**. PR-02 records the then-current unit
prices from the Cloudflare pricing pages in `docs/operations/lifecycle-costs.md`.

### Units per operation

| Operation | Worker requests | DO requests | DO storage rows written | Stream bytes | D1 rows written | D1 rows read |
|---|---|---|---|---|---|---|
| Ingest batch of E events over C cases | 1 | C | ≈ E (+ meta) | ≈ 600 B × E | 0 (synchronously) | ≤ 1 (key/app lookup, cached) |
| Projection of one case (debounced, ≤ 1 per 2 s) | 0 | 0 (alarm) | 2 | 0 | 2 × (1 + I + V + R): delete + insert of case, instances, intervals, relations | ≈ 1 (guard) |
| Daily aggregate recompute, per dirty day | ≤ 1/5 per cron tick | 0 | 0 | 0 | rows per `(stage, dims_key)` | instances closed that day |
| Dashboard flow query, 90 days | 1 | 0 | 0 | 0 | 0 | ≈ 90 × stages × dims_keys |
| Reconcile, per app-hour | 1 | ≤ 500 | 0 | 0 | 1 | ≤ 500 |

### Worked volumes (fictional but realistic)

| Process | Cases / year | Events per case | Events / year | Batches / year (avg 4 events) | D1 rows written / year (projection, ×2 for delete+insert, ~20 rows) |
|---|---|---|---|---|---|
| Hiring applications | 6,000 | 14 | 84,000 | 21,000 | 6,000 × ~8 projections × 40 ≈ 1.9 M |
| Deployments | 18,000 | 12 | 216,000 | 54,000 | 18,000 × ~6 × 40 ≈ 4.3 M |
| Incidents | 400 | 30 | 12,000 | 3,000 | 400 × ~15 × 40 ≈ 0.24 M |
| CI runs (stress case) | 1,000,000 | 20 | 20 M | 5 M | 1 M × ~5 × 40 ≈ 200 M (needs `readModel.aggregatesOnlyAfter`, below) |

The first three are tiny for every Cloudflare quota involved. The stress case is what the budgets
below guard against.

### D1 storage budget

Each closed case keeps roughly 20 rows at about 250 bytes, so about 5 KB. Default budget for all
`li_*` tables: **2 GB per deployment** (well under D1's per-database limit, and leaving room for
the existing rollups), so about 400,000 closed cases retained. Processes expected to exceed that
set `readModel: { "aggregatesOnlyAfter": "P30D" }` in the definition (05 §5.1): the
retention sweep then deletes instance and interval rows of cases closed more than 30 days ago,
keeping `li_cases` and `li_daily_*`. `li doctor` warns at 70% of the budget.

## 12.4 Performance budgets

| Path | Budget | Enforced by |
|---|---|---|
| Ingest, 100 events / ≤ 10 cases, server time | p95 < 250 ms, p99 < 600 ms | Worker analytics; load test in PR-06 |
| CaseDO fold, 2,000-event case | < 20 ms CPU | Unit benchmark in B's package (CI threshold) |
| Projection D1 batch | < 50 statements, < 100 ms p95 | Test asserting statement count for a 2,000-event case |
| `/flow`, `/stages`, `/funnel`, `/wip`, 90-day window | p95 < 300 ms; ≤ 50,000 D1 rows read | API tests with seeded F fixtures (100k cases); `meta` dev header with rows read |
| Same, 400-day window | p95 < 800 ms; ≤ 200,000 rows read | same |
| Case timeline | p95 < 100 ms | DO test |
| Cron tick total | < 30 s wall; < 10 s CPU | Cron logs |
| Reconcile, per app-hour | ≤ 1 Basin SQL query, ≤ 500 DO calls | Code limit + test |
| Dashboard Processes page JS | ≤ 40 KB gzip added to the SPA (lazy route, like `apps/dashboard/src/charts/lazy.tsx`) | Size check in CI |

## 12.5 Test plan

| Layer | What | Where (proposed) | Notes |
|---|---|---|---|
| Contract | A's schema accepts every wire event in the shared fixtures; B's adapter folds them to the expected projections; the two agree on the normalized vocabulary | `packages/lifecycle-contract-tests` or a root `contract/` Vitest project | **Gate G2.** Runs in CI on every PR touching `packages/schema/src/lifecycle*`, `packages/lifecycle/**` or fixtures |
| Semantics | Every `T-…` vector in 04 | B's package tests | Hand-checked numbers from 04 and the examples |
| Properties | Permutation invariance; duplicate idempotence; retract-then-resend; correction before target; decomposition sums to elapsed; attribution sums to the blocked union | B's package (fast-check or a seeded loop) | 1,000 seeds per property in CI |
| Ingest | Scope and capability checks, all-or-nothing batches, future-skew rejection, no clamping, 503 on CaseDO failure with retry convergence, case limit | `apps/flightdeck/test/lifecycle-ingest.test.ts` | Workers pool + real D1 migrations, like `server-ingest.test.ts` |
| CaseDO | Append dedupe and conflicts, alarm projection, `projection_seq` guard against stale writes, erase, replay merge/rebuild | `apps/flightdeck/test/case-do.test.ts` | `runDurableObjectAlarm`, like `session-do.test.ts` |
| D1 | Migrations apply on top of `main` and on top of A's and E's in either order (G3) | migration test | |
| Authorization | Every `/li/*` route denies without grants; service tokens never reach case-level or restricted data; suppression and complementary suppression; restricted window and breakdown rules; read audit written | extends E's `read-authorization.test.ts` pattern | Adversarial, like #31 |
| API contract | Envelope fields present and typed on every endpoint; `n` counts distinct cases; comparability splitting | `apps/flightdeck/test/api-lifecycle.test.ts` | Snapshot of `meta` keys |
| Reconcile and replay | Basin adapter fake (from `packages/lifecycle-queries` if it lands) with missing, duplicate and late rows | `apps/flightdeck/test/li-reconcile.test.ts` | |
| MCP | Tool list contains only read handlers; every tool output carries `meta`; service-token denials | `apps/flightdeck/test/mcp.test.ts` | |
| UI | axe in light and dark; keyboard paths; table equivalent; percentiles never stacked; reduced motion | `apps/dashboard/test/lifecycle/*.test.tsx` | happy-dom, like existing dashboard tests |
| Load | 100k-case F fixture through ingest in `wrangler dev`; 1M-case F fixture through the fold only | `examples/lifecycle-fixtures` (F) | Not in CI; run before `on` |
| Privacy | Definition publish and ingest reject the protected-characteristic denylist; `pii-check.sh` catches seeded violations | schema tests + skill script test | G7 |
| Smoke | `li emit` of the three RFC examples against staging; `li case` output matches the walkthroughs | runbook | Pre-release |
