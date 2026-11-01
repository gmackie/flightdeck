# 01 Current state: what exists, what is in flight, what is proposed

Audited against `main` at `af2f2f7` (FLIG-9, PR #29) on 2026-10-31. Three labels are used
throughout the RFC:

- **Exists**: merged on `main`, with the file that proves it.
- **In flight**: an unmerged branch, worktree or draft PR. It may change or never merge, so the
  RFC never depends on it as if it had shipped.
- **Proposed**: introduced by this RFC.

## 1. What exists on `main`

### Ingest

| Capability | Where | Relevance to lifecycles |
|---|---|---|
| RPC `Ingest` entrypoint (`ingest`, `track`, `identify`) behind a service binding, with the app id taken from `ctx.props.appId` | `apps/flightdeck/src/ingest/entrypoint.ts` | The pattern lifecycle RPC methods follow. |
| Authenticated HTTP server ingest `POST /v1/server/events`: bearer key, SHA-256 digest lookup in `server_ingest_keys`, 256 KiB cap, `track` only | `apps/flightdeck/src/ingest/http.ts`, `migrations/0002_server_ingest_keys.sql` | The model for `POST /v1/lifecycle/events`. Keys have **no scopes** on `main`. |
| Validation of each event on its own, so one bad event doesn't fail the batch; 50 events per batch; 32 props; reserved `$` names | `packages/schema/src/events.ts`, `apps/flightdeck/src/ingest/service.ts` | Lifecycle batches are **all-or-nothing** instead (D4); see 03. |
| Timestamp clamp: `ts` more than 5 min in the future or 24 h in the past is replaced by `received_at` | `ingest/service.ts` (`MAX_FUTURE_MS`, `MAX_PAST_MS`, `toRow`) | **Incompatible with lifecycle backfills.** Lifecycle ingest must not reuse `toRow` (D3). |
| Pipelines is the commit point; DO fan-out is best-effort under `ctx.waitUntil` and failures are only logged | `ingest/service.ts` (`ingestBatch`, `fanOut`) | Acceptable for counters, not for a read model that must converge. Lifecycle awaits both (D4). |
| `event_id` taken from the client `eventId` or minted with a ULID; dedupe documented as downstream on `(app_id, event_id)` | `ingest/service.ts`, `docs/operations/server-ingestion.md` | Same idempotency key shape. Dedupe on `main` is a promise to future readers: no reader dedupes yet. |

### Storage

| Capability | Where | Notes |
|---|---|---|
| Two Basin Pipelines streams, `EVENTS` and `SESSIONS`, with sinks into Iceberg tables `flightdeck.events` and `flightdeck.sessions` on R2 | `apps/flightdeck/wrangler.jsonc`, `apps/flightdeck/pipelines/*.schema.json`, `scripts/provision-dev.sh` | Provisioning is a dev script; the Phase 2 installer has not shipped (`packages/create-flightdeck/src/cli.ts` prints "coming in Phase 2"). Sinks roll every 60 s. |
| D1 `flightdeck`: `apps`, `server_ingest_keys`, `hourly_rollups`, `hourly_sessions` | `apps/flightdeck/migrations/0001`–`0004` | Highest migration on `main` is **0004**. |
| `SessionDO`: one per `app:session`, orders steps, streams transitions, writes a session record after 30 min idle, at-least-once close | `apps/flightdeck/src/do/session.ts` | Closest existing analogue to a CaseDO, but it keeps only the latest state, not an event log. |
| `AppDO`: one per `app:hour:shard`, holds counters, transitions, minutes and sessions; flushes the hour to D1 10 min after it ends; deletes itself 48 h later | `apps/flightdeck/src/do/app.ts`, `src/rollups.ts` | The flush pattern (delete + insert in one D1 batch, re-flush overwrites) is reused for projections. |
| D1 rollups written by AppDO alarms rather than by a Basin SQL cron (a recorded deviation from the design) | `docs/operations/dashboard.md` ("Trends and the warm tier") | There is **no cron trigger** in `wrangler.jsonc` and **no Basin SQL reader** in the Worker. |

### Read side

| Capability | Where | Notes |
|---|---|---|
| Access-protected `/api/*`: RS256 JWT for `ACCESS_AUD`, people and service tokens, fails closed when Access isn't configured | `apps/flightdeck/src/api/auth.ts`, `src/access.ts` | **Any authenticated principal can read every app.** There are no grants or roles on `main`. |
| `GET /api/apps/:id/live`, `/live/ws`, `/trends` | `src/api/live.ts`, `src/api/trends.ts` | Responses carry no freshness or sample metadata; `trends` documents that `totals.sessions` over-counts sessions that span hours. |
| App registry `GET/POST /api/apps`, server keys `POST/DELETE /api/apps/:id/server-keys` | `src/api/index.ts`, `src/api/registry.ts` | Ids are `app_<slug>[_<stage>]`. |
| Dashboard: Live and Trends; Journeys, Funnels and Retention marked `soon` | `apps/dashboard/src/nav.ts`, `src/router.ts` | React 19, `@cloudflare/kumo`, ECharts (`apps/dashboard/package.json`). |

### SDK, CLI, skills

| Capability | Where |
|---|---|
| `withFlightdeck`, `handleFlightdeck`, `flightdeck(env)` | `packages/worker/src/index.ts` |
| Privacy hooks `beforeSend` and `hashUserId` (salted SHA-256) | `packages/worker/src/privacy.ts` |
| CLI `apps list|add|key|revoke-key`, published as `@flightdeckhq/create` | `packages/create-flightdeck/src/cli.ts`, `docs/operations/releasing.md` |
| Agent skills for instrumenting Workers and frontends, with a PII diff check | `skills/`, `skills/flightdeck-instrument-worker/scripts/pii-check.sh` |

### Engineering baseline

CI runs `pnpm lint`, `pnpm typecheck`, `pnpm test`, the browser size check and `pnpm smoke:pack`
(`.github/workflows/ci.yml`). Worker tests use `@cloudflare/vitest-plugin` with real D1
migrations (`apps/flightdeck/vitest.config.ts`). Biome ignores `docs/` (`biome.json`).

## 2. What does not exist on `main`

Lifecycle intelligence depends on all of the following, none of which exist:

- No lifecycle event type, process definition, case or stage concept anywhere in `packages/` or `apps/`.
- No credential scopes, per-app capabilities, read grants or roles.
- No Basin SQL client, cron trigger, replay job or reconciliation job.
- No query response metadata (freshness, sample size, suppression).
- No MCP endpoint.
- No retention or erasure mechanism for the Iceberg tables. AppDOs expire after 48 h; the D1
  rollups and Iceberg rows have no expiry.

## 3. What is in flight (unmerged, 2026-10-31)

| Workstream | Issue | Branch / PR | What it is building | Status for this RFC |
|---|---|---|---|---|
| A: typed lifecycle events and ingest | FLIG-19 | `feat/lifecycle-event-ingest` (local worktree, no PR seen) | `LifecycleEventV1` and `ProcessDefinitionV1` in `@flightdeckhq/schema`; `trackLifecycle` / `ingestLifecycleBatch` RPC; `POST /v1/lifecycle/events`; migration `0005_lifecycle_write.sql` (key `scopes`, `app_capabilities`); `lifecycle_events` stream schema | **Adopted as the wire contract (D2)**, subject to [Gate G1](appendix-a-reconciliation.md#g1-shared-vocabulary) and the definition additions in 05. |
| B: process intelligence engine | FLIG-16 | `feat/lifecycle-process-engine` (local worktree) | Standalone `@flightdeckhq/lifecycle` package: `replay`, `stageMetrics`, `caseMetrics`, `summarize`, `funnel` | **Adopted as the fold** run inside the CaseDO and replay. Its WIP event vocabulary **differs from A's**; see G1. |
| C: lifecycle dashboard demo | FLIG-15 | `feat/lifecycle-dashboard-demo` (local worktree) | `LifecycleBar`, `LifecycleRow`, expandable hierarchy, portfolio view on local fixtures behind an adapter | Must satisfy the bar semantics and accessibility rules in 11. |
| E: read authorization | FLIG-18 | `feat/lifecycle-rbac-policy`, **draft PR #31** | Migration `0010_read_authorization.sql` (`authz_projects`, `authz_app_projects`, `authz_grants`), roles `reader/analyst/owner/admin`, `authorizeLifecycleRead`, small-cohort suppression, `READ_AUTHZ_MODE=legacy|enforce` | **Adopted as the authorization layer (D11).** Migration number must be reconciled (G3). |
| F: synthetic fixtures and smoke harness | FLIG-20 | `test/lifecycle-cross-domain-fixtures` (local worktree) | Seeded generator for recruiting, service delivery and incident processes, ground-truth expectations, validator | **Source of the cross-branch contract fixtures** (G2). The small examples in this RFC are hand-checked walkthroughs, not a replacement. |
| Query analytics (unnamed) | none seen | `feat/lifecycle-query-analytics` (local worktree) | `packages/lifecycle-queries`: registry-restricted SQL over a facts table, a Basin adapter interface and a fake | Candidate for the Explore/replay SQL layer in 08; needs an issue. |
| Serving API (unnamed) | none seen | `feat/lifecycle-serving-api` (local worktree, empty) | Not started | Covered by PR-08 in the plan. |

These descriptions come from the issue texts and a read-only look at the worktrees on
2026-10-31. **Workstream contracts are not currently compatible with each other**; Appendix A
lists the differences and the gates that must pass before any lifecycle feature is released.

## 4. What is proposed here

Everything in docs 02–12, summarized:

1. A `CaseDO` Durable Object class and D1 projection tables (`li_*`), fed synchronously by
   lifecycle ingest (02, 03).
2. Precise time semantics and censoring rules that B's fold must implement and every query must
   respect (04).
3. Definition additions to A's `ProcessDefinitionV1`: stage `kind`, `group`, `canonicalStageId`,
   terminal `outcome`, process `sensitivity`, and a `predecessor` stage map (05).
4. Lifecycle read API endpoints with a common response envelope (`freshness`, `sample`,
   `comparability`, `suppressed`) behind E's grants (06, 08).
5. Replay from Iceberg, hourly reconciliation, diagnostics endpoints and `create-flightdeck li`
   commands (07, 10).
6. Metric catalog, scorecards and alerts evaluated by a new cron trigger (09).
7. A read-only MCP endpoint for agents (10).
8. Nested segmented bar semantics (11).
9. Flags, provisioning, budgets and tests (12).
