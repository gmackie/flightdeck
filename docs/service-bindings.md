# Worker and Durable Object integration

Flightdeck does **not** require a public collector. Your application Worker/DO authenticates its own browser requests, validates and redacts submitted events, and calls a private Flightdeck Worker over a service binding.

## Setup

1. Provision R2 bucket `flightdeck-events` in your Cloudflare account.
2. Deploy `apps/core` with its R2 binding and a `SOURCE_CREDENTIALS` secret mapping source IDs to per-source random tokens and project IDs.
3. In each consuming Worker, add `{ "binding": "FLIGHTDECK", "service": "flightdeck-core", "entrypoint": "default" }` to `services`.
4. Add server-side `FLIGHTDECK_SOURCE_ID` and `FLIGHTDECK_SOURCE_TOKEN` secrets to the consuming Worker; never expose the token to a browser.
5. Instantiate `createFlightdeck({ binding: env.FLIGHTDECK, sourceId: ..., sourceToken: ... })`. Call `track`, `batch`, `identify` or `expose`. Durable Objects use the same service binding through their `env`.
6. Expose your own authenticated `/api/telemetry` endpoint only if the frontend needs it. Explicitly allowlist event names/properties and derive actor IDs from your session. See `examples/worker-collector.ts`.

## Delivery and security

The initial core stores one JSON record per event in R2 and acknowledges only completed writes. This is a **bootstrap durable sink**, not Basin/Iceberg or a queryable analytics warehouse. Partial R2 writes followed by a failure can be retried with stable event IDs. There is no transactional multi-event commit or guaranteed immutable event ID uniqueness. Source credentials are required even over private RPC to isolate projects and limit confused-deputy risks.

Important: a Cloudflare service binding is a trusted internal call path, **not** automatic per-caller authorization. Source credentials are therefore enforced inside core. The caller must validate its own users; Flightdeck does not trust actor IDs originating from unauthenticated browsers.

## Next production steps

Add credential rotation, source registry in D1, consent/redaction policies, event schema limits, R2-to-Basin pipeline or native Basin ingestion, query engine, deletion/retention, and integration tests. Benchmark per-event R2 writes before high-volume production use.
