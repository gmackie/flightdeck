# Registering an app with create-flightdeck

If your brief already lists the production and staging appIds, use them and skip this file. Registration is idempotent per name and stage, but the coordinator usually registers apps in bulk.

## Getting the CLI

Once published: `npx create-flightdeck apps add ...`. Until then, build it from a Flightdeck checkout that contains `packages/create-flightdeck` (FLIG-10):

```bash
cd ~/dev/flightdeck && wt switch --create fd-cli      # a worktree; never build inside the seed
pnpm install && pnpm --filter create-flightdeck build  # writes packages/create-flightdeck/dist/cli.js
create-flightdeck() { node ~/work/flightdeck/fd-cli/packages/create-flightdeck/dist/cli.js "$@"; }
```

If `packages/create-flightdeck` is missing, FLIG-10 has not merged yet: use the ids from the coordinator, or ask for them.

## Configuration

| Variable | Purpose |
|---|---|
| `FLIGHTDECK_URL` | Base URL of the Flightdeck deployment (or pass `--url <url>`) |
| `FLIGHTDECK_ACCESS_CLIENT_ID` + `FLIGHTDECK_ACCESS_CLIENT_SECRET` | A Cloudflare Access service token for Flightdeck's Access application; set both or neither |
| (none of the above) | Falls back to `cloudflared access token --app <url>`; run `cloudflared access login <url>` once first |

Never print or commit the Access secret; read it from the secret store your environment uses.

## Commands

```bash
create-flightdeck apps add <name> --json                    # production: app_<slug>
create-flightdeck apps add <name> --stage staging --json    # staging and every non-production lane: app_<slug>_staging
create-flightdeck apps list --json
```

`add` prints `{ app: { id, name, created_at }, binding: { binding, service, entrypoint, props: { appId } } }`; the `binding` object is the `services` entry for the wrangler config. Use the staging id for staging, beta, previews and one-boxes; do not register extra stages.
