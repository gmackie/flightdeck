import { getApp } from "../apps";
import { deps } from "./entrypoint";
import { IngestError, ingestBatch } from "./service";

const MAX_BYTES = 256 * 1024;
const reply = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });

/** App identity comes from a revocable, expiring credential, never the payload. */
export async function serverIngest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const authorization = request.headers.get("Authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization)) return reply(401, "Unauthorized");
  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(authorization.slice(7)),
    );
    const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    const key = await env.DB.prepare(
      "SELECT app_id FROM server_ingest_keys WHERE token_hash = ? AND expires_at > ?",
    )
      .bind(hash, Date.now())
      .first<{ app_id: string }>();
    if (!key) return reply(401, "Unauthorized");
    const app = await getApp(env.DB, key.app_id);
    if (!app) return reply(401, "Unauthorized");
    if (
      request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    )
      return reply(415, "Expected application/json");
    if (Number(request.headers.get("Content-Length")) > MAX_BYTES)
      return reply(413, "Payload too large");
    const reader = request.body?.getReader();
    if (!reader) return reply(400, "Invalid batch");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) {
          await reader.cancel();
          return reply(413, "Payload too large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
    } catch {
      return reply(400, "Invalid JSON");
    }
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
    // Never echo payloads, credentials or sink errors to the producer/logs.
    return new Response(JSON.stringify({ error: "Ingestion unavailable" }), {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Retry-After": "5",
      },
    });
  }
}
