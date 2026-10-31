import { createMcpHandler } from "@modelcontextprotocol/server";
import type { JWTVerifyGetKey } from "jose";
import { authenticate } from "./auth";
import { Authorizer } from "./authorize";
import { LIMITS } from "./bounds";
import { type Config, type ConfigEnv, readConfig } from "./config";
import { createLifecycleServer } from "./server";
import type { LifecycleReadSource } from "./source";
import { ReadApiLifecycleSource } from "./sources/read-api";
import { SyntheticLifecycleSource } from "./sources/synthetic";

export type WorkerEnv = ConfigEnv & {
  /** The future Workstream H read API; see `sources/read-api.ts`. */
  LIFECYCLE_READ_API?: Fetcher;
};

/** Test seams: a local JWKS, an injected source and a fixed clock. */
export type Deps = {
  keys?: JWTVerifyGetKey;
  source?: LifecycleReadSource;
  now?: () => number;
};

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The only request methods this server answers. The SDK rejects a body whose method disagrees
 * with the `Mcp-Method` header, so the header can be trusted. Everything else, notably
 * `subscriptions/listen` (a long-lived stream) and `tasks/*`, is refused before dispatch.
 */
const ALLOWED_METHODS = new Set([
  "server/discover",
  "ping",
  "tools/list",
  "tools/call",
  "prompts/list",
  "prompts/get",
  "resources/list",
  "resources/templates/list",
  "resources/read",
]);

const methodNotFound = () =>
  Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32601, message: "Method not found" } },
    { status: 404, headers: NO_STORE },
  );

const fail = (status: number, error: string, headers: Record<string, string> = {}) =>
  Response.json({ error }, { status, headers: { ...NO_STORE, ...headers } });

export function createSource(
  config: Config,
  env: WorkerEnv,
  now: () => number,
): LifecycleReadSource {
  return config.source === "synthetic"
    ? new SyntheticLifecycleSource({ now })
    : new ReadApiLifecycleSource(env.LIFECYCLE_READ_API);
}

/**
 * Serves `/mcp` only. Configuration, Origin and Access identity are checked before any MCP
 * parsing, so an unauthenticated caller cannot even list tools.
 */
export async function handleRequest(
  request: Request,
  env: WorkerEnv,
  deps: Deps = {},
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/mcp") return fail(404, "Not found");

  const config = readConfig(env);
  if ("error" in config) return fail(config.status, config.error);

  // Browsers attach the Access cookie cross-site; only listed origins may call (DNS rebinding too).
  const origin = request.headers.get("Origin");
  if (origin !== null && !config.allowedOrigins.has(origin)) return fail(403, "Origin not allowed");

  const principal = await authenticate(request, config, deps.keys);
  if (!principal) return fail(401, "Unauthorized");

  const method = request.headers.get("Mcp-Method");
  if (method !== null && !ALLOWED_METHODS.has(method) && !method.startsWith("notifications/")) {
    return methodNotFound();
  }

  const now = deps.now ?? Date.now;
  const source = deps.source ?? createSource(config, env, now);
  const ctx = {
    source,
    authorizer: new Authorizer(principal, source, now),
    minCohort: config.minCohort,
    now,
  };
  const handler = createMcpHandler(() => createLifecycleServer(ctx), {
    // Modern (2026-07-28) stateless protocol only: no 2025 sessions, no legacy SSE.
    legacy: "reject",
    maxRequestBodySize: LIMITS.maxRequestBytes,
  });
  const response = await handler.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers });
}
