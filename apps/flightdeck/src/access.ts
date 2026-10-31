import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";

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

/** An authenticated Access caller: a person (`email`) or a service token (`common_name`). */
export type AccessPrincipal = { sub: string; email?: string; serviceToken: boolean };

type AccessOpts = { teamDomain: string; audience?: string | null; keys?: JWTVerifyGetKey };

/** The token's claims when it is valid for this team and audience, else null. */
async function verifyAccessToken(token: string, opts: AccessOpts): Promise<JWTPayload | null> {
  const teamDomain = normalizeTeamDomain(opts.teamDomain);
  try {
    const { payload } = await jwtVerify(token, opts.keys ?? teamKeys(teamDomain), {
      issuer: teamDomain,
      algorithms: ["RS256"],
      // Access always sets both; a token without them would never expire.
      requiredClaims: ["exp", "iat"],
      ...(opts.audience ? { audience: opts.audience } : {}),
    });
    return payload;
  } catch {
    return null;
  }
}

/** The Access user id (`sub`) when the token is valid for this team and audience, else null. */
export async function verifyAccessUser(token: string, opts: AccessOpts): Promise<string | null> {
  const payload = await verifyAccessToken(token, opts);
  return typeof payload?.sub === "string" && payload.sub ? payload.sub : null;
}

/** Users carry `sub` + `email`; service tokens carry `common_name` (the client id) and an empty `sub`. */
export async function verifyAccessPrincipal(
  token: string,
  opts: AccessOpts & { audience: string },
): Promise<AccessPrincipal | null> {
  const payload = await verifyAccessToken(token, opts);
  if (!payload) return null;
  const { sub, email, common_name: commonName } = payload;
  // A service claim wins over person-like claims: it must never inherit a person's grants.
  if (typeof commonName === "string" && commonName) {
    return { sub: commonName, serviceToken: true };
  }
  if (typeof sub === "string" && sub && typeof email === "string" && email) {
    return { sub, email, serviceToken: false };
  }
  return null;
}
