# Lifecycle queries (Workstream G)

Self-contained query specification, read-only SQL plan builder, injected Basin adapter, and fake serving adapter. There are **no imports from the schema, reducer, dashboard, auth, or historical experiment packages**. No Cloudflare resources, credentials, migrations, HTTP routes, or deployments are created. This private workspace package is a contract proposal for integration.

```ts
import {
  createFakeAdapter,
  demoRegistry,
  demoQuery,
  demoWatermark,
  syntheticFacts,
} from "@flightdeckhq/lifecycle-queries";

const serving = createFakeAdapter(syntheticFacts(), demoRegistry, demoWatermark);
const dwell = await serving.query(demoQuery);
const comparison = await serving.query({
  ...demoQuery,
  metric: {
    kind: "comparison",
    stageId: "review",
    reference: { id: "before", caseMix: ["routine", "urgent"] },
  },
});
// comparison.rows has typed primary/reference samples and deltaP50Ms per caseMix.
```

## Contract and semantics

Every query requires app and definition IDs, registered definition versions, metric version `lifecycle.v1`, explicit cohort ID and case-mix strata, canonical UTC millisecond `from`/`to`/`asOf`, filters, `groupBy`, and `topN`. The interval is **case-start cohort membership `[from,to)`**, not event activity or stage-entry time. A case started before `from` is excluded even if still open. Current open age therefore means open cases in this explicit start cohort. Query time bounds must fit the trusted retention/window policy, `from < to <= asOf`, and at most 366 days. `asOf` can lag or exceed the source watermark; a lagging watermark signals incomplete knowledge, not complete data through `asOf`.

`QueryRegistry` is trusted app/definition configuration. It registers the only allowed filter and grouping dimensions: `caseMix`, `cohortId`, `definitionVersion`, `variantId`, and `outcome`. Filters use bounded nonempty value lists with AND across fields and IN within a field. Grouping accepts at most two dimensions; comparisons always add `caseMix`. All interpolated values, including registry mappings, must be restricted ASCII identifiers. Table names come from server configuration and accept up to three simple SQL identifier segments. The builder accepts no expressions, user column names, free SQL, operators, sort clauses, or unbounded limits. Extra request properties have no SQL effect. Public adapters validate at runtime and clone requests/configuration before asynchronous execution.

| Metric kind        | Unit and population                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stage-dwell`      | Per-case total milliseconds across all visits to the canonical stage. Only cases whose stage visits have all exited contribute to p50/p75/p90. An unfinished visit right censors the case's dwell. An invalid/null entry invalidates the whole case's stage sample. |
| `current-open-age` | `asOf - caseStartedAt` for open cases; these are censored cases, not observed completions.                                                                                                                                                                          |
| `outcomes`         | Distinct cases by open/completed/cancelled/failed; open is never treated as completed.                                                                                                                                                                              |
| `funnel`           | Distinct cases reaching each requested checkpoint **in the requested order** with increasing sequence and nondecreasing effective time. Each checkpoint row counts prefix membership, not independent hits.                                                         |
| `variant-counts`   | Distinct cases per canonical process variant. A variant is the projector's registered canonical signature; this package does not discover process paths.                                                                                                            |
| `case-counts`      | Distinct cases, observed terminal outcomes versus right censored open cases.                                                                                                                                                                                        |
| `comparison`       | Stage dwell per shared case-mix stratum and optional groups. Reports primary minus reference p50 only when both observed samples are sufficient. Missing strata are explicitly non-comparable. No unadjusted pooled delta, causal effect, or significance claim.    |

For dwell, observed/censored counts describe **stage** completion; for other metrics they describe **case** completion. Repeated stage visits are summed before percentiles so cases with more visits get no extra weight. The fixture uses exact nearest-rank percentiles. SQL uses `APPROX_PERCENTILE_CONT(value, fraction)` and may differ numerically. Definition versions can pool only when the registry explicitly assigns the same `comparisonKey`, and every requested stage/checkpoint has an explicit physical-to-canonical mapping in each selected version. Mappings must be injective per version. Incompatible definitions fail validation rather than producing a pooled result. Filtering by definition version can intentionally yield a missing comparison arm.

Results echo scope, versions, `asOf`, watermark, cohort, approximation mode, query-level sample size, coverage, suppression policy, and truncation. Query-level sample size is covered distinct **case facts before metric-specific selection**. Each row has its own distinct case sample size and counts. Coverage counts valid case facts versus eligible case facts in the scoped start cohort, before metric-specific selection; it does not measure event delivery completeness or stage/checkpoint completeness. Null starts cannot be assigned to a bounded partition and are excluded from both; upstream quarantine/quality monitoring must count them. Unknown eligible population yields null coverage, not an invented 100%. Top N sorts by sample size (sum of arms for comparison), then key and dimensions. One extra complete group is fetched to establish truncation. Absence of a row is not a measured zero.

Each sample reports explicit suppression flags for the sample, counts, and percentiles; metadata counts rows with any suppressed field. Small samples below the registry minimum (at least two) return null counts and percentiles. If either observed or censored subcount is small, both are hidden to avoid direct complement disclosure. Dwell percentiles also require enough **observed** cases even if the total sample is large. Query-level small counts and coverage ratios are hidden. Suppression is a reporting policy, not a privacy guarantee: group existence, ordering, repeated overlapping queries and aggregate totals can still reveal information. The future read API must apply authorization, approved cohort definitions, and any stronger disclosure policy before serving sensitive data.

## Required normalized projector facts

`LifecycleFact` is an independent serving interface, not the ingest event schema. All records for a case revision form a **complete, atomically visible snapshot**, containing exactly one case fact, intervals for every stage visit, and at most one canonical occurrence of each checkpoint. Flatten to these physical columns for SQL:

| Logical field                          | Iceberg SQL column                                                         |
| -------------------------------------- | -------------------------------------------------------------------------- |
| appId, definitionId, definitionVersion | `app_id`, `definition_id`, `definition_version`                            |
| factId, caseId, revision, kind         | `fact_id`, `case_id`, `revision`, `fact_kind`                              |
| recordedAt                             | `recorded_at_ms` (UTC epoch milliseconds, source knowledge/ingestion time) |
| caseStartedAt, caseEndedAt             | `case_started_at_ms`, `case_ended_at_ms` (nullable epoch ms)               |
| immutable UTC day of caseStartedAt     | `cohort_day` (ISO date partition)                                          |
| cohortId, caseMix, variantId, outcome  | `cohort_id`, `case_mix`, `variant_id`, `outcome`                           |
| stageId, enteredAt, exitedAt           | `stage_id`, `entered_at_ms`, `exited_at_ms`                                |
| checkpointId, reachedAt, sequence      | `checkpoint_id`, `reached_at_ms`, `sequence_no`                            |

Non-applicable columns are null. Partition by app/definition/cohort start day. Every fact in a revision must carry identical case attributes and knowledge timestamp. IDs are scoped by app and definition; `(caseId, revision, factId)` identifies a record. Exact retries are idempotent. Conflicting duplicates, multiple case facts, partial revisions, or ambiguous checkpoint occurrences are projector errors; the fake rejects them. SQL deduplicates exact replay IDs and **relies on projector validation to reject conflicts**, not arbitrary row ordering to resolve them. Revisions must increase and immutable case start must not change. Use a new identity/rebuild if that invariant cannot hold. Deletion/tombstone support needs a new agreed contract before rollout.

Select the highest revision with `recordedAt <= asOf` **before** applying mutable version/cohort/case-mix/outcome filters. A late event/correction creates a new full snapshot; it never patches old interval rows in place. Historical `asOf` excludes later knowledge even when the event's effective time is earlier. Unchanged intervals must be copied into the new revision; omitted intervals disappear. Retain historical revisions for the advertised historical window. A watermark is a source progress claim and cannot guarantee no future correction. Snapshot publication, replay conflict detection, physical partition assignment and revision retention belong to the future projector.

Null starts and terminal cases with null/negative/future end times are excluded. Open case end must be null. Intervals need valid entries within case life and nonnegative exits no later than `asOf` and the terminal case end. A null exit is censored only for an open case. Checkpoints must fall within case life and follow the requested sequence. The package does not infer missing timestamps, auto-close open cases, reduce raw events, perform survival estimation, or repair malformed facts.

## Required read API / Basin integration

`buildBasinSql` creates SELECT-only CTE plans over normalized Iceberg facts with app, definition, cohort partition, half-open start time, knowledge time, definition version, and LIMIT predicates. It is a **Basin/DataFusion dialect candidate**, not an end-to-end verified Basin query. The SQLite contract tests execute its portable SQL structure with an exact percentile stand-in. They do not certify Basin syntax, Iceberg pruning, performance, approximate percentile error, or production completeness.

`createBasinAdapter(registry, execute, table)` injects execution. The executor must:

1. Use a read-only scoped credential and a server-owned table. Validate the candidate SQL, column types, CTE/window functions, and approximate percentile signature against the actual Basin deployment before enabling serving.
2. Pin all data and coverage evidence to the same snapshot and knowledge cutoff. Decode snake_case columns to `AggregateRow` and reject partial, failed, timed-out, or malformed responses. The adapter checks count consistency, dimensions, percentiles, duplicate rows, and response row limits; those checks do not establish trustworthy source data.
3. Supply scoped eligible/covered case counts and the actual source watermark as `Evidence`. The metric SQL does not query or fabricate source progress and coverage; these need a consistent serving manifest or separate bounded evidence query.
4. Enforce scan bytes, execution deadline, response bytes, concurrency and cancellation budgets externally. A SQL LIMIT caps output, not scan cost; filtered partitions help pruning but do not prove a cost budget. Run read-only access, partition-pruning and query-plan checks on real Iceberg facts.
5. Authorize app/definition access independently of caller IDs, load trusted registry/cohort definitions, normalize requests, choose server-owned `asOf`, enforce freshness/disclosure policies, and translate validation/execution errors to the future read API. No auth or route is provided here.

Historical unmerged draft PRs [#3 (analytic query budgets)](https://github.com/gmackie/flightdeck/pull/3) and [#7 (experiments)](https://github.com/gmackie/flightdeck/pull/7) are possible future reuse/migration sources. This work assumes neither is on current main and imports neither. Before reuse, review their actual branch contracts, migrate useful executor budgets/cohort or experiment definitions behind these interfaces, and reconcile naming, versioning, authorization and disclosure semantics. Experiment assignment and causal analysis remain separate concerns.

## Verification

Run with the repository's Node 24 and locked pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm --filter @flightdeckhq/lifecycle-queries typecheck
pnpm --filter @flightdeckhq/lifecycle-queries build
pnpm --filter @flightdeckhq/lifecycle-queries test --coverage
pnpm lint
pnpm typecheck
pnpm test
```

Tests cover injection payloads at every interpolation boundary, invalid windows, null times, exact replay and conflicting IDs, full snapshot corrections, historical knowledge, open/terminal outcomes, repeat visits, ordered funnels, semantic version mappings, non-comparable cohorts/strata, top N, small-n counts and percentile suppression, malformed executor data, and in-flight mutation. SQL differential tests use Node's local SQLite; only tests use SQLite writes to populate fixtures. Production SQL plans contain no writes.
