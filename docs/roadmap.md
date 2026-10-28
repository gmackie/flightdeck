# Roadmap

## P0
- [x] Initial README and architecture RFC
- [x] Developer instructions and self-hosted deployment specification
- [ ] Verify Effect package versions; install, typecheck, test
- [ ] Select open-source license

## P1
- [ ] Collector and private RPC with authenticated source resolution
- [ ] Durable Basin stream, idempotency and correct receipts
- [ ] Browser + Effect SDK, RUM instrumentation
- [ ] D1 metadata/auth, queries and analytics console
- [ ] Account-owned CLI installer, Cloudflare Access and fresh-install tests

## P2+
- [ ] Funnels, retention, object-centric journey mining and live DO runtime
- [ ] Product knowledge graph, Workers AI discovery and experiments
- [ ] Agent investigations and approval-gated optimization

## Self-hosted release hardening (stack PR #6)
- [x] Guided D1/Core/Console configuration and explicit opt-in deploy plan
- [x] Metadata backup/restore into a new database, read-only remote checks
- [x] CI dry-runs and in-memory browser-to-RPC integration tests
- [ ] Fresh-account Basin/Iceberg/R2 end-to-end deployment verification
- [ ] Automated physical deletion, disaster-recovery tests, package release signing
- [ ] Actual quota/cost benchmarking and high-volume materialized aggregates
