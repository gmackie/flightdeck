# Flightdeck Administrator UI

The guided Cloudflare installer deploys a React Console with an Administration workspace. Feature flags and rollouts are still owned by Flagship in the Cloudflare dashboard.

## Access and identity

All Console requests and static assets pass through the Access-JWT-verifying Worker (assets.run_worker_first=true). Administrator privileges require a signed Cloudflare Access JWT and an exact email match against the installed ADMIN_EMAILS allowlist. Project IDs come from Worker configuration, not browser input.

## Health

Admin → Health displays Core RPC state, D1 metadata, Basin binding, registry mode, registered/enabled sources, pending changes, and configured project.

## Event sources

Admin → Sources creates Worker/DO identities with versioned, validated event/property policies. A random 32-byte source token is displayed once and only its SHA-256 digest is stored in D1. Source tokens belong exclusively in consuming Worker secrets, not frontend JavaScript or MCP requests.

A consuming app binds to the private Flightdeck Core Worker. Its authentication remains application-owned. Sources support explicit event names, allowed properties, kinds, environments, consent requirements, graph registration, and batch limits.

Rotate a token by generating a replacement, updating consuming Workers, and promoting the replacement. Until promotion both hashes are valid. Lost pending credentials can be cancelled and reissued. Source enable/disable and policy edits require a version check and audit entry.

## Budgets

Configure monthly relative query-unit admission and daily AI investigation request caps. These budgets are not Cloudflare billing caps; monitor Cloudflare account usage separately.

## Approvals and admin MCP

Admin → Approvals lists human/MCP proposals. Only validated operations can be requested: source enable/disable, source policy changes, and query/AI budget changes.

An MCP agent cannot apply changes. An independently authenticated administrator must explicitly approve in the UI and give a written rationale. Failed application is not retried automatically, and requires manual reconciliation.

## Audit

The Audit view shows project-scoped administrative actions, actors, timestamps and resources. Do not record plaintext source tokens, API credentials, signed Access JWTs or private events in the audit metadata.

## API

Admin routes are under /api/admin:

- GET /overview
- GET and POST /sources
- GET and PATCH /sources/:id
- POST /sources/:id/rotate
- POST /sources/:id/promote
- POST /sources/:id/cancel-rotation
- GET and PUT /budgets
- GET and POST /requests
- POST /requests/:id/decision
- GET /audit

Mutations require same-origin requests, Access administrator authorization, validated payloads, and appropriate version/approval checks.

## Release limitations

Full data deletion across Basin/Iceberg, DOs, caches and AI-derived materializations, provider-integrated Access testing, and distributed source traffic quotas remain production release gates. A structurally validated event is not guaranteed to be free of personal data if the app submits sensitive values under innocuous names.
