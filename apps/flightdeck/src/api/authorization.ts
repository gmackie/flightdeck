import type { AccessPrincipal } from "../access";
import { fail } from "./http";

export type Role = "reader" | "analyst" | "owner" | "admin";
export type Capability = "app:read" | "lifecycle:read" | "process:read" | "policy:manage";

const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  reader: ["app:read", "lifecycle:read"],
  analyst: ["app:read", "lifecycle:read", "process:read"],
  owner: ["app:read", "lifecycle:read", "process:read", "policy:manage"],
  admin: ["app:read", "lifecycle:read", "process:read", "policy:manage"],
};
const APP_ID = /^[\w-]{3,64}$/;
const authorized = Symbol("authorized read");

/** Opaque scope produced only after a current grant lookup, never from request JSON. */
export type AuthorizedRead = Readonly<{
  appId: string;
  capability: Capability;
  [authorized]: true;
}>;

/** Reuse the already verified dashboard principal. Ingest keys confer no read rights.
 * No grant cache: expiry/revocation and project membership apply on the next request.
 * All roles, including admin, are scoped; services are capped at app-scoped reader.
 */
export async function authorizeApp(
  env: Env,
  principal: AccessPrincipal,
  appId: string,
  capability: Capability,
): Promise<AuthorizedRead | Response> {
  if (!APP_ID.test(appId) || !principal.sub || principal.sub.length > 256) {
    return fail(403, "Forbidden");
  }
  // A local authentication shortcut must never become a sensitive-read bypass.
  if (!env.ACCESS_TEAM_DOMAIN.trim() || !env.ACCESS_AUD.trim()) {
    return fail(503, "Access not configured for authorized reads");
  }
  try {
    const { results } = await env.DB.prepare(
      `SELECT g.role, g.app_id FROM authz_grants g
       JOIN apps a ON a.id = ?
       LEFT JOIN authz_app_projects p ON p.app_id = a.id
       WHERE g.principal_kind = ? AND g.principal_subject = ?
         AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > ?)
         AND (g.app_id = a.id OR g.project_id = p.project_id)`,
    )
      .bind(appId, principal.serviceToken ? "service" : "person", principal.sub, Date.now())
      .all<{ role: string; app_id: string | null }>();
    const allowed = results.some((grant) => {
      if (!Object.hasOwn(ROLE_CAPABILITIES, grant.role)) return false;
      if (principal.serviceToken && (grant.role !== "reader" || grant.app_id !== appId))
        return false;
      return ROLE_CAPABILITIES[grant.role as Role].includes(capability);
    });
    // Same response for an unknown app and an app without a grant.
    return allowed
      ? Object.freeze({ appId, capability, [authorized]: true as const })
      : fail(403, "Forbidden");
  } catch {
    // Missing migration, D1 outage, etc. Never log exceptions or principal identifiers.
    return fail(503, "Authorization unavailable");
  }
}

/** Required entry point for every future lifecycle read, before querying its data. */
export function authorizeLifecycleRead(
  env: Env,
  principal: AccessPrincipal,
  appId: string,
  capability: "lifecycle:read" | "process:read" = "lifecycle:read",
) {
  return authorizeApp(env, principal, appId, capability);
}

export function isProcessRead(scope: AuthorizedRead): boolean {
  return scope[authorized] === true && scope.capability === "process:read";
}

/** Empty/unset retains the deployed legacy behavior; typos never disable enforcement. */
export function legacyReadMode(env: Env): "legacy" | "enforce" | Response {
  const mode = env.READ_AUTHZ_MODE?.trim();
  if (!mode || mode === "legacy") return "legacy";
  if (mode === "enforce") return "enforce";
  return fail(503, "Invalid read authorization mode");
}
