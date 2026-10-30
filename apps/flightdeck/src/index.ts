import { devRoutes } from "./dev";

export { AppDO } from "./do/app";
export { SessionDO } from "./do/session";
export { Ingest } from "./ingest/entrypoint";

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    if (env.FLIGHTDECK_DEV === "1" && url.pathname.startsWith("/__dev/")) {
      return devRoutes(request, env);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
