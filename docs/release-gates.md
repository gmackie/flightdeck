# Flightdeck release readiness and threat model

**Status: candidate source code, NOT production-release authorization.** A green CI run proves only the tested scopes (typechecking, unit/integration tests, Wrangler dry-run bundles). A live Cloudflare environment still needs independent provisioning and system tests.

## Required GA gates

### Authentication and isolation
- Anonymous attempts to access every console route/API, including Graph and Investigations, must fail.
- HTTP ingestion into Flightdeck Core has no public path.
- Every app's first-party browser endpoint authenticates and rate-limits locally.
- Unknown source token, disabled source, cross-project source, bad consent assertion, unknown event/property, sensitive keys and forged actor ID must be rejected.
- Explicit review of Access policies, custom domains, worker preview URLs and lifecycle of JWT key rotations.

### Data integrity
- Verify Basin stream binding with real structured schema and catalog sink; watch stream user errors for acknowledged-but-dropped records.
- Confirm historical SQL visibility and dedup semantics on a synthetic retry fixture.
- Confirm time-bound funnels, retention, object-centric journeys, late arrivals, and failed queue delivery/replay across Durable Objects.
- Compare query aggregate outputs to an independent baseline dataset.
- Confirm available SQL JSON extraction and percentile functions in the selected Basin SQL version.

### Privacy
- Document data controller and processors per deployment and consent requirements.
- Validate PII/secret controls on real application schemas, with nested redaction and no raw URL query/cookie/header storage.
- Implement and verify deletion, expiration, retention and backups across Basin Iceberg, D1, R2, DO history, KV, and AI-derived evidence.
- Configure AI data processing terms and opt-out policies; no student/health/regulated data before controls are evaluated.

### Cost, failure and operation
- Simulate sustained ingest and burst traffic, large data partitions and expensive query spikes; compare actual Cloudflare bill to configured relative quotas.
- Verify source credential rotation, deployment upgrade, lost secret recovery, D1 export and clean target restore.
- Verify DLQs and Queue fan-out failures do not lose canonical history.
- Restore an event lake from an independent backup strategy.
- Document on-call, alert thresholds, data delay/availability SLOs, incident response and emergency disable.

### Release process
- Each stacked PR passes checks; review and merge in parent order after approved workspace validation.
- Lockfile generated and frozen install validated, package tarballs and exports inspected.
- Tag release only when all gates above are documented, with security advisory and compatibility matrix.
- Do not publish access tokens, example credentials, tenant data or secrets in installer logs.
