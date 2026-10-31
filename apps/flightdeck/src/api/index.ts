import type { JWTVerifyGetKey } from "jose";
import * as v from "valibot";
import { forgetApp } from "../apps";
import { trackDogfood } from "../dogfood";
import { authenticate } from "./auth";
import { authorizeApp, legacyReadMode } from "./authorization";
import { fail, json, readJson } from "./http";
import { lifecycleRead } from "./lifecycle";
import { liveSocket, liveView, parseHours } from "./live";
import {
  appIdentity,
  MAX_KEY_LIFETIME_MS,
  NewApp,
  NewServerKey,
  serviceBinding,
  TOKEN_HASH,
} from "./registry";
import { parseTrendsQuery, trendsView } from "./trends";

type AppRow = { id: string; name: string; created_at: number };

const KEYS_ROUTE = /^\/api\/apps\/([\w-]{3,64})\/server-keys$/;
const KEY_ROUTE = /^\/api\/apps\/([\w-]{3,64})\/server-keys\/([^/]+)$/;
/** Read routes for one app: `live`, `live/ws` and `trends`. */
const QUERY_ROUTE = /^\/api\/apps\/([\w-]{3,64})\/(live|live\/ws|trends)$/;
const LIFECYCLE_ROUTE = /^\/api\/apps\/([\w-]{3,64})\/lifecycle(?:\/(.*))?$/;

/** The Access-protected admin API; `keys` lets tests verify tokens against a local JWKS. */
export async function apiRoutes(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  opts: { keys?: JWTVerifyGetKey } = {},
): Promise<Response> {
  const principal = await authenticate(request, env, opts.keys);
  if (principal instanceof Response) return principal;
  const url = new URL(request.url);
  const { pathname } = url;
  const { method } = request;

  const lifecycle = pathname.match(LIFECYCLE_ROUTE);
  if (lifecycle?.[1]) {
    return lifecycleRead(request, env, principal, lifecycle[1], lifecycle[2] ?? "");
  }

  if (pathname === "/api/me") {
    return method === "GET" ? json({ principal }) : notAllowed("GET");
  }
  if (pathname === "/api/apps") {
    if (method === "GET") return listApps(env);
    if (method === "POST") return registerApp(request, env, ctx);
    return notAllowed("GET, POST");
  }
  const keys = pathname.match(KEYS_ROUTE);
  if (keys?.[1]) return method === "POST" ? addKey(request, env, keys[1]) : notAllowed("POST");
  const key = pathname.match(KEY_ROUTE);
  if (key?.[1] && key[2]) {
    return method === "DELETE" ? deleteKey(env, key[1], key[2]) : notAllowed("DELETE");
  }
  const query = pathname.match(QUERY_ROUTE);
  if (query?.[1] && query[2]) {
    const mode = legacyReadMode(env);
    if (mode instanceof Response) return mode;
    if (mode === "enforce") {
      const scope = await authorizeApp(env, principal, query[1], "app:read");
      if (scope instanceof Response) return scope;
    }
    if (method !== "GET") return notAllowed("GET");
    return queryApp(request, url, env, ctx, query[1], query[2]);
  }
  return fail(404, "Not found");
}

/** Dashboard reads. The app must be registered, so a client never names an arbitrary shard. */
async function queryApp(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  appId: string,
  endpoint: string,
): Promise<Response> {
  const app = await env.DB.prepare("SELECT id FROM apps WHERE id = ?").bind(appId).first();
  if (!app) return fail(404, "Unknown app");
  if (endpoint === "live/ws") return liveSocket(request, env, appId);
  if (endpoint === "live") {
    const hours = parseHours(url.searchParams.get("hours"));
    if (hours === null) return fail(400, "hours must be an integer from 1 to 24");
    const view = await liveView(env, appId, hours);
    trackDogfood(ctx, "query.run", { endpoint, range: `${hours}h` });
    return json(view);
  }
  const parsed = parseTrendsQuery(url.searchParams);
  if (typeof parsed === "string") return fail(400, parsed);
  const view = await trendsView(env, appId, parsed);
  trackDogfood(ctx, "query.run", { endpoint, range: parsed.range });
  return json(view);
}

const notAllowed = (allow: string) => fail(405, "Method not allowed", { Allow: allow });

async function listApps(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, created_at FROM apps ORDER BY id",
  ).all<AppRow>();
  return json({ apps: results });
}

/** Idempotent: the id is derived from name + stage, so re-registering returns the existing app. */
async function registerApp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const parsed = await readJson(request);
  if (parsed instanceof Response) return parsed;
  const input = v.safeParse(NewApp, parsed.body);
  if (!input.success) return fail(400, "Expected { name, stage? }");
  const identity = appIdentity(input.output.name, input.output.stage);
  if (!identity) return fail(400, "Name must contain letters or digits and fit a 64-char id");
  const insert = await env.DB.prepare("INSERT OR IGNORE INTO apps (id, name) VALUES (?, ?)")
    .bind(identity.id, identity.name)
    .run();
  const app = await env.DB.prepare("SELECT id, name, created_at FROM apps WHERE id = ?")
    .bind(identity.id)
    .first<AppRow>();
  if (!app) return fail(503, "Registry unavailable");
  const created = insert.meta.changes > 0;
  if (created) {
    forgetApp(app.id);
    // Best effort dogfooding: never fails or delays registration.
    trackDogfood(ctx, "app.registered", { app_id: app.id });
  }
  const service = env.FLIGHTDECK_WORKER_NAME.trim() || "flightdeck";
  return json({ app, binding: serviceBinding(service, app.id) }, created ? 201 : 200);
}

async function addKey(request: Request, env: Env, appId: string): Promise<Response> {
  const parsed = await readJson(request);
  if (parsed instanceof Response) return parsed;
  const input = v.safeParse(NewServerKey, parsed.body);
  if (!input.success) return fail(400, "Expected { token_hash: <sha-256 hex>, expires_at: <ms> }");
  const { token_hash, expires_at } = input.output;
  const now = Date.now();
  if (expires_at <= now || expires_at > now + MAX_KEY_LIFETIME_MS) {
    return fail(400, "expires_at must be in the future and at most 400 days away");
  }
  const app = await env.DB.prepare("SELECT id FROM apps WHERE id = ?").bind(appId).first();
  if (!app) return fail(404, "Unknown app");
  const insert = await env.DB.prepare(
    "INSERT OR IGNORE INTO server_ingest_keys (token_hash, app_id, expires_at) VALUES (?, ?, ?)",
  )
    .bind(token_hash, appId, expires_at)
    .run();
  if (insert.meta.changes === 0) return fail(409, "Key already registered");
  return json({ key: { app_id: appId, token_hash, expires_at } }, 201);
}

async function deleteKey(env: Env, appId: string, hash: string): Promise<Response> {
  if (!TOKEN_HASH.test(hash)) return fail(400, "Expected a sha-256 hex digest");
  const result = await env.DB.prepare(
    "DELETE FROM server_ingest_keys WHERE token_hash = ? AND app_id = ?",
  )
    .bind(hash, appId)
    .run();
  if (result.meta.changes === 0) return fail(404, "Unknown key");
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
