# RFC: Lifecycle intelligence for Flightdeck

| | |
|---|---|
| Status | **Draft for workshop review.** Nothing in this directory is implemented. |
| Issue | [FLIG-17](https://tasks.gmac.io/gmacko/issue/FLIG-17) |
| Date | 2026-10-31 |
| Target branch | `main` (never the old `feat/0x-*` stack; see [Appendix A](appendix-a-reconciliation.md)) |
| Sibling workstreams | A [FLIG-19](https://tasks.gmac.io/gmacko/issue/FLIG-19) events + ingest, B [FLIG-16](https://tasks.gmac.io/gmacko/issue/FLIG-16) engine, C [FLIG-15](https://tasks.gmac.io/gmacko/issue/FLIG-15) dashboard demo, E [FLIG-18](https://tasks.gmac.io/gmacko/issue/FLIG-18) read authorization (draft PR #31), F [FLIG-20](https://tasks.gmac.io/gmacko/issue/FLIG-20) synthetic fixtures. All unmerged on 2026-10-31. |
| Delivery plan | [`docs/plans/2026-10-31-lifecycle-intelligence-plan.html`](../../plans/2026-10-31-lifecycle-intelligence-plan.html): 12 PRs with prerequisites and acceptance |

## Summary

Flightdeck today answers "what did visitors do on this site in the last hour or month":
page views, clicks, sessions, hourly counters and trends. This RFC adds a second, general-purpose
capability: **process intelligence for any lifecycle**. A lifecycle is anything with a start,
stages, waits, interruptions and an outcome: a hiring application, a service deployment, an
incident, a purchase order, a support ticket, a CI run.

Flightdeck becomes an **observer** of lifecycles that live in other systems, such as an applicant
tracking system, ForgeGraph or an incident tool. It answers questions those systems answer badly:

- Where does the time go, split into working, blocked, paused and waiting?
- How long do cases dwell in each stage, counting cases that are still open?
- Which stages cause rework, and which blockers overlap?
- How does this quarter compare with last quarter when the process definition changed in between?
- Which open cases breach their stage age limits right now?

It does this without becoming a second system of record, without storing personal data, and with
every number carrying its freshness and sample size.

## The decisions in one table

The full records, with alternatives considered, are in [13-decision-records.md](13-decision-records.md).

| # | Decision |
|---|---|
| D1 | Three tiers with one direction of truth: **operational system of record** (the producer) → **raw evidence** (Basin stream → Iceberg, append-only) → **read model** (CaseDO + D1, disposable and rebuildable). |
| D2 | Wire contract = workstream A's `LifecycleEventV1` in `@flightdeckhq/schema`, after vocabulary normalization ([Gate G1](appendix-a-reconciliation.md#g1-shared-vocabulary)). Engine types (B) adapt to it, not the other way round. |
| D3 | Lifecycle ingest is server-only, separate from browser analytics, and does **not** clamp old timestamps (backfills keep their true `occurredAt`; future skew is rejected). |
| D4 | A batch returns 200 only when both the raw stream and the CaseDO have accepted it; otherwise 503 and the producer retries with the same `eventId`s. Every sink is idempotent. |
| D5 | One CaseDO per case owns ordering, dedupe, corrections and the deterministic fold. D1 holds projections guarded by a monotonic `projection_seq`. |
| D6 | Time is decomposed with a fixed precedence: **paused > blocked > working**, plus **between stages** and **closed gap**. The five parts always sum to the case's elapsed time. |
| D7 | Overlapping blockers count once (interval union). Per-reason attribution splits overlapping time equally so reason totals add up to the union. |
| D8 | Open cases are right-censored. Duration answers report closed-only percentiles **and** a Kaplan–Meier median, with `n`, `n_censored` and `n_excluded` beside them. |
| D9 | Process definitions are immutable once published. Each version maps its stages to **canonical stages**; cross-version answers are labelled `exact`, `merged` or `not_comparable`. |
| D10 | Hierarchy is a single-parent tree via the reserved relation type `parent`. All other links are typed graph relations with no rollups. Parallel work is modelled as child cases. |
| D11 | Lifecycle reads go through workstream E's grants (`reader`/`analyst`/`owner`/`admin`). Aggregates are suppressed below k=5 distinct cases (k=10 for `restricted` processes such as hiring). |
| D12 | Identifiers are opaque producer ids. Flightdeck never accepts names, emails, free text, scores or protected characteristics; dimensions are allowlisted per definition version. |
| D13 | Dashboards are served from D1 and DOs only. Basin SQL serves replay, reconciliation and async Explore jobs. It never serves interactive dashboards. |
| D14 | Agents get a **read-only** MCP surface that reuses the same API, grants and suppression. There are no write tools. |
| D15 | A segmented bar stacks only additive quantities (sums or means of time). Percentiles are never stacked. |
| D16 | Everything ships dark behind `LIFECYCLE_MODE=off|shadow|on` and a per-app capability. The existing analytics paths are untouched. |

## The 12 PRs at a glance

Full tasks, files, verification and acceptance are in the
[delivery plan](../../plans/2026-10-31-lifecycle-intelligence-plan.html). "In flight" means
unmerged work exists; nothing is shipped.

| PR | Scope | Workstream | Prerequisites | Status |
|---|---|---|---|---|
| PR-01 | Schema contract: normalized vocabulary, definition additions, protected-characteristic denylist | A (FLIG-19) | Workshop decisions D2, G1, G5 | In flight |
| PR-02 | Basin lifecycle stream, provisioning, capability matrix (G6), unit costs | A + ops | PR-01 record type | Not started |
| PR-03 | Engine adapter (`fromWire`) and the 04 semantics vectors | B (FLIG-16) | PR-01 | In flight |
| PR-04 | Read authorization (rebased #31) mapped to lifecycle operations | E (FLIG-18) | `main` | Draft PR #31 |
| PR-05 | Definitions registry: `li_definitions`, publish/list API, CLI | new | PR-01, PR-04 | Not started |
| PR-06 | Lifecycle ingest: RPC/HTTP, scopes, capability, `LIFECYCLE_MODE`, stream commit, CaseDO log | A (FLIG-19) | PR-01, PR-02, PR-05 | In flight (partial) |
| PR-07 | CaseDO fold, D1 read model, contract test in CI | new + B | PR-03, PR-06, **G2 passing** | Not started |
| PR-08 | Query API v1 with the response envelope | new | PR-04, PR-07 | Not started |
| PR-09 | Aggregation, reconciliation, replay, retention, erasure, diagnostics | new | PR-02 (G6), PR-07 | Not started |
| PR-10 | SDK helper, CLI producer commands, instrumentation skill | new | PR-05, PR-06 | Not started |
| PR-11 | Dashboard Processes page with nested segmented bars | C (FLIG-15) | PR-08 | In flight (fixtures only) |
| PR-12 | Scorecards, alerts, read-only MCP | new | PR-08, PR-09 | Not started |

A feature release (`LIFECYCLE_MODE=on`, a non-prerelease npm export, or docs announcing the feature)
additionally requires integration gates **G1–G8** ([Appendix A](appendix-a-reconciliation.md#a3-integration-gates)).

## Reading order

| Doc | What it answers |
|---|---|
| [01 Current state](01-current-state.md) | What exists on `main`, what is in flight, and what this RFC proposes. Every "exists" claim cites a file. |
| [02 Architecture](02-architecture.md) | The tier boundary, data flow, failure modes and why D1 is disposable. |
| [03 Event contract and ingest](03-event-contract-and-ingest.md) | The wire event, idempotency, the relational graph, the Basin stream schema and the D1 DDL. |
| [04 Time semantics](04-time-semantics.md) | Pauses, overlapping blocks, dwell, open cohorts, censoring, retries, out-of-order events, corrections and reopen, with numeric examples. |
| [05 Definitions, hierarchy, relations](05-definitions-hierarchy-relations.md) | Versioned process definitions, canonical stage mapping, comparability, trees and graph links. |
| [06 Security and privacy](06-security-privacy.md) | App/project/role scoping, pseudonymization, suppression, retention and erasure. |
| [07 Operations](07-operations.md) | Replay, reconciliation, diagnostics, runbooks and SLOs. |
| [08 Query serving and API](08-query-serving-api.md) | Basin SQL constraints, the serving split, and endpoint specifications with freshness and sample counts. |
| [09 Metrics, scorecards, alerts](09-metrics-scorecards-alerts.md) | The metric catalog, scorecard and alert definitions, and evaluation. |
| [10 Instrumentation, CLI, SDK, MCP](10-instrumentation-cli-sdk-mcp.md) | Producer recipes (outbox), the SDK helper, CLI commands and the read-only MCP resources and tools. |
| [11 UI: nested segmented bars](11-ui-segmented-bars.md) | Visual semantics, interaction and accessibility. |
| [12 Rollout, cost, testing](12-rollout-cost-testing.md) | Migrations, provisioning, feature flags, cost and performance budgets, and the test plan. |
| [13 Decision records](13-decision-records.md) | D1–D16 with context, alternatives and consequences. |
| [Appendix A: Reconciliation](appendix-a-reconciliation.md) | Old stacked PRs #1–#18 (reuse concepts, don't merge), in-flight workstreams A–F, and **integration gates G1–G8**. |
| [Appendix B: Workshop](appendix-b-workshop.md) | Agenda, exercises and the open questions to settle. |
| [Examples](examples/README.md) | Hiring, deployment and incident walkthroughs with fictional fixtures and hand-checked expected values. |

## Glossary

| Term | Meaning |
|---|---|
| **Process** | A kind of lifecycle, such as `hiring.application`, `delivery.deploy` or `incident.response`. Identified by `processId`. |
| **Process definition** | An immutable, versioned description of a process: stages, allowed dimensions, relations and canonical mapping. `(processId, version)`. |
| **Case** | One instance of a process, such as one application, one deploy or one incident. Identified by an opaque `caseId` unique within `(app, processId)`. |
| **Stage** | A named step in a definition (`stageId`). |
| **Stage instance** | One visit of a case to a stage (`stageInstanceId`). Re-entering a stage creates a new instance; this is how retries and rework are counted. |
| **Canonical stage** | A version-independent stage key used to compare cases across definition versions. |
| **Pause** | An intentional clock stop: a requested delay, a change freeze. Paused time is excluded from active time. |
| **Block** | An impediment while the clock runs: awaiting approval, interviewer availability, a vendor. Identified by `(stageInstanceId, reason)`. |
| **Dwell** | Time a stage instance is open: `exitedAt − enteredAt`, or `asOf − enteredAt` while open. |
| **Censored** | A case or instance still open at `asOf`. Its true duration is at least its current age. |
| **Producer** | The system of record that emits lifecycle events, through an outbox, to Flightdeck. |
| **Raw evidence** | Every accepted lifecycle event, appended to the `lifecycle_events` Iceberg table through a Basin pipeline. |
| **Read model** | CaseDO state and D1 projection tables derived from raw evidence. Always rebuildable. |
| **`asOf`** | The instant a computation treats as "now" for open cases. Every response states it. |

## What this RFC is not

- **Not a workflow engine.** Flightdeck never moves a case, assigns work or enforces transitions.
- **Not a people-analytics product.** No individual performance views, no rankings of interviewers
  or engineers, no protected characteristics. Actor identities are not part of the v1 contract.
- **Not a causal tool.** Comparisons are descriptive. Process simulation (old PR #9) and experiment
  analysis (old PR #7) stay out of scope; see Appendix A.
- **Not a replacement for the existing analytics.** Events, sessions, live and trends keep their
  current behavior and code paths.
