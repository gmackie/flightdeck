import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, expect, it } from "vitest";
import { apiRoutes } from "../src/api";

const TEAM = "https://acme.cloudflareaccess.com";
const AUD = "aud-dashboard";
let keys: ReturnType<typeof createLocalJWKSet>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }],
  });
});

const sign = (claims: Record<string, unknown>, opts: { sub?: string; aud?: string } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject(opts.sub ?? "user-uuid-1")
    .setIssuer(TEAM)
    .setAudience(opts.aud ?? AUD)
    .setExpirationTime("5m")
    .sign(privateKey);

const configured = { ...env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, FLIGHTDECK_DEV: "0" };
const me = (token: string | null, e: Env = configured) =>
  apiRoutes(
    new Request("https://flightdeck.test/api/me", {
      headers: token ? { "Cf-Access-Jwt-Assertion": token } : {},
    }),
    e,
    createExecutionContext(),
    { keys },
  );

it("returns the principal for user tokens and service tokens", async () => {
  const user = await me(await sign({ email: "me@example.com" }));
  expect(user.status).toBe(200);
  expect(user.headers.get("Cache-Control")).toBe("no-store");
  expect(await user.json()).toEqual({
    principal: { sub: "user-uuid-1", email: "me@example.com", serviceToken: false },
  });
  const service = await me(await sign({ common_name: "client-id.access" }, { sub: "" }));
  expect(await service.json()).toEqual({
    principal: { sub: "client-id.access", serviceToken: true },
  });
});

it("rejects missing, invalid and wrong-audience tokens with 401", async () => {
  for (const token of [
    null,
    "not-a-jwt",
    await sign({ email: "me@example.com" }, { aud: "other-app" }),
    await sign({}, { sub: "" }),
  ]) {
    const res = await me(token);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  }
});

it("fails closed with 503 when Access is not configured", async () => {
  const token = await sign({ email: "me@example.com" });
  for (const missing of [{ ACCESS_TEAM_DOMAIN: "" }, { ACCESS_AUD: " " }]) {
    const res = await me(token, { ...configured, ...missing });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Access not configured" });
  }
});

it("allows a fixed dev principal only in dev mode without Access", async () => {
  const res = await me(null, { ...configured, ACCESS_TEAM_DOMAIN: "", FLIGHTDECK_DEV: "1" });
  expect(await res.json()).toEqual({
    principal: { sub: "dev", email: "dev@localhost", serviceToken: false },
  });
  // Dev mode does not bypass a configured Access application.
  expect((await me(null, { ...configured, FLIGHTDECK_DEV: "1" })).status).toBe(401);
});
