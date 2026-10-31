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

Server-side, the live and trends APIs record a `query.run` event with only
`{ endpoint, range }` (no user data), fire and forget under `ctx.waitUntil`.

## Live view

`GET /api/apps/:id/live?hours=N` (N from 1 to 24, default 2) returns the snapshots of the
last N hour shards (AppDOs), newest first: totals by kind, top counters, transitions,
unique sessions and per-minute event counts. Every `/api/apps/:id/*` read checks that the
app is registered first, and shard names come from the verified id and the server clock
only.

- **Active sessions** are distinct sessions whose latest event (by event time) is within
  the last 5 minutes. In the first 5 minutes of an hour the window spans two shards, so
  the API unions their session ids rather than adding counts.
- **Events per minute** is the mean of the last 5 complete minutes.
- **Page views this hour** counts `page` events since the top of the UTC hour.

`GET /api/apps/:id/live/ws` hands an Access-checked, same-origin WebSocket upgrade to the
current hour's AppDO, which holds it with the Hibernation API. Its first message is a
`hello` with the hour's end and the time, both by the server clock. The client moves to the
next hour's shard a moment after that hour end, so a client clock running fast or slow
doesn't matter. The DO refuses upgrades once its hour is over (410), and an alarm closes its
sockets with code 4000 at the hour end.

Each ingest broadcasts a compact delta (increments plus absolute session counts), coalesced
to at most one message per second. Snapshots carry the shard's write sequence `seq`; a delta
covers writes `since + 1` to `seq`. The client skips deltas a snapshot already includes,
refetches instead of double-counting one that overlaps it, and refetches after a gap or a
truncated delta. The client sends `ping` every 30 seconds (answered by an auto-response,
without waking the DO), reconnects with exponential backoff, and polls the snapshot every
10 seconds while the socket is down (every 60 seconds while it is up, to correct drift).

## Trends and the warm tier

Each AppDO flushes its hour into D1 (`hourly_rollups`, `hourly_sessions`; migration 0004)
by alarm 10 minutes after the hour ends. Events that arrive later re-arm a flush a minute
out. A flush deletes and rewrites the app-hour in one batch, so re-flushing is idempotent.
If a write lands while the D1 write is in flight (the shard counts its writes and compares
before and after), the alarm flushes again a minute later instead of waiting for expiry. An
hour keeps at most 1,000 names; the rest fold into one `$other` row per kind. Ingest rejects
custom event names starting with `$` (Flightdeck reserves them: `$start`, `$exit`,
`$other`); a `$other` recorded before that rule merges into the folded row.

This deviates from the design, where a cron runs Basin SQL over closed hours. Hours that
closed before this shipped never get D1 rows: their shards had no flush alarm, and expire
48h after their hour. Backfilling or repairing rollups from the Iceberg tables with Basin
SQL is a follow-up.

`GET /api/apps/:id/trends?range=24h|7d|30d&breakdown=kind|name|page&kind=...` reads D1
for older hours and the AppDOs for the previous and current hour (they stay authoritative
until they expire). Buckets are UTC hours for `24h` and UTC days otherwise. The top five
series are returned individually, the rest as `$other`. `breakdown=page` is page views by
path; `breakdown=name` without a `kind` skips page views. `totals.sessions` sums each
hour's unique sessions, so a session spanning hours counts once per hour.
