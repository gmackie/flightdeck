# Registering an app with @flightdeckhq/create

If your brief already lists the production and staging appIds, use them and skip this file. Registration is idempotent per name and stage, but the coordinator usually registers apps in bulk.

## Getting the CLI

Run it from npm with `npx @flightdeckhq/create apps add ...` (or `pnpm dlx @flightdeckhq/create ...`). It needs Node 24 or later; nothing to install or build.

Until 0.1.1 is published, `npm view @flightdeckhq/create version` returns 404. If it does, use the ids from the coordinator or ask for them, and report on FLIG-14 (the npm release). Don't build the CLI from a Flightdeck checkout.

## Configuration

| Variable | Purpose |
|---|---|
| `FLIGHTDECK_URL` | Base URL of the Flightdeck deployment (or pass `--url <url>`) |
| `FLIGHTDECK_ACCESS_CLIENT_ID` + `FLIGHTDECK_ACCESS_CLIENT_SECRET` | A Cloudflare Access service token for Flightdeck's Access application; set both or neither |
| (none of the above) | Falls back to `cloudflared access token --app <url>`; run `cloudflared access login <url>` once first |

Never print or commit the Access secret; read it from the secret store your environment uses.

## Commands

```bash
npx @flightdeckhq/create apps add <name> --json                    # production: app_<slug>
npx @flightdeckhq/create apps add <name> --stage staging --json    # staging and every non-production lane: app_<slug>_staging
npx @flightdeckhq/create apps list --json
```

`add` prints `{ app: { id, name, created_at }, binding: { binding, service, entrypoint, props: { appId } } }`; the `binding` object is the `services` entry for the wrangler config. Use the staging id for staging, beta, previews and one-boxes; do not register extra stages.
