import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { appIdentity, slugify } from "../src/api/registry";
import { getApp } from "../src/apps";
import { sinks } from "../src/sinks";

// The test Worker runs with FLIGHTDECK_DEV=1 and no Access config, so the dev principal applies.
const api = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  exports.default.fetch(`https://flightdeck.test${path}`, {
    ...init,
    ...(init.json !== undefined
      ? {
          body: JSON.stringify(init.json),
          headers: { "Content-Type": "application/json" },
          method: init.method ?? "POST",
        }
      : {}),
  });

const hex = (c: string) => c.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

afterEach(() => vi.restoreAllMocks());

describe("app ids", () => {
  it("slugifies names", () => {
    expect(slugify("ForgeGraph Web")).toBe("forgegraph-web");
    expect(slugify("  Café__Crème!! ")).toBe("cafe-creme");
    expect(slugify("!!!")).toBe("");
  });

  it("uses app_<slug> for production and app_<slug>_<stage> otherwise", () => {
    expect(appIdentity("Demo")).toEqual({ id: "app_demo", name: "Demo" });
    expect(appIdentity("bob", "production")).toEqual({ id: "app_bob", name: "bob" });
    expect(appIdentity("Kanbanger", "staging")).toEqual({
      id: "app_kanbanger_staging",
      name: "Kanbanger (staging)",
    });
    expect(appIdentity("???")).toBeNull();
    expect(appIdentity("x".repeat(64))).toBeNull();
  });
});

describe("/api/apps", () => {
  it("registers an app and returns the wrangler service binding", async () => {
    vi.spyOn(sinks, "events").mockResolvedValue();
    const res = await api("/api/apps", { json: { name: "Kanbanger", stage: "Staging" } });
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json<{ app: { id: string; name: string; created_at: number } }>();
    expect(body).toEqual({
      app: {
        id: "app_kanbanger_staging",
        name: "Kanbanger (staging)",
        created_at: expect.any(Number),
      },
      binding: {
        binding: "FLIGHTDECK",
        service: "flightdeck",
        entrypoint: "Ingest",
        props: { appId: "app_kanbanger_staging" },
      },
    });
    expect(await getApp(env.DB, "app_kanbanger_staging")).not.toBeNull();
  });

  it("is idempotent for the same name and stage", async () => {
    vi.spyOn(sinks, "events").mockResolvedValue();
    const first = await api("/api/apps", { json: { name: "Wafflehouse" } });
    expect(first.status).toBe(201);
    const again = await api("/api/apps", { json: { name: "wafflehouse", stage: "production" } });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
  });

  it("forgets a cached miss when an app is registered", async () => {
    vi.spyOn(sinks, "events").mockResolvedValue();
    expect(await getApp(env.DB, "app_late")).toBeNull();
    await api("/api/apps", { json: { name: "late" } });
    expect(await getApp(env.DB, "app_late")).not.toBeNull();
  });

  it("emits a best-effort app.registered dogfood event", async () => {
    const events = vi.spyOn(sinks, "events").mockResolvedValue();
    await api("/api/apps", { json: { name: "dogfood" } });
    await vi.waitFor(() =>
      expect(events.mock.calls.flatMap((c) => c[1])).toContainEqual(
        expect.objectContaining({
          app_id: "app_flightdeck",
          name: "app.registered",
          props: { app_id: "app_dogfood" },
        }),
      ),
    );
  });

  it("still registers when the dogfood event fails, and logs it", async () => {
    vi.spyOn(sinks, "events").mockRejectedValue(new Error("down"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await api("/api/apps", { json: { name: "resilient" } })).status).toBe(201);
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith("Flightdeck dogfood event failed", "app.registered"),
    );
    // Only the event name: the error could carry sink internals.
    expect(JSON.stringify(log.mock.calls)).not.toContain("down");
  });

  it("lists apps with the fixed { apps: [{ id, name, created_at }] } contract", async () => {
    const res = await api("/api/apps");
    expect(res.status).toBe(200);
    const { apps } = await res.json<{ apps: Record<string, unknown>[] }>();
    expect(apps).toContainEqual({
      id: "app_flightdeck",
      name: "Flightdeck",
      created_at: expect.any(Number),
    });
    for (const app of apps) expect(Object.keys(app).sort()).toEqual(["created_at", "id", "name"]);
  });

  it("validates input", async () => {
    for (const json of [
      null,
      [],
      {},
      { name: "" },
      { name: "!!!" },
      { name: 3 },
      { name: "a", stage: "bad stage" },
      { name: "x".repeat(65) },
    ])
      expect((await api("/api/apps", { json })).status).toBe(400);
    const text = await api("/api/apps", { method: "POST", body: '{"name":"x"}' });
    expect(text.status).toBe(415);
    const malformed = await api("/api/apps", {
      method: "POST",
      body: "{",
      headers: { "Content-Type": "application/json" },
    });
    expect(malformed.status).toBe(400);
    expect((await api("/api/apps", { method: "PUT" })).status).toBe(405);
    expect((await api("/api/nope")).status).toBe(404);
  });
});

describe("server ingest keys", () => {
  beforeAll(async () => {
    await env.DB.prepare("INSERT INTO apps (id, name) VALUES ('app_keyed', 'Keyed')").run();
  });

  const add = (body: unknown, appId = "app_keyed") =>
    api(`/api/apps/${appId}/server-keys`, { json: body });

  it("stores a digest that authenticates server ingestion, then revokes it", async () => {
    vi.spyOn(sinks, "events").mockResolvedValue();
    const raw = "k".repeat(43);
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw))),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    const expires_at = Date.now() + 90 * DAY;
    const res = await add({ token_hash: digest, expires_at });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      key: { app_id: "app_keyed", token_hash: digest, expires_at },
    });
    expect((await add({ token_hash: digest, expires_at })).status).toBe(409);

    const ingest = () =>
      exports.default.fetch("https://flightdeck.test/v1/server/events", {
        method: "POST",
        headers: { Authorization: `Bearer ${raw}`, "Content-Type": "application/json" },
        body: JSON.stringify({ events: [{ kind: "track", name: "x.done", ts: Date.now() }] }),
      });
    expect((await ingest()).status).toBe(200);

    expect(
      (await api(`/api/apps/app_other/server-keys/${digest}`, { method: "DELETE" })).status,
    ).toBe(404);
    expect(
      (await api(`/api/apps/app_keyed/server-keys/${digest}`, { method: "DELETE" })).status,
    ).toBe(204);
    expect(
      (await api(`/api/apps/app_keyed/server-keys/${digest}`, { method: "DELETE" })).status,
    ).toBe(404);
    expect((await ingest()).status).toBe(401);
  });

  it("validates hash format, expiry bounds and the app", async () => {
    const now = Date.now();
    for (const body of [
      { token_hash: "abc", expires_at: now + DAY },
      { token_hash: hex("A"), expires_at: now + DAY },
      { token_hash: hex("a"), expires_at: now - 1 },
      { token_hash: hex("a"), expires_at: now + 401 * DAY },
      { token_hash: hex("a"), expires_at: "tomorrow" },
      { token_hash: hex("a") },
    ])
      expect((await add(body)).status).toBe(400);
    expect((await add({ token_hash: hex("b"), expires_at: now + DAY }, "app_missing")).status).toBe(
      404,
    );
    expect(
      (await api("/api/apps/app_keyed/server-keys/not-a-hash", { method: "DELETE" })).status,
    ).toBe(400);
    expect((await api("/api/apps/app_keyed/server-keys")).status).toBe(405);
  });
});
