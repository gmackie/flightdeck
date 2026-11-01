import { getApp } from "../apps";
import { deps } from "./entrypoint";
import { readJsonBody, reply, serverKey, unavailable } from "./server-auth";
import { IngestError, ingestBatch } from "./service";

const MAX_BYTES = 256 * 1024;

/** App identity comes from a revocable, expiring credential, never the payload. */
export async function serverIngest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  try {
    const key = await serverKey(request, env);
    if (!key) return reply(401, "Unauthorized");
    const app = await getApp(env.DB, key.appId);
    if (!app) return reply(401, "Unauthorized");
    // A lifecycle-only key cannot write generic events.
    if (!key.scopes.has("events.write")) return reply(403, "Forbidden");
    const body = await readJsonBody(request, MAX_BYTES, "Invalid batch");
    if (body instanceof Response) return body;
    const input = body.value;
    // This API accepts server track events only: no browser identity assertion or Access JWT.
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((k) => k !== "events")
    )
      return reply(400, "Invalid batch");
    const events = (input as { events?: unknown }).events;
    if (
      !Array.isArray(events) ||
      events.some((e) => !e || typeof e !== "object" || Array.isArray(e) || e.kind !== "track")
    )
      return reply(400, "Expected track events");
    const result = await ingestBatch(app.id, { events }, "server", deps(env, ctx, app));
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof IngestError) return reply(400, "Invalid batch");
    return unavailable();
  }
}
