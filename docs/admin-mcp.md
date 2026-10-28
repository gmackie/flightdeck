# Flightdeck administration — UI + agent MCP

Flightdeck's separate account-owned console includes **Admin & Setup** at `/#admin`. This UI provides an installation checklist, a local setup walkthrough and dynamic source management. It never accepts Cloudflare API tokens from the browser.

## Admin API

See [admin-operations](admin-operations.md). The API is protected by Cloudflare Access JWT validation *and* an explicit `ADMIN_EMAILS` allowlist. Dynamic sources are persisted as SHA-256 hashes in the account's own D1 database and consumed by the private Core Worker. Creation and rotation return a **one-time** token for installation into consuming Workers/DOs. The UI will not re-display it after dismissal.

The Console and Core must both have `META` bound to the same D1 database, with migration `0007_admin_sources.sql` applied. If no D1 is available, admin operations fail closed.

## Admin MCP

The optional separate MCP Worker exposes two admin read-only tools only to Access-authenticated administrators:

- `flightdeck_admin_status`: checks installation configuration and D1 metadata readiness.
- `flightdeck_admin_sources`: returns source IDs, allowed event policies, and enabled status, never secrets.

An optional `flightdeck_admin_disable_source` write tool can be enabled by setting `ENABLE_ADMIN_MCP_WRITES=true` on the MCP Worker. It requires a project-authorized admin JWT, `confirm: "APPLY_DISABLE"`, and passes through the same console admin API with server-side audit. It cannot generate or reveal credentials, run arbitrary Wrangler commands, or delete resources.

For additional operations (creating tokens, rotating keys, changing Cloudflare account resources), use the human-operated admin UI and locally authenticated installation wizard. Tool availability is not a substitute for an independent operator approval policy.

## Installation wizard

Run `pnpm wizard` from a checked-out Flightdeck repository. It uses the operator's local Wrangler authentication, asks for account ID, existing or new D1, Basin stream, Access team domain/AUD and console hostname, and delegates to `pnpm workspace:deploy` only after explicit `DEPLOY` confirmation. Its default dry-run never writes files or calls Cloudflare.

**Cloudflare Access must exist first** (created in Cloudflare Zero Trust or by a separately reviewed account-scoped automation). The installer cannot create an Access application without an authenticated Cloudflare account and sufficient scopes. Basin Pipelines setup uses Cloudflare's official interactive Wrangler wizard; this is a verified supported route rather than a fabricated API.

The wizard is resumable via a gitignored non-secret `.flightdeck/wizard.json` manifest. It does not provide a fully browser-hosted OAuth installer yet; that needs an independent OAuth client, PKCE, scoped access tokens and secure workflow state.

## Optional Access provisioning

`pnpm access:provision` uses the separate `cf` CLI (requires `cf auth login`) to create or reuse a named Cloudflare Access allow policy and self-hosted application. It does **not** create public bypass rules or a wildcard allow policy.

```bash
pnpm access:provision -- \
  --account-id CLOUDFLARE_ACCOUNT_ID \
  --host analytics.example.com \
  --email admin@example.com \
  --dry-run

pnpm access:provision -- \
  --account-id CLOUDFLARE_ACCOUNT_ID \
  --host analytics.example.com \
  --email admin@example.com \
  --apply
```

If the account has no Zero Trust organization, `--bootstrap-zero-trust` explicitly authorizes creating one and adding a one-time PIN identity provider when no provider exists. On an existing organization with no IdP, it refuses to silently change identity configuration.

The main `pnpm wizard` can offer this path interactively when an Access team domain/AUD is missing, or use `--auto-access` when parameters are otherwise provided. All operations run locally with account-scoped Cloudflare permissions.
