import { apiRoutes } from "./api";
import { devRoutes } from "./dev";
import { dogfood } from "./dogfood";
import { serverIngest } from "./ingest/http";
import { lifecycleIngest, processRegistration } from "./ingest/lifecycle-http";
import { drainLifecycle } from "./lifecycle-projection/schedule";

export { AppDO } from "./do/app";
export { SessionDO } from "./do/session";
export { Ingest } from "./ingest/entrypoint";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/server/events") return serverIngest(request, env, ctx);
    if (url.pathname === "/v1/lifecycle/events") return lifecycleIngest(request, env, ctx);
    if (url.pathname === "/v1/lifecycle/processes") return processRegistration(request, env);
    if (url.pathname.startsWith("/_fd/")) return dogfood(request, ctx);
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    if (url.pathname.startsWith("/api/")) return apiRoutes(request, env, ctx);
    if (env.FLIGHTDECK_DEV === "1" && url.pathname.startsWith("/__dev/")) {
      return devRoutes(request, env);
    }
    return new Response("Not found", { status: 404 });
  },

  /** Retries lifecycle projection and Basin forwarding that did not finish at ingest time. */
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(drainLifecycle(env));
  },
} satisfies ExportedHandler<Env>;
