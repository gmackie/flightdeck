import { exports } from "cloudflare:workers";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config";
import {
  call,
  connect,
  ENV,
  MCP_URL,
  RELEASE,
  raw,
  serve,
  serviceToken,
  sign,
  TEAM,
  userToken,
} from "./helpers";

const post = (headers: Record<string, string> = {}) =>
  new Request(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });

describe("authentication", () => {
  it("rejects requests without an Access assertion before any MCP handling", async () => {
    const res = await serve(post());
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    await expect(connect({ token: null })).rejects.toThrow();
    // Even an otherwise valid raw tools/list never reaches the MCP handler.
    const listed = await raw("tools/list", {}, { token: null });
    expect(listed.status).toBe(401);
    expect(listed.text).not.toContain("get_stage_dwell");
  });

  it("rejects invalid, expired, wrong-audience, wrong-issuer and non-RS256 tokens", async () => {
    const hs256 = await new SignJWT({ email: "a@example.com" })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setSubject("user-uuid-1")
      .setIssuer(TEAM)
      .setAudience("aud-lifecycle-mcp")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("not-a-real-access-signing-secret-0123456789"));
    const tokens = [
      "not-a-jwt",
      // The dashboard's Access audience must not open the MCP server.
      await sign({ email: "a@example.com" }, { aud: "aud-dashboard" }),
      await sign({ email: "a@example.com" }, { iss: "https://evil.cloudflareaccess.com" }),
      await sign({ email: "a@example.com" }, { exp: Math.floor(Date.now() / 1000) - 60 }),
      // A sub alone is neither a user (no email) nor a service token (no common_name).
      await sign({}),
      hs256,
    ];
    for (const token of tokens) {
      const res = await serve(post({ "Cf-Access-Jwt-Assertion": token }));
      expect(res.status).toBe(401);
    }
  });

  it("serves verified users and service tokens", async () => {
    for (const token of [await userToken(), await serviceToken()]) {
      const client = await connect({ token });
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(12);
    }
  });

  it("caps service tokens at reader: no aggregates even with an analyst grant", async () => {
    const client = await connect({ token: await serviceToken() });
    const defs = await call(client, "list_workflow_definitions", { app_id: RELEASE });
    expect(defs.isError).toBe(false);
    const dwell = await call(client, "get_stage_dwell", {
      app_id: RELEASE,
      workflow_key: "change-rollout",
    });
    expect(dwell.error?.code).toBe("forbidden");
  });

  it("serves only /mcp", async () => {
    const res = await serve(new Request("https://lifecycle-mcp.test/", { method: "GET" }));
    expect(res.status).toBe(404);
  });

  it("refuses browser origins that are not allowlisted, even with a valid token", async () => {
    const token = await userToken();
    const evil = await serve(
      post({ "Cf-Access-Jwt-Assertion": token, Origin: "https://evil.test" }),
    );
    expect(evil.status).toBe(403);
    const env = { ...ENV, LIFECYCLE_MCP_ALLOWED_ORIGINS: "https://console.example.com" };
    const client = await connect({ env });
    expect((await client.listTools()).tools).toHaveLength(12);
    const listed = await raw(
      "tools/list",
      {},
      { env, headers: { Origin: "https://console.example.com" } },
    );
    expect(listed.status).toBe(200);
  });
});

describe("fail-closed configuration", () => {
  const refused = async (overrides: Record<string, string | undefined>) => {
    const res = await serve(post({ "Cf-Access-Jwt-Assertion": await userToken() }), {
      env: { ...ENV, ...overrides },
    });
    return { status: res.status, body: (await res.json()) as { error: string } };
  };

  it("refuses production outright in this build", async () => {
    expect(await refused({ LIFECYCLE_MCP_ENVIRONMENT: "production" })).toEqual({
      status: 503,
      body: { error: "Lifecycle MCP is not enabled for production" },
    });
    // Unset or unknown environments are treated as production.
    expect((await refused({ LIFECYCLE_MCP_ENVIRONMENT: undefined })).status).toBe(503);
    expect((await refused({ LIFECYCLE_MCP_ENVIRONMENT: "prod" })).status).toBe(503);
  });

  it("refuses disabled, unknown and unset sources", async () => {
    expect((await refused({ LIFECYCLE_MCP_SOURCE: "disabled" })).body.error).toBe(
      "Lifecycle MCP is disabled",
    );
    expect((await refused({ LIFECYCLE_MCP_SOURCE: "basin" })).body.error).toBe(
      "Lifecycle MCP is misconfigured",
    );
    expect((await refused({ LIFECYCLE_MCP_SOURCE: undefined })).status).toBe(503);
  });

  it("requires Access outside the local development bypass", async () => {
    expect(await refused({ ACCESS_AUD: "" })).toEqual({
      status: 503,
      body: { error: "Access not configured" },
    });
    // The bypass needs development, synthetic data and LIFECYCLE_MCP_DEV=1 together.
    const noAccess = { ACCESS_AUD: "", ACCESS_TEAM_DOMAIN: "", LIFECYCLE_MCP_DEV: "1" };
    expect((await refused({ ...noAccess })).status).toBe(503); // staging
    expect(
      (
        await refused({
          ...noAccess,
          LIFECYCLE_MCP_ENVIRONMENT: "development",
          LIFECYCLE_MCP_SOURCE: "read-api",
        })
      ).status,
    ).toBe(503);
    const dev = readConfig({
      ...ENV,
      ...noAccess,
      LIFECYCLE_MCP_ENVIRONMENT: "development",
    });
    expect("error" in dev ? dev.error : dev.access).toBeNull();
  });

  it("never lowers the minimum cohort below 5", () => {
    for (const [raw, expected] of [
      ["1", 5],
      ["abc", 5],
      ["", 5],
      ["12", 12],
      ["100000", 1000],
    ] as const) {
      const config = readConfig({ ...ENV, LIFECYCLE_MCP_MIN_COHORT: raw });
      expect("error" in config ? null : config.minCohort).toBe(expected);
    }
  });

  it("the deployed defaults (wrangler.jsonc) serve nothing", async () => {
    const res = await exports.default.fetch(
      new Request(MCP_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cf-Access-Jwt-Assertion": await userToken(),
        },
        body: "{}",
      }),
    );
    expect(res.status).toBe(503);
  });
});
