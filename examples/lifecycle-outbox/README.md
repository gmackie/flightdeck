# Lifecycle outbox example

A deploy tracker that reports each deploy's lifecycle (`case.created`, `stage.exited`,
`stage.entered`, `case.completed`) to Flightdeck through a transactional outbox in D1.
See [docs/operations/lifecycle-ingestion.md](../../docs/operations/lifecycle-ingestion.md).

```bash
pnpm --filter @flightdeckhq/lifecycle-outbox-example dev
curl -X POST localhost:8787/deploys/web-1234/build
curl -X POST localhost:8787/deploys/web-1234/canary
curl "localhost:8787/__scheduled?cron=*+*+*+*+*"   # drain now
```

Flightdeck must be running with the `LIFECYCLE_EVENTS` binding and must have granted
`app_deploys` `lifecycle.write`; until then the drain keeps rows pending and retries.

`pnpm test` at the repo root runs [`test/outbox.test.ts`](test/outbox.test.ts) against a local D1
and a stand-in `FLIGHTDECK` binding that applies the real `@flightdeckhq/schema` contract and
the registered process definition: transactional enqueue, ordering, retries, quarantine,
clock skew, batch size and concurrent transitions.
