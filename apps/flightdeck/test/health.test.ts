import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("serves /healthz", async () => {
  const res = await exports.default.fetch("http://flightdeck.test/healthz");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
