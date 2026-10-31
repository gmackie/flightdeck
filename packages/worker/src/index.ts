import type { IngestRpc, RequestContext } from "@flightdeckhq/schema";
import { type PrivacyOptions, withPrivacy } from "./privacy";

export type { ClientEventInput, IngestResult, IngestRpc } from "@flightdeckhq/schema";
export type { PrivacyOptions } from "./privacy";

export type FlightdeckOptions = PrivacyOptions & {
  /** Env binding name of the Flightdeck service binding. Default `FLIGHTDECK`. */
  binding?: string;
  /** Endpoint path the browser script posts to. Default `/_fd/e`. */
  path?: string;
  /** Extra origins allowed to post, besides the request's own origin. */
  allowedOrigins?: string[];
  /** Default 64 KiB. */
  maxBodyBytes?: number;
};

/**
 * Options, or a function that builds them from the request's `env` (called per request, e.g. to
 * read a `hashUserId` salt from a secret).
 */
export type FlightdeckOptionsInput<E = never> = FlightdeckOptions | ((env: E) => FlightdeckOptions);

/** Resolves a per-request options function against `env`. */
function resolve<E>(options: FlightdeckOptionsInput<E> | undefined, env: E): FlightdeckOptions {
  return (typeof options === "function" ? options(env) : options) ?? {};
}

const DEFAULT_PATH = "/_fd/e";
const DEFAULT_BINDING = "FLIGHTDECK";
const DEFAULT_MAX_BODY = 64 * 1024;
const CONTENT_TYPES = new Set(["text/plain", "application/json"]);

/**
 * Returns the Flightdeck service binding from `env`, for server-side `track`/`identify` calls.
 * With `beforeSend` or `hashUserId` set, returns a wrapper that applies them to every event.
 */
export function flightdeck<E extends object>(env: E, input?: FlightdeckOptionsInput<E>): IngestRpc {
  const options = resolve(input, env);
  const name = options.binding ?? DEFAULT_BINDING;
  const binding = (env as Record<string, IngestRpc | undefined>)[name];
  if (!binding) throw new Error(`Flightdeck: env.${name} service binding is missing`);
  return withPrivacy(binding, options);
}

/** Reads `stream` up to `maxBytes`. Returns null, cancelling the rest unread, once it exceeds the limit. */
async function readLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Handles the browser endpoint. Returns null when the request is not for Flightdeck. */
export async function handleFlightdeck<E extends object>(
  request: Request,
  env: E,
  input?: FlightdeckOptionsInput<E>,
): Promise<Response | null> {
  const options = resolve(input, env);
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
  if (!request.body) return new Response(null, { status: 400 });
  const bytes = await readLimited(request.body, maxBytes);
  if (!bytes) return new Response(null, { status: 413 });
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

/**
 * Wraps a Worker's default export so it serves the Flightdeck browser endpoint.
 *
 * The result inherits from `handler` (`Object.create`), so other handlers such as `scheduled`
 * or `queue` keep working, including methods on a class instance's prototype. Only `fetch` is
 * overridden, and it calls `handler.fetch` with `this` bound to `handler`.
 *
 * Not supported: a `class extends WorkerEntrypoint` default export, which the runtime
 * instantiates itself. Call `handleFlightdeck` at the top of its `fetch` method instead.
 *
 * `options` may be a function of `env`, called for each request; use it when options depend
 * on bindings or secrets (a `hashUserId` salt). Pass the same value to `flightdeck(env, options)`
 * so server events get the same treatment.
 *
 * Behind a proxy that rewrites the URL (so the Worker sees a different host than the page),
 * the page's origin differs from the request's and must be listed in `allowedOrigins`.
 */
export function withFlightdeck<E extends object>(
  handler: ExportedHandler<E>,
  options?: FlightdeckOptionsInput<E>,
): ExportedHandler<E> {
  const wrapped: ExportedHandler<E> = Object.create(handler);
  wrapped.fetch = async (request, env, ctx) => {
    const res = await handleFlightdeck(request as unknown as Request, env, options);
    if (res) return res;
    if (!handler.fetch) return new Response("Not found", { status: 404 });
    return handler.fetch(request, env, ctx);
  };
  return wrapped;
}
