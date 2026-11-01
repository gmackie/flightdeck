# Examples: hiring, deployment, incident

Three small, **entirely fictional** scenarios that exercise the semantics in
[04](../04-time-semantics.md). All identifiers are opaque, made-up codes. No real candidate,
employee, interviewer, customer or service data appears anywhere, and the hiring example carries
no personal attributes at all: only `level`, `channel` and `department` codes.

These are **hand-checked walkthroughs**, not a fixture generator or a reference implementation.
Workstream F (FLIG-20) owns generated fixtures at scale, and workstream B (FLIG-16) owns the
reducer. Gate G2 ([Appendix A](../appendix-a-reconciliation.md#g2-cross-branch-contract-test)) adds
these three directories to the cross-branch contract test.

| File | Format |
|---|---|
| `*/definitions/*.json` | A's `ProcessDefinitionV1` plus the RFC additions from [05 §5.1](../05-definitions-hierarchy-relations.md#51-what-a-definition-is) (`sensitivity`, `kind`, `outcome`, `group`, `canonicalStageId`, `ageLimitMs`, `breakdown`, `failureReasons`, `predecessor`, `calendar`, `maxDepth`, `retention`, and `processId` on `parent` relations). **They won't validate against A's current strict draft** until G5 lands or is deferred. |
| `*/events.ndjson` | Wire events in the normalized vocabulary (03), one per line, **in receipt order**. |
| `*/expected.json` | Projections at `asOf = 2026-10-12T00:00:00Z`: decomposition, instances, intervals with attribution, derived measures, diagnostics. Durations are in ms. |

Single cases can't show percentiles or suppression; the aggregate behavior is in 04 §4.7 (T-CEN-1)
and 06 §6.4. Note that a real hiring process with one case would be **fully suppressed** for
`reader` (k = 10).

## Hiring: `hiring.application` v1, case `appl_7d21c9`

**What it exercises:** overlapping blocks, a case pause overlapping a block, receipt out of order,
a duplicate resend, a retraction, a parent that hasn't arrived, a restricted process, and v1/v2
comparability.

Timeline (UTC):

| When | Event |
|---|---|
| 09-05 09:00 | `case.created` (parent `requisition/req_4b8e10`, dims L4/referral/platform); enters `applied` |
| 09-08 00:00 | `applied` → `screen` |
| 09-15 00:00 | `screen` → `onsite`; block `interviewer_availability` starts |
| 09-17 00:00 | block `awaiting_feedback` starts |
| 09-18 00:00 | `interviewer_availability` cleared |
| 09-18 12:00 | `case.paused` `requested_delay` (**received after** the next event) |
| 09-19 00:00 | `awaiting_feedback` cleared |
| 09-19 12:00 | `case.resumed` |
| 09-20 00:00 | `stage.entered offer` sent by mistake (`hire-0013`), retracted by `hire-0019` |
| 09-22 00:00 | `onsite` → `offer` |
| 09-29 00:00 | `offer` → `hired` (terminal, success); `case.completed` |
| (receipt) | `hire-0004` (screen entry) resent at the end: a duplicate |

Ingest: 20 lines, 19 distinct ids, 1 duplicate, no conflicts. 17 effective transitions (19 minus the
retracted event and the correction itself). No diagnostics.

| Stage instance | Wall | Working | Blocked | Paused |
|---|---|---|---|---|
| `applied.1` (wait) | 63 h | 63 h | 0 | 0 |
| `screen.1` | 168 h | 168 h | 0 | 0 |
| `onsite.1` → canonical `interview` | 168 h | 60 h | 84 h | 24 h |
| `offer.1` | 168 h | 168 h | 0 | 0 |
| **Case (567 h elapsed)** | | **459 h** | **84 h** | **24 h** |

`onsite.1` is the worked example from 04 §4.4 and §4.5: blocked = union of the blocks minus the
pause = 84 h, attributed 60 h to `interviewer_availability` and 24 h to `awaiting_feedback`, though
their raw open durations are 72 h and 48 h.

Derived: active time 543 h; flow efficiency 459 / 543 = 0.8453; blocked share 0.1547; time to offer
399 h (16 d 15 h).

**Comparability.** `hiring.application.v2.json` splits `onsite` into `technical_interview` and
`team_interview`, both with `canonicalStageId: "interview"`, and records
`predecessor.stageMap.onsite = [technical_interview, team_interview]`. Canonical `interview` is
`merged`: this v1 case's 168 h `onsite` visit pools with v2 canonical visits that span both
interview stages. The v2 fine-grained stages are `not_comparable` with v1 and are shown per version.

## Deployment: `delivery.deploy` v1, case `dpl_3c91e0`

**What it exercises:** a retry (two build instances), queue time via `case.started`, a change-freeze
pause **inside** an approval block (pause wins), a parent release, and a standard-sensitivity
process.

| Stage instance | Window (10-08 UTC) | Wall | Working | Blocked | Paused |
|---|---|---|---|---|---|
| `queued.1` (wait) | 10:00–10:05 | 5 m | 5 m | | |
| `build.1` (exit `failed`) | 10:05–10:15 | 10 m | 10 m | | |
| `build.2` | 10:15–10:27 | 12 m | 12 m | | |
| `test.1` | 10:27–10:45 | 18 m | 18 m | | |
| `approval.1` (wait) | 10:45–13:00 | 135 m | 30 m | 45 m | 60 m |
| `rollout_staging.1` | 13:00–13:10 | 10 m | 10 m | | |
| `verify_staging.1` | 13:10–13:30 | 20 m | 20 m | | |
| `rollout_production.1` | 13:30–13:50 | 20 m | 20 m | | |
| `verify_production.1` | 13:50–14:20 | 30 m | 30 m | | |
| **Case (260 m)** | | | **155 m** | **45 m** | **60 m** |

Approval: block `awaiting_approver` is open 10:45–12:30 (105 m raw); the freeze pause 11:00–12:00
takes precedence, so blocked = 105 − 60 = 45 m and working = 135 − 60 − 45 = 30 m.

Derived: queue time 5 m; active 200 m; flow efficiency 0.775; build attempts 2; build first-pass
yield false; retry time 12 m.

## Incident: `incident.response` v1, case `inc_51f7aa`, with two remediation children

**What it exercises:** nested overlapping blocks, reopen and closed gap, time to first close vs final
close, a `caused_by` graph relation to a deploy that isn't in the data set, and a hierarchy with one
closed and one open (censored) child.

| Stage instance | Window (10-09 UTC) | Wall | Working | Blocked |
|---|---|---|---|---|
| `triage.1` | 02:10–02:25 | 15 m | 15 m | |
| `investigating.1` | 02:25–04:05 | 100 m | 40 m | 60 m |
| `mitigating.1` | 04:05–04:35 | 30 m | 30 m | |
| `monitoring.1` (wait) | 04:35–05:35 | 60 m | 60 m | |
| *closed 05:35, reopened 07:35* | | *120 m closed gap* | | |
| `monitoring.2` (wait) | 07:35–08:35 | 60 m | 60 m | |
| **Case (385 m)** | | | **205 m** | **60 m** (+ 120 m closed gap) |

Blocks in `investigating.1`: `vendor_response` 02:50–03:50 contains `awaiting_access` 03:20–03:40.
The union is 60 m. Attribution: vendor gets 30 m (alone) + 10 m (half of the 20 m overlap) + 10 m
(alone) = 50 m; access gets 10 m.

Derived: time to mitigate (first entry to `monitoring`) 145 m; time to first close 205 m; final
lead time 385 m; active 265 m; flow efficiency 205 / 265 = 0.7736; `reopen_count` 1.

Children (`incident.remediation`, parent `incident/inc_51f7aa`):

| Case | Status at asOf | Elapsed | Notes |
|---|---|---|---|
| `rem_a1c3e5` | closed (`done`) at 10-10 09:00 | 24 h | `todo` 1 h, `in_progress` 23 h |
| `rem_b2d4f6` | **open, censored** | 63 h (age) | `todo` 39 h; in `in_progress` for 24 h (age, not dwell) |

The incident's own decomposition is unaffected by its children (05 §5.5). Its row shows
"remediation: 1 open, 1 closed" through the parent rollup.
