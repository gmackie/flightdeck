# The FLIGHTDECK binding in wrangler configs

The binding is a service binding to the `Ingest` entrypoint of the `flightdeck` Worker, with the appId in `props`. `services` is **not inherited** by `env.*` blocks, so restate it in every env, with that env's appId.

| Stage | appId |
|---|---|
| production | `app_<slug>` |
| staging, beta, preview, PR previews, one-box | `app_<slug>_staging` (the id `npx create-flightdeck apps add <name> --stage staging` returned) |
| local dev (top-level config, no env) | the staging appId |

## wrangler.jsonc

```jsonc
{
  "name": "myapp-web",
  "main": "src/server/worker.ts",
  // Top level: what `wrangler dev` uses.
  "services": [
    { "binding": "FLIGHTDECK", "service": "flightdeck", "entrypoint": "Ingest", "props": { "appId": "app_myapp_staging" } }
  ],
  "env": {
    "staging": {
      "name": "myapp-web-staging",
      "services": [
        { "binding": "FLIGHTDECK", "service": "flightdeck", "entrypoint": "Ingest", "props": { "appId": "app_myapp_staging" } }
      ]
    },
    "production": {
      "name": "myapp-web",
      "services": [
        { "binding": "FLIGHTDECK", "service": "flightdeck", "entrypoint": "Ingest", "props": { "appId": "app_myapp" } }
      ]
    }
  }
}
```

If the config already has `services` (Kanbanger, ForgeGraph), append to the existing array; do not replace it.

## wrangler.toml

```toml
[[services]]
binding = "FLIGHTDECK"
service = "flightdeck"
entrypoint = "Ingest"
props = { appId = "app_myapp_staging" }

[[env.production.services]]
binding = "FLIGHTDECK"
service = "flightdeck"
entrypoint = "Ingest"
props = { appId = "app_myapp" }
```

## Where stage configs live

Check all of these before deciding you are done:

- **`env.<stage>` blocks** in one file (create-gmacko-app derived repos, Kanbanger, Wafflehouse: `preview`, `staging`, `production`). Builds select one with `CLOUDFLARE_ENV=<env>` or `wrangler deploy --env <env>`.
- **One file per stage**: ForgeGraph `apps/web/wrangler.toml` (production, Worker `forgegraf`) and `apps/web/wrangler.staging.toml` (beta, Worker `forgegraf-beta`, which also serves Worker Previews). PR previews use the staging file, so they get the staging appId automatically.
- **One-boxes** (`<slug>-onebox` Workers created by ForgeGraph traffic management) are deployed from a copy of the production config. Per the registration contract they must bind the staging appId; if the one-box is built from the production file and you cannot give it its own binding, report it to the coordinator instead of guessing.
- **Generated configs**: a header such as `// Generated from cloudflare.config.ts ... do not edit` (school-os: `cloudflare.config.ts` -> `pnpm configs:generate`, and `wrangler.production.jsonc` from `scripts/production/` via `pnpm production:configs`). Edit the source and regenerate; never hand-edit the output. If the generator cannot express `entrypoint` + `props` on a service binding, stop and report it as a blocker.
- **Routers** (`*-router` Workers) forward to the app through their own service binding. Do not instrument the router; instrument the app Worker behind it. If the router rewrites the request URL so the app sees a different host than the browser, add the public origin(s) to `allowedOrigins` (see recipe-plain-worker.md).

## After editing

- `wrangler types` (with `--strict-vars false` if the repo's typegen script uses it), commit `worker-configuration.d.ts`.
- `wrangler deploy --dry-run --env <env>` for each env, when the repo can build locally, to catch config errors.
- The service binding resolves at deploy time: the `flightdeck` Worker already exists in the account, so a deploy never fails because of it. Locally, wrangler resolves it through the dev registry when Flightdeck runs in another `wrangler dev`; otherwise calls fail, which the fail-open code tolerates.
