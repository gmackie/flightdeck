# Dashboard and dogfooding (FLIG-9)

The dashboard SPA (`apps/dashboard`) is served as static assets by the `flightdeck`
Worker. The Worker runs first only for `/api/*`, `/_fd/*`, `/v1/*`, `/healthz` and
`/__dev/*`; other paths serve the SPA, with `index.html` as the fallback.

Build and run from `apps/flightdeck`:

- `pnpm run dev` builds the dashboard, then runs `wrangler dev`.
- `pnpm run ship` builds the dashboard, then runs `wrangler deploy`.

Don't run `pnpm deploy` (pnpm's built-in command) or a bare `wrangler deploy`: neither
builds the dashboard, so the Worker would ship stale or missing assets. For a dry run,
use `pnpm run build:dashboard && pnpm exec wrangler deploy --dry-run`.

## Cloudflare Access

Access must protect every hostname that serves the dashboard and `/api/*`. That
includes the `workers.dev` hostname while `workers_dev` is enabled. Otherwise, disable
`workers_dev` and serve Flightdeck only on a custom domain that Access covers.

Set `ACCESS_TEAM_DOMAIN` to the team domain and `ACCESS_AUD` to the AUD tag of the
dashboard's Access application.

## Dogfooding

Flightdeck instruments itself as `app_flightdeck`, which migration 0003 registers. The
SPA's browser SDK posts to same-origin `/_fd/e`. The Worker passes those batches to its
own `Ingest` entrypoint through `ctx.exports`: the same RPC path as any app's service
binding.

The `app_flightdeck` row has no `access_aud`, so its Access identities are checked
against `ACCESS_AUD`. That rejects JWTs minted for other Access applications in the
team. When `ACCESS_AUD` is empty, the audience isn't checked, as before.
