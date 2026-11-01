# Lifecycle MCP server (optional, read-only)

`apps/lifecycle-mcp` is a separate, optional Cloudflare Worker that exposes lifecycle and workflow
intelligence to trusted agents over the Model Context Protocol. It reads aggregates and single-case
histories; it never writes. It is generic process analytics (change rollouts, support tickets and
similar). It has no HR or personnel logic.

**Status: not deployable to production.** This build refuses `LIFECYCLE_MCP_ENVIRONMENT=production`,
and its only real data path, the `read-api` source, fails closed until the Workstream H read API
(FLIG-21, PR #36) is on main and the adapter is implemented. Nothing in this repository deploys it.

## Protocol

- MCP protocol revision **2026-07-28** with the stable v2 TypeScript SDK
  (`@modelcontextprotocol/server` 2.4.0). It uses the SDK's stateless `createMcpHandler`: one
  `McpServer` per request, with no sessions and no Durable Objects. The Cloudflare `agents` package
  and the v1 `@modelcontextprotocol/sdk` are not used.
- Endpoint: `POST /mcp` only. `legacy: "reject"` answers 2025-era `initialize` traffic with `-32022`.
  `GET`/`DELETE` return 405.
- Capabilities: `tools`, `resources` and `prompts`, with `listChanged: false`. There are no
  completions, logging, resource subscriptions, `subscriptions/listen` streams or async tasks. A
  method allowlist on the trusted `Mcp-Method` header refuses everything else before dispatch.
  A task-augmented `tools/call` runs synchronously and creates no task.

## Tools

All tools are annotated `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` and
`openWorldHint: false`. Inputs and outputs use strict schemas: unknown arguments such as `sql` are
rejected, and an output field the server did not add on purpose fails validation.

| Tool | Capability | Returns |
| --- | --- | --- |
| `list_workflow_definitions` | `lifecycle:read` | Versioned definitions: stages, outcomes, declared dimensions (paginated) |
| `get_case_summary` | `lifecycle:read` | One case by opaque id: status, stage, outcome, times, declared dimensions |
| `get_case_timeline` | `lifecycle:read` | One case's stage intervals (paginated); no actors or notes |
| `get_stage_dwell` | `process:read` | p50, p90, mean and open count per stage, optionally by one dimension |
| `get_funnel` | `process:read` | Reach rate and step conversion per stage |
| `compare_workflow_variants` | `process:read` | Path variants of one version, or a two-version end-to-end comparison |
| `list_bottlenecks` | `process:read` | Stages ranked by an observed waiting signal |
| `describe_metric` | authenticated | Definition, computation and caveats of a metric |
| `get_data_freshness` | `lifecycle:read` | Watermark, lag and status per workflow |
| `plan_investigation` | `process:read` | Typed bounded aggregate-read plan; no data queries or model invocation |
| `collect_investigation_evidence` | `process:read` | Immutable aggregate evidence pack, source snapshots, sample/quality checks and citations |

Resources: `lifecycle://glossary/metrics`, `lifecycle://spec/workflow-definition` and the template
`lifecycle://apps/{app_id}/workflows/{workflow_key}/definition`. The template lists and reads only
apps the caller holds a grant for.

Existing read-tool results carry `provenance` (source, `synthetic` flag, source version, `as_of`, freshness and
the normalized query) and `interpretation` (`causal: false` plus caveats). Aggregates are labelled
observed process patterns. Comparisons always state that differences are not caused by the version
alone, and bottlenecks are `evidence: "observed_association"`.

## Security model

1. **Fail-closed configuration** (`src/config.ts`). An unset or unknown environment counts as
   production, and production is refused (`PRODUCTION_ENABLED = false`). An unknown or `disabled`
   source returns 503. A missing Access team or AUD returns 503, except for the local bypass, which
   needs `development` + `synthetic` + `LIFECYCLE_MCP_DEV=1` together.
2. **Cloudflare Access verification before any MCP parsing** (`src/auth.ts`). The Worker verifies
   `Cf-Access-Jwt-Assertion` itself: RS256, issuer = team, `exp`/`iat` required, and the audience
   of the **MCP hostname's own Access application**. A dashboard token is rejected. Users need
   `sub` + `email`; service tokens need `common_name`. An unauthenticated caller cannot list tools.
3. **Origin allowlist.** A request that has an `Origin` header outside
   `LIFECYCLE_MCP_ALLOWED_ORIGINS` gets 403. This covers browsers that would attach the Access
   cookie cross-site, and DNS rebinding.
4. **App-scoped grants** (`src/authorize.ts`). The roles mirror FLIG-18 (PR #31): reader has
   `lifecycle:read`, and analyst/owner/admin add `process:read`. Service tokens are capped at reader,
   so they get no aggregates. Expired grants and unknown roles do not count. An unknown app and an
   ungranted app get the same `forbidden` error. If grants cannot be loaded, every call is denied.
   The only way to obtain the `AppScope` that every source method requires is through the
   authorizer, so a source is never asked about an ungranted app. The upstream read API must
   re-check the forwarded assertion; the MCP check adds a second layer and does not replace it.
5. **Privacy** (`src/privacy.ts`):
   - Explicit allowlist projection: only declared stages, outcomes and dimension values pass, and
     free text (notes, names, emails) a source returns is dropped.
   - Groups under k distinct cases (k ≥ 5, `LIFECYCLE_MCP_MIN_COHORT` can only raise it) are
     withheld without counts.
   - Complementary suppression: when exactly one group in a breakdown is withheld, the next smallest
     is withheld too.
   - Funnel reach and completion counts/rates also withhold rare complementary non-reached/open cohorts.
   - Rare path variants are pooled into `other`, which is never left recoverable.
   - Percentiles need at least k completed intervals, and open counts between 1 and k-1 are null.
6. **Bounds** (`src/bounds.ts`):
   - Pages: ≤ 50 rows; timelines ≤ 100 entries per page.
   - Cursors: ≤ 20 pages. A cursor is bound to the tool, app and query fingerprint.
   - Windows: ≤ 366 days (default 90), no future `to`.
   - Queries: ≤ 3 filters, ≤ 12 funnel stages, ≤ 64 argument elements, 64 KiB request bodies.
   - Results: ≤ 48,000 serialized characters. A larger answer is refused with `result_too_large`,
     never truncated silently.
7. **No arbitrary queries.** There is no SQL, expression or free-text search input. The source of
   truth is the future read API's derived read model, never Basin/R2 raw events.
8. **Errors** use fixed messages and codes (`forbidden`, `not_found`, `invalid_argument`,
   `source_unavailable`, `result_too_large`, `budget_exceeded`, `insufficient_evidence`, `internal`). Upstream error text and input values are
   never echoed. Responses are `Cache-Control: no-store`.

## Configuration

See `apps/lifecycle-mcp/wrangler.jsonc` (defaults: `production` + `disabled`, so the deployed
defaults serve nothing) and `apps/lifecycle-mcp/.env.example` for local overrides. This server holds
no secrets. `workers_dev` and `preview_urls` are off and no route is configured.

Local synthetic demo (no Access, invented data only):

```sh
cp apps/lifecycle-mcp/.env.example apps/lifecycle-mcp/.env
pnpm --filter @flightdeckhq/lifecycle-mcp dev
# Connect an MCP client that speaks protocol 2026-07-28 to http://localhost:8787/mcp
```

Synthetic apps: `synthetic-release` (`change-rollout` v1/v2) and `synthetic-support`
(`support-ticket`), both with an analyst grant for every caller. `synthetic-restricted` has no grant
and exists for denial checks.

## Rollout checklist (before production can be enabled)

Each item is unverified today:

1. Workstream H read API (PR #36) merged and routed behind FLIG-18 grants (PR #31).
2. A caller-grants read endpoint exists upstream. `grantsFor` has no specified route yet (see
   `PLANNED_ROUTES` in `src/sources/read-api.ts`). Funnel and path-variant summaries do not exist in
   PR #36 yet.
3. `ReadApiLifecycleSource` implemented: GET only, forwards the verified assertion over a service
   binding, checks the envelope `app_id` equals the scope, and validates every field. It needs
   tests against H's real handler.
4. A dedicated Access application and AUD for the MCP hostname, with a policy for the intended agents
   and service tokens. Confirm that the MCP clients you use can send `Cf-Access-Jwt-Assertion` (or
   go through `cloudflared access`). OAuth 2.1 protected-resource metadata for generic MCP clients
   is **not implemented**.
5. Staging verification with real Access and the read API, a review of suppression on real cohort
   sizes, and a rate limit (none exists today).
6. Only then: a reviewed change flipping `PRODUCTION_ENABLED`, adding a custom domain and the service
   binding.

## Known limitations

- Differencing across many overlapping queries (different windows or filters) can still narrow down
  small groups. Complementary suppression, pooling, analyst-only aggregates and bounds reduce this
  but do not eliminate it. Neither count rounding nor differential privacy is implemented.
- Case-level tools are not cohort-suppressed. They expose opaque ids and declared categorical values
  under `lifecycle:read`, matching H, and grant policy decides who gets them. Opaque ids must come
  from a keyed hash upstream.
- The bottleneck score is a heuristic for where to look, not a diagnosis.
- No rate limiting or per-caller query budget.

## Analysis prompts (FLIG-29; stacked follow-up to PR #44)

The stable v2 `McpServer.registerPrompt(name, {title, description, argsSchema}, callback)` registers
`investigate_bottleneck`, `explain_dwell_change`, `compare_process_variants`,
`evaluate_intervention`, `process_health_review` and `capacity_risk`. `prompts/list` and
`prompts/get` are allowlisted. Each requires only `app_id` and `workflow_key`, validated with a
strict object schema; no free-text instruction parameter exists. Unknown/extra arguments fail.

MCP prompt messages have user/assistant roles, not a system role. The first message contains only
static server-authored safety and analysis guidance. The second contains validated scope identifiers
serialized as untrusted JSON data. No producer-authored label, description or source result is
promoted into instructions. Templates do not access lifecycle data; tool calls separately authorize
the exact app. They direct the **client's model** to collect evidence, verify freshness, check matched
cohorts and case mix, cite quantitative sources and report alternatives, censoring, suppression and
uncertainty. They cannot guarantee a client's model will obey, and never invoke a model themselves.

## Bounded deterministic evidence UX

Call `plan_investigation` or `collect_investigation_evidence` with the same strict input:

```json
{
  "app_id": "synthetic-release",
  "workflow_key": "change-rollout",
  "goal": "compare_process_variants",
  "dependency_scope": "workflow_only",
  "cohorts": [
    { "version": 1, "from": "2026-06-01T00:00:00.000Z", "to": "2026-10-30T00:00:00.000Z" },
    { "version": 2, "from": "2026-06-01T00:00:00.000Z", "to": "2026-10-30T00:00:00.000Z" }
  ]
}
```

Goals use the six prompt names. Variant comparison requires two different explicit versions with
the same start window. Dwell-change and intervention goals require two same-version, disjoint,
equal-duration windows. Other goals allow one cohort or two temporal cohorts. Windows select
**case start times**, not event observation cutoffs. Equal windows are a basic comparability gate;
they do not match case mix or follow-up, and the result always says matching is unverified.

Both tools require a person with `process:read`/analyst on the exact app. An owner/admin grant on a
service token is still capped at reader and denied. They never forward dashboard tokens, exchange
audiences, elevate service tokens or fall back to single-case reads. CloudflareOS OAuth delegated
user identity is a separate, unimplemented production release gate.

Planning resolves grants but makes no lifecycle data queries; workflow/version existence is checked
when evidence is collected. Collection executes a fixed finite recipe: app freshness, then dwell,
funnel and path/completion stats for each cohort, using the **existing read handlers and privacy
projections**, including their definition reads. No arbitrary tool chain, SQL, model, process write,
raw event/case, assessment, score, compensation or producer free text enters the pack. No filters
or group breakdowns are accepted by this initial bridge. No query/result/PII logging was added.
Future audit must record only redacted query metadata, never results, tokens or PII.

Bounds: at most two cohorts, 14 source calls (current recipe uses 7/13), 256 source-returned array
elements including nested rows, a 3-second whole-operation deadline, 366 days per cohort and the
configured k floor of five. Structured JSON plus concise text caveats must fit the existing 48,000
character budget. Oversized results fail rather than truncate. Timeout prevents more reads but
cannot cancel an already-started source call: `LifecycleReadSource` has no abort signal. Production
integration must enforce upstream scan/time/row limits as well; none is claimed here.

Successful calls return the exact typed plan/pack in **structuredContent**, plus concise static text
caveats. A pack contains:

- Content-derived `evidence_id` and `evidence_ref`, and an entry for each bounded tool/cohort.
- Deterministic `query_id` per entry, normalized `provenance.query`, quantitative observations,
  suppression and original aggregate provenance. Each entry's `source_refs` identifies both its
  definition and aggregate source reads.
- **Every** source read's `as_of`, source revision (`source_version`), watermark, lag and status;
  definition and second-cohort snapshots are preserved. Differing metadata sets top-level `as_of`
  to null and yields `insufficient_evidence`; the minimum watermark is reported conservatively.
- Sample/completed/open counts only when releasable, freshness/window coverage checks and explicit
  completed-interval/right-censoring, unknown upstream coverage and unverified cohort matching.
  Outcome detail is completion only: no source endpoint for outcome breakdowns is invented.
- Fixed warnings about synthetic data, stale/missing watermarks, unprojected window tails, withheld
  cells and insufficient released sample/dwell evidence. Even a source claiming fresh is checked
  against a maximum 15-minute watermark lag. Future/inconsistent timestamp metadata fails closed.

`bounded_evidence` means the finite reads passed basic checks, not that a hypothesis is proven.
No confidence intervals, causal effect, counterfactual, matched comparison, staffing requirement or
forecast is computed. Synthetic fixtures have a fixed 2026-10-30 watermark and become honestly stale
when run later. `as_of`/`asOf` inputs are rejected: this source cannot time-travel.

Citation verification: `query_id` is `sha256:` plus the lowercase full SHA-256 of UTF-8
`JSON.stringify({app_id, tool, query})`, in that key order, with the entry's tool and provenance query.
`evidence_id` hashes the complete payload before adding `evidence_id`/`evidence_ref` and expanding
local refs. To verify a received pack, remove those two fields and replace each entry/source ref
and entry `source_refs` prefix `evidence_ref + "#"` with the local suffix; serialize the remaining
schema-ordered object with `JSON.stringify` and SHA-256. Timestamps and warnings are part of the
hash. These hashes provide integrity/content identity, **not signed authenticity or source trust**.
Refs are URN citations, not dereferenceable MCP resources or durable status handles. Retain the pack.

## Nested workflows and package integration boundary

`LifecycleReadSource` cannot expose parent/child relations or concurrent dependency graphs. Plans
always report `dependency_graph: "unsupported"`. Requests with
`dependency_scope: "child_dependencies"` return `insufficient_evidence` after authorization and
before any data reads. Never infer requisition/application/interview/assessment or
rollout/region parent blockers or critical paths by summing child/stage medians. Future
`aggregate_child_rollup` or `get_case_relations` capability needs its own authorized, privacy-safe
source contract and tests before these questions can be answered.

`src/investigation-contract.ts` defines a versioned `InvestigationBridge` seam; the temporary
`BoundedReadInvestigationBridge` only plans/collects existing reads and checks their bounds and
metadata. `@flightdeckhq/lifecycle-investigations` is not a dependency and was not published as a
PR when implementation began. Its concurrent worktree is untouched. When its reviewed contract is
available, replace this bridge with package calls, keeping app authorization, fixed read bounds,
privacy projection and provenance at the MCP boundary. No second statistics/LLM engine was built.

## Deferred progressive enhancements (unimplemented)

- **MCP Apps:** no `ui://` resource or `_meta.ui.resourceUri` is advertised. A follow-up can reuse
  this typed pack with the dashboard `src/workflows/model.ts` and accessible segmented bars/dwell/
  outcomes/filters. It must negotiate the host's Apps capability, register standalone sandboxed
  HTML, enforce restrictive CSP/no unvetted external access, reauthorize filtered reads and retain
  structured/text fallback. No fake UI or external iframe was inserted here.
- **Tasks:** no durable task/status storage or scheduler exists. Only consider the 2026-07-28
  `io.modelcontextprotocol/tasks` extension as a capability-negotiated enhancement after those
  exist. Authorize every durable status retrieval/update/cancel (`tasks/get`, `tasks/update`,
  `tasks/cancel`), bind ownership and app grants, expire retained evidence, enforce cancellation
  and restart recovery, and retain synchronous fallback. Do not implement the obsolete
  `tasks/list` API or deprecated sampling. All task methods remain denied, as does
  `subscriptions/listen`. Task metadata on a tool call does not create a task.

## End-to-end synthetic MCP client example

With the local synthetic Worker running as above, run this from `apps/lifecycle-mcp` with the
installed `@modelcontextprotocol/client` 2.4.0. Staging requires a token for the MCP host's own
Access AUD; the local synthetic bypass needs no token. Never substitute a dashboard token.

```js
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const client = new Client(
  { name: "synthetic-investigation-demo", version: "1" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
);
await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8787/mcp")));
const scope = { app_id: "synthetic-release", workflow_key: "change-rollout" };
const input = {
  ...scope,
  goal: "compare_process_variants",
  cohorts: [1, 2].map(version => ({
    version, from: "2026-06-01T00:00:00.000Z", to: "2026-10-30T00:00:00.000Z",
  })),
};
await client.listPrompts();
const prompt = await client.getPrompt({ name: "compare_process_variants", arguments: scope });
const plan = await client.callTool({ name: "plan_investigation", arguments: input });
const collected = await client.callTool({ name: "collect_investigation_evidence", arguments: input });
if (collected.isError) throw new Error("Evidence collection refused; inspect the safe error code");
const evidence = collected.structuredContent;
// The client model receives `prompt.messages` and typed evidence, not a server-authored conclusion.
// Inspect evidence.checks, source_reads, entries and warnings before citing any metric.
// Expect synthetic:true and stale/insufficient_evidence when now is past the fixture watermark.
await client.readResource({ uri: "lifecycle://glossary/metrics" });
await client.close();
```

Automated end-to-end verification uses real 2026-07-28 clients and signed test Access assertions,
calling the Worker in-process (no model/network/data service needed):

```sh
pnpm exec vitest run --project lifecycle-mcp
```

`test/prompts.test.ts` exercises list/get and malicious structured arguments;
`test/investigations.test.ts` exercises planning/collection, content/query hash verification,
readonly resources, grants/service ceiling/cross-app denial, fail-closed read API, stale/mixed
snapshots, small cohorts, raw-field projection, child-graph refusal, deadlines and output bounds.
