import { getApp } from "../apps";
import { lifecycleDeps } from "./entrypoint";
import { ingestLifecycle, LifecycleRejected, LifecycleUnavailable } from "./lifecycle";
import { readJsonBody, reply, serverKey, unavailable } from "./server-auth";

const MAX_BYTES = 256 * 1024;

/**
 * `POST /v1/lifecycle/events` for trusted server producers. Needs a key carrying the
 * `lifecycle.write` scope for an app an operator granted `lifecycle.write`. There is no browser,
 * cookie or Access path: the credential alone names the app.
 */
export async function lifecycleIngest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  try {
    const key = await serverKey(request, env);
    if (!key) return reply(401, "Unauthorized");
    const app = await getApp(env.DB, key.appId);
    if (!app) return reply(401, "Unauthorized");
    if (!key.scopes.has("lifecycle.write") || !key.lifecycleGranted) return reply(403, "Forbidden");
    const body = await readJsonBody(request, MAX_BYTES, "Invalid lifecycle batch");
    if (body instanceof Response) return body;
    const result = await ingestLifecycle(app.id, body.value, "http", lifecycleDeps(env));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof LifecycleRejected) {
      return reply(400, "Invalid lifecycle batch", { issues: error.issues });
    }
    // The stream is not provisioned yet: retryable once an operator binds it.
    if (error instanceof LifecycleUnavailable) return unavailable(60);
    return unavailable();
  }
}
