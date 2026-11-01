# 06 Security, scoping and privacy

Lifecycle data is more sensitive than page analytics. A hiring pipeline describes decisions about
people, even when every identifier is opaque. This section is written for that worst case. Deploys
and incidents get the same machinery with lower thresholds.

## 6.1 Threat model

| # | Threat | Example | Control |
|---|---|---|---|
| S1 | A producer writes into another app | A Worker sets someone else's `appId` | App id only from the binding `props` or the key digest. `lifecycle.write` capability per app (A's migration). Payload has no app field. |
| S2 | A read crosses apps | A dashboard user of `app_web` reads `app_hiring` | E's `authorizeLifecycleRead` on every `/li/*` route; unknown app and missing grant give the same 403 (PR #31 behavior). |
| S3 | Re-identification from small groups | "Level L6, referral, rejected at onsite, week 41" matches one person | k-suppression (§6.4), restricted breakdowns, minimum windows, no case-level views below `analyst`. |
| S4 | Differencing | Two overlapping queries subtracted to reveal one case | Fixed bucket boundaries, minimum window, count rounding, at most one breakdown dimension on restricted processes, read audit (§6.4). |
| S5 | Personal data in payloads | A producer puts an email in `caseId` or a name in a dimension | A's id regex (no `@` or spaces), sensitive-key denylist, definition allowlists, the protected-characteristic denylist (§6.3), producer HMAC (§6.2), and `pii-check.sh` in the instrumentation skill. |
| S6 | Prompt injection through data into agents | A reason code crafted as an instruction | No free text exists in the contract; MCP returns codes from allowlists only (10). |
| S7 | Over-privileged service tokens | The CLI token reads hiring cases | E caps service grants at `reader` on one app (SQL `CHECK`); case-level endpoints need person `analyst`. |
| S8 | Stale access after revocation | A revoked grant keeps a WebSocket alive | Lifecycle has no WebSockets in v1; every request re-checks grants with no cache (E's design). |
| S9 | Raw evidence outlives a deletion | An erased case remains in Iceberg | §6.6. Partly open (OQ-3). |

## 6.2 Pseudonymization

Flightdeck never needs to know who a case is about.

- **Producers pseudonymize before sending.** `caseId = "appl_" + base32(HMAC-SHA256(k_producer,
  ats_application_id))[:12]`. The key lives in the producer's secret store, so Flightdeck can't
  reverse it and the producer can still map back for corrections and erasure. The SDK helper
  `caseRef()` does this (10).
- **No actor identities in v1.** No interviewer, recruiter, approver or on-call ids. Questions like
  "which interviewer is slowest" are out of scope (README, "What this RFC is not"). If a later
  version adds actor roles, they are role codes (`role: "approver"`), never person ids.
- **The existing `hashUserId`** (`packages/worker/src/privacy.ts`) is a different mechanism for
  analytics `userId`; lifecycle doesn't use `userId` at all.

## 6.3 What may never be sent

Enforced at ingest for every process:

- A's sensitive-key segments (`name`, `email`, `phone`, `address`, `salary`, `compensation`, `dob`, …).
- Free text in any field: the regexes allow codes only.

Additionally for `restricted` processes, this RFC proposes adding a **protected-characteristic
denylist** to dimension keys and values, checked at publish and at ingest
([Gate G7](appendix-a-reconciliation.md#g7-privacy-review-for-restricted-processes)): `gender`,
`sex`, `race`, `ethnicity`, `age`, `birth`, `disability`, `religion`, `nationality`, `citizenship`,
`veteran`, `marital`, `pregnancy`, `orientation`, `health`, `union`, plus `score`, `rating`,
`feedback`, `interviewer`, `recruiter`, `referrer_id`. The list is deliberately broad; a false
positive costs a rename, while a false negative stores data that shouldn't exist.

The hiring fixtures in [examples](examples/README.md#hiring-hiringapplication-v1-case-appl_7d21c9) show what remains useful:
`level`, `channel` (`referral`/`inbound`/`agency`), `department`. That is enough for flow analysis,
and nothing describes a person.

## 6.4 Authorization and suppression (D11)

Authorization is E's model (draft PR #31): grants for a person (`sub`) or service (`common_name`)
on an app or project, roles `reader < analyst < owner < admin`, expiry and revocation, no caching,
fail closed. This RFC maps lifecycle operations onto it:

| Operation | Standard process | Restricted process |
|---|---|---|
| Aggregates: flow, stages, WIP counts, throughput, cohorts, scorecards | `reader` | `reader`, k = 10, restricted breakdowns |
| Case list (`/li/processes/:p/cases`) and case timeline | `analyst` (person) | `analyst` (person) **and** read audit |
| Diagnostics with case ids | `analyst` | `owner` |
| Explore jobs (async Basin SQL over raw evidence) | `analyst` | `admin` only, results aggregated with suppression |
| Publish or deprecate definitions, alert rules, scorecards | `owner` | `owner` |
| Replay, reconcile, erasure requests | `owner` | `admin` |
| MCP tools | Same as the HTTP operation they wrap; service tokens get only `reader` aggregates | Service tokens get **nothing** on restricted processes |

### Suppression rules

- Every aggregate cell carries `n`, the **distinct cases** contributing, not events.
- A cell with `0 < n < k` returns `suppressed: true` and no values. k is 5 for standard and 10 for
  restricted processes, configurable upward only.
- **Complementary suppression.** If exactly one cell in a row or column is suppressed, the
  next-smallest cell is suppressed too, so totals can't reveal it.
- Counts are rounded to the nearest 5 for `reader` on restricted processes (E rounds counts too).
  Durations are rounded to the hour.
- **Restricted queries also require**: a window of at least 28 days, aligned to UTC weeks; at most
  one breakdown dimension, and only one marked `breakdown: true`; no filter that narrows below k
  before breakdown.
- Suppression happens in the API layer after aggregation and before serialization, in one shared
  function, so HTTP, MCP and scorecards can't diverge.

Suppression is not differential privacy (E's PR says the same). It makes casual re-identification
hard. It does not make the data anonymous in a legal sense, which is why case ids stay pseudonymous
and `restricted` processes carry the additional read audit.

### Read audit

For `restricted` processes, every case-level read and every Explore job writes
`li_read_audit(app_id, process_id, principal_kind, principal_subject, route, case_count, at)`.
Rows are kept for 400 days. The audit stores the reader's Access subject, which is itself personal
data about employees; that is why it is limited to restricted processes and retained for a fixed
period.

### Relationship to `READ_AUTHZ_MODE`

PR #31 keeps `live`/`trends` in `legacy` mode (any Access principal) until an explicit switch to
`enforce`. **Lifecycle routes always enforce**, regardless of the mode, matching #31's statement
that new lifecycle reads deny without grants.

## 6.5 Retention

| Data | Default retention | Mechanism |
|---|---|---|
| D1 `li_cases`, `li_stage_instances`, `li_intervals`, `li_relations` for **closed** cases | 400 days after `closed_at` | Daily cron deletes expired cases' rows (aggregates in `li_daily_*` remain) |
| D1 rows for **open** cases | while open, up to 3 years since `created_at`, then the case is force-closed in the read model as `expired`, with diagnostic `retention_expired` | Daily cron |
| `li_daily_*` aggregates | 3 years | Daily cron |
| `li_diagnostics` | 90 days | Daily cron |
| CaseDO storage | Deleted 30 days after the case closes (re-created on reopen from Iceberg replay) | CaseDO alarm |
| Iceberg `lifecycle_events` | 400 days after `received_at` by default; per-process override | **Not implemented by any Cloudflare mechanism we have verified** (OQ-3, G6) |
| `li_read_audit` | 400 days | Daily cron |

Restricted processes may set shorter periods in the definition (`retention: { closedDays, rawDays }`),
never longer than the defaults without an admin override.

## 6.6 Erasure

Producers own the mapping from a person to case ids, so erasure starts there.

1. The producer (or an `admin` through the API) calls
   `POST /api/apps/:app/li/erasures { processId, caseIds[] }`, or the CLI
   `create-flightdeck li erase --process … --case …`.
2. Flightdeck records `li_erasures`, calls `CaseDO.erase()` (which deletes storage), deletes the
   case's D1 rows except a tombstone `li_cases.status = 'erased'` without dimensions or times, and
   marks affected days dirty so aggregates are recomputed without the case. **Target: within 1 hour.**
3. Ingest rejects any later event for an erased case (permanent 400 `case erased`), so a lagging
   producer can't resurrect it.
4. Raw evidence: the rows remain pseudonymous, and once the producer deletes its mapping key or
   row, nothing links them to a person. Physically removing them from Iceberg needs a row-level
   delete or a rewrite of the affected data files followed by snapshot expiry. **Whether Basin
   supports this is unverified (G6, OQ-3).** Until it is verified, the documented position is: raw
   lifecycle evidence is pseudonymous and is deleted at the raw retention boundary by an operator
   job using an Iceberg-capable engine (07 §7.7). Restricted processes must not go live until this
   job exists and has been tested (G7).

## 6.7 Secrets and credentials

- Lifecycle write keys are ordinary `server_ingest_keys` rows with the `lifecycle.write` scope (A).
  The existing rotation procedure applies (`docs/operations/server-ingestion.md`).
- The producer's HMAC key for `caseRef()` never leaves the producer.
- Webhook secrets for alerts (09) are Worker secrets, referenced by name in `li_alert_channels`,
  never stored in D1.
