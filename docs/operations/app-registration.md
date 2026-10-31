# App registration (FLIG-10)

Worker apps send analytics to Flightdeck through a `FLIGHTDECK` service binding
whose `props.appId` names a registered app. Register apps with the
Access-protected admin API, usually through the `@flightdeckhq/create` CLI. The
`/__dev/*` routes are for local development only; keep `FLIGHTDECK_DEV=0` in
production.

## App ids

Ids are derived from the name and stage, so registration is idempotent:

- The name is slugified: lowercased, accents stripped, and every run of other
  characters becomes one `-` (`ForgeGraph Web` → `forgegraph-web`).
- Production (no `--stage`, or `--stage production`) uses `app_<slug>`, matching
  the existing `app_demo`, `app_bob` and `app_flightdeck`.
- Any other stage uses `app_<slug>_<stage>`. A stage is lowercase letters,
  digits and single hyphens, at most 32 characters (`app_kanbanger_staging`).
  The stored display name is `<name> (<stage>)`.
- Slugs only contain `-`, so `_` always separates prefix, slug and stage. Ids are
  at most 64 characters.

Registering the same name and stage again returns the existing app with 200
instead of 201. Names that differ only in case or punctuation map to the same id.

## Cloudflare Access setup

The Worker verifies Access itself, so a request that reaches it without Access
(for example through `workers.dev` or a preview URL) still gets 401 on `/api/*`.

1. In Zero Trust, create a self-hosted Access application for the Flightdeck
   hostname, covering the dashboard and `/api/*`. Allow your team with a normal
   Allow policy.
2. Copy the application's **Application Audience (AUD) Tag**. Set the Worker
   vars `ACCESS_TEAM_DOMAIN` (e.g. `acme.cloudflareaccess.com`) and `ACCESS_AUD`.
   If either is empty, `/api/*` answers 503 `Access not configured`. Only local
   `wrangler dev` with `FLIGHTDECK_DEV=1` and no Access config uses a fixed dev
   principal instead.
3. If the Worker is renamed from `flightdeck`, also set `FLIGHTDECK_WORKER_NAME`,
   which is the `service` in the bindings the API returns.
4. Add **Bypass** policies, scoped to these paths only:
   - `/v1/server/events`: server ingestion authenticates with app-scoped bearer
     keys (see [server-ingestion.md](server-ingestion.md)) and is called by
     services, not people.
   - `/healthz`: uptime checks.

Do not bypass anything else:

- `/_fd/e` on the Flightdeck host does not need a bypass. Instrumented apps'
  browsers post to `/_fd/e` on the app's own origin, and `withFlightdeck`
  forwards the batch over the service binding, never to the Flightdeck
  hostname. Flightdeck's own dashboard calls its `/_fd/e` same-origin, behind
  the same Access session.
- `/api/*` must stay behind Access.

### Service token for the CLI and agents

1. In Zero Trust, go to Access → Service credentials → Service tokens and
   create a token, e.g. `flightdeck-cli`. Store the client id and secret in your
   secret manager. The secret is shown only once.
2. In the Flightdeck Access application, add a policy with action
   **Service Auth** that includes this service token.
3. Export them for the CLI:

   ```sh
   export FLIGHTDECK_URL=https://flightdeck.example.com
   export FLIGHTDECK_ACCESS_CLIENT_ID=...      # from your secret manager
   export FLIGHTDECK_ACCESS_CLIENT_SECRET=...
   ```

Access exchanges the token for a JWT whose `common_name` is the client id. The
API reports it as `{ sub: <client id>, serviceToken: true }`. People can use
`cloudflared access login $FLIGHTDECK_URL` instead; the CLI then uses
`cloudflared access token --app $FLIGHTDECK_URL`.

## CLI

```sh
npx @flightdeckhq/create apps list [--json]
npx @flightdeckhq/create apps add kanbanger --stage staging [--json]
npx @flightdeckhq/create apps key app_bob [--days 90] [--out bob.key] [--json]
npx @flightdeckhq/create apps revoke-key app_bob <sha256-hex>
```

`--url` overrides `FLIGHTDECK_URL`. HTTPS is required except for `localhost`.

`apps add` prints the `services` entry to paste into the stage's
`wrangler.jsonc`, then the next steps. Wrap the fetch handler with
`withFlightdeck`, and follow `skills/flightdeck-instrument-worker`.

```jsonc
{
  "services": [
    {
      "binding": "FLIGHTDECK",
      "service": "flightdeck",
      "entrypoint": "Ingest",
      "props": { "appId": "app_kanbanger_staging" }
    }
  ]
}
```

`apps key` generates 32 random bytes locally and encodes them as base64url. It
sends only the key's SHA-256 digest and expiry, then prints the raw key once to
stdout. With `--out`, it creates the file exclusively with mode 0600 before
registering anything, so an existing or unwritable path fails without creating a
key. If the API rejects the digest, the file is removed and the key is never
shown. If the key is registered but the write fails, the CLI prints its digest
and the exact `revoke-key` command, and exits non-zero. Store the key as a secret immediately, e.g.
`npx @flightdeckhq/create apps key app_bob | wrangler secret put BOB_FLIGHTDECK_TOKEN`.

## API

Every route requires the Access JWT in `Cf-Access-Jwt-Assertion`, which Access
adds at the edge. It must be RS256, from the team's issuer, for `ACCESS_AUD`,
and carry `exp` and `iat`. Responses are JSON with `Cache-Control: no-store`, and errors
are `{ "error": "..." }`. Request bodies must be `application/json` (415
otherwise), which keeps cross-site form posts from riding the Access cookie.

| Route | Body | Success |
| --- | --- | --- |
| `GET /api/me` | | 200 `{ principal: { sub, email?, serviceToken } }` |
| `GET /api/apps` | | 200 `{ apps: [{ id, name, created_at }] }` |
| `POST /api/apps` | `{ name, stage? }` | 201 new or 200 existing `{ app: { id, name, created_at }, binding }` |
| `POST /api/apps/:id/server-keys` | `{ token_hash, expires_at }` | 201 `{ key: { app_id, token_hash, expires_at } }` |
| `DELETE /api/apps/:id/server-keys/:hash` | | 204 |

- `token_hash` is 64 lowercase hex characters.
- `expires_at` is epoch milliseconds, in the future and at most 400 days away.
- Unknown apps return 404, a duplicate digest returns 409, and deleting a key
  that does not belong to the app returns 404.
- Deleting a key revokes it immediately.
- A newly registered app emits a best-effort `app.registered` event under
  `app_flightdeck`. Registration never fails because of it; a failure logs only
  the event name.
