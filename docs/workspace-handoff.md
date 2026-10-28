# Flightdeck — handoff to a fresh Cloudflare workspace

**No live Cloudflare resources have been created by the development PR stack.**
Review and merge PRs in order only after validation.

## Stacked PR order

1. PR #1 — baseline self-hosted Worker RPC, SDKs, Basin and Console.
2. PR #2 — source security, consent assertion, credential rotation.
3. PR #3 — query deduplication, admission budgets, D1 dashboard/control plane.
4. PR #4 — deterministic object-scoped journeys, DO state and replay.
5. PR #5 — product graph, evidence-bounded investigations, human-reviewed proposals.
6. PR #6 — deployment and recovery tooling, integrated tests and release gates.
7. PR #7 — observational experiment outcomes with statistical safeguards.
8. PR #8 — optional Access-authenticated read-only MCP for coding agents.

All PRs remain draft until reviewed; **do not squash a child PR onto main before its parent branch**.

## Prerequisites

- Cloudflare Workers Paid in an account you control, with Wrangler authenticated.
- Basin Pipeline stream, R2 Catalog/Iceberg table, D1 database ID, and account ID.
- A self-hosted Cloudflare Access application on the exact console hostname, with a valid Access team domain and AUD.
- Restrict Basin SQL credential permissions to the minimal necessary scope.
- Node.js 22+, pnpm 10, tested versions pinned in lockfile/release.
- A non-sensitive test app Worker using a first-party service binding and a dedicated source token.

## Reproducible staging

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:deployment
pnpm workspace:deploy -- --help
```

On a new account, provision R2/Catalog, Basin pipeline and D1 manually or via the approved installer; preserve resource IDs. Then run the **dry-run** setup with your IDs:

```sh
pnpm workspace:deploy -- \
  --d1-id YOUR_D1_UUID \
  --d1-name flightdeck-meta \
  --stream-id YOUR_BASIN_STREAM_ID \
  --account-id YOUR_ACCOUNT_ID \
  --host analytics.example.com \
  --access-domain team.cloudflareaccess.com \
  --access-aud YOUR_AUD \
  --admin-email admin@example.com \
  --dry-run
```

After security/resource preflight, set `FLIGHTDECK_BASIN_SQL_TOKEN` as a secret environment variable in your local workspace and use `--apply --yes` to perform the remote migration/deployment.

**Do not use sensitive production user data for the first validation.**

## Acceptance checklist

- Private Core has no public route; only an app with a correct server-side source credential can ingest.
- Cross-project/source attempts, forged actors, disallowed event names, sensitive properties and missing consent are rejected.
- Event stream receipt means accepted into Basin; SQL query visibility may lag.
- Tenant-scoped event count/funnel data agrees with a known fixture including duplicate retries.
- Console HTML and every API return non-200 anonymously; Access JWT is independently verified server-side.
- D1 migrations are applied, query-budget admission is effective and audit records are present.
- Optional Queue + DO replays late events deterministically and isolates objects/projects.
- Graph manifest registration requires explicit source permission and rejects ungrounded inferred edges.
- AI investigations have bounded inputs, quotas, and approval-only action semantics.
- Backup can be exported with checksum, and restore can populate a **new** D1 database.
- RUM captures no raw secrets/URL queries and requires app-owned consent.
- Actual Cloudflare billing, Basin schema drop/error metrics and production load limits are evaluated before GA.

## Known gaps / next milestones

Full row-level Iceberg deletion, event-lake backup/replication, warehouse materialized aggregations, query billing alerts, source-policy admin UI, true cross-session identity resolution, causal experiment statistics, source-code graph extraction, autonomous coding integrations and comprehensive observability/SLAs still require work. Do not label these shipped until separately verified.

## Operational policy

Never merge or auto-deploy from generated findings. Keep Flagship management entirely within Cloudflare's dashboard. Coding agents may prepare PRs from approved investigations but must not receive broad production credentials.
