import type { AccessPrincipal } from "../access";
import { authorizeLifecycleRead } from "./authorization";
import { fail, json } from "./http";
import { LIFECYCLE_POLICY, parseProjection } from "./lifecycle-policy";

/** Policy/schema discovery only. No ingestion table dependency or synthetic personnel rows. */
export async function lifecycleRead(
  request: Request,
  env: Env,
  principal: AccessPrincipal,
  appId: string,
  endpoint: string,
): Promise<Response> {
  const scope = await authorizeLifecycleRead(
    env,
    principal,
    appId,
    endpoint === "projection" ? "process:read" : "lifecycle:read",
  );
  if (scope instanceof Response) return scope;
  if (request.method !== "GET") return fail(405, "Method not allowed", { Allow: "GET" });
  if (endpoint === "policy") return json({ app_id: scope.appId, policy: LIFECYCLE_POLICY });
  if (endpoint === "projection") {
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((name) => name !== "dimensions"))
      return fail(400, "Invalid projection");
    const dimensions = parseProjection(
      params.getAll("dimensions").flatMap((value) => value.split(",")),
    );
    if (!dimensions) return fail(400, "Invalid projection");
    return json({ app_id: scope.appId, dimensions, policy_version: LIFECYCLE_POLICY.version });
  }
  // Reserve the namespace: unknown future lifecycle endpoints still require a grant.
  return fail(404, "Not found");
}
