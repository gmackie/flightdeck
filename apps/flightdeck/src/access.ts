import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

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

/** The Access user id (`sub`) when the token is valid for this team and audience, else null. */
export async function verifyAccessUser(
  token: string,
  opts: { teamDomain: string; audience?: string | null; keys?: JWTVerifyGetKey },
): Promise<string | null> {
  const teamDomain = normalizeTeamDomain(opts.teamDomain);
  try {
    const { payload } = await jwtVerify(token, opts.keys ?? teamKeys(teamDomain), {
      issuer: teamDomain,
      algorithms: ["RS256"],
      ...(opts.audience ? { audience: opts.audience } : {}),
    });
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}
