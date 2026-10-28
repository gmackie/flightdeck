# Flightdeck administrator API

The separate Flightdeck console is protected by Cloudflare Access JWTs. Admin endpoints additionally require an explicit `ADMIN_EMAILS` allowlist. They fail closed without D1 metadata or migrations.

- `GET /api/admin/status`: installation checks (configuration only).
- `GET /api/admin/sources`: source records without credentials/hashes.
- `POST /api/admin/sources`: create source with an explicit policy and `confirm: "CREATE_SOURCE"`.
- `POST /api/admin/sources/:id/rotate`: generate a new one-time credential with `confirm: "APPLY_ROTATE"`.
- `POST /api/admin/sources/:id/disable`: deactivate a source with `confirm: "APPLY_DISABLE"`.
- `POST /api/admin/sources/:id/enable`: reactivate a source with `confirm: "APPLY_ENABLE"`.

For cookie-based access, mutations require the request Origin to match the console origin. Source IDs and policies are validated, audit entries are created, and plaintext tokens are returned only once. Never embed generated tokens in client SDKs or GitHub issues.

Rotation initially accepts both old and new tokens. Operators must update consumers and retire the old hash separately before treating rotation as complete. No source-provisioning API may modify Cloudflare account settings or expose project-scoped tokens to read-only MCP clients.

Dynamic sources require D1 migration `0007_admin_sources.sql` and a Core Worker binding named `META`. The Core must resolve configured source IDs through D1 before ingesting events; never treat D1 UI management as authoritative until this service integration is verified.
