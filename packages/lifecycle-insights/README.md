# @flightdeckhq/lifecycle-insights

Workstream I: a standalone, dependency-free TypeScript library for **process improvement** across any lifecycle. It evaluates versioned aggregate snapshots and returns alert state transitions or descriptive process-variant comparisons. It has no IO, persistence, scheduler, notifier, credentials, UI, or dependency on Flightdeck's schema, ingest, or lifecycle packages.

**This is not a production alerting system without integration.** It must never make automated HR decisions, score people, or rank processes as “best.” The hiring, release, and incident examples contain synthetic aggregate data only.

## API and runnable synthetic examples

```ts
import { compareVariants, evaluateRule } from "@flightdeckhq/lifecycle-insights";
import { syntheticContext, syntheticFixture } from "@flightdeckhq/lifecycle-insights/fixtures";

for (const lifecycle of ["hiring", "release", "incidents"] as const) {
  const { snapshot, comparison, rule } = syntheticFixture(lifecycle);
  const alerts = evaluateRule({ rule, current: snapshot, context: syntheticContext });
  const observed = compareVariants({
    spec: comparison,
    left: snapshot,
    right: snapshot,
    context: syntheticContext,
  });
  // alerts.status === "evaluated", alerts.transition === "opened", alerts.value === 0.9
  // observed.status === "compared"; both sides cover 100% of two matched strata.
  // Duration differs in opposite directions by category; pooled difference is 0.
  // Inspect warnings and coverage before interpreting any differences.
}
```

Public exports: `evaluateRule`, `alertKey`, `acknowledgeAlert`, `compareVariants`, `validateSnapshot`, and the TypeScript contracts in [`src/types.ts`](src/types.ts). Examples are opt-in through `./fixtures`; the main entry point does not import them. All functions are synchronous and deterministic for the same inputs. Config and persisted alert state are trusted typed inputs; `validateSnapshot(unknown, context)` validates snapshot shape and invariants at runtime, rejects unknown fields, and returns reason codes. Evaluations also run that validation. Callers should size-limit incoming JSON before parsing it.

## Aggregate contract and producer responsibilities

Only **normalized aggregate cells**, never case rows, stage event rows, person IDs, names, free text, PII, sensitive dimensions, or scorecards enter this library. IDs refer to snapshots, aggregate cells, process definitions, stage occurrences, populations, variants, or process-owning groups. Opaque IDs are references, not a license to pass individual pseudonyms. The integration must review the source and dimension policy; this library cannot determine whether an opaque string secretly identifies a person.

A `Snapshot` pins:

- Contract version `1`, permitted `sourceId`, source/definition/mapping revisions, lifecycle/population, and **case** or **stage occurrence** scope. Definition revision includes population membership, metric eligibility, sampling, and outcome semantics. A stage occurrence is not a reusable stage template. `stageMapping` assigns each canonical stage role a distinct occurrence ID, including repeated reviews. Mixed scopes, repeated IDs, mapping drift, and version drift block evaluation.
- Explicit half-open event-time window `[start, end)`, caller-supplied evaluation `asOf`, producer `producedAt`, and event-time completeness `watermark`. Timestamps are nonnegative UTC epoch milliseconds. `window.end <= watermark <= asOf <= producedAt`; point-in-time dwell/backlog/capacity/SLA alerts additionally require completeness through `asOf`; current and baseline snapshots must have the **same** `asOf` as the evaluation context. Baseline events come from its earlier window but reflect the same knowledge cutoff. Snapshot IDs must be immutable and revisioned on backfill.
- A valid IANA `timeZone` and a versioned upstream `calendar`. The producer resolves local window bounds, DST, holidays, business time, pause subtraction, and calendar revisions. The evaluator does no date bucketing or implicit timezone conversion. Baseline windows must have equal elapsed length; DST/business-window differences require upstream normalization and an explicit compatible definition, not silent comparison.
- Explicit common units: duration `ms`, a normalized cost unit, rework `count`, and capacity unit. Currency, calendar, units, source, population, stage mapping, or definition changes require new compatible configs; they cannot silently carry an alert or comparison forward.
- `intervalPolicy: "union-active-excluding-pauses"`, `overlappingIntervalsResolved: true`, and `disjointCells: true`. The trusted producer unions overlapping active intervals, subtracts pauses, clips at the cutoff, and guarantees one observation per scoped unit and no overlapping cells. In case scope, repeated stage visits must be aggregated into the case before computing moments; they are not extra independent samples. These attestations are mandatory, but aggregates cannot prove them. The producer also must allocate shared capacity without duplicating its denominator across cells.

Every cell contains all policy dimensions, one variant, distinct cohort size, completed count, censored/open count, paused-open count, current active dwell p90/sample size, stuck/aged/SLA threshold counts and denominators, terminal outcome counts, used/available capacity, and completed-only duration/cost/rework moments `{ n, sum, sumSquares }`. Outcome categories rejected/cancelled are mutually exclusive; “other” is `total - rejected - cancelled`. Unobserved moments use all zeroes; empty dwell uses `{ n: 0, p90Ms: null }`. Zero is a real observation, not missing data. Moment/sample counts cannot exceed completed counts. Counts, finite numbers, moment consistency, duplicate cells, scope, and interval flags are checked. Eligibility definitions belong in the versioned producer contract:

- Current dwell and stuck/aged backlog refer to unpaused open observations at `asOf`, not completed durations. Open observations are right-censored. Threshold counts use strict active age `> thresholdMs`.
- SLA eligibility is explicitly supplied by the source definition; age uses the same pause-excluding calendar. Completed and eligible open observations must be distinct.
- Completed throughput and outcomes use completion event times inside the window. Moments and completed counts must describe the same selected cohort. Cost units must already be normalized; no FX conversion occurs here.
- Backfill uses historical **event time** and an explicit knowledge cutoff. A later `producedAt` is allowed only when the producer reconstructs exactly what was known at `asOf`. Ingestion time must not stand in for event time. The library cannot reconstruct historical knowledge from aggregates or verify that promise.

## Rule DSL

A `Rule` specifies ID/version, process-owning `ownerRef`, severity (`info`, `warning`, `critical`), expected `contract`, explicit window, variant/allowlisted filters, metric, strict `threshold`, minimum samples/cohort size, and cooldown milliseconds. Stuck/aged/SLA rules also pin `ageThresholdMs` to the source's threshold bucket. Throughput rules require explicit `baselineWindow`. For example:

```ts
const { rule: capacityRule, snapshot } = syntheticFixture("incidents");
const backlogRule = {
  ...capacityRule,
  id: "incident-process-backlog",
  version: 1,
  metric: "stuck-open-count" as const,
  ageThresholdMs: 3 * 86_400_000,
  threshold: 10,
};
evaluateRule({ rule: backlogRule, current: snapshot, context: syntheticContext });
```

| Metric                | Evaluated value                                                 | Sample denominator / limitation                                                                                   |
| --------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `p90-current-dwell`   | Active open dwell p90 in ms                                     | Active dwell sample size; exactly one selected preaggregated cell, since p90s cannot be pooled                    |
| `stuck-open-count`    | Sum of open observations beyond the pinned age                  | Eligible unpaused open observations                                                                               |
| `aged-backlog-count`  | Sum of backlog observations beyond the pinned age               | Eligible unpaused open observations                                                                               |
| `throughput-drop`     | `(baseline completed - current completed) / baseline completed` | Baseline completions and current eligible cohort must meet minimum; zero current completions is a valid full drop |
| `rejection-share`     | Rejected / terminal outcomes                                    | Terminal outcomes                                                                                                 |
| `cancellation-share`  | Cancelled / terminal outcomes                                   | Terminal outcomes                                                                                                 |
| `capacity-saturation` | Used / available capacity                                       | Eligible cohort size; availability must be positive; utilization may exceed 1                                     |
| `sla-breach-share`    | Breaches / SLA-eligible observations                            | SLA-eligible observations                                                                                         |

Shares/drop thresholds use fractions in `[0,1]`, not percentages. Count and duration thresholds are nonnegative. Values must be strictly greater than the threshold to open. Throughput may be negative when volume grows; no alert results for a nonnegative drop threshold. Baseline windows must precede the current window, have identical duration, and use identical scope, units, calendar, versions, stage mapping, selected strata, and cutoff. Zero denominators, too few observations, suppression, mismatched buckets, and incomplete watermarks produce `blocked`, never a fabricated zero or a cleared alert. “Unusual” shares are configured process thresholds, not an anomaly model.

### Alert lifecycle

Pass previously persisted `Alert` state as `previous`; omit it for first evaluation. Persist successful state atomically by `alertKey(rule)` and evaluation cutoff. The dedupe key uses canonical configuration (including normalized filters, scope, rule version, units, window duration/baseline lag, thresholds, minimums, owner, severity, cooldown) while excluding rolling window endpoints. Semantic config changes require a new version. Persisted state for a different key/version/scope is rejected; the caller must explicitly initialize the new rule's state and retire/migrate the old version.

Transitions: `opened`, `updated`, `cooldown`, `cleared`, `reopened`, `unchanged`. `emit` is a **pure intent** emitted on opening or an ongoing breach after cooldown. A reopen changes status even within cooldown, increments occurrences, and removes the prior occurrence's acknowledgment. Clearing emits no notification intent; it requires valid nonbreaching evidence. Blocked results carry no state to overwrite a prior alert. An acknowledgment does not mute ongoing breach updates or clear it. `acknowledgeAlert(alert, ownerRef, at)` returns a copy; the caller authorizes and persists it. Never accept process owners directly from untrusted clients.

Evaluations must advance monotonically. Replaying a prior snapshot at the same cutoff returns unchanged, without emission. A conflicting snapshot/value at the same cutoff or an older cutoff is blocked. Replay does not compare entire payloads: IDs must refer to immutable snapshots. Retain caller-owned state across executions; this package alone cannot guarantee delivery, distributed deduplication, restart recovery, or exactly-once behavior. Throughput alerts also retain their baseline drilldown. Alert drilldowns are structured aggregate snapshot/scope/filter/window/cutoff/watermark references, never URLs into individual records. Callers must independently authorize drilldowns.

## Descriptive variant comparison

`ComparisonSpec` selects different variants with identical canonical allowlisted filters and a single pinned contract/window. It explicitly assigns **every** allowed dimension (e.g. category, level, region) to `controls` or `uncontrolled`. Matching is exact on control strata, without fuzzy matching, propensity inference, or automatic choice of controls. Nonmatching strata count against coverage; they never become a comparison with zero-valued outcomes.

For each matched stratum `s`, weight `w_s = (left cohort_s + right cohort_s) / combined matched cohort`. Each side's standardized mean is `sum(w_s * mean_s)`; the observed difference is **right minus left**. Crude differences use each side's own metric sample composition over the same matched population. Report duration, cost, rework, rejection share, and cancellation share; do not turn signs into a winner, recommendation, or causal attribution. Controls describe observed composition only. They do not remove unmeasured confounding, selection bias, informative censoring, or time trends.

Every stratum/side must meet configured sample and privacy floors. `minimumCoverage` in `(0,1]` applies both to matched cohort coverage and metric observations as a fraction of completed observations in every matched stratum. Below it, comparison blocks. Below full coverage, warnings describe the excluded population. Returned coverage shows left/right matched fractions and matched stratum count. Completed-only statistics do not estimate the full censored lifecycle duration; outputs flag censoring, unequal censoring (>10 percentage points), and paused time. Open durations are never imputed as completed zeroes.

For each metric, the approximate 95% normal interval is `difference ± 1.96 * sqrt(sum(w_s² * (variance_left/n_left + variance_right/n_right)))`. Variances use unbiased sample moments; outcome indicators use their Bernoulli sample variance. Intervals require at least 30 observations per side in **every** stratum; rare outcomes (<5 events or nonevents in any stratum) receive no normal interval. Smaller permitted cohorts receive descriptive differences plus `small-n-no-confidence-interval`. Intervals assume independent observations, fixed observed weights, and sufficiently regular sampling. Aggregate moments cannot diagnose skew, clustering, or dependence; these intervals are not distribution-free guarantees. Multiple metrics are flagged as unadjusted; there is no significance-based recommendation.

A sign reversal between crude and standardized differences, or between crude and all strata, flags `simpsons-paradox-concern`. Opposing stratum differences flag heterogeneity. Neither diagnostic proves or rules out confounding. Reused or missing stage roles must be mapped consistently upstream; ambiguous occurrence reuse or mapping drift blocks. Missing coverage, incompatible populations/windows/versions/units/calendars, hidden cells, zero denominators, and blocked filters return only `{ status: "blocked", reasons }`, without partial statistics, cohort counts, or drilldowns.

## Privacy and suppression boundary

`EvaluationContext.policy` is trusted server configuration: a permitted-source list, explicit dimension **keys and values**, and a minimum cohort floor (>=2; synthetic examples use 10). Only approved non-sensitive process dimensions belong in it. Unknown/missing dimensions, unallowlisted filter values, individual record fields, and unknown snapshot fields fail closed. Every selected cell and each nonzero measurement cohort must meet the privacy floor; a large parent cohort cannot disguise a single-observation moment. Rule/comparison minimums can raise the policy floor but cannot lower it.

Any selected suppressed cell blocks the whole selection before matching, including otherwise unmatched cells. It is never silently dropped or exposed as a smaller visible remainder. The source can send a suppressed placeholder with zero-valued measurements and `suppressed: true`; actual sensitive aggregates need not be supplied. Unselected suppressed cells contribute nothing to results. Reasons do not echo raw values or cell IDs.

This library stores nothing and implements neither differential privacy nor a query-history privacy budget. Upstream must perform primary/complementary suppression, prevent differencing attacks across adjacent filters/windows, prohibit sensitive or uniquely identifying dimension combinations, and apply source/tenant permissions. Allowlisting and a cohort floor alone cannot guarantee anonymity. Policy/schema shape checks cannot prove the absence of PII inside an otherwise allowed string or the legitimacy of the source; the adapter must enforce both.

## Future integration (not implemented here)

1. An authorized aggregate adapter consumes the permitted normalized process/stage interval source and produces immutable snapshots satisfying the above contracts. It owns overlap/pause/calendar normalization, stable cohorts, watermark/cutoff reconstruction, deduplication, suppression, coverage, unit normalization, and repeated-stage mapping. It must not pass raw entities through this API.
2. A server-owned versioned config registry validates policy/rule ownership, freezes matching windows and baselines, and calls these pure functions. It persists alert state atomically under the dedupe key, records blocked evaluations separately, and defines replay/backfill policy and old-version retirement. Concurrent workers need compare-and-swap or equivalent serialization.
3. Authorized future read/display code may consume the result, present coverage/warnings alongside differences, and resolve aggregate drilldown references with the same policy. Any future notification adapter must be separately designed and audited. No existing read API, Basin schema, dashboard component, RBAC migration, schema/ingest package, or lifecycle package is changed by this work.
4. Integration/operational acceptance must establish durable state, scheduling, retries, stale-source monitoring, authorization, privacy/query limits, auditability, performance limits, and delivery semantics before describing this as production alerting. No merge, publish, deploy, or HR automation is part of this draft.

## Development and packaging

The workspace's `packages/*` and Vitest project globs discover this package automatically; it adds no dependencies or lockfile resolutions (frozen install is verified). It follows source exports for workspace development, `.js` relative imports, `dist` ESM/declarations via `publishConfig.exports`, root MIT license, shared version `0.1.1`, and `prepack` builds. Root release scripts already discover all nonprivate packages. This makes it eligible for a **future** coordinated release; nothing is published here.

```sh
pnpm --filter @flightdeckhq/lifecycle-insights test
pnpm --filter @flightdeckhq/lifecycle-insights typecheck
pnpm --filter @flightdeckhq/lifecycle-insights build
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm release:version check v0.1.1
pnpm smoke:pack
```

The shared pack smoke installs actual tarballs outside the workspace, typechecks the public API using TypeScript 5 and the repository version, and evaluates synthetic alerts/comparisons in plain Node ESM, including the optional fixture subpath. Tests cover zero denominators, threshold boundaries, version/source/scope/calendar/units drift, wrong baselines, suppression/blocked filters, small cohorts, pauses/overlap attestations, event vs ingestion time and backfill, alert dedupe/cooldown/clear/reopen/acknowledgment, controlled matching, coverage, censoring, and Simpson's paradox concerns.
