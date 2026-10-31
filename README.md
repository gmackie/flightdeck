# Flightdeck

Open-source, self-hosted product analytics and behavioral intelligence for Cloudflare.

## Layout

Design and implementation plans live in [`docs/plans/`](docs/plans/).

- `apps/` — deployable Cloudflare Workers (planned)
- `packages/` — the SDKs and CLI published to npm: [`@flightdeckhq/worker`](packages/worker), [`@flightdeckhq/browser`](packages/browser), [`@flightdeckhq/schema`](packages/schema) and [`@flightdeckhq/create`](packages/create-flightdeck); releasing: [`docs/operations/releasing.md`](docs/operations/releasing.md)
- [`@flightdeckhq/lifecycle-insights`](packages/lifecycle-insights) — standalone aggregate-only lifecycle alert evaluation and descriptive variant comparisons; integration is not implemented
- `examples/` — example integrations (planned)
- `skills/` — agent skills for instrumenting Worker apps with Flightdeck (backend, frontend, fleet rollout); see [`skills/README.md`](skills/README.md)

## License

MIT; see [`LICENSE`](LICENSE).
