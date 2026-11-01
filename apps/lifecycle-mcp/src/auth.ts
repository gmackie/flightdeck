import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { Config } from "./config";
import type { Principal } from "./source";

// The same verification as apps/flightdeck/src/access.ts; apps do not import each other's sources.

const remoteKeys = new Map<string, JWTVerifyGetKey>();

/** `acme.cloudflareaccess.com` or `https://acme.cloudflareaccess.com/` -> `https://acme.cloudflareaccess.com`. */
export function normalizeTeamDomain(teamDomain: string): string {
  const host = teamDomain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  return `https://${host}`;
}

function teamKeys(teamDomain: string): JWTVerifyGetKey {
  let keys = remoteKeys.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
    remoteKeys.set(teamDomain, keys);
  }
  return keys;
}

/** Used only by the local development bypass (see `readConfig`). */
export const DEV_PRINCIPAL: Principal = {
  sub: "dev",
  email: "dev@localhost",
  serviceToken: false,
  assertion: null,
};

/**
 * The Access principal for this request, or null. The token must be signed for this team and for
 * the Access application that protects the MCP hostname (`ACCESS_AUD`), not the dashboard's.
 */
export async function authenticate(
  request: Request,
  config: Config,
  keys?: JWTVerifyGetKey,
): Promise<Principal | null> {
  if (!config.access) return DEV_PRINCIPAL;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || token.length > 16_384) return null;
  const teamDomain = normalizeTeamDomain(config.access.teamDomain);
  try {
    const { payload } = await jwtVerify(token, keys ?? teamKeys(teamDomain), {
      issuer: teamDomain,
      audience: config.access.audience,
      algorithms: ["RS256"],
      // Access always sets both; a token without them would never expire.
      requiredClaims: ["exp", "iat"],
    });
    const { sub, email, common_name: commonName } = payload;
    // An Access assertion for multiple applications must not bridge the dashboard boundary.
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (audiences.length !== 1 || audiences[0] !== config.access.audience) return null;
    if (typeof commonName === "string" && commonName) {
      return { sub: commonName, serviceToken: true, assertion: token };
    }
    if (typeof sub === "string" && sub && typeof email === "string" && email) {
      return { sub, email, serviceToken: false, assertion: token };
    }
    return null;
  } catch {
    return null;
  }
}
