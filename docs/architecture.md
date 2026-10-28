# Flightdeck architecture RFC

Flightdeck is a self-hosted Cloudflare analytics and behavioral intelligence platform.

## Planes

- **Collector:** Browser HTTP batch endpoint with source verification, consent/redaction, CORS and rate limiting. Untrusted browser data never supplies authoritative project identity.
- **Core:** Private Effect-based Worker service-bound RPC, validated event schemas, enrichment, idempotency and durable acknowledgment.
- **Historical:** Basin Pipelines to R2/Iceberg, separately partitioned events and RUM data; D1 metadata and access policies.
- **Query:** Tenant-scoped query DSL compiled to bounded SQL; dashboards, cohorts, funnels, retention, object-centric journeys.
- **Live:** Queues and SQLite Durable Objects for approved journey state machines; reconcile against canonical history.
- **Intelligence:** Process mining, Workers AI semantic proposals and schema-validated journey compiler; evidence and provenance mandatory.
- **Optimization:** Investigations, experiments and approval-gated agents proposing changes through PRs.

## Correctness

Basin acceptance does not guarantee immediate query visibility. Independent Queue and Basin writes are not atomic; use deduplication and reconciliation, not exactly-once claims. Never expose the control plane without verified authentication. Production collector must fail closed without configured source authorization and privacy policies.

## Integrations

Shared Effect SDK sends private analytics RPC from Workers/DOs; browser SDK posts to the public collector. Flagship stays managed in Cloudflare dashboard; Flightdeck only analyzes variant exposures and outcomes.

## Release gates

Fresh-account installer, database migrations, access-control E2E, event privacy/deletion, durable sink, replay, backup/restore, cost quotas and verified runtime tests.
