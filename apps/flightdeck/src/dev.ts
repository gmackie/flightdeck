import { appShard } from "./do/shards";

const SNAPSHOT_ROUTE = /^\/__dev\/apps\/([\w-]+)\/hours\/(\d{4}-\d{2}-\d{2}T\d{2})$/;
const APP_ID = /^[\w-]{3,64}$/;

/** Local-only inspection routes; the Phase 3 dashboard API replaces them. */
export async function devRoutes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const [, appId, hour] = url.pathname.match(SNAPSHOT_ROUTE) ?? [];
  if (request.method === "GET" && appId && hour) {
    return Response.json(await appShard(env, appId, hour).snapshot());
  }
  if (request.method === "POST" && url.pathname === "/__dev/apps") {
    const app = parseApp(await request.json().catch(() => null));
    if (!app) return new Response("Expected { id, name }", { status: 400 });
    await env.DB.prepare("INSERT OR IGNORE INTO apps (id, name) VALUES (?, ?)")
      .bind(app.id, app.name)
      .run();
    return new Response(null, { status: 201 });
  }
  return new Response("Not found", { status: 404 });
}

function parseApp(body: unknown): { id: string; name: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const { id, name } = body as Record<string, unknown>;
  if (typeof id !== "string" || !APP_ID.test(id)) return null;
  if (typeof name !== "string" || !name.trim()) return null;
  return { id, name };
}
