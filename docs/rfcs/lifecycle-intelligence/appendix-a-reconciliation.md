# Appendix A: Reconciliation with earlier and parallel work

Three bodies of work touch lifecycle intelligence:

1. **The old stacked draft PRs #1–#18** on `feat/*` branches. They predate `main`'s current
   architecture and are **not shipped**.
2. **The parallel lifecycle workstreams A–F** (FLIG-15, -16, -18, -19, -20, plus two unnamed local
   worktrees). They are being built against `main` now and are **unmerged**.
3. **This RFC** (FLIG-17), which is the integration contract between them.

All implementation targets **`main`**.

## A.1 The old stack (#1–#18): reuse concepts, never merge

### Why not merge it

- **It is a different architecture.** PR #1 builds `@flightdeck/contracts`, `@flightdeck/sdk-worker`,
  `@flightdeck/sdk-effect` and a separate console Worker, with an optional Queue and a journey
  state machine. `main` instead has `@flightdeckhq/schema|worker|browser|create` published to npm
  (FLIG-14), one `flightdeck` Worker serving the API and SPA, and DO tiers (FLIG-4…FLIG-9). Package
  names, entrypoints, D1 schemas and auth layers conflict.
- **It is a long chain.** #1 → #2 → … → #18, each based on the previous branch. Landing any later
  PR means landing everything under it.
- **It isn't verified against a real account.** The bodies say so themselves: e.g. #1 "Still
  required before production approval/merge: actual clean-account provisioning", #4 "No actual
  Cloudflare account deployment in this stack".
- **Main has moved on.** Ingest, DOs, the registry, server keys, the dashboard, releases and skills
  were rebuilt on `main` with tests and production deployment.

### Policy

1. Don't merge, rebase onto `main`, or cherry-pick from any `feat/0x-*`, `feat/1x-*`,
   `feat/bootstrap-architecture`, `FLIG-1-verified-demo` or `FLIG-3-live-sessions` branch.
2. To reuse an idea, write a fresh PR on `main` that names the old PR in its description ("concept
   from #4"), so reviewers can compare without importing code.
3. **None of these PRs' features count as shipped.** Docs, skills and issues must not describe them
   as available.
4. Closing the old drafts is the repository owner's call. This RFC recommends closing them with a
   link to this appendix once the PR-01…PR-12 plan is accepted.

### What to reuse and what to avoid

This summary comes from the PR descriptions on 2026-10-31, not from a line-by-line read of their
diffs.

| PR | Title (abridged) | Reuse (as concepts, in the RFC section named) | Avoid |
|---|---|---|---|
| #1 | Self-hosted analytics core, console, SDKs, journey intelligence | Durability receipts reporting what was accepted (03 §3.4 responses); allowlisted event and property schemas (A's dimension allowlists) | All packages and the console Worker; Workers AI path interpretation; R2 direct-write fallback |
| #2 | Source governance, consent, credential rotation | Rotation with overlapping keys (already on `main`: `server_ingest_keys`) | Its source registry, superseded by the app registry and A's capabilities |
| **#3** | Deduplicated analytics, query budgets, D1 control plane | **Query-time dedupe by `(source, eventId)`** → the Basin SQL dedupe rule (03 §3.5); **query budgets and audit** → Explore job quotas and the restricted read audit (06 §6.4, 08); "relative units are not billing" honesty → 12 §12.3 states units, not prices | KV result cache; Access admin allowlist (superseded by E's grants); its "project" concept, which differs from E's `authz_projects`; saved-insights CRUD (out of scope) |
| **#4** | Object-centric journey replay, versioning, approvals | **Per-object journal DO that replays on late arrivals** → CaseDO (02 §2.3); **dedupe by source + event id, reorder by timestamp** → 04 §4.9; **definition validation** (terminal states, reachability) → publish rules (05 §5.2); **"replay ≠ proof of complete Basin data"** → why reconciliation exists (07 §7.4); disabled-until-approved definitions → `owner` publish | Its journey definition and compiler format; Queue consumer path; actor-scoped virtual objects; the **30-day horizon** (incompatible with backfills, D3); its 4,096-event cap (RFC uses 2,000 with child-case guidance) |
| #5 | Product knowledge graph, evidence-backed investigations | Typed edges between objects → graph relations (05 §5.7) | The knowledge graph store and investigations UI |
| #6 | Account-owned deployment, backups, release gates | Backup and restore thinking → 07 §7.7 | Its deployment scripts; separate-workspace release gates (main has `release.yml`) |
| **#7** | Observational experiment outcomes | **Explicit non-causal flags** (`causalClaim: false`) → scorecard "no clear change" wording and Wilson intervals (09 §9.2) | Experiment analysis itself (out of scope); `feature.exposed` instrumentation |
| **#8** | Read-only MCP for trusted agents | **No write tools, truncation, deny without Access, honest note that OAuth isn't implemented** → 10 §10.5 | Its separate MCP Worker forwarding to the old console service binding; its ten tools bound to old APIs |
| **#9** | Observational process twin, what-if simulator | Non-causal labelling; directly-follows transitions could later feed a simulator from `li_stage_instances` | Shipping simulation in v1; Markov what-if UI |
| #10 | Approval-gated GitHub issue handoff for agents | none for lifecycle | Agent write paths |
| #11, #13–#15 | Install wizards, account preflight, subdomain bootstrap | Preflight checks → `li doctor` (10 §10.3) | Wizards (the Phase 2 installer on `main` is separate work) |
| **#12** | Admin console, source registry, approval-gated MCP tools | **Change requests with separate approval** as a future pattern for publishing definitions of restricted processes; optimistic versioning → `projection_seq` / definition `body_hash`; audit trail → read audit | **MCP write tools, even approval-gated** (D14: none in v1); its D1 admin settings tables (overlap with E) |
| #16–#18 | Consent propagation, verified demo, revision-aware installer | Browser consent is analytics-only, so not relevant to server lifecycles | — |

## A.2 Parallel workstreams (unmerged)

| WS | Issue | Branch / PR | Owns | Contract it provides | Contract it consumes |
|---|---|---|---|---|---|
| A | FLIG-19 | `feat/lifecycle-event-ingest` (local, no PR seen) | `@flightdeckhq/schema` lifecycle types; ingest RPC and HTTP; `0005_lifecycle_write.sql`; `lifecycle_events` stream schema | **Wire vocabulary**, `ProcessDefinitionV1`, `LifecycleRecord` | G5 additions from this RFC |
| B | FLIG-16 | `feat/lifecycle-process-engine` (local) | `@flightdeckhq/lifecycle`: `replay`, metrics | **Fold semantics** (04) | A's wire vocabulary via adapter (G1) |
| C | FLIG-15 | `feat/lifecycle-dashboard-demo` (local) | Workflows demo route, `LifecycleBar`/`LifecycleRow` on fixtures | UI components | 08 `/flow` response, 11 rules |
| E | FLIG-18 | `feat/lifecycle-rbac-policy`, **draft PR #31** | `0010_read_authorization.sql`, `authorizeLifecycleRead`, suppression | **Authorization** | nothing lifecycle-specific (by design) |
| F | FLIG-20 | `test/lifecycle-cross-domain-fixtures` (local) | Seeded generator, ground truth, validator | **Contract fixtures** | A's wire format, 04 semantics for ground truth |
| — | none | `feat/lifecycle-query-analytics` (local) | `packages/lifecycle-queries` | Registry-restricted SQL, Basin adapter interface | G6 matrix; needs an issue |
| — | none | `feat/lifecycle-serving-api` (local, empty) | — | — | Becomes PR-08 |
| RFC | FLIG-17 | `docs/lifecycle-intelligence-rfc` (this PR) | Docs | Semantics, envelope, gates, plan | All of the above |

**The workstream contracts are not compatible today.** Each was started on purpose without
depending on the others ("do not modify or depend on it" appears in E's and B's scopes). That was
right for parallel development, and it means integration is real work, gated below.

## A.3 Integration gates

A **feature release** means any of: setting `LIFECYCLE_MODE=on` for any app; publishing a
non-prerelease npm version that exports lifecycle APIs; or documenting lifecycle intelligence as
available in `README.md` or the skills. No feature release happens until **every gate below is
green**, with evidence linked in FLIG-17. Individual PRs may merge behind `LIFECYCLE_MODE=off`
before that, subject to the per-gate "blocks" column.

| Gate | Blocks merge of | Owner |
|---|---|---|
| G1 Shared vocabulary | B's adapter (PR-03), CaseDO fold and read model (PR-07) | A + B |
| G2 Cross-branch contract test | CaseDO fold and read model (PR-07); any release | A + B + F |
| G3 Migration order | Every PR with a migration | each PR author |
| G4 Authorization wiring | Query API (PR-08), MCP (PR-12) | E + PR-08 |
| G5 Definition additions | A's schema PR (PR-01) | A + RFC |
| G6 Basin capability matrix | Replay and reconcile (PR-09), Explore | PR-02 |
| G7 Privacy review for restricted processes | Any `restricted` process in `on` mode | RFC + E + repository owner |
| G8 Shadow soak | `LIFECYCLE_MODE=on` | ops |

### G1 Shared vocabulary

**Problem.** In the work-in-progress seen on 2026-10-31 (read-only), A and B use different names and
shapes for the same concepts:

| Concept | A (`packages/schema/src/lifecycle.ts`, WIP) | B (`packages/lifecycle/README.md`, WIP) | Proposed normalized form |
|---|---|---|---|
| Event id field | `eventId` | `id` | `eventId` |
| Case begins | `case.created`, `case.started` | `case.start` | `case.created` + optional `case.started` (04 §4.1, 03 §3.3) |
| Stage begins / ends | `stage.entered` / `stage.exited` | `stage.enter` / `stage.exit` | `stage.entered` / `stage.exited` |
| Correction | `event.corrected` with `correction: { targetEventId, action: "retract" \| "amend", … }` | Replacement event with `supersedes: <eventId>` | `event.corrected` with `retract`/`amend` (04 §4.9) |
| Producer order | `source` (key) + top-level `sourceSequence` | `source: { id, sequence }` | `source` + `sourceSequence` |
| Process version | `processId` + `processVersion` | Opaque process id in the example (`"proc_7:v1"`) | `processId` + `processVersion` |
| Stage reference on events | `stageId` + `stageInstanceId` | `stageInstanceId`, with instances declared separately in `ReplayInput.stageInstances` | Both on the event; the adapter derives B's declarations |
| Case metadata | Per event: `processId`, `processVersion`, `dimensions` | Declared in `ReplayInput.cases` with `attributes` | Per event; adapter derives |
| Trusted sources | none | `reliableSources` | Not on the wire; an adapter parameter if B needs it |

Both are WIP and may already differ from this table; G1 is about the merged state, not this snapshot.

**Exit criteria.**

1. One exported list of transition names and fields, in `@flightdeckhq/schema`
   (`LIFECYCLE_TRANSITIONS` and the `LifecycleEventV1` type), is the only definition of the
   vocabulary.
2. B either consumes those types directly, or ships `fromWire(events: LifecycleEventV1[],
   definitions): ReplayInput` with an **exhaustive** mapping: a type-level test fails to compile when
   A adds a transition B doesn't handle.
3. Docs (this RFC's 03 and 04, A's `docs/operations/lifecycle-ingestion.md`, B's README, F's fixture
   README) use only the normalized names. `rg "case\.start\b|stage\.enter\b|stage\.exit\b|supersedes"`
   finds nothing outside the adapter and its tests.
4. The decisions on the RFC's proposed transitions (`case.migrated`) and field rules (`reason`
   required on blocks, reserved `parent` relation) are recorded as accepted or rejected in 13.

### G2 Cross-branch contract test

**Problem.** A's schema, B's fold and F's ground truth are each tested only against themselves.
Agreement between them is unproven.

**Test design.**

```
F fixtures (seeded; plus examples/ in this RFC)
   │ events.ndjson, definitions/*.json, expected.json
   ▼
A: v.safeParse(LifecycleEventV1) + checkAgainstDefinition      → every event valid, or expected-invalid ones rejected with the expected problem
   ▼
B: replay(fromWire(events, definitions), { asOf })             → projections
   ▼
compare with expected.json: per case status, outcome, closed_at, reopen_count,
five-part decomposition; per instance dwell, working/blocked/paused, attribution;
diagnostics codes; aggregates (n, n_censored, p50/p90 nearest rank, KM median)
```

- **Location.** A root Vitest project `contract/lifecycle` (added to `vitest.config.ts` projects)
  that imports A and B through their package names, so it tests what consumers get.
- **Before A and B merge**: run on a throwaway integration branch that merges A, B and F heads onto
  current `main`. Record the commit SHAs and result in FLIG-17. Nothing on that branch merges.
- **After they merge**: runs in CI on every PR touching `packages/schema/src/lifecycle*`,
  `packages/lifecycle/**`, `examples/lifecycle-fixtures/**` or `docs/rfcs/lifecycle-intelligence/examples/**`.
- **Determinism**: F's 1k seed golden hash must match; property tests (12 §12.5) run in the same
  project.

**Exit criteria.** All three RFC examples and F's 1k-seed scenarios pass on the integration branch,
then on `main` in CI. Any intentional semantics difference is resolved by changing the RFC (04) or
the code, never by loosening the comparison.

### G3 Migration order

`main` ends at `0004`. A uses `0005`, E uses `0010`, and this RFC's `li_*` tables need one more.
Rules: each PR rebases and takes the next free number at merge; no migration references tables from
an unmerged one; a test applies every migration in order on a fresh D1. Exit: `main` migrations are
contiguous and the migration test passes.

### G4 Authorization wiring

Every `/api/apps/:app/li/*` route and every MCP tool calls E's `authorizeLifecycleRead` (or its
merged successor) before touching data, and every aggregate passes through one suppression function.
Exit: a route-table test enumerates lifecycle routes and MCP tools and asserts both calls exist; E's
adversarial suite runs against the lifecycle routes.

### G5 Definition additions before the schema freezes

A's `ProcessDefinitionV1` is a `strictObject`. The 05 §5.1 additions (`sensitivity`, `kind`,
`outcome`, `group`, `canonicalStageId`, `order`, `ageLimitMs`, `breakdown`, `failureReasons`,
`predecessor`, `calendar`, `maxDepth`, `retention`, `readModel`, the `parent` relation entry) must
land in A's PR or be explicitly deferred to `schemaVersion: 2`. Exit: A's merged schema contains them
or 13 records the deferral.

### G6 Basin capability matrix

PR-02 fills in 08 §8.2 with probe results against a dev warehouse (queries, outputs, timings, bytes
scanned), and records whether Iceberg row deletion or rewrite is available (06 §6.6). Exit: the
matrix is committed in `docs/operations/lifecycle-basin.md`, and every "fallback" in the RFC is either
unnecessary or implemented.

### G7 Privacy review for restricted processes

Before any `restricted` process (hiring) is `on` with real data:

1. The protected-characteristic denylist (06 §6.3) is enforced at publish and ingest, with tests.
2. k = 10, complementary suppression, rounding, window and breakdown rules are tested on the
   lifecycle routes.
3. The read audit is written and retained.
4. The raw-tier erasure and retention job (07 §7.7) exists and has been run on a scratch table.
5. The repository owner signs off in FLIG-17. This RFC can't decide on legal suitability for a
   given organization's hiring data.

### G8 Shadow soak

Seven consecutive days in `shadow` for the pilot app with: reconcile `ok` ≥ 99.5% of hours, zero
`mismatch`, projection lag p95 < 10 s, no unexplained diagnostics growth, and API budgets met (12
§12.4). Evidence: `li doctor --json` output attached to the issue.
