import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { DOGFOOD_APP_ID, trackDogfood } from "../src/dogfood";
import { sinks } from "../src/sinks";
import { CHROME, sid } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

const post = (body: string, headers: Record<string, string> = {}) =>
  exports.default.fetch("https://flightdeck.test/_fd/e", {
    method: "POST",
    headers: { "Content-Type": "text/plain", "User-Agent": CHROME, ...headers },
    body,
  });

it("registers app_flightdeck through migration 0003", async () => {
  const app = await env.DB.prepare("SELECT id, name FROM apps WHERE id = ?")
    .bind(DOGFOOD_APP_ID)
    .first();
  expect(app).toEqual({ id: "app_flightdeck", name: "Flightdeck" });
});

it("ingests the dashboard's browser batches as app_flightdeck", async () => {
  const events = vi.spyOn(sinks, "events").mockResolvedValue(undefined);
  const res = await post(
    JSON.stringify({
      events: [
        { kind: "click", name: "nav.live", ts: Date.now(), path: "/live", sessionId: sid("d") },
      ],
    }),
    { Origin: "https://flightdeck.test" },
  );
  expect(res.status).toBe(204);
  expect(events.mock.calls[0]?.[1][0]).toMatchObject({
    app_id: "app_flightdeck",
    kind: "click",
    name: "nav.live",
    source: "browser",
    browser: "Chrome",
  });
});

it("applies the browser endpoint's checks", async () => {
  const events = vi.spyOn(sinks, "events").mockResolvedValue(undefined);
  expect((await post("{}", { Origin: "https://evil.test" })).status).toBe(403);
  expect((await post("{not json")).status).toBe(400);
  expect((await exports.default.fetch("https://flightdeck.test/_fd/e")).status).toBe(405);
  expect((await exports.default.fetch("https://flightdeck.test/_fd/other")).status).toBe(404);
  expect(events).not.toHaveBeenCalled();
});

it("trackDogfood records a server event without blocking the caller", async () => {
  const events = vi.spyOn(sinks, "events").mockResolvedValue(undefined);
  const ctx = createExecutionContext();
  trackDogfood(ctx, "app.registered", { app: "app_new" });
  await waitOnExecutionContext(ctx);
  expect(events.mock.calls[0]?.[1][0]).toMatchObject({
    app_id: "app_flightdeck",
    kind: "track",
    name: "app.registered",
    props: { app: "app_new" },
    source: "server",
  });
});

it("trackDogfood swallows ingest failures", async () => {
  vi.spyOn(sinks, "events").mockRejectedValue(new Error("pipeline down"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  const ctx = createExecutionContext();
  trackDogfood(ctx, "app.registered");
  await expect(waitOnExecutionContext(ctx)).resolves.toBeUndefined();
});
