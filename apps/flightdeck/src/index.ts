export { AppDO } from "./do/app";
export { SessionDO } from "./do/session";
export { Ingest } from "./ingest/entrypoint";

export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
