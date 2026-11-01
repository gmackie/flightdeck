# Lifecycle MCP

Read-only MCP v2 server. The existing `bounded-read-bridge@1` tools and synthetic
local demo remain unchanged; see [operations](../../docs/operations/lifecycle-mcp.md).
The optional package path joins [PR #47](https://github.com/gmackie/flightdeck/pull/47)
and [PR #48](https://github.com/gmackie/flightdeck/pull/48) without reimplementing
investigation recipes, evidence interpretation or claim validation.

## Optional package path

The host passes `Deps.investigationEngine` to `handleRequest` (or the corresponding
`ToolContext` to `createLifecycleServer`). This is a code/configuration seam, not an
environment variable, automatic production source selection or deployed endpoint.

```ts
import type { InvestigationCatalog } from "@flightdeckhq/lifecycle-investigations";
import type { QueryAdapter } from "@flightdeckhq/lifecycle-queries";
import type { AppScope } from "./src/source";
import { handleRequest } from "./src/worker";

// Trusted server-owned catalog/registry, never supplied by the client model.
// Each registry contains exactly one app/definition, mapped definition versions,
// canonical stages/lanes, approved cohort/caseMix/variant/outcome labels and k >= 5.
declare const catalog: InvestigationCatalog;
declare function scopedAdapter(scope: AppScope): QueryAdapter;

export const fetch = (request: Request, env: Parameters<typeof handleRequest>[1]) =>
  handleRequest(request, env, {
    investigationEngine: {
      source: {
        kind: "fixture", // Only synthetic createFakeAdapter is integration-tested here.
        historicalAsOf: true,
        catalogs: [catalog],
        adapterFor: (scope) => scopedAdapter(scope),
      },
    },
  });
```

Configuration behavior:

| Configuration                | Behavior                                                               |
| ---------------------------- | ---------------------------------------------------------------------- |
| No `investigationEngine`     | Original PR47 tools/prompts; no package tools advertised               |
| `{ source: null }`           | Package tools advertised; authorized calls return `engine_unavailable` |
| Trusted fixture query source | Package tools use that fixture only; return `source.kind: "fixture"`   |
| Normalized query source      | Interface supported, **no production implementation verified**         |

The new `plan_process_investigation` and `execute_process_investigation` tools use
`contract_version: "package-investigation@1"`. Their nested objects retain exactly
`flightdeck.investigation-plan.v1` and `flightdeck.evidence-pack.v1`; they are never
cast to the original bridge schema. Existing `plan_investigation` and
`collect_investigation_evidence` continue to use the limited original source.
A package error never falls back to that source or to synthetic data.

## User workflow

Use an official `@modelcontextprotocol/client` 2.4.0 client with protocol
`2026-07-28`, as in the operations guide. Fetch a static analysis prompt, plan,
then collect with the exact returned plan digest:

```ts
await client.getPrompt({
  name: "evaluate_intervention",
  arguments: {
    app_id: "release-demo",
    workflow_key: "deploy-pipeline",
  },
});
const input = {
  contract_version: "package-investigation@1",
  dependency_scope: "workflow_only",
  request: {
    recipe: "intervention-review",
    recipeVersion: 1,
    appId: "release-demo",
    definitionId: "deploy-pipeline",
    definitionVersions: ["v1"],
    metricVersion: "lifecycle.v1",
    asOf: "2026-02-05T00:00:00.000Z",
    window: { from: "2026-01-15T00:00:00.000Z", to: "2026-01-29T00:00:00.000Z" },
    cohort: { id: "pilot", caseMix: ["minor", "major"] },
    baseline: { cohort: { id: "control", caseMix: ["minor", "major"] } },
    stages: ["review"],
  },
};
const planned = await client.callTool({ name: "plan_process_investigation", arguments: input });
if (planned.isError) throw new Error("Planning refused");
const collected = await client.callTool({
  name: "execute_process_investigation",
  arguments: {
    ...input,
    expected_plan_digest: planned.structuredContent.plan.digest,
  },
});
if (collected.isError) throw new Error("Collection refused");
// Retain structuredContent.pack. Check status, metadata and missing evidence before citing.
```

These IDs/windows are from the library's synthetic deployment test configuration;
they are not registered by the default Worker. Supply trusted matching catalogs
and facts explicitly. Recipe names and contracts are documented in the
[package README](../../packages/lifecycle-investigations/README.md). Numeric legacy
workflow versions are not interchangeable with package registered version IDs.

Both tools emit strict structured JSON and concise static caveats. Exact package
query IDs, digests, row references, coverage, samples, censoring, watermarks,
version comparability and non-causal finding candidates remain intact. Use
`parseEvidencePack` / `serializeEvidencePack` for integrity checks; hashes are not
signatures. No server model generates narrative claims.

Optionally pass `analysis` to execution to call the package's
`validateAgentAnalysis` against the freshly collected pack. This is bounded client
analysis data, never query instructions: one claim, one finding, up to six row
refs, <=500 characters per text field. Factual claim text must copy an exact
determinable finding and all its refs; invented statistics, foreign refs and
causal claims fail validation. Advisory prose semantics are not proven. Changed
evidence must be reviewed again. The existing 64-element total input limit may
require a smaller request or claim. No client-supplied pack or plan is executed.

## Authorization and bounds

`investigation-engine-adapter.ts` selects a trusted registry only after MCP
`process:read` authorization for the exact app. It uses the existing role policy
on newly fetched grant snapshots before private plan disclosure, each package
query and return. Service tokens remain capped at reader. The package receives
an opaque scope key hashing principal and relevant role/expiry grant snapshot;
a changed snapshot rejects the execution. `adapterFor` receives a newly authorized
`AppScope` and trusted catalog; the source must independently enforce that scope.
No source data reads occur for denied plans/calls, and errors never echo upstream
text. No auth/RPC implementation or shared synthetic source files were changed.

Package budget resolution only tightens recipe defaults. MCP ceilings: 14 queries,
8 stages, 92 days, 20 rows/query, 256 total source result rows, concurrency 2,
1 second/query and 2 seconds source execution inside the existing 3-second
whole-call deadline. Requests permit at most two versions, four case mixes and
one extra grouping. Strict schemas reject SQL, case IDs and unknown fields.
Outputs plus static text must fit 48,000 characters; oversized evidence is refused.
Small-n configuration below max(5, configured MCP floor) is refused, rather than
relabelling unsuppressed source results. Watermark lag tolerance is capped at
15 minutes, explicitly included in the plan and its digest.

Default admission is isolate-local: 10 plan/execute calls and 1,200 planned cost
units per principal/app per minute; plans consume calls, execution consumes the
full planned cost even if collection stops early. At most 1,024 active buckets;
a full table denies new buckets. A trusted synchronous `admit` hook can replace
this with shared admission. Cost units are a planning heuristic, not billed scan
cost. Authorization is independent of admission and repeated after it.

## Verified scope and limitations

- Tests use synthetic hiring/deployment facts and the **existing**
  `@flightdeckhq/lifecycle-queries.createFakeAdapter` through the actual Worker
  handler and official MCP v2 client. This is not a production normalized query
  adapter, a live Cloudflare read source or a deployed integration.
- A normalized source must retain complete atomic fact revisions and enforce
  historical `asOf`, current authorization, scan/row/byte budgets and transport
  deadlines. The legacy source cannot supply these semantics. Neither the D1
  adapter from the separate live-source PR nor synthetic acceptance app files are
  modified here.
- Cloudflare Access in tests uses locally signed assertions. Real Cloudflare,
  role-delegated OAuth and production end-to-end authorization are unverified.
  Production remains disabled by the existing configuration gate.
- Grant fingerprints use the existing app/role/expiry snapshot; the legacy grant
  contract has no monotonic revision. Revoke-and-regrant between checks cannot be
  observed atomically. Sources must independently authorize dispatched work.
- QueryAdapter has no cancellation signal. Timed-out I/O can finish; it cannot
  schedule more work or alter returned evidence. Cross-request in-flight limits
  and distributed admission require a real source/host implementation.
- No persistent evidence/cache, Tasks, Apps UI, relationships, dependency graphs,
  raw case investigations, causal effects or significance claims. Child graph
  requests explicitly return `unsupported`. No merge or deployment is included.

Run the focused suite with:

```sh
pnpm exec vitest run --project lifecycle-mcp test/investigation-engine.test.ts
```
