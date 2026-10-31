# Verifying Flightdeck instrumentation

## 1. Static checks

- The repo's own typecheck, lint and test commands.
- `scripts/pii-check.sh` from this skill on the diff.
- `wrangler deploy --dry-run --env <env>` per env, when the repo builds locally.

## 2. Local: Flightdeck and the app as two `wrangler dev` processes

Wrangler's dev registry connects the app's `FLIGHTDECK` service binding to a Flightdeck Worker running in another `wrangler dev` on the same machine. This is the pattern `scripts/smoke.sh` in the Flightdeck repo automates for `examples/demo-app`.

Terminal 1, Flightdeck. Wrangler writes `.wrangler/` into the project, so run it from a Flightdeck worktree or clone with dependencies installed, not the protected seed (`cd ~/dev/flightdeck && wt switch --create local-run`, see the worktrunk-worktrees skill):

```bash
cd ~/work/flightdeck/local-run/apps/flightdeck
STATE=$(mktemp -d)
pnpm exec wrangler d1 migrations apply flightdeck --local --persist-to "$STATE"
pnpm exec wrangler dev --port 8798 --persist-to "$STATE" --var FLIGHTDECK_DEV:1
```

Register the appId your local config binds (the dev-only route; production uses `create-flightdeck apps add`):

```bash
curl -sf -X POST http://localhost:8798/__dev/apps -H 'Content-Type: application/json' \
  -d '{"id":"app_myapp_staging","name":"My app (local)"}'
```

Terminal 2, the app: its normal dev command (`pnpm dev`, `wrangler dev`, `vite dev` with the Cloudflare plugin). Exercise the instrumented flows: load pages, click tagged controls, trigger the domain events.

Check the live counters for the current UTC hour:

```bash
curl -s "http://localhost:8798/__dev/apps/app_myapp_staging/hours/$(date -u +%Y-%m-%dT%H)"
```

`counters` must list each page path and event name you exercised. Events arrive after the ingest commit, so poll for a few seconds. Browser events flush every 5 s, on tab hide, or every 20 events.

A quick server-path probe without a browser (same body the SDK sends):

```bash
TS=$(($(date +%s) * 1000))
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:<app-port>/_fd/e \
  -H 'Origin: http://localhost:<app-port>' -H 'Content-Type: text/plain' \
  -H 'User-Agent: Mozilla/5.0 (Macintosh) Chrome/141.0 Safari/537.36' \
  --data-binary "{\"events\":[{\"kind\":\"track\",\"name\":\"probe.sent\",\"ts\":$TS}]}"
```

Expect `204`. A curl/bot User-Agent is accepted but counted as a bot and dropped, hence the browser UA.

## 3. Fail-open check (required)

Stop Flightdeck (terminal 1) and repeat the flows. Every app response must be unchanged. `POST /_fd/e` may return 502; nothing else may fail. Also run the app's tests with no `FLIGHTDECK` binding available. Record the result in the PR.

## 4. After deploy

Deploy through the repo's normal pipeline, staging first. Then confirm the first event under the staging appId (and later the production appId):

- **Live view**: open the Flightdeck dashboard, pick the app, watch events arrive while you click through the staging site.
- **Until the dashboard exists**: production Flightdeck runs with dev routes off, so query the lake. The warehouse name comes from `wrangler r2 bucket catalog get <flightdeck-lake-bucket>`; tables fill after the Pipelines roll interval (minutes):

```bash
pnpm exec wrangler basin sql query "$WAREHOUSE" \
  "SELECT name, count(*), min(received_at) FROM flightdeck.events WHERE app_id = 'app_myapp_staging' GROUP BY name ORDER BY 2 DESC"
```

`min(received_at)` (epoch ms) is the first-event timestamp for the status table. If nothing arrives: check the deployed Worker has the binding (`wrangler deployments`/dashboard bindings), the appId is registered, the browser's `/_fd/e` request returns 204 (DevTools network tab), and the Flightdeck Worker logs for `unknown app` errors.

Pilot apps also re-run the fail-open check against the deployed staging app while Flightdeck returns errors, if the coordinator schedules a Flightdeck outage drill.
