import { DurableObject } from "cloudflare:workers";
import { handleFlightdeck } from "@flightdeckhq/worker";

/** Shows the endpoint inside a Durable Object: the DO's own fetch serves /room/_fd/e. */
export class Counter extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const fd = await handleFlightdeck(request, this.env, { path: "/room/_fd/e" });
    if (fd) return fd;
    return new Response("counter");
  }
}
