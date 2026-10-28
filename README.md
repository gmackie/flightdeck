# Flightdeck 🚀

Open-source, account-owned **product analytics, RUM and behavioral intelligence** on Cloudflare.

> **Status:** architecture and bootstrap scaffold only. The ingestion Worker fails closed until identity, privacy policy and durable event storage are wired up. Not ready for production traffic.

## Vision

Flightdeck collects product events and real-user experience metrics, relates them to observability and deployment data, discovers object-centric user journeys, and eventually supports evidence-grounded AI investigations and experiments.

**Flagship stays separate:** Flagship flags remain managed in the Cloudflare dashboard. Flightdeck consumes exposure events and measures outcomes.

## Why account-owned?

Inspired by [Coworkers](https://github.com/fayazara/coworkers), the intended installation provisions resources into **your Cloudflare account**, with no required hosted Flightdeck backend. We want an interactive installer, repeatable CLI upgrades, fail-closed Cloudflare Access setup, diagnostics, migration support and explicit cost controls.

## Stack

- Effect for typed services and contracts; Cloudflare service bindings for private Worker RPC.
- Public browser ingestion endpoint; validated, scoped and rate-limited before private ingestion.
- Basin → R2/Iceberg for historical analytics, D1 for project configuration.
- Queues and SQLite Durable Objects for opt-in live journey monitors.
- Workers Observability and browser RUM for performance and errors.
- Workers AI, Workflows and Containers for proposed journey discovery and investigations.

## Development

Node.js 22+, pnpm 10+. The scaffold can be inspected and typechecked without a Cloudflare account.

```bash
pnpm install
pnpm typecheck
```

Do **not** deploy the example collector expecting functioning analytics: it deliberately returns a service-unavailable response until a secure durable sink is implemented.

Read [architecture](docs/architecture.md), [deployment](docs/deployment.md), [roadmap](docs/roadmap.md) and [agent guidance](AGENTS.md).

## License

No license has been selected yet. Redistribution and reuse rights are **not** implicitly granted. Selecting an open-source license is required before announcing a public release.
