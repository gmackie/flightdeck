import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, expect, it } from "vitest";
import { normalizeTeamDomain, verifyAccessUser } from "../src/access";

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

const sign = (claims: { iss?: string; aud?: string; exp?: string | number }) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject("user-uuid-1")
    .setIssuer(claims.iss ?? TEAM)
    .setAudience(claims.aud ?? "aud-app")
    .setExpirationTime(claims.exp ?? "5m")
    .sign(privateKey);

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
