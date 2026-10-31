import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { normalizeTeamDomain, verifyAccessPrincipal, verifyAccessUser } from "../src/access";

const TEAM = "https://acme.cloudflareaccess.com";
let keys: ReturnType<typeof createLocalJWKSet>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }],
  });
});

const sign = (
  claims: { iss?: string; aud?: string; exp?: string | number | null; iat?: boolean },
  extra: Record<string, unknown> = {},
) => {
  const jwt = new SignJWT(extra)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject("user-uuid-1")
    .setIssuer(claims.iss ?? TEAM)
    .setAudience(claims.aud ?? "aud-app");
  if (claims.exp !== null) jwt.setExpirationTime(claims.exp ?? "5m");
  if (claims.iat !== false) jwt.setIssuedAt();
  return jwt.sign(privateKey);
};

it("returns sub for a valid token", async () => {
  expect(await verifyAccessUser(await sign({}), { teamDomain: TEAM, keys })).toBe("user-uuid-1");
  expect(
    await verifyAccessUser(await sign({}), { teamDomain: TEAM, audience: "aud-app", keys }),
  ).toBe("user-uuid-1");
});

it("rejects wrong issuer, wrong audience, and expired tokens", async () => {
  expect(
    await verifyAccessUser(await sign({ iss: "https://evil.cloudflareaccess.com" }), {
      teamDomain: TEAM,
      keys,
    }),
  ).toBeNull();
  expect(
    await verifyAccessUser(await sign({ aud: "other" }), {
      teamDomain: TEAM,
      audience: "aud-app",
      keys,
    }),
  ).toBeNull();
  expect(
    await verifyAccessUser(await sign({ exp: Math.floor(Date.now() / 1000) - 60 }), {
      teamDomain: TEAM,
      keys,
    }),
  ).toBeNull();
});

it("rejects tokens not signed with RS256", async () => {
  const secret = new TextEncoder().encode("not-a-real-access-signing-secret-0123456789");
  // A key resolver that would hand out the HMAC secret: only the algorithm pin can reject this token.
  const hmacKeys = async () => secret;
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256", kid: "k1" })
    .setSubject("user-uuid-1")
    .setIssuer(TEAM)
    .setAudience("aud-app")
    .setExpirationTime("5m")
    .sign(secret);
  expect(await verifyAccessUser(token, { teamDomain: TEAM, keys })).toBeNull();
  expect(await verifyAccessUser(token, { teamDomain: TEAM, keys: hmacKeys })).toBeNull();
});

it("accepts team domains given with or without https://", async () => {
  expect(normalizeTeamDomain("acme.cloudflareaccess.com")).toBe(TEAM);
  expect(normalizeTeamDomain(" https://acme.cloudflareaccess.com/ ")).toBe(TEAM);
  expect(
    await verifyAccessUser(await sign({}), { teamDomain: "acme.cloudflareaccess.com", keys }),
  ).toBe("user-uuid-1");
});

it("requires exp and iat claims", async () => {
  expect(await verifyAccessUser(await sign({ exp: null }), { teamDomain: TEAM, keys })).toBeNull();
  expect(await verifyAccessUser(await sign({ iat: false }), { teamDomain: TEAM, keys })).toBeNull();
});

describe("verifyAccessPrincipal", () => {
  const opts = () => ({ teamDomain: TEAM, audience: "aud-app", keys });
  const user = { email: "me@example.com" };

  it("returns users and service tokens", async () => {
    expect(await verifyAccessPrincipal(await sign({}, user), opts())).toEqual({
      sub: "user-uuid-1",
      email: "me@example.com",
      serviceToken: false,
    });
    const service = await new SignJWT({ common_name: "client.access" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setSubject("")
      .setIssuer(TEAM)
      .setAudience("aud-app")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    expect(await verifyAccessPrincipal(service, opts())).toEqual({
      sub: "client.access",
      serviceToken: true,
    });
  });

  it("rejects a sub without email or common_name", async () => {
    expect(await verifyAccessPrincipal(await sign({}), opts())).toBeNull();
  });

  it("rejects expired, wrong-issuer, wrong-audience, claimless and non-RS256 tokens", async () => {
    for (const token of [
      await sign({ exp: Math.floor(Date.now() / 1000) - 60 }, user),
      await sign({ iss: "https://evil.cloudflareaccess.com" }, user),
      await sign({ aud: "other" }, user),
      await sign({ exp: null }, user),
      await sign({ iat: false }, user),
    ])
      expect(await verifyAccessPrincipal(token, opts())).toBeNull();
    const secret = new TextEncoder().encode("not-a-real-access-signing-secret-0123456789");
    const hs256 = await new SignJWT(user)
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setSubject("user-uuid-1")
      .setIssuer(TEAM)
      .setAudience("aud-app")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(secret);
    expect(await verifyAccessPrincipal(hs256, { ...opts(), keys: async () => secret })).toBeNull();
  });
});
