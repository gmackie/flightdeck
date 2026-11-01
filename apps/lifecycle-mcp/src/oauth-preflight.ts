/**
 * Offline Managed OAuth contract inspection. No fetch, listener, registration, token issuance,
 * token decoding or account mutations. A passing capture is NOT browser/staging verification.
 * Inputs contain public metadata and redacted client plans only; never tokens, codes or cookies.
 */
export const DELEGATED_SCOPES = ["lifecycle:read", "process:read"] as const;
const METADATA_PATH = "/.well-known/oauth-protected-resource/mcp";
const MAX_CAPTURE_BYTES = 64_000;

export type PreflightPins = {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  accessIssuer: string;
  accessAudience: string;
  dashboardAudience: string;
};

export type ClientPlan = {
  clientId: string;
  redirectUri: string;
  requestedScopes: string[];
  approvedScopes: string[];
  consent: "explicit-user-and-client";
  stepUp: boolean;
};

export type Capture = {
  pins: PreflightPins;
  challenge: { status: number; wwwAuthenticate: string };
  resourceMetadata: unknown;
  authorizationMetadata: unknown;
  clients: ClientPlan[];
  /** Public authorization-request shape, NOT a real authorization URL, code, state or verifier. */
  request: {
    clientId: string;
    redirectUri: string;
    resource: string;
    responseType: string;
    codeChallengeMethod: string;
    scope: string[];
  };
  /** Public token-request shape only; never include code, client secret or code_verifier. */
  tokenRequest: { clientId: string; resource: string; grantType: string };
};

export type PreflightResult = {
  contract: "pass" | "blocked";
  activation: "blocked";
  checks: string[];
  /** Always present, even for locally consistent captures. Not attested by JSON booleans. */
  stagingGates: readonly string[];
};

export const STAGING_GATES = [
  "real-edge-401-and-path-resource-metadata",
  "browser-client-user-consent-and-scope-step-up",
  "S256-code-verifier-enforcement-and-code-replay-denial",
  "RFC8707-wrong-resource-token-denial-at-edge",
  "duplicate-client-and-redirect-registration-policy",
  "verified-consented-scope-propagation-and-attenuation-at-origin",
  "opaque-token-expiry-refresh-revocation-and-replay-window",
  "Access-policy-and-JWKS-rotation-failure-behavior",
  "CloudflareOS-and-second-MCP-v2-client-interoperability",
] as const;

/** A single canonical HTTPS origin and /mcp, with no credentials, port, query or fragment. */
export function isMcpResource(value: string): boolean {
  const url = httpsUrl(value);
  return !!url && !url.port && value === `${url.origin}/mcp`;
}

function httpsUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.href.includes("*") &&
      !url.search &&
      !url.hash &&
      (url.href === value || value === url.origin)
      ? url
      : null;
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((s) => typeof s === "string");
}

function unique(value: string[]): boolean {
  return value.length > 0 && new Set(value).size === value.length;
}

function scopes(value: unknown): value is string[] {
  return (
    strings(value) &&
    unique(value) &&
    value.every((s) => (DELEGATED_SCOPES as readonly string[]).includes(s)) &&
    value.includes("lifecycle:read")
  );
}

/**
 * Accept one unambiguous Bearer challenge with the exact RFC9728 path metadata URL.
 * Conservative subset: ambiguous/multiple schemes, duplicate params and escaped values block.
 * Does not synthesize an origin challenge, follow a challenge URL, or accept a login redirect.
 */
export function validEdgeChallenge(status: unknown, header: unknown, resource: string): boolean {
  if (status !== 401 || typeof header !== "string" || !isMcpResource(resource)) return false;
  if (!/^Bearer /i.test(header) || header.length > 4096) return false;
  const params = new Map<string, string>();
  for (const part of header.slice(7).split(",")) {
    const match = /^\s*([a-z_]+)="([^"\\\r\n]*)"\s*$/.exec(part);
    if (!match?.[1] || match[2] === undefined || params.has(match[1])) return false;
    params.set(match[1], match[2]);
  }
  const allowed = ["resource_metadata", "scope", "error", "error_description", "realm"];
  if ([...params.keys()].some((key) => !allowed.includes(key))) return false;
  const scope = params.get("scope");
  return (
    params.get("resource_metadata") === `${new URL(resource).origin}${METADATA_PATH}` &&
    (scope === undefined || scopes(scope.split(" ")))
  );
}

/** Validate untrusted JSON without echoing any input or exception text into output. */
export function inspectCapture(input: unknown): PreflightResult {
  const failures: string[] = [];
  const check = (ok: unknown, code: string) => {
    if (!ok) failures.push(code);
  };
  try {
    if (JSON.stringify(input).length > MAX_CAPTURE_BYTES) throw new Error("oversize");
    const capture = object(input);
    const pins = object(capture.pins);
    const resource = typeof pins.resource === "string" ? pins.resource : "";
    check(isMcpResource(resource), "exact-resource-pin");
    const issuer = httpsUrl(pins.issuer);
    const accessIssuer = httpsUrl(pins.accessIssuer);
    check(issuer, "authorization-issuer-pin");
    check(
      accessIssuer && /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\/$/.test(accessIssuer.href),
      "Access-issuer-pin",
    );
    check(
      typeof pins.accessAudience === "string" &&
        /^[A-Za-z0-9_-]{1,256}$/.test(pins.accessAudience) &&
        typeof pins.dashboardAudience === "string" &&
        /^[A-Za-z0-9_-]{1,256}$/.test(pins.dashboardAudience) &&
        pins.accessAudience !== pins.dashboardAudience,
      "isolated-MCP-AUD",
    );
    check(httpsUrl(pins.authorizationEndpoint) && httpsUrl(pins.tokenEndpoint), "endpoint-pins");

    const challenge = object(capture.challenge);
    check(
      validEdgeChallenge(challenge.status, challenge.wwwAuthenticate, resource),
      "edge-401-resource-metadata-challenge",
    );
    const metadata = object(capture.resourceMetadata);
    check(metadata.resource === resource && isMcpResource(resource), "metadata-resource");
    check(
      strings(metadata.authorization_servers) &&
        metadata.authorization_servers.length === 1 &&
        metadata.authorization_servers[0] === pins.issuer,
      "metadata-issuer",
    );
    check(scopes(metadata.scopes_supported), "metadata-scopes");
    check(
      strings(metadata.bearer_methods_supported) &&
        metadata.bearer_methods_supported.length === 1 &&
        metadata.bearer_methods_supported[0] === "header",
      "header-bearer-only",
    );
    const auth = object(capture.authorizationMetadata);
    check(auth.issuer === pins.issuer && issuer, "authorization-metadata-issuer");
    check(
      auth.authorization_endpoint === pins.authorizationEndpoint &&
        auth.token_endpoint === pins.tokenEndpoint,
      "authorization-metadata-endpoints",
    );
    check(
      strings(auth.code_challenge_methods_supported) &&
        auth.code_challenge_methods_supported.includes("S256") &&
        !auth.code_challenge_methods_supported.includes("plain"),
      "PKCE-S256-only",
    );
    check(scopes(auth.scopes_supported), "authorization-scopes");
    check(
      strings(auth.response_types_supported) &&
        auth.response_types_supported.length === 1 &&
        auth.response_types_supported[0] === "code" &&
        strings(auth.grant_types_supported) &&
        auth.grant_types_supported.includes("authorization_code") &&
        auth.grant_types_supported.every((g) =>
          ["authorization_code", "refresh_token"].includes(g),
        ),
      "authorization-code-only",
    );

    const clients = Array.isArray(capture.clients) ? capture.clients.map(object) : [];
    check(clients.length > 0 && clients.length <= 16, "client-plans");
    const ids = clients.map((c) => c.clientId);
    check(
      ids.every((id) => typeof id === "string" && /^[A-Za-z0-9._:-]{1,256}$/.test(id)) &&
        new Set(ids).size === ids.length,
      "unique-client-identifiers",
    );
    for (const client of clients) {
      check(httpsUrl(client.redirectUri), "exact-HTTPS-client-redirect");
      check(scopes(client.requestedScopes) && scopes(client.approvedScopes), "client-scopes");
      check(client.consent === "explicit-user-and-client", "client-user-consent-plan");
      const requested = strings(client.requestedScopes) ? client.requestedScopes : [];
      const approved = strings(client.approvedScopes) ? client.approvedScopes : [];
      check(
        requested.every(
          (s) =>
            strings(metadata.scopes_supported) &&
            metadata.scopes_supported.includes(s) &&
            strings(auth.scopes_supported) &&
            auth.scopes_supported.includes(s),
        ),
        "client-scopes-advertised",
      );
      check(
        approved.every((s) => requested.includes(s)),
        "consent-cannot-widen-scopes",
      );
      check(!approved.includes("process:read") || client.stepUp === true, "analysis-step-up-plan");
    }
    const request = object(capture.request);
    const client = clients.find((c) => c.clientId === request.clientId);
    check(client && request.redirectUri === client.redirectUri, "registered-client-redirect");
    check(
      request.resource === resource && isMcpResource(resource),
      "RFC8707-authorization-resource",
    );
    check(
      request.responseType === "code" && request.codeChallengeMethod === "S256",
      "authorization-request-PKCE",
    );
    check(
      scopes(request.scope) &&
        client &&
        strings(client.approvedScopes) &&
        request.scope.every((s) => (client.approvedScopes as string[]).includes(s)),
      "request-consented-scopes",
    );
    const token = object(capture.tokenRequest);
    check(
      token.clientId === request.clientId &&
        token.resource === resource &&
        isMcpResource(resource) &&
        token.grantType === "authorization_code",
      "RFC8707-token-resource",
    );
  } catch {
    failures.push("invalid-capture");
  }
  return {
    contract: failures.length ? "blocked" : "pass",
    activation: "blocked",
    checks: [...new Set(failures)],
    stagingGates: STAGING_GATES,
  };
}
