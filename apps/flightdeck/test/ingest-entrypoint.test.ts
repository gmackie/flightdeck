import { createExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { hourKey } from "@flightdeckhq/schema";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { appShard } from "../src/do/shards";
import worker from "../src/index";
import { sinks } from "../src/sinks";
import { CHROME, sid } from "./fixtures";

const APPS = [
  "app_e2e_browser",
  "app_e2e_server",
  "app_e2e_invalid",
  "app_e2e_dev",
  "app_e2e_sinkfail",
];

beforeAll(async () => {
  await env.DB.batch(
    APPS.map((id) => env.DB.prepare("INSERT INTO apps (id, name) VALUES (?, ?)").bind(id, id)),
  );
});
afterEach(() => vi.restoreAllMocks());

const ingestFor = (appId: string) => exports.Ingest({ props: { appId } });

/** Awaits an RPC call and returns its error message; `expect().rejects` leaves the RPC promise unhandled. */
async function rpcError(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the RPC call to reject");
}

it("rejects unknown apps and missing props", async () => {
  expect(await rpcError(() => ingestFor("app_missing").ingest({ events: [] }))).toMatch(
    /unknown app/,
  );
  expect(await rpcError(() => exports.Ingest({ props: {} }).ingest({ events: [] }))).toMatch(
    /props.appId/,
  );
});

it("ingests a browser batch into Pipelines and the hour shard", async () => {
  const events = vi.spyOn(sinks, "events").mockResolvedValue(undefined);
  const ts = Date.now();
  const res = await ingestFor("app_e2e_browser").ingest({
    events: [{ kind: "page", name: "/users/42", path: "/users/42", ts, sessionId: sid("e") }],
    context: { userAgent: CHROME, country: "GB" },
  });
  expect(res).toEqual({ accepted: 1, rejected: 0 });
  expect(events.mock.calls[0]?.[1][0]).toMatchObject({
    app_id: "app_e2e_browser",
    path: "/users/:id",
    country: "GB",
    source: "browser",
  });
  // DO fan-out runs after the response via waitUntil, so poll for it.
  await vi.waitFor(async () => {
    const snap = await appShard(env, "app_e2e_browser", hourKey(ts)).snapshot();
    expect(snap.counters).toContainEqual({ kind: "page", name: "/users/:id", count: 1 });
    expect(snap.sessions).toBe(1);
  });
});

it("fails the call when the Pipelines send fails", async () => {
  vi.spyOn(sinks, "events").mockRejectedValue(new Error("pipeline down"));
  expect(
    await rpcError(() =>
      ingestFor("app_e2e_sinkfail").ingest({
        events: [{ kind: "track", name: "x", ts: Date.now() }],
      }),
    ),
  ).toMatch(/pipeline down/);
});

it("track() and identify() record server events", async () => {
  const events = vi.spyOn(sinks, "events").mockResolvedValue(undefined);
  const ingest = ingestFor("app_e2e_server");
  expect(
    await ingest.track({ name: "invoice.paid", userId: "u_1", props: { plan: "pro" } }),
  ).toEqual({ accepted: 1, rejected: 0 });
  expect(await ingest.identify({ userId: "u_1", anonymousId: sid("y") })).toEqual({
    accepted: 1,
    rejected: 0,
  });
  expect(
    events.mock.calls.map(([, rows]) => [rows[0]?.kind, rows[0]?.name, rows[0]?.source]),
  ).toEqual([
    ["track", "invoice.paid", "server"],
    ["identify", "identify", "server"],
  ]);
});

it("rejects identify() without a userId and track() with a non-object", async () => {
  const events = vi.spyOn(sinks, "events").mockResolvedValue(undefined);
  const ingest = ingestFor("app_e2e_invalid");
  expect(await ingest.identify({})).toEqual({ accepted: 0, rejected: 1 });
  expect(await ingest.track("invoice.paid")).toEqual({ accepted: 0, rejected: 1 });
  expect(events).not.toHaveBeenCalled();
});

it("serves dev routes in dev mode", async () => {
  const res = await exports.default.fetch(
    `http://flightdeck.test/__dev/apps/app_e2e_dev/hours/${hourKey(Date.now())}`,
  );
  expect(res.status).toBe(200);
  expect(await res.json()).toHaveProperty("counters");
});

it("registers apps over POST /__dev/apps and validates the body", async () => {
  const post = (body: unknown) =>
    exports.default.fetch("http://flightdeck.test/__dev/apps", {
      method: "POST",
      body: JSON.stringify(body),
    });
  expect((await post({ id: "app_dev_new", name: "Dev" })).status).toBe(201);
  const row = await env.DB.prepare("SELECT name FROM apps WHERE id = 'app_dev_new'").first();
  expect(row).toEqual({ name: "Dev" });

  expect((await post({ id: "a!", name: "Bad" })).status).toBe(400);
  expect((await post({ id: "app_dev_x", name: "" })).status).toBe(400);
  expect((await post({ id: "app_dev_x" })).status).toBe(400);
  expect((await post("nope")).status).toBe(400);
  const bad = await exports.default.fetch("http://flightdeck.test/__dev/apps", {
    method: "POST",
    body: "{not json",
  });
  expect(bad.status).toBe(400);
});

it("hides dev routes unless FLIGHTDECK_DEV is 1", async () => {
  const res = await worker.fetch(
    new Request(`http://flightdeck.test/__dev/apps/app_e2e_dev/hours/${hourKey(Date.now())}`),
    { ...env, FLIGHTDECK_DEV: "0" },
    createExecutionContext(),
  );
  expect(res.status).toBe(404);
});
