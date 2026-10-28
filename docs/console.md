# Flightdeck console — current release

The console is a separate React application and Worker, **not part of Flagship**. Its first vertical slice queries the event table in your own Basin Catalog and renders real data (no synthetic production dashboard metrics).

## Views

Overview, event explorer, ordered funnels, retention cohorts, directly-follows journey transitions, Web Vitals p75, variant exposure counts, integration instructions.

This is **read-only analytics**. It does not support flag mutation. It does not yet include AI-discovered names, causal experiment inference, session replay or the future knowledge graph.

## Build

```sh
pnpm install
pnpm --filter @flightdeck/console build
```

The console Worker serves static Vite assets and `/api/*` endpoints. It validates Cloudflare Access JWTs (JWKS + audience/issuer) on every request. If Access is not configured, **even the HTML shell returns 503**. There is no demo-user fallback.

## Cloudflare settings

Fill the console Wrangler configuration with:
- `ACCESS_TEAM_DOMAIN` (e.g. `example.cloudflareaccess.com`)
- `ACCESS_AUD` (Access application audience)
- `ACCOUNT_ID` (Cloudflare account owning Basin Catalog)
- `BASIN_BUCKET` (R2 bucket with Catalog enabled)
- `BASIN_TABLE` (initially `default.flightdeck_events`)
- `PROJECT_ID` (trusted, server-configured single-project scope)

Set the secret `BASIN_SQL_TOKEN` using `pnpm exec wrangler secret put BASIN_SQL_TOKEN -c apps/console/wrangler.jsonc`. Its Cloudflare permissions should be restricted to Basin SQL, Catalog and R2 as documented by Cloudflare. Deploy with `pnpm --filter @flightdeck/console deploy`.

Configure a **Cloudflare Access self-hosted application** for the console host and an allow policy. The Worker validates the Access JWT independently of the edge policy.

Do not expose Basin SQL tokens or Cloudflare account API tokens in the React bundle.

## Query safety

The `@flightdeck/query` package compiles a fixed, bounded DSL. It does not accept arbitrary SQL, enforces project/time filters, validates identifiers, limits pagination and rejects queries spanning more than 90 days. Expensive cohort/funnel views will eventually use asynchronous, materialized jobs.

## Limitations

The exact Basin SQL API response structure must be integration-tested against your live account. The React UI accepts common rows/data shapes but cannot guarantee correct rendering until validated. For very large volumes, the retention and transition queries should be replaced with staged materializations and cost caps before general availability.
