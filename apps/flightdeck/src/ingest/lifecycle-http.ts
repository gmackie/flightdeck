import { getApp } from "../apps";
import { limits, THROTTLE_RETRY_AFTER } from "../limits";
import { registerDefinition } from "../processes";
import { lifecycleDeps } from "./entrypoint";
import { ingestLifecycle, LifecycleRejected, LifecycleUnavailable } from "./lifecycle";
import { readJsonBody, reply, serverKey, unavailable } from "./server-auth";

const MAX_BYTES = 256 * 1024;

const throttled = () =>
  Response.json(
    { error: "Rate limit exceeded" },
    {
      status: 429,
      headers: { "Cache-Control": "no-store", "Retry-After": String(THROTTLE_RETRY_AFTER) },
    },
  );
/** A definition at its schema bounds (64 stages, 16 dimensions of 64 values) fits easily. */
const MAX_DEFINITION_BYTES = 128 * 1024;

/**
 * `POST /v1/lifecycle/events` for trusted server producers. Needs a key carrying the
 * `lifecycle.write` scope for an app an operator granted `lifecycle.write`. There is no browser,
 * cookie or Access path: the credential alone names the app.
 */
export async function lifecycleIngest(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  try {
    const key = await serverKey(request, env);
    if (!key) return reply(401, "Unauthorized");
    const app = await getApp(env.DB, key.appId);
    if (!app) return reply(401, "Unauthorized");
    if (!key.scopes.has("lifecycle.write") || !key.lifecycleGranted) return reply(403, "Forbidden");
    if (!(await limits.lifecycle(env, app.id))) return throttled();
    const body = await readJsonBody(request, MAX_BYTES, "Invalid lifecycle batch");
    if (body instanceof Response) return body;
    const result = await ingestLifecycle(
      app.id,
      body.value,
      "http",
      lifecycleDeps(env, app.id, ctx && ((work) => ctx.waitUntil(work))),
    );
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

/**
 * `POST /v1/lifecycle/processes` registers a `ProcessDefinitionV1` for the key's app, with the
 * same authorization as event writes. 201 created, 200 identical, 409 changed, 400 invalid.
 */
export async function processRegistration(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  try {
    const key = await serverKey(request, env);
    if (!key) return reply(401, "Unauthorized");
    const app = await getApp(env.DB, key.appId);
    if (!app) return reply(401, "Unauthorized");
    if (!key.scopes.has("lifecycle.write") || !key.lifecycleGranted) return reply(403, "Forbidden");
    if (!(await limits.lifecycle(env, app.id))) return throttled();
    const body = await readJsonBody(request, MAX_DEFINITION_BYTES, "Invalid process definition");
    if (body instanceof Response) return body;
    const result = await registerDefinition(env.DB, app.id, body.value);
    if (result.status === "invalid") {
      return reply(400, "Invalid process definition", { message: result.message });
    }
    if (result.status === "conflict") {
      return reply(409, "Process version already registered with different content");
    }
    const { processId, version } = result.definition;
    return Response.json(
      { process: { processId, version }, created: result.status === "created" },
      { status: result.status === "created" ? 201 : 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return unavailable();
  }
}
