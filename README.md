# Flightdeck

Open-source, self-hosted product analytics and behavioral intelligence for Cloudflare.

## Layout

Design and implementation plans live in [`docs/plans/`](docs/plans/). RFCs live in [`docs/rfcs/`](docs/rfcs/); the lifecycle intelligence RFC (draft) is [`docs/rfcs/lifecycle-intelligence/`](docs/rfcs/lifecycle-intelligence/README.md).

- `apps/` — deployable Cloudflare Workers (planned)
- `packages/` — the SDKs and CLI published to npm: [`@flightdeckhq/worker`](packages/worker), [`@flightdeckhq/browser`](packages/browser), [`@flightdeckhq/schema`](packages/schema) and [`@flightdeckhq/create`](packages/create-flightdeck); releasing: [`docs/operations/releasing.md`](docs/operations/releasing.md)
- [`packages/lifecycle`](packages/lifecycle) — standalone object-centric lifecycle replay and process metrics (`@flightdeckhq/lifecycle`), with no schema or ingestion dependency
- [`@flightdeckhq/lifecycle-insights`](packages/lifecycle-insights) — standalone aggregate-only lifecycle alert evaluation and descriptive variant comparisons; integration is not implemented
- `examples/` — example integrations (planned)
- `skills/` — agent skills for instrumenting Worker apps with Flightdeck (backend, frontend, fleet rollout); see [`skills/README.md`](skills/README.md)

## License

MIT; see [`LICENSE`](LICENSE).
