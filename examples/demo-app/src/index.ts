import { flightdeck, withFlightdeck } from "@flightdeckhq/worker";

export { Counter } from "./counter";

export default withFlightdeck<Env>({
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/checkout") {
      // Server-side event: goes straight over the service binding, no browser involved.
      ctx.waitUntil(flightdeck(env).track({ name: "checkout.completed", props: { plan: "pro" } }));
      return Response.json({ ok: true });
    }
    if (url.pathname.startsWith("/room/")) {
      return env.COUNTER.get(env.COUNTER.idFromName("demo")).fetch(request);
    }
    return new Response("Not found", { status: 404 });
  },
});
