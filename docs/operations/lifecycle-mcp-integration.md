# Draft lifecycle + MCP integration (FLIG-34)

Review-only integration of existing work, based on `origin/main` at
`9ab001a4c9f1a1d25813130654953e021c981d71` (2026-11-01). Delivery target:
non-deploying. Original feature branches are preserved. Do not merge main,
deploy, apply remote migrations or use real personnel data as part of this work.

## Integration matrix

All nine exact heads below are ancestors of this integration. GitHub returned
**no submitted reviews** for these draft PRs at inspection; latest heads include
reported review fixes, but this is not an assertion of formal approval.

| PR | Exact included head | Integration |
| --- | --- | --- |
| #45 lifecycle end-to-end | `aea9d20ad2db14b46b4aa67d864202c098a0a503` | Included through #49; ingest → replay → D1 → authorized dashboard |
| #44 MCP read-only baseline | `324615dbc2658cb56c075d0b174b455e54e5c515` | Already in #47/#49; no second merge |
| #47 MCP analysis | `246586d0fbbb1c6ecf2dc3cddeba63517316adeb` | Already in #49/#50/#51; excludes competing #46 |
| #49 private authenticated D1 RPC | `63d45b609ae8fc06dadc014e2fcf44a7efb176c4` | First integration merge; includes dotted-key/completeness fixes |
| #50 two-domain acceptance | `213b15206f89627e528bc024387e546cf49d8d99` | Second merge; retains independent numeric oracle |
| #48 investigation package | `7f1956d89c3e507647400a10cff318cf846b74db` | Already in #51; no second merge |
| #51 package MCP bridge | `3c156e3c1f0892383c996ee7d609faf5a46a2f0f` | Third merge; optional trusted query source required |
| #38 insights | `f51856418007bfa01cec9bafd6fd908571f8e3e2` | Fourth merge; standalone aggregate evaluator, no scheduled alerts |
| #40 RFC | `25046412f50eea65fa35617135008854cb162741` | Fifth merge; proposals/examples remain distinct from implemented contracts |

Main already squash-merged #31 authorization, #32 dashboard, #34 query contracts
and #37 fixtures. #45 previously reconciled main; merging its descendant #49
retains that reconciliation. No duplicate patch commits were cherry-picked for
these four dependencies. Their migrations, authorization, query package and
fixture files are unchanged from main where no integration extension is needed.

Conflict resolutions are additive: retain schema + query + investigation workspace
dependencies, regenerate the lockfile under existing supply-chain policies, and
retain all replay/investigation/insights tarball consumers in `scripts/pack-smoke.sh`.
README entries are combined. No runtime route/schema conflicts required a second
implementation: `/v1/lifecycle/{processes,events}` and authorized
`/api/apps/:app/lifecycle/*` remain wired once; private
`LifecycleReadEntrypoint` is exported once with no public RPC HTTP route.
The shared schema exports both lifecycle-write and private-read contracts.

#50's two golden evidence IDs change because #49 updates one hashed limitation
string to describe live D1 correctly. Restoring **only that string** in each pack
reproduced both old hashes in a temporary diagnostic (2/2 passed). All golden
samples, query IDs, dwell cells, suppression and numeric oracle checks are
unchanged; hashes of the actual returned packs still verify independently.

## D1 migration order and configuration

Fresh database order (all under `apps/flightdeck/migrations`):

1. `0001_apps.sql`
2. `0002_server_ingest_keys.sql`
3. `0003_dogfood_app.sql`
4. `0004_hourly_rollups.sql`
5. `0005_lifecycle_write.sql` — scoped producer keys and app capability
6. `0006_process_definitions.sql` — immutable registered definitions
7. `0010_read_authorization.sql` — read grants/policy
8. `0020_lifecycle_serving.sql` — rebuildable serving snapshots
9. `0030_lifecycle_projection.sql` — evidence log, queue, outbox and tombstones

No filename collisions or new integration migration. Existing databases must
honor their migration ledger, never replay applied `ALTER TABLE` statements;
check pending migrations and schema on an isolated staging copy before release.
The example outbox's `0001_outbox.sql` belongs to its **separate producer DB**.
Local workerd tests apply the real ordered migrations to ephemeral D1 only.
No remote migration was run.

| Setting/surface | Committed default / expected opt-in |
| --- | --- |
| Backend `LIFECYCLE_MCP_READ_ENABLED` | `0`; isolated tests opt into `1` |
| Backend `LIFECYCLE_MCP_ACCESS_AUD` | Empty; opt-in needs MCP-specific AUD distinct from dashboard `ACCESS_AUD` |
| MCP environment/source | `production` / `disabled`; `PRODUCTION_ENABLED = false` refuses production |
| MCP binding | `LIFECYCLE_READ_API` → backend `LifecycleReadEntrypoint`, commented out by default; must target the same isolated environment |
| MCP Access | Separate MCP-host audience, verified unchanged again by backend; no dashboard token forwarding |
| MCP privacy/origin/dev | minimum cohort `5`, origins empty, dev bypass `0`; synthetic local bypass only in explicit development mode |
| Legacy dashboard reads | `READ_AUTHZ_MODE=legacy`; lifecycle reads always require app grants; enforce legacy reads separately after grant provisioning |
| Lifecycle ingestion | Operator grants app `lifecycle.write`, scoped key and registered definition required; accepted events persist in D1/outbox even without Basin binding |
| Package investigation tools | Absent unless host injects `Deps.investigationEngine`; no environment flag enables a fixture adapter or infers one from live D1 |

## Verification

Node `24.14.0`, pnpm `12.14.0`. Commands run on the integrated tree:

| Command | Local result |
| --- | --- |
| `pnpm install --frozen-lockfile` | PASS; 14 workspace projects, supply-chain policies preserved |
| `pnpm lint` | PASS; 359 files |
| `pnpm typecheck` | PASS across workspace |
| `pnpm test` | PASS; 1,021 tests / 71 files |
| `pnpm test:integration` | PASS; 40 tests / 3 files, combined suite below |
| `pnpm build` | PASS; dashboard, packages, MCP dry-run bundle |
| `pnpm --filter @flightdeckhq/app exec wrangler deploy --dry-run --outdir dist` | PASS; backend 277.74 KiB, no upload |
| `pnpm smoke:pack` | PASS; eight tarballs installed outside workspace, TS 7.0.2 + 5.9.3, Node exports, replay, package evidence round-trip, insights and CLI |
| `pnpm --filter @flightdeckhq/browser --if-present size` | PASS; 2,247 B gzip / 3,072 B limit |
| `git diff --check` | PASS |

`pnpm test:integration` runs the actual MCP v2 client/handler with signed local
Access assertions across three complementary seams:

- #50: synthetic recruiting interview-loop regression and delivery rollout v1/v2,
  independent fixture-derived dwell/sample oracle, pinned evidence IDs,
  suppression, censoring, non-causal interpretation and negative access/input tests.
- #49: both synthetic fixture domains through HTTP ingestion, replay, migrated
  local D1, the actual named Worker RPC and MCP client; dotted stages, signed
  identity, audience isolation, revocation, suppression and fail-closed semantics.
- #51: hiring/deployment package-backed evidence compared with direct library
  results, strict schemas/citations/claim validation, budgets and grant rechecks.

These are distinct source contracts. The package fixture adapter is **not**
connected to the D1 read adapter. The latter cannot supply historical `asOf`,
atomic revisions, funnel/path variants, paused/blocked reconstruction or dimension
breakdowns; unsupported operations fail closed with no synthetic fallback.
`fresh` describes projection recency; log sequence is not an event-time watermark.
The complete Vitest suite also covers all 11 committed lifecycle scenarios and
the seeded 1k dataset against the ingestion/projection oracle.

## Optional add-ons and release gates

At publication inspection none of these branches had published a remote head or
any local commit beyond its stated base. No add-on SHA is claimed as an
implementation, and none is required for this draft's core CI to pass.

| Later order | Branch | Base | Add-on commit |
| --- | --- | --- | --- |
| 1 | `feat/lifecycle-mcp-privacy-gate` | #49 `63d45b609ae8fc06dadc014e2fcf44a7efb176c4` | Pending |
| 2 | `feat/lifecycle-erasure-retention` | #45 `aea9d20ad2db14b46b4aa67d864202c098a0a503` | Pending |
| 3 | `feat/lifecycle-mcp-oauth-preflight` | #49 `63d45b609ae8fc06dadc014e2fcf44a7efb176c4` | Pending |
| 4 | `feat/lifecycle-integration-preflight` | main `9ab001a4c9f1a1d25813130654953e021c981d71` | Pending |

For later integration take each branch's **unique reviewed commits after its
base**, record exact SHAs, reconcile any new migration numbers, and rerun frozen
install plus all checks and combined acceptance. Do not replay its base stack.
Privacy and retention can be developed independently; OAuth follows the privacy
policy, and staging preflight should assess the final combined configuration.

Release blockers remain separate from a green review-only integration:

- Privacy review, cross-query differencing/admission controls and minimum cohort
  policy before real sensitive data. No real-HR safety claim.
- D1 evidence retention, Basin erasure and tombstone-aware rebuild procedure;
  D1 erasure alone cannot remove already-forwarded Basin rows.
- Environment-specific Workers/D1/bindings, separate Access audiences and real
  JWKS/service identities, denied cross-environment reads, migration rehearsal,
  rollback, operational budgets and staging/health evidence before enablement.
- OAuth/delegation/client interoperability is unimplemented; production MCP stays
  compile-time disabled. No persistent evidence retrieval, Apps UI or async Tasks.
- Typed engine production adapter must provide complete normalized revisions,
  historical reads, current authorization and shared durable admission; the D1
  live source must not be relabelled to pretend it provides those semantics.
- Bounded live grant discovery (256), pending-queue global unavailability and
  aggregate differencing remain limits. Insights have no live scheduler/wiring;
  RFC additions beyond current strict schema remain proposals.
- Exact-head GitHub checks and independent review required before any later
  integration decision. **No main merge or deployment is authorized here.**

No live Cloudflare Access, account, Basin SQL, deployment or health verification
is claimed. Kanbanger status is maintained explicitly; a PR link alone does not
prove automatic status synchronization.
