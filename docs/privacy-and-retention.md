# Privacy, consent, retention and deletion design

**Status:** baseline ingestion policy is implemented; lifecycle enforcement across Basin Iceberg is still subject to verified account integration.

## Invariants
- Every application authenticates its users; Flightdeck authenticates its source Workers and binds them to projects.
- Browser IDs, actor IDs, and consent flags submitted by an untrusted browser are **not authoritative**.
- Browser SDK does not send unless the caller explicitly grants consent.
- If a project/source requires consent, the application Worker must read its own trusted consent record and assert `consentGranted` in the private RPC context.
- No raw form inputs, cookies, tokens, auth headers, full URLs or query strings should enter the event lake.
- Event and property names must be explicitly allowlisted per source, with nested sensitive-key rejection and bounded payload shape.
- Query and export flows must never join datasets across projects unless an authorized service deliberately requests such a scope.
- Avoid using PII in IDs; prefer purpose-scoped pseudonymous identifiers where feasible.

## Recommended retention policies
Store data-class metadata in D1: purpose, lawful basis, capture consent requirements, country/region, and retention expiration policy. Treat these as design requirements, **not implemented compliance guarantees**.
Suggested configurable ranges (to be confirmed by each deploying organization): RUM resource details 7–30 days, raw interactions 30–90 days, aggregates 12–24 months. Defaults should be conservative.

## Right-to-delete execution plan
A deletion request references the requesting actor and its verified subject IDs. The execution workflow must:
1. Authenticate/authorize the requesting principal and establish linked pseudonymous identifiers.
2. Stop collection from affected subjects where required.
3. Query canonical R2/Iceberg tables for affected records, including object links and derivative materializations.
4. Apply supported Iceberg row deletion/rewrite operations, then ensure physical deletion via retention and compaction semantics.
5. Invalidate materialized views, query caches, DO state and AI-derived personal data.
6. Verify absence or document permitted exceptions and produce an audit receipt without leaking deleted content.

**Important:** Do not advertise completed deletion merely because a D1 tombstone exists; Basin/Iceberg physical erasure and derived-data cleanup must be proved. Until verified, deployments with regulated deletion requirements must not ingest identifiable data.

## Threat model
See [source governance](source-governance.md). Additional work remains: distributed request quotas, provenance of consent flags, column-level PII redaction for permitted-but-sensitive values, D1 source registry administration, and replay protection for long-lived credentials.
