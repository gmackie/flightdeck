# Lifecycle MCP Managed OAuth preflight (FLIG-37)

**Non-deploying draft stacked on PR #49. No production activation.** This is a
standalone offline harness and origin security regression suite. A browser OAuth
handshake in a Cloudflare account, CloudflareOS interoperability, consented scope
propagation and revocation are **unverified**. No credentials, clients, Access
applications, routes, grants or account resources were created by this work.

Decision: [Managed OAuth preflight ADR](../adr/0001-lifecycle-mcp-managed-oauth-preflight.md).
Current official sources (fetched 2026-11-01):
[Access Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
(updated July 1) and [MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/)
(updated October 27). Managed OAuth documents RFC8707 clients, same Access policies,
opaque tokens and origin signed assertions. Workers OAuth Provider v1 documents
separate auth/resource Workers and private token validation. Only the Managed OAuth
preflight path is chosen here. There is no speculative authorization server.

## Supported contract and verification boundary

The eventual client connects to exactly `https://<isolated-staging-host>/mcp` using
MCP `2026-07-28`, with `resource` set to that exact value on authorization **and** token
requests. No root resource, trailing slash, query, alternate hostname, encoded path,
fragment or dashboard URL is accepted by the preflight. Live-source origin mode now
requires `LIFECYCLE_MCP_RESOURCE` and rejects mismatching request URLs. This is an
HTTP destination pin; it does not establish opaque token audience enforcement.

Access owns OAuth discovery and the public unauthenticated `401/WWW-Authenticate`.
Enabling Managed OAuth **replaces the application's 401 behavior**. Do not add an
`OAuthResourceServer`, a second issuer, origin OAuth challenge, or independent public
metadata route. The origin's failure remains `401`, `Cache-Control: no-store`,
`{"error":"Unauthorized"}`, no Location, and **no OAuth WWW-Authenticate**. Check the
edge's final response, including on origin refusal; don't assume it survives unchanged.
The harness requires an edge challenge with one unambiguous Bearer scheme and exact
path metadata URL:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://<isolated-staging-host>/.well-known/oauth-protected-resource/mcp", scope="lifecycle:read"
```

This is the required **captured-edge contract**, not a response this Worker serves or
a claim about Access's current response format. Managed OAuth docs show
`/.well-known/oauth-authorization-server` discovery; they do not establish our exact
path-specific RFC9728 response shape. If Access doesn't expose this path contract,
record the discrepancy and keep activation blocked. Do not fabricate metadata at the
origin or silently change the required resource to a hostname root.

An opaque `oauth:...` bearer reaches Access, which resolves it into the signed
`Cf-Access-Jwt-Assertion`. The Worker ignores Authorization as an identity source;
no OAuth bearer is forwarded as an Access JWT. It verifies RS256, issuer, exact single
MCP AUD and mandatory expiry/issued-at; the named backend independently repeats JWT
validation and checks D1 on **every** read. A token issued for both MCP and dashboard
is refused by both MCP boundaries. Existing dashboard authentication semantics are
unchanged. Private RPC receives exactly the signed assertion, no client principal,
roles or scopes. Access must replace/strip a caller-injected assertion header: verify
that at the real edge, and close workers.dev, preview and all bypass routes.

| Permission | Authoritative mapping |
| --- | --- |
| `lifecycle:read` | Explicit unexpired/non-revoked D1 app grant, reader or higher |
| `process:read` | Person analyst or higher D1 app grant; delegated consent must require step-up |
| Service identity | Signed `common_name` wins over person-like claims; explicit service app reader grant; never analyze |
| Unknown/ungranted app | Same `forbidden`; app selector, token scopes and roles cannot create a grant |

The **delegated** permission set must ultimately be the intersection of the approved
client scopes and those existing D1 capabilities. This build does not consume OAuth
scope claims, and Access docs don't specify authenticated scope propagation into the
origin JWT. An analyst's read-only OAuth consent cannot yet be shown to restrict them
to reader at the origin. A matching capture is insufficient to enable delegated use.
Signed scope/role claims cannot widen D1 grants; that is tested. Attenuation is a
separate release gate. Never treat a caller-supplied scope header as proof of consent.

## Run the offline harness

Node >=24 and the repository's locked pnpm version are sufficient. No Cloudflare API
access, credentials or network is used by the harness:

```sh
node scripts/lifecycle-mcp-oauth-preflight.mjs apps/lifecycle-mcp/test/fixtures/managed-oauth-capture.json
```

The checked-in file is a **hypothetical mock capture**, not a recorded Cloudflare
response. Its example endpoint paths and client ID are not Cloudflare or CloudflareOS
configuration defaults. Output is `contract: pass`, `activation: blocked` and the
remaining staging gates. Exit status is **always 2** for parseable captures, even on
contract pass; invalid JSON/usage/oversize input exits 1. There is no enable flag and
no success exit that an activation script could mistake for authorization.

To inspect an operator capture, copy that schema to a private local file and replace:

- `pins`: independently reviewed exact resource, authorization-server issuer and
  endpoint URLs from Access configuration; Access team issuer, MCP AUD, separate
  dashboard AUD. Do not pin values by blindly copying untrusted metadata.
- `challenge`: actual unauthenticated edge status and WWW-Authenticate only.
- `resourceMetadata`, `authorizationMetadata`: parsed public JSON responses. Endpoint
  URLs must equal independent pins; resource/issuer must match, supported scopes
  must be least privilege, no query bearer or implicit/client-credentials grant.
- `clients`: operator-reviewed distinct client IDs and exact HTTPS redirect URIs;
  requested/approved scopes, explicit client/user consent plan and analysis step-up.
  These are plans, not proof of a completed consent screen or server policy.
- `request`, `tokenRequest`: only the public redacted request shape, including exact
  resource, registered client/redirect, `responseType: code`, and S256 method.

Never include a bearer, JWT, code, refresh token, cookie, client secret, state,
code_verifier, person identity or company data. The harness never echoes input or
exception text, fetches metadata URLs, follows redirects or changes configuration.
It rejects ambiguous/duplicate challenge parameters, duplicate client IDs, unknown
scopes, redirect mismatch, wrong issuer/resource/AUD separation, plain PKCE and
consent scope widening. Duplicate-client rejection here validates the local plan;
it does not test Access's registration endpoint. Matching S256 metadata does not
prove verifier enforcement or code replay rejection. All those remain staging gates.

## Operator-only staging configuration (not executed)

Use a dedicated sandbox account or separately isolated staging services and synthetic
apps/data. An environment label alone cannot isolate a production service binding or
D1 database. No real HR/company resources, personal data or production grants.

1. In Cloudflare dashboard: **Zero Trust > Access controls > Applications**. Create
   or identify a dedicated **self-hosted Access application** or **MCP server
   application** for only the staging MCP host. Record its Application Audience
   (AUD) and team issuer independently. Do not add dashboard or other domains to
   this application: Managed OAuth tokens can access all domains in one application.
   Use deny-by-default identity policies with explicitly selected test users. Keep
   service-auth policies separate; OAuth user consent is not a service identity.
2. On that app: **Edit > Advanced settings > Managed OAuth** is the documented
   switch. This procedure is a future staging checklist, not authorization to switch
   it now. Do not enable it on an app already serving its own OAuth 401.
3. Under **Managed OAuth settings**, disable **Allow localhost clients** and **Allow
   loopback clients** for remote CloudflareOS use. Set **Allowed redirect URIs** to
   the actual exact HTTPS callback shown by the installed client, no wildcard. If
   another desktop MCP client requires loopback, review separately in an isolated
   app, with S256, a local listener and exact callback validation; this remote-client
   harness deliberately rejects non-HTTPS redirects.
4. Set short **Access token lifetime** (5 minutes is supported by the docs) and a
   short test **Grant session duration** (e.g. 24 hours), pending revocation tests.
   The docs' API fields are `oauth_configuration.enabled`,
   `dynamic_client_registration.enabled`, `allow_any_on_localhost`,
   `allow_any_on_loopback`, `allowed_uris`, `grant.access_token_lifetime` and
   `grant.session_duration` under `oauth_configuration`. Preserve the full existing
   application config if an operator later uses PUT; do not submit a partial object
   that overwrites policies. This work makes no API writes.
5. In the MCP staging Worker set `LIFECYCLE_MCP_ENVIRONMENT=staging`,
   `LIFECYCLE_MCP_SOURCE=read-api`, `LIFECYCLE_MCP_DEV=0`,
   `LIFECYCLE_MCP_RESOURCE=https://<isolated-staging-host>/mcp`,
   `ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com`, `ACCESS_AUD=<MCP AUD>`.
   Set allowed browser origins only if required; non-browser clients send none.
   Bind `LIFECYCLE_READ_API` to the isolated backend's **LifecycleReadEntrypoint**.
   Keep workers_dev/preview_urls false; Access protects every reachable route.
6. Backend staging config: `LIFECYCLE_MCP_READ_ENABLED=1`,
   `LIFECYCLE_MCP_ACCESS_AUD=<same MCP AUD>`, `ACCESS_TEAM_DOMAIN=<same team>`,
   `ACCESS_AUD=<distinct dashboard AUD>`. Apply the existing staging migrations and
   fixture/grant procedures from [live-source operations](lifecycle-mcp-live-source.md).
   Grant only fixture apps to the signed Access person `sub` or service `common_name`.
   Never mint a dashboard-audience assertion or reuse production D1/bindings.
7. In CloudflareOS, add a **remote MCP server** using the exact endpoint above and
   its OAuth/RFC8707 authentication mode, not an API key or static Access JWT.
   Use the client-provided exact HTTPS callback in Access's redirect allowlist.
   Set resource to the endpoint, start with only `lifecycle:read`, and request
   `process:read` only through explicit renewed consent/step-up. Exact CloudflareOS
   UI labels, callback URL, custom-scope controls and OAuth behavior depend on the
   installed version and are **unverified**. No CloudflareOS config schema, callback
   URL or credential is invented here. If those settings cannot be expressed,
   record the version and gap; do not activate. Repeat with a second official MCP
   v2-compatible client supporting RFC8707 and S256.

Required operator permissions: Access app/policy **Read** for inspection; **Access:
Apps and Policies Write** for a separately authorized future Managed OAuth change;
Workers edit/deploy plus same-account service binding permissions for isolated staging;
D1 access/migration and the existing grant-admin permission only for synthetic fixture
setup. A client needs an allowed Access identity and explicit client/user approval;
no account-wide Cloudflare token belongs in MCP client configuration. Store any future
client/refresh credentials in the client secret store. This task requests none of these
account changes or credentials. Production remains hard-disabled by code.

## Staging acceptance and remaining gaps

Save only redacted evidence (timestamps, client version, endpoint, audience names and
result codes; no JWT/body/token logs). A separate authorized staging run must:

1. Capture the public edge's unauthenticated MCP 401, path-specific RFC9728 metadata
   and RFC8414 server metadata. Confirm HTTPS, no login HTML/302, exact resource and
   independently pinned issuer/endpoints. Run the offline capture validator. Record
   unsupported format/scopes explicitly; never serve competing origin metadata.
2. Complete actual browser login and explicit client/user consent. Verify exact
   redirect allowlisting, duplicate/unknown client policy, CSRF/state, PKCE S256
   enforcement, wrong/missing verifier denial, single-use authorization code and
   denial of code replay. Try wrong/missing RFC8707 resource on both auth/token
   requests; try using an obtained token at another resource/dashboard/alias.
3. Confirm opaque token resolution and signed person identity preservation at origin
   and private RPC without logging JWTs. Inject a bogus assertion header at the
   public edge and verify replacement/refusal. Test expired/unknown/revoked OAuth
   tokens, wrong issuer/AUD/signature, unknown `kid`, malformed/unavailable JWKS,
   rotations and origin errors. No opaque token may reach RPC as an assertion.
4. Demonstrate authenticated propagation of consented scopes and enforce intersection
   with D1 grants. Reader+process scope stays reader; analyst with read-only consent
   cannot analyze; process scope requires renewed explicit consent. This last case
   is **not implemented/established** by the current Access assertion contract.
   If Access cannot supply a verifiable mechanism, stop and revisit the split-
   provider ADR; don't trust unsigned client headers or broaden D1 permissions.
5. Service with analyst-like claims remains reader. Unknown/ungranted apps deny.
   Revoke a D1 app grant and replay the same token: the next read must deny. Revoke
   OAuth/client/session grants and exercise refresh and cached token windows;
   measure how long replay remains possible. Bearer tokens are replayable while
   valid; this harness does not claim proof-of-possession or universal immediate
   OAuth revocation. Also verify sign-out/Access policy removal behavior.
6. Inspect Access policies, alternative hostnames, service bindings, database inventory
   and observability redaction. Confirm all resources are isolated staging, no
   secret-bearing logs or responses. Record actual browser/client results instead
   of upgrading mock outcomes to a working OAuth claim.

## Rollback and default off

Default Wrangler config keeps source `disabled`, resource/AUD empty, no routes, no
workers.dev/preview and hard-coded `PRODUCTION_ENABLED=false`. No OAuth feature flag
can activate this harness. For a separately approved staging experiment, disable its
MCP route/source and backend MCP-read flag first, then revoke test grants/sessions
and disable Managed OAuth on only the staging app. Disabling Managed OAuth alone
may restore browser 302 behavior; it is not a way to keep non-browser MCP working.
Keep dashboard app/AUD and production untouched. Restore configuration from the
reviewed staging snapshot; independently verify denial and no bypass hostname.

## Local evidence

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Focused security run:

```sh
pnpm exec vitest run --project lifecycle-mcp --project flightdeck-mcp-live
```

The suites use locally signed mock RS256 tokens, local public JWKS, real Miniflare
D1 migrations/private named binding and official `@modelcontextprotocol/client` v2.4.0
pinned to `2026-07-28`. The mock edge replaces an injected assertion and preserves the
same signed identity through both JWT verifiers. Tests cover malformed discovery,
wrong exact resource, duplicate client plans, PKCE/consent/scope plans, bearer/JWT
confusion, expiry/signature/issuer/AUD/multi-AUD rejection, unknown signing key,
JWKS failures, reader/service ceiling, malicious scope/role claims, unknown apps and
D1 grant revocation/replay. Mock edge token denials are simulation, not tests of
Cloudflare's OAuth implementation. No tests issue real OAuth tokens, complete a
browser flow, assert real Access registration behavior, or establish scope attenuation.
