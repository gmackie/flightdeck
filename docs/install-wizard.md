# Flightdeck universal Cloudflare installation wizard

For a **local browser step-by-step setup** with account picker, resource review, permissions and progress, run pnpm install:web and open http://127.0.0.1:43217. It requires scoped tokens in environment variables for unattended provisioning. See [web installer](web-installer.md).

The CLI alternative below uses the same provider engine and can delegate interactive Cloudflare authentication/Basin steps to the provider's own CLI.

**Install into your own Cloudflare account, including the admin UI and optional MCP.** No hosted Flightdeck service or public collection endpoint is required.

## Prerequisites

- Node.js 22.18+, pnpm 10+, Cloudflare Workers Paid and R2 enabled.
- Cloudflare CLI (\`npm install --global cf\`) and Wrangler installed with the repository.
- Sign in to both CLIs once: \`cf auth login\` and \`pnpm exec wrangler login\`. For unattended installs use a scoped \`CLOUDFLARE_API_TOKEN\` environment variable and \`CLOUDFLARE_ACCOUNT_ID\`.
- A Cloudflare R2 Catalog API token with R2 Admin read/write and Basin SQL permissions, from the R2 dashboard. Keep it secret. Set \`FLIGHTDECK_CATALOG_TOKEN\` in your shell for the fully automated mode; the wizard stores it only as a Console Worker secret.
- Zero Trust Access enabled for your account, or permission to initialize it. The wizard creates a One-time PIN IdP only if the account has no existing IdP.

A Cloudflare account without Workers Paid/R2 entitlement **cannot** install the Basin-backed variant. The wizard stops with an actionable error; it does not silently switch to less durable storage.

## Quick install

\`\`\`bash
git clone https://github.com/gmackie/flightdeck.git
cd flightdeck
pnpm install

# Interactive account selection, admin emails, mode, then explicit approval
pnpm install:cloudflare
\`\`\`

The wizard preserves the account's existing workers.dev subdomain, or creates a new account-level subdomain if none exists. This setting affects the entire Cloudflare account and will never be renamed by an upgrade. Workers.dev is suitable for staging; for business-critical production use, configure a custom domain and its Access policy after installation.

The wizard creates namespaced resources such as \`flightdeck-default-core\`, \`flightdeck-default-console\`, \`flightdeck-default-meta\` and a Basin Catalog/Iceberg event dataset. It uses \`workers.dev\` as its initial console hostname, so **an existing custom domain or zone is not required**.

For a fully unattended install with API credentials:

\`\`\`bash
export CLOUDFLARE_API_TOKEN="YOUR_SCOPED_API_TOKEN"
export FLIGHTDECK_CATALOG_TOKEN="YOUR_R2_CATALOG_TOKEN"

pnpm install:cloudflare -- \\
  --account-id YOUR_ACCOUNT_ID \\
  --slug myteam \\
  --admin-emails owner@example.com \\
  --mode intelligence \\
  --apply --yes
\`\`\`

The installed Console is protected by Cloudflare Access. The wizard deploys the Console and optional MCP Worker **locked** before creating Access, sets up a narrowly named admin Access policy and a shared Access application, then redeploys with the correct audience. Both hosts share the same Access AUD so MCP-to-console service binding requests can be revalidated. The Console Worker uses \`assets.run_worker_first=true\` so even \`index.html\` and JS assets require an authenticated request.

## Basin setup modes

**Full unattended mode** (two environment tokens): The wizard calls the Cloudflare API to create an R2 bucket and D1, enables Basin Catalog, creates a structured stream (Worker binding enabled, HTTP endpoint disabled), creates a Catalog sink, then creates the SQL pipeline. The Catalog token is submitted in the API request body, not exposed on the command line or committed.

**OAuth/interactive mode** (no \`CLOUDFLARE_API_TOKEN\`): The wizard uses the authenticated CLIs for account discovery and resources and launches Cloudflare's native \`wrangler basin pipelines setup\` for the one token-sensitive pipeline step. Use \`basin/events.schema.json\`, HTTP ingestion **disabled**, the R2 bucket/namespace/table printed by the wizard, and a simple SQL pipeline. Then paste the **stream ID**. To unlock the Console, set \`FLIGHTDECK_CATALOG_TOKEN\` and rerun. This is the same complete installation but preserves token entry through Cloudflare's own prompt.

No Basin schema migration occurs automatically on existing streams; a schema version change requires explicit operator action.

## Installed components

| Mode | Resources |
| --- | --- |
| Standard | Private Core Worker, Access-protected React Console, D1 metadata, Basin stream/sink/pipeline and R2 Catalog, D1-backed source registry |
| Intelligence | Standard + Queues/DLQ, SQLite Journey Durable Object Worker, opt-in Workers AI |
| Optional MCP | Read-only/administrator tool server on a separate Access-protected Worker, sharing the Console's Access application/AUD |

Workers and Durable Objects of **other apps** perform their own user auth and send approved analytics directly through the Flightdeck service binding. The wizard prints the name and source token location.

## Safety and recovery

- \`pnpm install:cloudflare -- --dry-run --account-id ... --admin-emails ...\` prints a plan without any account API calls or file writes.
- All resource names are derived from a unique deployment suffix. Existing named resources are **never adopted** without matching the local installation manifest.
- Resumable steps are saved in \`.flightdeck/install.json\`. It contains identifiers and state only. One-time credentials are in \`.flightdeck/credentials.json\` (0600, gitignored).
- Run the wizard again for an interrupted installation; use the **same** account and suffix. The wizard refuses to take over another account's installation.
- Backup D1 metadata before schema upgrades; never assume that D1 backup contains R2/Iceberg event data.
- After deployment the wizard sends unauthenticated probes to both \`/api/config\` and \`/index.html\` and **fails** if either returns HTTP 200.
- Full installation requires a real-account validation pass; unit tests and Wrangler dry-runs cannot prove provider-side entitlements, Access configuration or Basin delivery consistency.

Cloudflare account permissions needed: Workers scripts/routes, D1, R2, Basin Pipelines, Zero Trust organization/Access applications and policies, and Queues/DOs if Intelligence mode is selected. Limit API tokens to the target account and install only into an account you control.

## Admin UI and MCP

After install, open the Console with the configured admin email. Admin screens provide source registration and rotation, project policies, query/AI budgets, integrations, access diagnostics, audit history and approvals. MCP exposes read-only analytics and a dedicated admin tool set. Administrative changes proposed through MCP require explicit review and confirmation in the Admin UI; MCP does not deploy Workers, run shell, change Flagship flags or expose source tokens.

See \`docs/admin.md\` and \`docs/admin-mcp.md\`.
