import { createFlightdeck } from "@flightdeck/sdk-worker";
import type { AnalyticsBinding } from "@flightdeck/contracts";

type Env = { FLIGHTDECK: AnalyticsBinding; FLIGHTDECK_SOURCE_ID: string; FLIGHTDECK_SOURCE_TOKEN: string };
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Replace with your application's session authentication.
    const user = await authenticate(request);
    if (!user) return new Response("Unauthorized", { status: 401 });
    const flightdeck = createFlightdeck({
      binding: env.FLIGHTDECK, sourceId: env.FLIGHTDECK_SOURCE_ID,
      sourceToken: env.FLIGHTDECK_SOURCE_TOKEN,
      defaults: () => ({ actorId: user.id }),
    });
    if (new URL(request.url).pathname === "/api/telemetry" && request.method === "POST") {
      // Explicit allowlist: never forward arbitrary browser properties or identities.
      const body: unknown = await request.json();
      if (!body || typeof body !== "object" || !("action" in body) || body.action !== "project_opened")
        return new Response("Invalid event", { status: 400 });
      await flightdeck.track("project.opened", {}, { actorId: user.id });
      return Response.json({ ok: true });
    }
    await flightdeck.track("page.requested", { path: new URL(request.url).pathname });
    return new Response("Hello");
  },
};
async function authenticate(_request: Request): Promise<{id:string}|null> {
  // Application-specific auth: do not ship this placeholder to production.
  return null;
}
