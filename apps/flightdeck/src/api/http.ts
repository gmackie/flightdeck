const NO_STORE = { "Cache-Control": "no-store" };

/** Admin API responses are per-caller and must never be cached by the edge or the browser. */
export const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: NO_STORE });

export const fail = (status: number, error: string, headers: Record<string, string> = {}) =>
  Response.json({ error }, { status, headers: { ...NO_STORE, ...headers } });

const MAX_BODY = 16 * 1024;

/**
 * Parses a small JSON body. Requiring `application/json` makes cross-site form posts
 * (which would carry the Access cookie) need a CORS preflight, which this API never grants.
 */
export async function readJson(request: Request): Promise<{ body: unknown } | Response> {
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    return fail(415, "Expected application/json");
  const text = await request.text();
  if (text.length > MAX_BODY) return fail(413, "Payload too large");
  try {
    return { body: JSON.parse(text) };
  } catch {
    return fail(400, "Invalid JSON");
  }
}
