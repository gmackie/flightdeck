# Flightdeck for existing Workers and Durable Objects

**There is no mandatory public Flightdeck collector.** Each consuming Worker/DO already owns authentication to its app and can expose whatever first-party frontend telemetry endpoint it chooses. It then calls Analytics Core over a Cloudflare service binding, not an external HTTP URL.

## Deploy Analytics Core

```sh
pnpm install
pnpm setup -- --mode basin --stream-id YOUR_BASIN_STREAM_ID
pnpm doctor
```

`setup` provisions/deploys a private Core Worker and attaches the durable stream. It writes `.flightdeck/deploy.json`, `.flightdeck/sources.json`, and `.flightdeck/source-tokens.json` locally (gitignored). The source registry contains token hashes; tokens themselves are stored server-side as Worker secrets.

For an unprovisioned account, follow [Basin setup](basin.md) to create a Catalog and structured Pipeline stream. There is also an R2-only mode for small-scale fallback.

## Consumer Worker configuration

```json
{ "services": [{ "binding": "FLIGHTDECK", "service": "flightdeck-core" }] }
```

Set `FLIGHTDECK_SOURCE_ID` and `FLIGHTDECK_SOURCE_TOKEN` as server-side Worker secrets; do **not** put them in frontend bundles. Each consuming Worker/DO can use `@flightdeck/sdk-worker`.

```ts
const analytics = createFlightdeck({
  binding: env.FLIGHTDECK,
  sourceId: env.FLIGHTDECK_SOURCE_ID,
  sourceToken: env.FLIGHTDECK_SOURCE_TOKEN,
}).withContext({ actorId: user.id });

await analytics.track("project.created", { template: "blank" }, {
  objects: [{ type:"project", id:project.id, role:"target" }]
});
```

Use `effectFlightdeck(analytics).track(...)` from Effect programs; never turn critical transaction logging into a best-effort side effect unless explicitly allowed.

## Browser to own Worker

The browser SDK `@flightdeck/browser` defaults to `/api/analytics` on **your own origin**. The application Worker authenticates the request and can use `createBrowserEventHandler` from `@flightdeck/sdk-worker/handler`. That helper enforces allowed origins, exact event names/properties, payload-size limits, and replaces browser actor identity with the application's authenticated subject. You must additionally provide your application's rate limiter and consent/privacy controls.

The browser SDK does not transmit events without explicit `consent:()=>true`. Optional Web Vitals use `web-vitals` and collect no form bodies.

## Source policies

`SOURCE_CREDENTIALS` is a private Core secret mapping source ID to {sha256, projectId, allowedEvents, allowedProperties}. `pnpm source:add -- APP SOURCE_PROJECT` adds a source locally; republish its registry with Wrangler secret put. Unknown sources, unregistered events and properties are rejected. Inbound project IDs from browser payloads are ignored.

No distributed exactly-once guarantee. Basin stream acceptance means ingestion, not immediate SQL visibility. Repeated event IDs should be deduplicated in downstream projections; event registry retention and privacy deletion remain required work.
