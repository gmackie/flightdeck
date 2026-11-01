# Private lifecycle MCP live read source (FLIG-32)

This change is **draft, non-deploying** and stacked on integration PR #45
(`feat/FLIG-22-lifecycle-integrated-vertical-slice`). It merges MCP PR #47, including
its #44 parent, into the feature worktree. It does not include investigation package
PR #48. No merge, Cloudflare deployment, real HR data, or real Basin SQL verification
is part of this work.

## Trust boundary and private contract

The optional MCP Worker authenticates `/mcp` against its own Cloudflare Access
application. `ReadApiLifecycleSource` passes the **unchanged signed assertion** over
`LIFECYCLE_READ_API.read(assertion, appId, request)` to the Flightdeck Worker's named
`LifecycleReadEntrypoint`. The entrypoint independently verifies RS256, issuer,
expiry/issued-at requirements and **MCP-specific audience**, then derives the person
or service identity from those signed claims. A `common_name` claim takes precedence
over person-like claims in both workers. Caller-supplied principals, roles and
capabilities are not RPC parameters and are rejected as extra request properties.

The backend calls the existing `authorizeLifecycleRead()` for **every data call**.
The app id is a selector, never proof of authorization. D1 grants, expiration,
revocation and project membership are authoritative; there is no grant cache at the
backend. Service tokens require an explicit app-scoped reader grant and cannot read
analyst aggregates. There are no wildcard/global grants. Person project grants expand
only over actual `authz_app_projects` membership. Authenticated `grantsFor` expands
only the verified subject's live grants (maximum 256 rows, overflow fails closed).
MCP's request-local grant lookup is advisory: a previously minted scope still fails
if its backend grant was revoked.

This is a named **RPC service binding**, not a Fetcher for the default entrypoint:

```jsonc
// apps/lifecycle-mcp/wrangler.jsonc: opt-in environment configuration, not enabled here
"services": [{
  "binding": "LIFECYCLE_READ_API",
  "service": "flightdeck",
  "entrypoint": "LifecycleReadEntrypoint"
}]
```

There is no `/internal` route, public grants endpoint, arbitrary URL, SQL, ingestion,
write or raw-evidence RPC. The MCP assertion is never sent to the existing
`/api/apps/:app/lifecycle/*` dashboard routes. Those retain their separate dashboard
Access audience. Binding to the default Flightdeck entrypoint cannot supply `read`
and produces `source_unavailable`; there is no HTTP or synthetic fallback.

Requests are discriminated strict objects (`packages/schema/src/lifecycle-read.ts`).
Results are `{ok:true, appId, value}` or `{ok:false, code}`, with only fixed codes:
`unauthorized`, `forbidden`, `invalid_argument`, `source_unavailable`. Every successful
adapter response is runtime-validated against a purpose-specific typed schema and
must echo the requested app. Backend response JSON is capped at 60,000 characters;
MCP further caps rendered results at 48,000. Tokens, principal identities, exception
messages and raw records are not returned/logged by this boundary. Normal MCP tool
failures use the MCP protocol's error result, which may have HTTP 200; they contain
no synthetic success payload.

Unknown apps and apps without a grant produce the same RPC `forbidden` and MCP
`forbidden` error. After app authorization, a missing case/definition becomes null at
the source and `not_found` at the MCP boundary. The existing dashboard API retains
its HTTP 403/404 behavior; private RPC does not pretend to be HTTP.

## Supported methods and exact semantics

| Method | Live D1 support | Limits / gaps |
| --- | --- | --- |
| `grantsFor` | Current person/service grants from D1 | 256 expanded grant rows; no app enumeration beyond grants |
| `listWorkflowDefinitions` | App-scoped serving definitions, exact process keys/versions, keyset pagination | 100 RPC / 50 MCP rows per page; MCP 20-page cap |
| `getWorkflowDefinition` | Exact version or latest version, ordered D1 query | No first-page approximation |
| `getCaseSummary` | App-scoped non-deleted snapshot | Raw notes never selected; no parent/child data exposed by the existing MCP summary contract |
| `getCaseTimeline` | Completed/open visits **only when all stored case intervals are active segments** | Up to 500 stored intervals, pages of at most 100. Any paused/blocked segment returns `source_unavailable` |
| `getStageDwell` | Ungrouped, explicit workflow version and `[from,to)` case-start cohort, all-active histories only | At most 366 days, 1,000 cases, 10,000 intervals. Overflow/paused/blocked histories fail closed |
| `getFreshness` | App projection time/status/sequence and per-workflow last observed event time | 100 workflows; no event-time completeness promise |
| `getFunnel`, `getVariantStats` | **Unsupported** | Typed `source_unavailable`, no invented values |

Namespaced workflow keys use `[a-z0-9][a-z0-9_.-]{0,63}` and exact D1 equality.
`delivery.deploy` and `delivery_deploy` are distinct, tested keys; there is no aliasing.
Resource URIs encode keys with `encodeURIComponent`. App and opaque-case validators
are unchanged. Workflow/stage terminal flags come from the explicit stored definition,
never inferred from a stage name.

Field adapters are explicit: `process_key -> workflow_key`,
`process_version -> version`, and the stored stage order becomes `order`. The serving
model does not retain description, declared dimensions/outcomes or original publication
time: description/dimensions/outcomes are empty, and the legacy MCP `published_at`
field is the **definition projection timestamp**, not an asserted original publication
date. Case dimensions are empty; the existing MCP privacy layer withholds case outcome
codes absent a definition outcome allowlist. Parent/child evidence is exercised by
fixtures but not exposed as a dependency-analysis capability. No fields are recovered
by reading raw event JSON. Full metadata/outcomes/dependency support needs a future
reviewed contract extension.

H stores `active`/`paused`/`blocked` **segments**, not visit IDs. A segment must not be
reported as a stage attempt or used as an independent dwell sample. The narrow adapter
therefore refuses timelines and stage dwell whenever any relevant segment is non-active.
For all-active histories, each row corresponds to a visit; attempts increment per
stage in stored order. An exited row becomes `completed`, an open row `active` in MCP.
Re-entry remains a separate visit. General paused/blocked/reopened attempt semantics,
paths and child/parent critical paths require persistent attempt identity or a proven
reconstruction contract; this PR does not invent one.

Dwell uses nearest-rank p50/p90 and rounded arithmetic mean over **completed visits**.
`n` counts distinct cases with a completed visit, `open_n` distinct cases with an open
visit, not numbers of events/segments. A case with a completed visit and an open
re-entry may appear in both populations, matching the existing source contract.
Open/right-censored visits never contribute durations. Backend suppression floor is
five distinct cases: a group is wholly withheld when either nonzero completed or
censored population is smaller than five. Withheld wire rows have no numeric evidence
(`n/open_n = 0`, durations null, `suppressed = true`); MCP renders only a suppression
reason, not these placeholders. MCP can raise the threshold and applies its existing
privacy boundary again. No grouping, dimension filtering, outcome comparisons or
suppressed residual totals are supported by this adapter.

## Freshness: sequence is not time

`lifecycle_projection_state.source_watermark` is an **ingestion log sequence**, not
UTC milliseconds and not event-time completeness. The source preserves it as numeric
`provenance.projection.source_watermark` together with generation, status and
projection lag. `as_of` is the committed projection time. `projection.lag_ms` measures
clock time since that projection; status becomes `stale` after 15 minutes.

MCP `freshness.watermark` and `freshness.lag_ms` are **null** because no bounded lateness
or event-time completeness guarantee is established. Per-workflow `last_event_at` is
merely the maximum observed event time. Neither it nor projection `as_of` can replace
a completeness watermark. The seq=17 regression verifies that a realistic projection
timestamp is preserved while the event-time watermark stays null. Evidence plans
must treat this as insufficient completeness, even if the projection just ran.

No committed projection, non-ready state or queued projection work yields
`source_unavailable`, rather than an empty successful fallback. Reads do not trigger
a projector or write any data. There is no atomic cross-tool snapshot or historical
`as_of` support; concurrent/multiple-tool evidence cannot assert one coherent snapshot.

## Provisioning and secrets prerequisites (no commands executed against production)

1. Review and land the integration/MCP stack through the owning project's gates.
   Keep production disabled until the separate privacy/access/deletion gates below
   have explicit evidence. `PRODUCTION_ENABLED` remains **false** in MCP code;
   setting environment variables alone cannot turn production on.
2. Provision Flightdeck's D1 binding and apply migrations through `0030`, including
   `0005` lifecycle writes, `0006` process registry, `0010` grants and `0020` serving
   tables. Register immutable process versions. Provision scoped synthetic producer
   keys and explicit app read grants through the existing operator process.
3. Confirm HTTP ingest persists evidence, the projector/scheduled drain converges,
   no cases remain queued, and derived snapshots/definitions are ready. Provision
   the Basin/Pipelines lifecycle stream and forwarding/replay operations per
   `lifecycle-ingestion.md`; an outbox or D1 fixture test is not Basin verification.
4. Create a distinct Cloudflare Access application for the MCP hostname under the
   configured team issuer. Its AUD must differ from the dashboard AUD. Decide
   person policies and purpose-specific service token policies independently.
   Record the identity relationship: person grant subject is signed Access `sub`;
   service grant subject is signed `common_name`, with `principal_kind=service`.
   No person grant can be inherited by a service assertion with extra person claims.
5. Backend opt-in settings: `ACCESS_TEAM_DOMAIN=<team>`,
   `ACCESS_AUD=<dashboard AUD>`, `LIFECYCLE_MCP_READ_ENABLED="1"`,
   `LIFECYCLE_MCP_ACCESS_AUD=<distinct MCP AUD>`. Defaults are off/empty. Missing
   dashboard configuration also fails closed under the existing D1 authorizer.
6. Bind the MCP Worker to **LifecycleReadEntrypoint**, as above; use same-account
   service binding permissions. Test in isolated staging with
   `LIFECYCLE_MCP_ENVIRONMENT=staging`, `LIFECYCLE_MCP_SOURCE=read-api`,
   `ACCESS_TEAM_DOMAIN=<same team>`, `ACCESS_AUD=<MCP AUD>`,
   `LIFECYCLE_MCP_DEV=0`, min cohort >=5, and explicit allowed browser origins.
   Never configure synthetic mode as a live data fallback.
7. Keep `workers_dev=false`, `preview_urls=false` and no public MCP routes by default.
   An eventual custom hostname needs Access protecting **every** reachable route;
   protect/disable alternative hostnames. No public hostname is needed for private
   backend RPC. The existing Flightdeck dashboard still needs its own Access policy.
8. Team domain and AUD tags are configuration, not secrets. Access signing private
   keys stay with Cloudflare; both Workers retrieve public JWKS over HTTPS. Store
   service-token credentials and producer keys in the operator secret manager /
   Wrangler secret bindings or client secret storage; never repository vars, logs,
   fixtures, URLs, MCP responses or committed `.dev.vars`. Restrict rotation/revoke
   authority; verify the next request loses D1 grant access immediately on revocation.
9. Generate Wrangler types for each Worker. This PR uses an explicit shared structural
   RPC type, so no enabled production service is needed to generate types. Once a
   binding is configured, use multi-config generation if needed:
   `pnpm exec wrangler types -c apps/lifecycle-mcp/wrangler.jsonc -c apps/flightdeck/wrangler.jsonc`.
   Confirm the generated binding targets the named class, not the default Fetcher.

## Verification and remaining production gates

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm smoke:pack`.
The dedicated suite runs with:
`pnpm exec vitest run --project flightdeck-mcp-live`.
It uses real cloudflare:test migrations and a real Miniflare named service binding to
the exported Flightdeck entrypoint. Synthetic PR #37 recruiting assessment/interview
parent-child and service-delivery deployment fixtures use #45's converter, HTTP ingest
and projector. MCP v2 client calls use the live factory/adapter. Backend JWKS HTTP is
stubbed with a locally generated RS256 public key; signed assertions are independently
verified in the entrypoint, not accepted through an injected principal. Five independent
fixture copies establish k=5 and compare the nine-day scorecard dwell with the fixture's
independent expectation. This is local Worker/D1 validation, **not** Cloudflare-account
or Basin SQL validation.

Release blockers remain: privacy/legal review and approved metadata policy; retention
windows and automated evidence-log/read-model purges; end-to-end Basin/R2 erasure,
late-event tombstones and replay non-resurrection evidence; real-account Access policies,
JWKS rotation, service binding/routing, D1 migration/rollback, cron and query-budget
measurements; operational rate limits and abuse controls; actual staging validation and
production deployment/health evidence. A bounded result count is not a measured CPU,
D1 rows-scanned or account-cost budget. Observe these in staging before enabling traffic.

Queries are purpose-limited with bound values and bounded returned rows; cohort limits
fail rather than truncate. Retention must constrain historical scans operationally.
Current process indexes do not include version/deleted filtering, and grant expansion
may scan project memberships: measure and add indexes/budgets in a separately reviewed
change if needed. Deletion must cover the event log, outbox, serving snapshots,
intervals, edges, diagnostics, registry as appropriate and Basin history, with an approved
retention policy. D1 soft deletion alone is not erasure evidence.

CloudflareOS needs a **separate user-delegated OAuth flow**: resource metadata,
authorization server/client registration, PKCE, consent, scopes, audience/resource-bound
tokens, revocation and subject-to-app-grant mapping, with backend validation. This
implementation supports verified Access assertions only. It does **not** implement or
claim OAuth, user delegation, token exchange, or permission inheritance from an agent.

## Independent review fixes and remaining release blockers

The PR #49 review confirmed a correctness defect: the privacy projection accepted
namespaced workflow names but silently omitted registered dotted stage names such as
`qa.review`. The shared `LIFECYCLE_READ_KEY` validator now covers registered workflow,
stage, outcome and dimension names/codes throughout MCP inputs and privacy projection.
App ids and opaque case ids retain their original validators. Syntax alone never grants
access or registers a category: grouping/filter values and funnel stages must still be
present in the authorized definition. Malformed definitions and unregistered timeline/
dwell stage evidence now return `source_unavailable` instead of a partial successful
result. The regression sends nine cases with `build`, `qa.review`, `done` through HTTP
ingest, projection, the named binding and MCP, and checks all three stages plus the
nine-case `qa.review` count and its independent 3,000 ms duration. Suspicious path,
query, encoded and email-like keys remain rejected.

All live MCP data envelopes now include
`provenance.event_time_completeness: "unknown"` and an interpretation warning.
The legacy freshness status remains for compatibility: **`fresh` describes recent
projection only**, not producer health, arrival coverage, bounded lateness or event-time
completeness. `watermark` and event-time `lag_ms` remain null; the log sequence stays
numeric in `projection.source_watermark`. Consumers must retain the warning and
unknown completeness flag when presenting or reasoning from the evidence.

The following P2 issues remain explicit release gates, including before real HR data
is used in any environment:

- **Cross-query disclosure:** arbitrary millisecond cohort windows permit differencing.
  Two overlapping answers with at least k=5 cases can still isolate one added case from
  the change in `n` and `n * mean_ms` (within mean rounding precision). Small-group and
  complementary suppression within one answer do not prevent this. Existing row,
  window and response bounds are not a cross-query privacy budget. Approved coarse
  UTC day/week cohort policy, query budgeting/auditing and resistance to repeated or
  overlapping queries must be designed and independently verified before release.
  Coarse windows alone also do not prove protection against sparse bucket differences.
  This change does not enforce such a policy and does not claim real HR disclosure safety.
- **Pending projection availability:** one queued case still makes all app reads fail
  closed. H incrementally overwrites case rows before advancing the app watermark, so
  serving an allegedly committed stale snapshot needs proven snapshot isolation or a
  versioned snapshot design. Returning those rows as an old committed view would be
  misleading. A ready-state-plus-pending-row regression locks down the current refusal.
- **Grant expansion availability:** more than 256 expanded grants still makes discovery
  unavailable for that principal. No truncated list or blanket authorization is returned.
  A future bounded per-app capability lookup or paginated authenticated discovery needs
  independent review. Backend D1 grant enforcement must remain on every data request.
- **Environment isolation:** `LIFECYCLE_MCP_ENVIRONMENT=staging` is a label, not an
  account/data-isolation control. If an operator binds a staging-labelled MCP Worker to
  an opted-in production backend with an accepted AUD, it can read that backend under
  its D1 grants. Default-off flags and the production-label refusal are not protection
  against that configuration error. Use distinct staging/prod Worker service names,
  D1 databases and Access applications/AUDs; bind each backend to the intended
  environment's MCP AUD; restrict binding/configuration changes; keep the production
  backend read flag off. Verify the real account's binding inventory, Access policy and
  environment-to-AUD/data mapping before any release. These account-level controls
  have not been provisioned or verified by this change.

Funnel/path variants, general state-segment-to-attempt reconstruction, privacy/retention
and Basin erasure gates, OAuth delegation and production account/deployment evidence
remain outside this fix. No merge or deployment is authorized or performed.
