# Lifecycle aggregate privacy admission (FLIG-36)

Draft, non-deploying change against **main at `53a9382`**, after integration PR #52
landed PR #49 (`feat/lifecycle-mcp-live-source`) and its dependency stack. Registered
process definitions, projection and current D1 grants remain prerequisites. No real
hiring data, Cloudflare-account migration, merge or deployment is part of this change.

## Release boundary

Aggregate reads fail closed unless the backend has `LIFECYCLE_PRIVACY_MODE=enforce`,
a stable `LIFECYCLE_PRIVACY_KEY` secret of at least 32 characters, an exact operator
process approval and both app/global-principal budget rows. Absent, disabled or
unknown mode never restores the old aggregate behavior. Case, definition and
freshness reads retain their distinct `lifecycle:read` authorization contract; they
are not anonymous analytics and this guard does not make them safe for unrestricted
access. Never grant case access to an aggregate-only consumer as a workaround.

The private typed RPC admits only `getStageDwell`, over one **closed Monday 00:00
UTC through next Monday 00:00 UTC** case-start cohort, explicit exact version and
no grouping or dimension filters. No partial millisecond windows, shifted weeks,
rolling windows, multi-week totals, status/outcome subsets or version pooling.
Adjacent approved weeks are disjoint by case start, not by person. Repeat visits
and open/closed status can overlap: `n` counts distinct cases, not events, visits
or distinct people. Completion times may fall outside the start week.

Dimensions/values must come from registered definitions, never inferred from raw
records or client sensitivity claims. This narrow adapter supports **no dimension
projection**: even a registered dimension/filter is denied. Funnels and variants
remain unavailable rather than inventing semantics. Dwell, bottleneck, evidence
and investigation calls all converge on the guarded source; aliases share the
ledger and each data call costs one query. The legacy dashboard stage/outcome
summary endpoints now return a fixed 503 **after grant checking**, with no cohort
counts. Re-enabling them needs a reviewed integration with this same admission
boundary and proven interval semantics; lowering their old `minCohort` option
cannot bypass admission. SQL read helpers are internal, not exposed RPCs.

## Process sensitivity and independent review

`lifecycle_privacy_processes` is an **operator-only allowlist** joined to
`process_definitions` on app, process and exact version. The server validates the
registered schema and checks its stored serialized definition against a SHA-256
digest approved by the operator. Unknown versions, missing reviews or mismatched
digests deny. Classification is not accepted from MCP inputs or producer metadata.
There is no process-name heuristic that labels an unknown HR workflow safe.

Each row has classification `aggregate` or `restricted`, an opaque review ID, and
`restricted_approved` (default 0). All approved rows require a review ID matching
`[A-Za-z0-9_-]{1,64}`; use an opaque reference, never review notes or a person's name.
Restricted rows additionally require **both** `restricted_approved=1` and the
separate backend `LIFECYCLE_PRIVACY_RESTRICTED=reviewed` opt-in. The shipped value
is `deny`; unknown/unset restricted mode fails closed for all aggregate reads.
There are no seeded approvals and no API for clients/producers to approve a row.
Only trusted D1 operators may edit policy. Review must cover the actual definition,
case-to-person relationship, related processes/apps, cohort stability, metadata,
case-access grants, retention/deletion and side information before any opt-in.
A recorded review ID is a release gate, not proof that a legal review occurred.

## Durable admission and accounting

The budget period is a server-selected fixed **UTC day**. `lifecycle_privacy_limits`
holds an app row (`kind=app, scope=<app id>`) and one cross-app principal policy
(`kind=principal, scope=global`). Both rows are required. Each contains independently
configurable `query_count`, `row_budget`, `scan_budget`, and `time_budget_ms` ceilings.
Query counts are 1..1000 per day; SQL constraints bound all configuration numbers.
The global principal policy sets the same ceiling separately for every verified
principal. An app ceiling is shared by all principals, processes and tools; a
principal ceiling is shared across all apps. Other people/apps are otherwise
isolated; collaborating principals can still pool information up to the app cap.

One `INSERT ... SELECT ... WHERE ... RETURNING` statement checks **both** ledger
sums and inserts the reservation. SQLite serializes the conditional mutation on
D1's primary; there is no application read/modify/write gap, process memory, replica
read or location-dependent counter in admission. A grant predicate is included in
the same mutation. Miniflare tests concurrently compete for final app slots using
16 requests and for a cross-app principal budget using 12 requests. This is local
D1 evidence, not a multi-region Cloudflare-account load test. Future implementations
must preserve one authoritative database/primary or use a principal/app coordinated
Durable Object design. Separate D1 databases do not share a budget.

Current grants are checked before policy/accounting, inside admission, immediately
before each aggregate data SELECT and before release. Reader/service roles cannot
read aggregates. Revoked requests cannot spend a new reservation or receive results;
a revocation during execution can consume an already admitted reservation and then
withhold output. No assertion, app selector or previously minted MCP scope is a grant.
Revocation is observed at these checks, not an atomic transaction across networked
request/response delivery.

Every admitted call reserves **1 query, 11,002 returned-row units, 100,000 scan-row
units and 5,000 time-ms units**, regardless of actual result size. These conservative
units can intentionally exhaust a small policy without executing any data query.
Queries are not cached/refunded: identical queries, aliases, failed reads, client
cancellations and audit failures after admission all retain their reservation.
The ledger stores `max(reserved, observed)` on completion/failure. Exceeding a
reservation withholds the answer; future admission sees the higher charged amount.
No query budget error includes used/remaining counts or cohort evidence.

**Query count is a strict admission budget. Scan/time budgets are reservation and
observed-cost accounting, not a hard Cloudflare CPU, wall-time or billing cap.**
The two aggregate case/interval SELECTs measure D1 `rows_read` and `duration`, plus
elapsed execution time. Grants, metadata, policy, admission and audit overhead are
not included in those telemetry totals. LIMIT bounds returned rows (1,000 cases,
10,000 intervals, overflow denied), not physical rows scanned. The adapter checks
the first SELECT's telemetry before starting the second; it cannot cancel a D1
statement at the threshold. Concurrent admitted statements, outages and failed
telemetry updates can exceed/under-record observed work beyond the retained
reservations. Do not use this as a hard spending guarantee. Account validation,
query-plan measurements, retention and Cloudflare runtime limits remain release
gates; workloads requiring strict physical-cost limits must remain denied until
an enforceable design exists. DO admission alone would not cancel D1 work either.

## Release suppression and validation

The backend minimum is five distinct cases in every nonempty completed/open
population. If any stage has a small population **or a small complement against
the full cohort**, all stage numeric evidence is withheld: zero wire placeholders
for counts, null durations and `suppressed=true`. No residual total or original
cohort size is released. Overlapping stage memberships are not treated as disjoint
cells. MCP projects these placeholders to suppression-only results. This is more
conservative than withholding only the smallest cell. Stage keys must be registered;
negative, fractional, unsafe or >366-day completed stage durations fail closed.
Timeline pages retain their 100-row page/500-interval limits and validate durations;
cursor numeric tuples must be nonnegative safe integers. No raw event JSON, notes,
name or personnel record is queried to reconstruct missing metadata.

**This is not differential privacy or any formal privacy guarantee.** Fixed weeks,
minimum k, complementary withholding and bounded query counts do not prevent every
inference. Repeated answers over changing projections, late arrivals, deletions,
related workflows, reidentified cases, repeated people, sparse adjacent cohorts,
external totals and colluding principals can disclose information. No immutable
historical release cache or person-level contribution bounds are implemented.
Restricted processes remain denied by default and need independent review before
opt-in. The production MCP gate in #49 remains closed.

## Audit and secret handling

The audit table has exactly four fields: opaque HMAC principal, opaque HMAC app,
keyed hashed query fingerprint, fixed decision (`admitted`, `denied`, `withheld`,
`released`). No raw inputs, names, notes, principal subjects, assertion, results,
cohort counts, query text or exception messages are stored/logged by the guard.
The separate ledger adds random reservation ID, UTC epoch and accounting units.
The fingerprint binds purpose, app, exact registered version and canonical cohort;
dwell aliases use the same fingerprint, but each consumes a reservation.
`released` means backend validation succeeded, not that a client received output;
a later transport failure may prevent delivery. Suppressed successful answers may
also carry `released`. Authentication failures and mode/key failures cannot always
be audited: they do not have a usable verified principal/key; they release no data.
Audit failure denies execution/release, preserving reservations already spent.
Operator policy tables necessarily contain app/process IDs, never hiring evidence.

Use one stable random HMAC secret across all backend locations sharing the ledger.
Changing it changes opaque budget identities and could reset their effective daily
budget: rotate only with aggregate reads disabled and a full-day drain or reviewed
ledger migration. Never log or commit it. No retention purge is added here. Review
opaque-audit retention separately; never delete current-day reservations to regain
quota. Old accounting rows can be purged after their UTC epoch ends, subject to
in-flight work and an approved retention policy. Retaining the ledger indefinitely
requires operational storage/query-plan monitoring even with per-day limits.

## Migration and integration order (no remote commands run)

Apply existing migrations in filename order:
`0001`, `0002`, `0003`, `0004`, `0005_lifecycle_write`,
`0006_process_definitions`, `0010_read_authorization`,
`0020_lifecycle_serving`, `0030_lifecycle_projection`, then
**`0040_lifecycle_privacy_budget.sql`**. `0040` is a new unique number and table/index
namespace on the merged integration main; no old migration is renumbered. Recheck numbering when integrating
other stack layers; do not edit already applied migration contents to resolve a
future conflict. The full sequence runs through `readD1Migrations` and
`applyD1Migrations` on Miniflare for both Worker suites.

Keep aggregate mode disabled while applying DDL. Register the immutable definition,
complete the projector, provision current read grants, approve its definition digest
and classification independently, and configure both limit rows. Provision the stable
secret through the operator secret manager/Wrangler secrets. Then explicitly enable
`enforce` only in an isolated synthetic/staging account with the correct backend AUD,
service binding and D1. Restricted opt-in remains a separate decision. Configuration
alone cannot activate the production-labelled MCP server.

Rollback by disabling aggregate reads first; leave ledger/audit intact so reenabling
cannot reset spent budgets. Do not drop privacy tables while traffic is enabled.
No auto-apply hook, production policy row, enabled flag, real credentials or data is
included. Integration owners must adapt dashboard aggregate consumers to the denied
summary routes; case/definition views retain their existing API behavior.

## Reproducible verification

Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and the PR CI jobs
(`check`, `pack-smoke`) against the exact draft head. Focused local D1 tests:
`pnpm exec vitest run --project flightdeck test/lifecycle-privacy.test.ts`.
Live binding/MCP tests: `pnpm exec vitest run --project flightdeck-mcp-live`.
All fixtures are synthetic. Miniflare concurrency is regression evidence for the
conditional SQL, not a claim of real-account global load validation.

Cloudflare's [rate-limit binding documentation](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
describes approximate per-location limits and recommends Durable Objects for a strict
global limit. This feature does not rely on that binding for privacy accounting.

Local verification on the main-based draft: 72 test files / 1,032 tests passed,
including 13 new Miniflare privacy cases and 11 live binding/MCP cases.
`pnpm typecheck`, `pnpm lint`, `pnpm build` and `pnpm smoke:pack` passed.
Wrangler builds use `--dry-run`; no account flags or remote databases were changed.
GitHub CI is tracked on the draft PR separately from this local evidence.
