# create-flightdeck

CLI for a self-hosted [Flightdeck](https://github.com/gmackie/flightdeck): register apps and manage their server ingest keys. (Installing Flightdeck itself comes later.) Needs Node 24 or later.

## Use

```bash
export FLIGHTDECK_URL=https://flightdeck.example.com

npx create-flightdeck apps add myapp --json                  # production: app_myapp
npx create-flightdeck apps add myapp --stage staging --json  # app_myapp_staging
npx create-flightdeck apps list
npx create-flightdeck apps key app_myapp --days 90 --out key.txt
npx create-flightdeck apps revoke-key app_myapp <sha256>
npx create-flightdeck --help
```

`apps add` prints the service binding to paste into your wrangler config (see [`@flightdeckhq/worker`](https://www.npmjs.com/package/@flightdeckhq/worker)).

## Auth

Flightdeck's API sits behind Cloudflare Access. The CLI uses, first match wins:

- `FLIGHTDECK_ACCESS_CLIENT_ID` + `FLIGHTDECK_ACCESS_CLIENT_SECRET`: an Access service token
- `cloudflared access token --app <url>`, after `cloudflared access login <url>`

## Docs

- [App registration](https://github.com/gmackie/flightdeck/tree/main/docs/operations/app-registration.md)
- [Registering from an agent](https://github.com/gmackie/flightdeck/tree/main/skills/flightdeck-instrument-worker/references/registration.md)

## License

Apache-2.0
