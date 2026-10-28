# Flightdeck self-hosted installation — guided beta

Flightdeck runs in your Cloudflare account. This process requires a Workers Paid account, Wrangler, pnpm, Basin Catalog and a configured Cloudflare Access application. **No live account setup has been verified end-to-end yet.**

## Phase 1: Create a Basin stream

From the repository root:

```sh
pnpm install
pnpm exec wrangler login
pnpm exec wrangler basin pipelines setup
```

Follow the interactive wizard with `basin/events.schema.json`, select an R2 Catalog/Iceberg sink and table `default.flightdeck_events`, and retain the stream ID. Do not enable public unauthenticated ingestion—the existing first-party Workers are your collectors. See [Basin guide](basin.md).

## Phase 2: Deploy the private Analytics Core

```sh
pnpm setup -- --mode basin --stream-id YOUR_STREAM_ID --yes
pnpm doctor
```

The script generates a non-public Worker and a source registry. It does not grant user access. Store the printed token **only** as a Worker secret in each consuming application and configure a service binding to the private core. Never expose the token in JavaScript delivered to browsers.

The default source policy is restrictive: only specified events and property keys are allowed. Create additional sources with `pnpm source:add -- SOURCE_ID PROJECT_ID` and update the core's secret registry.

## Phase 3: Deploy the Access-protected console

First create an Access self-hosted application for the desired hostname. Obtain the team domain and application AUD. Then:

```sh
pnpm setup:console -- --host analytics.example.com --access-domain team.cloudflareaccess.com --access-aud YOUR_AUD --account-id YOUR_ACCOUNT_ID --bucket flightdeck-events --project-id default --yes
pnpm exec wrangler secret put BASIN_SQL_TOKEN --config apps/console/wrangler.generated.jsonc
```

The console independently verifies Access JWTs on every HTML/API request. A missing or invalid Access configuration fails closed. The SQL token needs Basin SQL/Catalog/R2 permissions and is never embedded in a frontend bundle.

Confirm that the anonymous HTML request is denied, your authenticated browser can open the console, and recent event queries return the expected records. Do not infer success merely because Wrangler deploys.

## Phase 4: Integrate an existing app

Add the service binding to your application's Wrangler config:

```json
{ "services":[{"binding":"FLIGHTDECK","service":"flightdeck-core"}] }
```

Add `FLIGHTDECK_SOURCE_ID` and `FLIGHTDECK_SOURCE_TOKEN` secrets to your application Worker and use `@flightdeck/sdk-worker`, as described in [service bindings](service-bindings.md). Existing Durable Objects can use the same binding through their `env`.

For browser events, `@flightdeck/browser` sends JSON to **your own authenticated Worker route**, and `createBrowserEventHandler` checks origin and explicitly allowlisted event types/properties.

## Optional feature deployments

- [Live journey monitors](journeys.md): D1, Queue, Durable Objects, enabled definitions.
- [AI interpretation](ai-discovery.md): opt-in Workers AI for privacy-filtered aggregate path labels.

## Safety, operating costs and limitations

- Ingestion and query counts incur Cloudflare usage charges; budget and alerting controls are currently manual.
- No source-credential rotation UI, full consent-management interface, schema evolution workflow, privacy deletion automation, or idempotent install migration is implemented yet.
- SQL may lag ingestion; Basin stream acceptance is not immediate Iceberg query visibility.
- Query and console behavior have not yet been verified against a fresh account with real Basin records.
- Keep the deployment on a test project until these are validated.
