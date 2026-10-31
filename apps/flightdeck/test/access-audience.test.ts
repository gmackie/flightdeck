import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { expect, it } from "vitest";
import { verifyAccessUser } from "../src/access";
import { accessAudience } from "../src/ingest/entrypoint";

const app = (id: string, access_aud: string | null = null) => ({ id, name: id, access_aud });

it("uses the app's own audience when it has one", () => {
  expect(accessAudience({ ACCESS_AUD: "aud-dash" }, app("app_flightdeck", "aud-own"))).toBe(
    "aud-own",
  );
  expect(accessAudience({ ACCESS_AUD: "aud-dash" }, app("app_other", "aud-x"))).toBe("aud-x");
});

it("pins app_flightdeck to ACCESS_AUD when its row has no audience", () => {
  expect(accessAudience({ ACCESS_AUD: " aud-dash " }, app("app_flightdeck"))).toBe("aud-dash");
});

it("keeps today's behaviour for other apps and when ACCESS_AUD is empty", () => {
  expect(accessAudience({ ACCESS_AUD: "aud-dash" }, app("app_other"))).toBeNull();
  expect(accessAudience({ ACCESS_AUD: "" }, app("app_flightdeck"))).toBeNull();
});

it("rejects another Access application's token for dogfood identities", async () => {
  const TEAM = "https://acme.cloudflareaccess.com";
  const pair = await generateKeyPair("RS256");
  const keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }],
  });
  const token = (aud: string) =>
    new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setSubject("user-1")
      .setIssuer(TEAM)
      .setAudience(aud)
      .setExpirationTime("5m")
      .sign(pair.privateKey);
  const audience = accessAudience({ ACCESS_AUD: "aud-dash" }, app("app_flightdeck"));
  const verify = async (aud: string) =>
    verifyAccessUser(await token(aud), { teamDomain: TEAM, audience, keys });
  expect(await verify("aud-dash")).toBe("user-1");
  expect(await verify("aud-some-other-app")).toBeNull();
});
