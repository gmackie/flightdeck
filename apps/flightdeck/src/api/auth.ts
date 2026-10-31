import type { JWTVerifyGetKey } from "jose";
import { type AccessPrincipal, verifyAccessPrincipal } from "../access";
import { fail } from "./http";

/** Used only when `FLIGHTDECK_DEV=1` and Access is not configured, i.e. local `wrangler dev`. */
export const DEV_PRINCIPAL: AccessPrincipal = {
  sub: "dev",
  email: "dev@localhost",
  serviceToken: false,
};

/**
 * Every `/api/*` request must carry a Cloudflare Access JWT for the dashboard application
 * (`ACCESS_AUD`) of this team (`ACCESS_TEAM_DOMAIN`). Fails closed when either is unset.
 */
export async function authenticate(
  request: Request,
  env: Env,
  keys?: JWTVerifyGetKey,
): Promise<AccessPrincipal | Response> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN.trim();
  const audience = env.ACCESS_AUD.trim();
  if (!teamDomain || !audience) {
    if (env.FLIGHTDECK_DEV === "1") return DEV_PRINCIPAL;
    return fail(503, "Access not configured");
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return fail(401, "Unauthorized");
  const principal = await verifyAccessPrincipal(token, { teamDomain, audience, keys });
  return principal ?? fail(401, "Unauthorized");
}
