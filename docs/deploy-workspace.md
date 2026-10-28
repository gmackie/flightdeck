# Separate-workspace deployment and operator sequence

Flightdeck is deployed into the operator's own Cloudflare account; the development environment **does not** have Cloudflare account credentials and must not mutate production.

## Resources (create once)

1. Workers Paid Cloudflare account with a constrained API token or Wrangler login.
2. An R2 bucket with Basin Catalog enabled and a structured Basin Pipeline stream using `basin/events.schema.json`.
3. A D1 database named `flightdeck-meta` (record the UUID from Wrangler).
4. A Cloudflare Access self-hosted application for the console custom domain; record team domain and AUD.
5. A restricted Basin SQL API credential provided through an environment variable, never a file in the repo.
6. An application Worker/DO with its own session authentication and an internal service binding to Flightdeck Core.

The Warehouse REST/SQL capabilities, quota limits and event schemas must be confirmed in the actual account. Basin setup is a guided Cloudflare CLI step; it is **not** automatically created by Flightdeck's local installer.

## Prepare without remote mutations

```sh
pnpm install
pnpm build && pnpm typecheck && pnpm test
pnpm test:integration && pnpm test:deployment

pnpm workspace:deploy -- \
  --d1-id 00000000-0000-0000-0000-000000000000 \
  --d1-name flightdeck-meta \
  --stream-id BASIN_STREAM_ID \
  --account-id CLOUDFLARE_ACCOUNT_ID \
  --host analytics.example.com \
  --access-domain team.cloudflareaccess.com \
  --access-aud YOUR_CLOUDFLARE_ACCESS_AUD \
  --admin-email admin@example.com \
  --dry-run
```

## Apply after explicit approval and preflight

```sh
export FLIGHTDECK_BASIN_SQL_TOKEN='SECRET_FROM_ACCOUNT_VAULT'
pnpm workspace:deploy -- \
  --d1-id YOUR_REAL_D1_UUID \
  --stream-id YOUR_REAL_BASIN_STREAM_ID \
  --account-id YOUR_REAL_CLOUDFLARE_ACCOUNT_ID \
  --host YOUR_CONSOLE_HOST \
  --access-domain YOUR_ACCESS_DOMAIN \
  --access-aud YOUR_ACCESS_AUD \
  --admin-email YOUR_ADMIN_EMAIL \
  --apply --yes
unset FLIGHTDECK_BASIN_SQL_TOKEN

pnpm workspace:doctor
pnpm workspace:backup -- --apply
```

The script generates local account-specific configs; checks D1/Basin resource IDs; exports a D1 backup before schema migrations; applies D1 migrations; seeds the project/source inventory; deploys private Core and Access-guarded Console Workers; and installs source and SQL tokens as Worker secrets. It does not deploy the optional Journey Worker; that remains a guided opt-in deployment.

**Upgrade note:** On subsequent runs, inspect the generated config and migration plan before applying. D1 migrations are versioned and may be nonreversible; the script does not automatically restore production state.

## Add an existing Worker

```json
{"services":[{"binding":"FLIGHTDECK","service":"flightdeck-core"}]}
```

The source token remains a server-side secret. Apps may use the browser SDK to submit to their own authenticated endpoint; they use `@flightdeck/sdk-worker` or `@flightdeck/sdk-effect` to send authorized backend events.

## Operator checkpoints

Verify anonymous console API denial (Cloudflare Access and Worker JWT), authenticated console query, one real event through service RPC, Basin stream ingestion/user-error metrics, SQL appearance, per-project query budgets, and backup checksum. Use the [full release gates](release-gates.md). D1 backups do not back up the Iceberg event lake.
