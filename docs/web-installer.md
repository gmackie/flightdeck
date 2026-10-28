# Flightdeck — local browser installation wizard

Flightdeck provides a small local web wizard that anyone can run after cloning the repo. It calls the same audited account-owned installer as the CLI, and **does not** send Cloudflare credentials to an external Flightdeck server.

## Start

Install Node.js 22+, pnpm 10+, Wrangler and dependencies. In a local terminal, configure a scoped Cloudflare account API token and an R2 Catalog/Basin SQL token as environment variables. Then run:

    pnpm install
    pnpm install:web

Open the local address printed by the server (default http://127.0.0.1:43217). The browser wizard is **only** bound to 127.0.0.1; remote access is deliberately disabled.

If you do not wish to create an API token, use the interactive CLI wizard (pnpm install:cloudflare), which can invoke Cloudflare's own authentication and Basin setup CLI.

## Four steps

1. **Account:** choose one account visible to your scoped token, choose a unique installation name, enter Access administrator email addresses.
2. **Features:** standard or full Intelligence, optional MCP, optional Workers AI, and the relative SQL admission budget.
3. **Review:** exact namespaced resources, cost and permission notice, credential preflight and explicit typed INSTALL confirmation.
4. **Deploy:** the local server spawns the account-owned CLI with a fixed argument allowlist, streams redacted progress to the browser, and shows completion/error information. The installer records completed steps for safe rerun.

The user-owned resources include D1 metadata, R2 Basin Catalog/Iceberg, Basin stream/sink/pipeline, private Core ingestion Worker, Access-protected React Console, optional Queues and Journey Durable Objects, and the optional Access-protected MCP Worker. All credentials remain in the local process or in Cloudflare Worker secrets.

## Security

- Server binds to 127.0.0.1 only, rejects unexpected Host headers and enforces an unpredictable session CSRF nonce for every API request.
- All mutating requests require a same-origin Origin and JSON content type.
- Strict CSP, no third-party JavaScript, no cross-origin calls from browser, no cookies or Cloudflare API tokens sent to the page.
- Environment credentials are never included in the plan, status JSON, HTML or deployment manifest. Installer logs redact configured token values and bearer strings.
- The installation subprocess uses spawn without a shell and fixed CLI arguments validated again by the CLI installer. No arbitrary commands are accepted from browser input.
- Only one installation is allowed per local process at a time.
- Stopping the UI during an install can leave provider resources partially created. The CLI manifest records completed steps, so rerun in the same workspace with the same account/name. Do not blindly recreate or delete resources.

## Limitations

The browser wizard requires scoped Cloudflare and R2 Catalog tokens to run unattended. Access identity-provider setup may still need Cloudflare Zero Trust account onboarding and policy agreement. A fresh Cloudflare account must have Workers Paid/R2/Basin entitlement. This local browser wizard is not a hosted one-click OAuth installer.

The code has mock-provider and localhost security tests in CI; a real fresh-account end-to-end deployment is a separate release gate. Before production, validate Basin schema, Access JWT, source registry, query console, DO replay, metrics, backups and privacy lifecycle.

On first-ever Cloudflare Workers use, the wizard checks GET /accounts/{account}/workers/subdomain and creates a unique account-level workers.dev subdomain only when missing. It never modifies an existing account subdomain. This requires Workers Scripts Write permission.

The installer performs a server-side, read-only capability check for D1/R2/Basin/Queues and workers.dev before provisioning. Required service permissions must be present on the scoped account token; entitlement and billing readiness still require operator verification.
