# @flightdeckhq/lifecycle-investigations

Model-agnostic, aggregate-only lifecycle evidence over
`@flightdeckhq/lifecycle-queries`. Runs in Node and Workers. No model calls, MCP
server, process writes, recruiting logic, or production connection is included.

## Core API

```ts
import {
  executeInvestigation,
  planInvestigation,
  serializeEvidencePack,
  validateAgentAnalysis,
  type AuthorizeInvestigation,
  type InvestigationCatalog,
  type InvestigationRequest,
} from "@flightdeckhq/lifecycle-investigations";
import type { QueryAdapter } from "@flightdeckhq/lifecycle-queries";

export async function collect(
  request: InvestigationRequest,
  catalog: InvestigationCatalog,
  adapter: QueryAdapter,
  authorize: AuthorizeInvestigation,
) {
  // Pure preview; do not accept a caller-supplied plan as executable code.
  const preview = planInvestigation(request, catalog);
  const { pack, report } = await executeInvestigation(request, {
    catalog,
    adapter,
    authorize,
    expectedPlanDigest: preview.digest,
  });
  return { pack, json: serializeEvidencePack(pack), report };
}
```

Load the catalog from trusted server configuration: exactly one registered app
and definition, canonical stage IDs and lanes, grouping allowlist and policy.
Registry `comparisonKey` declares comparable definition versions. Catalog revision
must change when mappings or policies change. Requests supply an explicit cohort
ID, registered case-mix strata, canonical UTC windows and a single knowledge
`asOf`. `asOf` cannot precede window end or be in the future. A preview performs
no I/O; the boundary must still authorize disclosure of private catalogs/plans.

`authorize` is required and fails closed. Return `{ allowed: true, appId,
scopeKey }` only for a current `process:read` grant on the requested app and
definition. `scopeKey` must be an opaque token bound to principal AND grant
revision, never a raw user identifier. Execution rechecks it before cache/source
access and before returning a pack; changed grants reject the whole execution.
Adapters must enforce their own source authorization too. No remote process can
make grant revocation atomic with an already dispatched query.

## Version 1 recipes

| Recipe                | Required comparison                             | Evidence                                        |
| --------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `process-health`      | None                                            | Counts, outcomes, open age, stage dwell         |
| `bottleneck-triage`   | None                                            | Stage median and open-work rankings             |
| `dwell-regression`    | Earlier, non-overlapping equal-length window    | Matched stage dwell and case-mix shares         |
| `variant-comparison`  | At least two visible variants                   | Within-stratum dwell and outcome differences    |
| `intervention-review` | Distinct reference cohort, identical case mixes | Signed p50 differences and independent outcomes |
| `capacity-risk`       | Earlier equal-length window                     | Arrival counts, open work and open age          |

Use `describeRecipes()` for versioned hypotheses, parameter contracts, budgets,
alternatives and safeguards. Unknown recipe/definition versions, unregistered
stages, cross-app scope, mixed case mixes and disallowed grouping fail validation.
Every query is checked by the query package against the trusted `QueryRegistry`.
Extra grouping is limited to one recipe-allowlisted dimension, always alongside
case mix. Request budgets only tighten defaults. Absolute ceilings are 24 queries,
8 stages, 92 days, 50 rows/query, concurrency 4, 30 seconds/query and 120 seconds
of source execution. Recipe defaults are lower. Cost units are a planning
heuristic, not a claim about upstream scanned rows or billed cost.

## Evidence and interpretation

Packs carry query IDs/digests, result digests, exact row refs (`q:<queryId>#<n>`),
metadata refs, per-result asOf/watermark/lag/window coverage, sample counts,
coverage, suppression, observed/censored counts, approximation, missing evidence,
confounders, unsupported claims and descriptive finding candidates. Source rows
are sorted independently of adapter completion order. SHA-256 hashes canonical
sorted-key JSON; `ep_` IDs use its first 32 hex characters, while `digest` retains
the full hash. `parseEvidencePack` verifies integrity on round-trip; hashes are
not signatures, source authenticity proofs, or authorization tokens.

Negative `deltaP50Ms` means the primary/current cohort is faster; it is valid.
Only durations and counts must be nonnegative. Stage medians are **never summed**
into cycle time or critical paths, including across parallel lanes.

Findings are `observed`, `not_observed` or `cannot_determine`. Small samples,
unknown/low coverage, missing strata, truncated results, stale/incomplete source
windows and incompatible censoring block the dependent finding. Comparisons
across different source watermarks are undeterminable; unrelated observations
retain their own freshness metadata. A shared asOf does not promise an atomic
source snapshot. Window maturity is reported without survival correction.
`complete` describes completed evidence collection, not proof that every finding
is determinable or that an intervention is beneficial. Thresholds are descriptive,
not significance tests. No confidence intervals, causal effect, service-capacity
forecast or individual-case inference is generated.

Result validation checks full metric identity, registered keys/group values,
cohort/version/app scope, suppression consistency and exact signed comparisons.
Unknown payload fields and adapter error messages are never copied into packs.
Registered dimension values must themselves be safe aggregate labels; do not
register person IDs, emails or sensitive text as dimensions.

## Timeouts, cache and storage

The `QueryAdapter` contract has no cancellation signal. A timeout retains its
concurrency slot until the underlying operation settles. The total deadline
returns with timed-out/unstarted evidence explicitly marked, closes scheduling,
and prevents late adapter results from mutating the returned pack or starting
cache writes. An I/O operation already dispatched cannot be cancelled. Hooks for
authorization, cache and optional persistence are caller-owned and should have
their own bounded transport timeouts. Source deadlines use a monotonic clock;
`now` is only the trusted planning clock.

Caching and persistence are disabled by default. Optional cache keys bind app,
definition, principal/grant scope, full catalog digest/revision, source revision
and exact query digest. Supply a real source revision/watermark token; do not
reuse it after corrections. Cache contents are projected aggregates, revalidated
on read; denied authorization performs zero cache/source/persistence I/O. Cache
failures are misses. Optional persistence writes canonical aggregate JSON to an
app/pack key with a bounded TTL. Its store must remain private and enforce current
principal grants on retrieval; this package exposes no retrieval endpoint.

## Client claims and prompts

`PROMPT_TEMPLATES` / `renderInvestigationPrompt` provide static, domain-neutral
playbooks and `AGENT_OUTPUT_SCHEMA`. Register them in the host's current MCP SDK;
the library performs no sampling or model invocation.

`validateAgentAnalysis(pack, output)` requires each factual claim to copy **one
exact finding statement** and cite all its row refs. It rejects unknown refs,
foreign rows, invented statistics/paraphrases, undeterminable findings asserted
as facts, and causal language (including causal hypotheses). An uncited fallback
must say exactly `Cannot determine from this evidence pack.`. Free-form uncertainty,
next measurements and action proposals are advisory text, not validated evidence
or executable actions. This validator cannot establish their semantic correctness.

## Companion MCP integration (PR #47)

[FLIG-29 / PR #47](https://github.com/gmackie/flightdeck/pull/47) defines
`InvestigationBridge` in `apps/lifecycle-mcp/src/investigation-contract.ts`:
`plan(InvestigationInput): Promise<InvestigationPlan>` and
`collect(InvestigationInput): Promise<InvestigationEvidence>`, with transport
`contract_version: "bounded-read-bridge@1"`. That transport is not the package's
`flightdeck.investigation-plan.v1` / `flightdeck.evidence-pack.v1` schema.

A future typed adapter implementing that interface must explicitly map app,
workflow and numeric definition version to a trusted catalog, normalize UTC
instants, resolve registered cohort/case-mix IDs, map goals to recipes, preserve
its existing Access/app-grant/service-reader ceiling, and call this package with
`authorize`. Map only evidence the source actually supplies. Its current reads
cannot supply historical asOf, verified matched cohorts, case counts/coverage or
full outcomes: refuse those recipes as insufficient evidence rather than invent
adapter results. Preserve exact package refs/digests in a versioned transport
upgrade; never cast these different schemas into each other. Clamp package
budgets to the MCP boundary's stricter time/read/row/output limits. No companion
worktree or MCP server implementation is changed here.

MCP Tasks, Apps visualizations, persistent evidence retrieval, production source
wiring, cancellation-capable transports and a bridge schema upgrade are follow-ups.
No Tasks/Apps capability or dependency graph is advertised by this library.

## Validation

`test/fixtures.ts` generates hiring (parallel lanes), deployment and incident
facts using the existing query package's `createFakeAdapter`; all data is
synthetic. Run `pnpm --filter @flightdeckhq/lifecycle-investigations test`.
Workspace `pnpm smoke:pack` installs tarballs outside the workspace, typechecks
consumer imports on TypeScript 7 and 5, and executes an installed-package
investigation. No publication, merge or deployment is performed.
