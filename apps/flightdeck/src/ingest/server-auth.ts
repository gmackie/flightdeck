/** What a server ingest key may write. Keys predating scopes hold `events.write` only. */
export type ServerScope = "events.write" | "lifecycle.write";

export type ServerKey = {
  appId: string;
  scopes: ReadonlySet<string>;
  /** Whether an operator granted the key's app `lifecycle.write` (`app_capabilities`). */
  lifecycleGranted: boolean;
};

const BEARER = /^Bearer [A-Za-z0-9_-]{32,256}$/;

/**
 * Looks up the request's bearer key on every call, so expiry and revocation are immediate.
 * Returns null for a missing, malformed, unknown or expired key. App identity comes only from
 * here, never from the payload.
 */
export async function serverKey(request: Request, env: Env): Promise<ServerKey | null> {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!BEARER.test(authorization)) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(authorization.slice(7)),
  );
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  const key = await env.DB.prepare(
    `SELECT k.app_id, k.scopes, EXISTS (
       SELECT 1 FROM app_capabilities c
       WHERE c.app_id = k.app_id AND c.capability = 'lifecycle.write'
     ) AS lifecycle_granted
     FROM server_ingest_keys k WHERE k.token_hash = ? AND k.expires_at > ?`,
  )
    .bind(hash, Date.now())
    .first<{ app_id: string; scopes: string; lifecycle_granted: number }>();
  if (!key) return null;
  return {
    appId: key.app_id,
    scopes: new Set(key.scopes.split(/\s+/).filter(Boolean)),
    lifecycleGranted: key.lifecycle_granted === 1,
  };
}

/** Whether the app bound by a service binding may write lifecycle events. Uncached. */
export async function lifecycleGranted(db: D1Database, appId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM app_capabilities WHERE app_id = ? AND capability = 'lifecycle.write'")
    .bind(appId)
    .first();
  return row !== null;
}

export const reply = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  Response.json({ error, ...extra }, { status, headers: { "Cache-Control": "no-store" } });

/** Never echo payloads, credentials or sink errors to the producer. */
export const unavailable = (retryAfter = 5) =>
  new Response(JSON.stringify({ error: "Ingestion unavailable" }), {
    status: 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfter),
    },
  });

/**
 * Reads a JSON body of at most `maxBytes`, enforcing the limit on the bytes actually received
 * (Content-Length may be absent or wrong). Returns the parsed value or an error response.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number,
  invalid: string,
): Promise<{ value: unknown } | Response> {
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    return reply(415, "Expected application/json");
  if (Number(request.headers.get("Content-Length")) > maxBytes)
    return reply(413, "Payload too large");
  const reader = request.body?.getReader();
  if (!reader) return reply(400, invalid);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
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
  try {
    return {
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body)),
    };
  } catch {
    return reply(400, "Invalid JSON");
  }
}
