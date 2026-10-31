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
- Capabilities: `tools` and `resources`, with `listChanged: false`. There are no prompts,
  completions, logging, resource subscriptions, `subscriptions/listen` streams or MCP Tasks. A
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

Resources: `lifecycle://glossary/metrics`, `lifecycle://spec/workflow-definition` and the template
`lifecycle://apps/{app_id}/workflows/{workflow_key}/definition`. The template lists and reads only
apps the caller holds a grant for.

Every result carries `provenance` (source, `synthetic` flag, source version, `as_of`, freshness and
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
   `source_unavailable`, `result_too_large`, `internal`). Upstream error text and input values are
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
