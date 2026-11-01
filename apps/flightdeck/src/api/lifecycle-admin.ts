import * as v from "valibot";
import type { AccessPrincipal } from "../access";
import { fail, json, readJson } from "./http";
import { TOKEN_HASH } from "./registry";

export const SCOPES = ["events.write", "lifecycle.write"] as const;

/** One or both scopes, each once. Stored space-separated in a fixed order. */
export const Scopes = v.pipe(
  v.array(v.picklist(SCOPES)),
  v.minLength(1),
  v.maxLength(SCOPES.length),
  v.check((s) => new Set(s).size === s.length, "duplicate scope"),
  v.transform((s) => SCOPES.filter((scope) => s.includes(scope))),
);
export const storedScopes = (scopes: readonly string[]) => scopes.join(" ");

/**
 * Lifecycle grants and lifecycle-scoped keys are managed only by principals listed in
 * `LIFECYCLE_ADMINS` (comma-separated Access emails, or service-token client ids). Any other
 * Access principal, including the local dev one, gets 403; an empty list disables management.
 */
export function isLifecycleAdmin(env: Env, principal: AccessPrincipal): boolean {
  const admins = (env.LIFECYCLE_ADMINS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  const ids = [principal.email, principal.serviceToken ? principal.sub : undefined]
    .filter((id): id is string => !!id)
    .map((id) => id.toLowerCase());
  return ids.some((id) => admins.includes(id));
}

const denied = () => fail(403, "Lifecycle administration requires LIFECYCLE_ADMINS");

/** Structured audit line: who changed which app's lifecycle access. Never logs secrets. */
function audit(principal: AccessPrincipal, action: string, detail: Record<string, unknown>) {
  const by = principal.email ?? principal.sub;
  console.log(JSON.stringify({ event: "flightdeck.lifecycle_admin", action, by, ...detail }));
}

const appExists = async (env: Env, appId: string) =>
  (await env.DB.prepare("SELECT id FROM apps WHERE id = ?").bind(appId).first()) !== null;

/** `PUT` grants and `DELETE` revokes `lifecycle.write` for an app. */
export async function capabilityRoute(
  request: Request,
  env: Env,
  principal: AccessPrincipal,
  appId: string,
): Promise<Response> {
  if (request.method !== "PUT" && request.method !== "DELETE") {
    return fail(405, "Method not allowed", { Allow: "PUT, DELETE" });
  }
  if (!isLifecycleAdmin(env, principal)) return denied();
  if (!(await appExists(env, appId))) return fail(404, "Unknown app");
  if (request.method === "PUT") {
    const insert = await env.DB.prepare(
      "INSERT OR IGNORE INTO app_capabilities (app_id, capability) VALUES (?, 'lifecycle.write')",
    )
      .bind(appId)
      .run();
    const granted = insert.meta.changes > 0;
    if (granted) audit(principal, "grant", { app_id: appId, capability: "lifecycle.write" });
    return json({ app_id: appId, capability: "lifecycle.write", granted }, granted ? 201 : 200);
  }
  const result = await env.DB.prepare(
    "DELETE FROM app_capabilities WHERE app_id = ? AND capability = 'lifecycle.write'",
  )
    .bind(appId)
    .run();
  if (result.meta.changes === 0) return fail(404, "Not granted");
  audit(principal, "revoke", { app_id: appId, capability: "lifecycle.write" });
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

/** `PUT { scopes }` replaces a key's scopes. Changing scopes is lifecycle administration. */
export async function keyScopesRoute(
  request: Request,
  env: Env,
  principal: AccessPrincipal,
  appId: string,
  hash: string,
): Promise<Response> {
  if (request.method !== "PUT") return fail(405, "Method not allowed", { Allow: "PUT" });
  if (!isLifecycleAdmin(env, principal)) return denied();
  if (!TOKEN_HASH.test(hash)) return fail(400, "Expected a sha-256 hex digest");
  const parsed = await readJson(request);
  if (parsed instanceof Response) return parsed;
  const input = v.safeParse(v.strictObject({ scopes: Scopes }), parsed.body);
  if (!input.success) return fail(400, `Expected { scopes: [${SCOPES.join(" | ")}] }`);
  const scopes = input.output.scopes;
  const result = await env.DB.prepare(
    "UPDATE server_ingest_keys SET scopes = ? WHERE token_hash = ? AND app_id = ?",
  )
    .bind(storedScopes(scopes), hash, appId)
    .run();
  if (result.meta.changes === 0) return fail(404, "Unknown key");
  audit(principal, "set_scopes", { app_id: appId, token_hash: hash, scopes });
  return json({ key: { app_id: appId, token_hash: hash, scopes } });
}

export { audit as auditLifecycleAdmin };
