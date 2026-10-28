# Flightdeck's optional read-only MCP server

This optional Worker exposes Flightdeck's existing **bounded, project-scoped** analytics and investigation endpoints as tools for coding agents. It does not alter the Flagship dashboard, commit code, run shell commands, approve investigations or deploy anything.

The implementation uses Cloudflare's **2026 stateless MCP v2** path (`createMcpHandler` and `@modelcontextprotocol/server`). The deprecated `McpAgent` session transport is not used. The endpoint uses Streamable HTTP at `/mcp`; legacy standalone SSE is not supported.

## Deployment prerequisites

- Deploy the Flightdeck Console in your own Cloudflare account, with Cloudflare Access enabled and independently verified.
- Deploy the MCP Worker with a private `CONSOLE` service binding, `workers_dev:false`, preview URLs disabled.
- Set the MCP Worker's `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` to the proper Access-protected application. Put a distinct Access application on the MCP hostname if its audience differs.
- Add a **custom hostname** and Cloudflare Access policy for the MCP Worker only after checking authorization. No default public route is provided.
- MCP clients must be configured to send a valid signed `Cf-Access-Jwt-Assertion` header; this proof is independently verified in the MCP Worker and in the Console Worker.

For clients unable to present Cloudflare Access JWT headers, implement and review an OAuth 2.1 resource server/protected-resource metadata integration using Workers OAuth Provider. Do not bypass Access, add demo auth, or expose a bearer-secret route in its place.

## Read-only tools

`flightdeck_overview`, `flightdeck_top_events`, `flightdeck_retention`, `flightdeck_experience`, `flightdeck_journey_transitions`, `flightdeck_graph`, `flightdeck_investigations`, `flightdeck_investigation`, `flightdeck_query_budget`, and `flightdeck_saved_insights`.

The server proxies only specific GET paths to the trusted Console service binding, forwarding the signed Access assertion. The Console rechecks authentication, project scope and query-budget limits. Results are bounded at 15,000 characters. No raw event-property exploration tool is provided by default, reducing accidental disclosure of user content.

## Agent workflow

Agents can read Flightdeck measurements and evidence, then draft reviewable tickets or pull requests using their **separately authorized GitHub tooling**. Human review and existing CI gates remain mandatory. Approved findings do not authorize arbitrary source-code modification or production deployment.

**Not yet validated:** actual Access JWT forwarding across the connected Cloudflare account, MCP client authentication UX, and end-to-end remote MCP protocol interoperability. The separate workspace must verify these before enabling a hostname.
