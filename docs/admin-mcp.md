# Flightdeck administrator MCP

The account-owned optional MCP Worker offers read-only analytics plus an administrator capability set. It checks a signed Cloudflare Access assertion and registers admin tools only if the principal email belongs to the installation's ADMIN_EMAILS allowlist.

The MCP Worker forwards the same signed assertion over a private service binding to the Console Worker. The Console independently validates its signature, audience, issuer, admin allowlist and installation project.

## Read-only administrator tools

- flightdeck_admin_status
- flightdeck_admin_sources
- flightdeck_admin_budgets
- flightdeck_admin_audit
- flightdeck_admin_pending_changes

Source credentials are never returned. Project scope cannot be selected by an MCP caller.

## Proposal-only tools

- flightdeck_admin_propose_disable_source
- flightdeck_admin_propose_enable_source
- flightdeck_admin_propose_query_budget
- flightdeck_admin_propose_ai_budget
- flightdeck_admin_propose_source_policy

All writes are saved as a pending review request. None apply a change. Admin → Approvals in the React Console must explicitly approve or reject the operation with a rationale.

Forbidden via MCP: arbitrary SQL, shell command execution, Cloudflare provisioning, Flagship rollouts, source token retrieval, production deployment, deleting analytics history and executing AI-produced code.

## MCP connection

The guided installation can provision an Access-protected workers.dev MCP hostname. Clients must send a valid signed Cloudflare Access assertion. Third-party MCP clients lacking this integration need an OAuth 2.1 protected resource workflow, which is not enabled merely by installing Flightdeck. Do not bypass Access to accommodate a client.

## Example

An agent sees a retired Worker still registered. It proposes source.disable with its source ID and a written rationale. Flightdeck stores a pending change request. A separate administrator opens the Console, reviews the request and approves it. The D1 source registry changes and subsequent Core RPC calls from the retired source are denied.

Any failure after a change is claimed becomes a manual reconciliation task, not an autonomous retry loop.
