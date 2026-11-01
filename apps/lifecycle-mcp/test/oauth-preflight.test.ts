import { describe, expect, it } from "vitest";
import {
  type Capture,
  inspectCapture,
  isMcpResource,
  validEdgeChallenge,
} from "../src/oauth-preflight";
import capture from "./fixtures/managed-oauth-capture.json";

const fresh = () => structuredClone(capture) as Capture;
const blocked = (edit: (c: Capture) => void, code: string) => {
  const c = fresh();
  edit(c);
  const result = inspectCapture(c);
  expect(result.contract).toBe("blocked");
  expect(result.activation).toBe("blocked");
  expect(result.checks).toContain(code);
};

describe("offline Managed OAuth preflight (mock capture, never activation)", () => {
  it("checks a consistent mock edge capture but keeps every staging gate blocked", () => {
    const result = inspectCapture(fresh());
    expect(result.contract).toBe("pass");
    expect(result.checks).toEqual([]);
    expect(result.activation).toBe("blocked");
    expect(result.stagingGates).toContain(
      "verified-consented-scope-propagation-and-attenuation-at-origin",
    );
  });

  it("accepts only the exact canonical HTTPS /mcp resource", () => {
    expect(isMcpResource(capture.pins.resource)).toBe(true);
    for (const resource of [
      "http://mcp.example.test/mcp",
      "https://mcp.example.test/",
      "https://mcp.example.test/mcp/",
      "https://mcp.example.test/mcp?app=x",
      "https://mcp.example.test/mcp#x",
      "https://user:password@mcp.example.test/mcp",
      "https://mcp.example.test:8443/mcp",
      "https://mcp.example.test/%6dcp",
      "https://MCP.example.test/mcp",
      "https://mcp.example.test:443/mcp",
      "https://*.example.test/mcp",
    ])
      expect(isMcpResource(resource), resource).toBe(false);
  });

  it("requires an unambiguous edge 401 challenge pointing to path-specific metadata", () => {
    const { resource } = capture.pins;
    const good = capture.challenge.wwwAuthenticate;
    expect(validEdgeChallenge(401, good, resource)).toBe(true);
    for (const header of [
      "",
      'Basic realm="login"',
      good.replace("/oauth-protected-resource/mcp", "/oauth-protected-resource"),
      good.replace("https://mcp.example.test", "https://evil.example.test"),
      `${good}, resource_metadata="https://evil.example.test/metadata"`,
      `${good}, Basic realm="login"`,
      `${good}\r\nX-Token: secret`,
      good.replace("lifecycle:read", "admin"),
    ])
      expect(validEdgeChallenge(401, header, resource)).toBe(false);
    for (const status of [200, 302, 403, 500])
      expect(validEdgeChallenge(status, good, resource)).toBe(false);
  });

  it("rejects malformed, wrong-resource, unpinned issuer, and bearer-in-query metadata", () => {
    for (const resourceMetadata of [
      null,
      [],
      "html",
      {},
      { resource: "https://mcp.example.test/" },
    ]) {
      blocked((c) => {
        c.resourceMetadata = resourceMetadata;
      }, "metadata-resource");
    }
    blocked((c) => {
      c.resourceMetadata = { ...capture.resourceMetadata, resource: "https://other.test/mcp" };
    }, "metadata-resource");
    blocked((c) => {
      c.resourceMetadata = {
        ...capture.resourceMetadata,
        authorization_servers: ["https://evil.test"],
      };
    }, "metadata-issuer");
    blocked((c) => {
      c.resourceMetadata = {
        ...capture.resourceMetadata,
        bearer_methods_supported: ["header", "query"],
      };
    }, "header-bearer-only");
    blocked((c) => {
      c.authorizationMetadata = { ...capture.authorizationMetadata, issuer: "https://evil.test" };
    }, "authorization-metadata-issuer");
    blocked((c) => {
      c.authorizationMetadata = {
        ...capture.authorizationMetadata,
        token_endpoint: "https://evil.test/token",
      };
    }, "authorization-metadata-endpoints");
    blocked((c) => {
      c.pins.dashboardAudience = c.pins.accessAudience;
    }, "isolated-MCP-AUD");
    blocked((c) => {
      c.pins.accessIssuer = "https://evil.test";
    }, "Access-issuer-pin");
  });

  it("blocks plain/missing PKCE, implicit grants and unknown scopes", () => {
    for (const methods of [[], ["plain"], ["S256", "plain"]]) {
      blocked((c) => {
        c.authorizationMetadata = {
          ...capture.authorizationMetadata,
          code_challenge_methods_supported: methods,
        };
      }, "PKCE-S256-only");
    }
    blocked((c) => {
      c.authorizationMetadata = {
        ...capture.authorizationMetadata,
        grant_types_supported: ["authorization_code", "client_credentials"],
      };
    }, "authorization-code-only");
    blocked((c) => {
      c.resourceMetadata = { ...capture.resourceMetadata, scopes_supported: ["admin"] };
    }, "metadata-scopes");
    blocked((c) => {
      c.request.codeChallengeMethod = "plain";
    }, "authorization-request-PKCE");
  });

  it("denies duplicate/unknown clients, redirect mismatch and omitted RFC8707 resource", () => {
    blocked((c) => {
      c.clients.push({ ...c.clients[0] } as Capture["clients"][number]);
    }, "unique-client-identifiers");
    blocked((c) => {
      c.request.clientId = "unknown";
    }, "registered-client-redirect");
    blocked((c) => {
      c.request.redirectUri = "https://evil.test/callback";
    }, "registered-client-redirect");
    blocked((c) => {
      c.request.resource = "https://mcp.example.test/";
    }, "RFC8707-authorization-resource");
    blocked((c) => {
      c.tokenRequest.resource = "";
    }, "RFC8707-token-resource");
    blocked((c) => {
      c.tokenRequest.resource = "https://dashboard.example.test/mcp";
    }, "RFC8707-token-resource");
  });

  it("requires explicit consent and analysis step-up without scope widening", () => {
    blocked((c) => {
      if (c.clients[0]) c.clients[0].consent = "silent" as never;
    }, "client-user-consent-plan");
    blocked((c) => {
      c.clients[0]?.approvedScopes.push("process:read");
    }, "consent-cannot-widen-scopes");
    blocked((c) => {
      c.request.scope.push("process:read");
    }, "request-consented-scopes");
    blocked((c) => {
      c.clients[0]?.requestedScopes.push("process:read");
      c.clients[0]?.approvedScopes.push("process:read");
    }, "analysis-step-up-plan");
    const c = fresh();
    c.clients[0]?.requestedScopes.push("process:read");
    c.clients[0]?.approvedScopes.push("process:read");
    if (c.clients[0]) c.clients[0].stepUp = true;
    c.request.scope.push("process:read");
    expect(inspectCapture(c).contract).toBe("pass");
    expect(inspectCapture(c).activation).toBe("blocked");
  });

  it("fails closed on arbitrary or oversized input without echoing sensitive contents", () => {
    for (const value of [
      undefined,
      null,
      [],
      "secret-jwt",
      { token: "secret-jwt" },
      { data: "secret-jwt".repeat(7000) },
    ]) {
      const result = inspectCapture(value);
      expect(result.contract).toBe("blocked");
      expect(JSON.stringify(result)).not.toContain("secret-jwt");
    }
  });
});
