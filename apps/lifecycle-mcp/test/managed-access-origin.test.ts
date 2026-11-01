import { describe, expect, it, vi } from "vitest";
import { readConfig } from "../src/config";
import { handleRequest } from "../src/worker";
import { AUD, ENV, keys, MCP_URL, serve, sign, synthetic, userToken } from "./helpers";

const post = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers, body: "{}" });

describe("origin Access assertion contract after Managed OAuth edge (no OAuth listener)", () => {
  it("never treats opaque or JWT bearer tokens as an Access assertion", async () => {
    const jwt = await userToken();
    for (const token of ["oauth:unknown", "oauth:expired", jwt]) {
      const res = await serve(post(MCP_URL, { Authorization: `Bearer ${token}` }));
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBeNull();
      expect(res.headers.get("Location")).toBeNull();
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.text()).not.toContain(token);
    }
  });

  it("refuses alternate resource URLs before processing a signed identity", async () => {
    const token = await userToken();
    for (const resource of [
      "https://other.test/mcp",
      "http://lifecycle-mcp.test/mcp",
      `${MCP_URL}/`,
      `${MCP_URL}?app=x`,
      "https://lifecycle-mcp.test/dashboard",
      "https://lifecycle-mcp.test/.well-known/oauth-protected-resource/mcp",
      "https://lifecycle-mcp.test/.well-known/oauth-authorization-server",
    ]) {
      expect((await serve(post(resource, { "Cf-Access-Jwt-Assertion": token }))).status).toBe(404);
    }
  });

  it("requires the exact resource pin for a live source, including with injected test sources", async () => {
    for (const resource of [undefined, "", "https://lifecycle-mcp.test/", `${MCP_URL}?x=1`]) {
      const config = readConfig({
        ...ENV,
        LIFECYCLE_MCP_SOURCE: "read-api",
        LIFECYCLE_MCP_RESOURCE: resource,
      });
      expect(config).toEqual({ status: 503, error: "MCP resource not configured" });
    }
  });

  it("rejects unknown keys and multi-app assertions even when one AUD is the MCP AUD", async () => {
    for (const token of [
      await sign({ email: "mock@example.test" }, { kid: "unknown" }),
      await sign({ email: "mock@example.test" }, { aud: [AUD, "dashboard-aud"] }),
    ]) {
      expect((await serve(post(MCP_URL, { "Cf-Access-Jwt-Assertion": token }))).status).toBe(401);
    }
  });

  it("fails closed on JWKS failures without exposing or logging the assertion or exception", async () => {
    const token = await userToken();
    const logged = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    try {
      const res = await handleRequest(post(MCP_URL, { "Cf-Access-Jwt-Assertion": token }), ENV, {
        source: synthetic(),
        keys: async () => {
          throw new Error(`JWKS unavailable ${token}`);
        },
      });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe('{"error":"Unauthorized"}');
      for (const log of logged) expect(log).not.toHaveBeenCalled();
    } finally {
      for (const log of logged) log.mockRestore();
    }
    // A malformed assertion never reaches JWKS at all.
    const lookup = vi.fn(keys);
    expect(
      (
        await handleRequest(post(MCP_URL, { "Cf-Access-Jwt-Assertion": "oauth:opaque" }), ENV, {
          keys: lookup,
        })
      ).status,
    ).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });
});
