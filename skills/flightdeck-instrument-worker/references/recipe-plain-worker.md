# Recipe: plain Worker, Hono, Durable Objects

References: ForgeGraph `apps/ci-control` and `apps/git-gateway` (object-literal default export with `fetch`, `scheduled`, `queue`), `examples/demo-app` in the Flightdeck repo.

## Object-literal Worker

```ts
import { withFlightdeck } from "@flightdeckhq/worker";
import { fdOptions, trackEvent } from "./flightdeck";

export default withFlightdeck<Env>(
  {
    async fetch(request, env, ctx) {
      // existing routing, unchanged
      const run = await createRun(request, env);
      trackEvent(env, (p) => ctx.waitUntil(p), { name: "run.created", props: { trigger: run.trigger } });
      return Response.json(run);
    },
    async scheduled(controller, env, ctx) {
      // unchanged; withFlightdeck keeps it
    },
  },
  fdOptions,
);
```

Backend-only Workers that serve no browser pages (ci-control, git-gateway, queue consumers) do not need `withFlightdeck`; add only the binding and `trackEvent` calls. In `queue`/`scheduled` handlers use their `ctx.waitUntil`.

## Hono

```ts
import { Hono } from "hono";
import { withFlightdeck } from "@flightdeckhq/worker";
import { fdOptions, trackEvent } from "./flightdeck";

const app = new Hono<{ Bindings: Env }>();

app.post("/api/invites", async (c) => {
  const invite = await createInvite(c.env, await c.req.json());
  trackEvent(c.env, (p) => c.executionCtx.waitUntil(p), { name: "invite.sent", props: { role: invite.role } });
  return c.json(invite, 201);
});

export default withFlightdeck<Env>({ fetch: app.fetch }, fdOptions);
```

Pass `{ fetch: app.fetch }` (Hono's documented Worker export), not `app` itself.

## `class extends WorkerEntrypoint` default export

`withFlightdeck` cannot wrap a class. Call `handleFlightdeck` first in its `fetch`:

```ts
import { WorkerEntrypoint } from "cloudflare:workers";
import { handleFlightdeck } from "@flightdeckhq/worker";
import { fdOptions } from "./flightdeck";

export default class extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    const fd = await handleFlightdeck(request, this.env, fdOptions);
    if (fd) return fd;
    return app(request, this.env, this.ctx);
  }
}
```

## Durable Objects

Bindings reach a DO through its constructor (`this.env`), so the `FLIGHTDECK` binding needs no extra wiring. Use the DO's own `waitUntil`:

```ts
import { DurableObject } from "cloudflare:workers";
import { trackEvent } from "./flightdeck";

export class Room extends DurableObject<Env> {
  async close(reason: "idle" | "finished") {
    // ...existing close logic
    trackEvent(this.env, (p) => this.ctx.waitUntil(p), { name: "room.closed", props: { reason } });
  }
}
```

If a DO itself serves pages that post events (the browser talks to the DO URL directly), serve the endpoint from the DO with `handleFlightdeck(request, this.env, (env) => ({ ...fdOptions(env), path: "/room/_fd/e" }))` and init the browser SDK with `endpoint: "/room/_fd/e"` (see `examples/demo-app/src/counter.ts`).

Emit lifecycle events (created, joined, finished, closed), never per message, tick or alarm.

## Options worth knowing

`FlightdeckOptions` (all optional): `binding` (default `"FLIGHTDECK"`), `path` (default `"/_fd/e"`), `allowedOrigins` (extra page origins allowed to post, for routers/proxies that rewrite the host), `maxBodyBytes` (default 64 KiB), `beforeSend`, `hashUserId`. `flightdeck(env, options)` uses `binding`, `beforeSend` and `hashUserId`. All three SDK functions accept either an options object or a function of `env` (the helper module's `fdOptions`), resolved per request. Set options such as `allowedOrigins` inside `fdOptions`, so one value serves every call.
