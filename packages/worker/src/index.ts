import type { IngestRpc, RequestContext } from "@flightdeckhq/schema";

export type { ClientEventInput, IngestResult, IngestRpc } from "@flightdeckhq/schema";

export type FlightdeckOptions = {
  /** Env binding name of the Flightdeck service binding. Default `FLIGHTDECK`. */
  binding?: string;
  /** Endpoint path the browser script posts to. Default `/_fd/e`. */
  path?: string;
  /** Extra origins allowed to post, besides the request's own origin. */
  allowedOrigins?: string[];
  /** Default 64 KiB. */
  maxBodyBytes?: number;
};

const DEFAULT_PATH = "/_fd/e";
const DEFAULT_BINDING = "FLIGHTDECK";
const DEFAULT_MAX_BODY = 64 * 1024;
const CONTENT_TYPES = new Set(["text/plain", "application/json"]);

/** Returns the Flightdeck service binding from `env`, for server-side `track`/`identify` calls. */
export function flightdeck(
  env: object,
  options: Pick<FlightdeckOptions, "binding"> = {},
): IngestRpc {
  const name = options.binding ?? DEFAULT_BINDING;
  const binding = (env as Record<string, IngestRpc | undefined>)[name];
  if (!binding) throw new Error(`Flightdeck: env.${name} service binding is missing`);
  return binding;
}

/** Handles the browser endpoint. Returns null when the request is not for Flightdeck. */
export async function handleFlightdeck(
  request: Request,
  env: object,
  options: FlightdeckOptions = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== (options.path ?? DEFAULT_PATH)) return null;
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });

  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin && !options.allowedOrigins?.includes(origin)) {
    return new Response(null, { status: 403 });
  }

  // Beacons are sent as text/plain to avoid a CORS preflight; fetch callers may use JSON.
  const mediaType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (!mediaType || !CONTENT_TYPES.has(mediaType)) return new Response(null, { status: 415 });

  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maxBytes) return new Response(null, { status: 413 });

  const binding = flightdeck(env, options);

  // Content-Length may be absent or wrong, so enforce the limit on the bytes actually received.
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxBytes) return new Response(null, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof body !== "object" || body === null) return new Response(null, { status: 400 });

  const country = (request as { cf?: { country?: unknown } }).cf?.country;
  const userAgent = request.headers.get("User-Agent")?.slice(0, 512);
  const context: RequestContext = {
    ...(typeof country === "string" && country ? { country } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
  const accessJwt = request.headers.get("Cf-Access-Jwt-Assertion");

  try {
    await binding.ingest({
      events: (body as { events?: unknown }).events,
      context,
      ...(accessJwt ? { accessJwt } : {}),
    });
  } catch (err) {
    const invalid = err instanceof Error && err.message.startsWith("invalid batch");
    if (!invalid) console.error("Flightdeck ingest failed", err);
    return new Response(null, { status: invalid ? 400 : 502 });
  }
  return new Response(null, { status: 204 });
}

/** Wraps a Worker's default export so it serves the Flightdeck browser endpoint. */
export function withFlightdeck<E extends object>(
  handler: ExportedHandler<E>,
  options?: FlightdeckOptions,
): ExportedHandler<E> {
  return {
    ...handler,
    async fetch(request, env, ctx) {
      const res = await handleFlightdeck(request as unknown as Request, env, options);
      if (res) return res;
      if (!handler.fetch) return new Response("Not found", { status: 404 });
      return handler.fetch(request, env, ctx);
    },
  };
}
