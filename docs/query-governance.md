# Query governance and accuracy (Beta)

## Event identity and deduplication

Basin Pipelines can deliver data exactly once to R2 while a **caller retry** can still send the same logical event more than once. Flightdeck queries now project logical events using `ROW_NUMBER() OVER (PARTITION BY project_id, source_id, event_id)`, keeping the earliest accepted record. Raw history remains append-only; avoid assuming ingest-level exactly-once application events.

This query-time projection can be expensive. At larger volumes, migrate to materialized deduplicated tables, periodic compaction and partition-aware projections. No materialized-view service is included in this milestone.

## Admission limits

All API analytics requests use a fixed query DSL with a server-derived project/table, validated event names and time windows. Expensive funnel/retention/RUM/transition queries are capped at 31 days; other queries at 90 days. Result rows are bounded.

D1 `query_budgets` tracks **relative units** per project and UTC month. Units represent estimated query complexity, **not Cloudflare costs or bytes scanned**. The quota is atomically incremented before a Basin SQL query. A configured KV binding may cache successful bounded responses for 60 seconds.

With `QUERY_QUOTA_REQUIRED=true` (default), the console fails closed on missing D1 binding/migrations. For test-only environments it may be explicitly disabled, but that should not be used for public production consoles.

`query_audit` logs principal, kind, relative units and status—never API tokens or raw SQL bodies. Actual Cloudflare billing guardrails and materialized aggregate schedules are still future milestones.

## Analysis semantics

- Funnels are **ordered actor-level** steps and require the next event to occur after the previous step, within the queried time span.
- Retention is based on the first event **observed in the selected window**, not true lifetime acquisition.
- Experiment variant counts are exposures, not randomized subjects or evidence of causal lift.
- RUM p75 values are approximate and may require sample weighting as the SDK evolves.
- Discovered transitions are event-to-event counts, not complete user path populations.

For correctness, reconcile event timestamp skew, actor identity changes, late-arriving events and transactional outcomes before treating metrics as financial truth.
