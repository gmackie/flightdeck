# ADR: lifecycle MCP Managed OAuth preflight (FLIG-37)

Status: accepted for local preflight only; activation blocked on staging evidence.
Base: PR #49, `63d45b609ae8fc06dadc014e2fcf44a7efb176c4`.

The MCP origin already verifies an Access assertion and sends that unchanged assertion
through the private named `LifecycleReadEntrypoint`. The backend verifies it again
against the MCP AUD and checks live D1 per-app grants on every read. Preserve this
boundary; OAuth scopes, client identities and resource selectors cannot mint D1 roles.

| Choice | Trust and integration | Decision |
| --- | --- | --- |
| Access Managed OAuth | Access owns discovery, registration, browser login, token lifecycle and edge 401. Its opaque OAuth token is resolved at the edge into the existing signed `Cf-Access-Jwt-Assertion`. Access policy remains authoritative for admission. | Choose **preflight only**: smallest documented identity bridge and no new issuer, credential store or token conversion code. |
| Workers OAuth Provider v1 split workers | `OAuthAuthorizationServer` owns login/consent/PKCE/token issuance; `OAuthResourceServer` validates through a private service binding. Supports MCP 2026-07-28 and RFC9728. Would need an independently verified user/grant mapping at the private backend, scope step-up and revocation design. | Defer. Do not forward its token as an Access assertion, fake an Access JWT, or share dashboard AUD. |

The official Managed OAuth docs explicitly say opaque tokens are resolved to signed
origin assertions and that enabling the feature **replaces 401/WWW-Authenticate
behavior**. Therefore the origin will not serve independent OAuth metadata or a new
OAuth challenge. The standalone, offline harness inspects edge discovery captures and
client plans; it serves no HTTP routes, registers no clients and accepts no tokens.
Exact `/mcp` resource and path metadata, S256, least-privilege scopes and explicit
client/user consent are strict preflight requirements, not asserted Access features.
If Access cannot meet them, activation stays blocked; revisit this ADR for a separate
split-provider implementation instead of combining the two authorization paths.

`lifecycle:read` maps to reader-or-higher D1 access; `process:read` requires analyst-or-
higher and explicit step-up. Service identities remain reader-capped. Access's docs do
not establish propagation of client consented scopes to the origin assertion. Until
that is validated, we cannot enforce a delegated subset of a person's D1 permissions.
A signed `scope`, `roles`, `resource` or client-supplied header must never widen a grant.
This preflight does not claim to implement origin OAuth scope attenuation or OAuth replay
protection: bearer replay is possible until expiry/revocation, and D1 grant revocation
is independently enforced. Production remains hard-disabled and default config serves
nothing. No deployment, merge, account changes or company data are authorized.

Sources fetched 2026-11-01 (official Cloudflare documentation):

- [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/), updated 2026-07-01: non-browser RFC8707 clients, policy identity bridge, opaque tokens, replaced 401 behavior, dashboard settings.
- [MCP Authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/), updated 2026-10-27: v1 split authorization/resource workers, private `validateToken(resource, token)` binding, consent owned by authorization app, scope step-up and resource metadata.

See [operator contract and staging gates](../operations/lifecycle-mcp-oauth-preflight.md).
