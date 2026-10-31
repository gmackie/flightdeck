import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { hourKey } from "@flightdeckhq/schema";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiRoutes } from "../src/api";
import { liveView } from "../src/api/live";
import type { CounterRow } from "../src/do/app";
import { appShard } from "../src/do/shards";
import { sinks } from "../src/sinks";
import { sid } from "./fixtures";

const MIN = 60_000;
const HOUR_MS = 3_600_000;
const TEAM = "https://acme.cloudflareaccess.com";
const AUD = "aud-dashboard";
let keys: ReturnType<typeof createLocalJWKSet>;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }],
  });
  await env.DB.prepare("INSERT OR IGNORE INTO apps (id, name) VALUES (?, ?), (?, ?), (?, ?)")
    .bind("app_live", "Live", "app_live_ws", "Live WS", "app_live_auth", "Live Auth")
    .run();
});
afterEach(() => vi.restoreAllMocks());

const counter = (over: Partial<CounterRow> = {}): CounterRow => ({
  kind: "page",
  name: "/",
  path: "/",
  session_id: sid("a"),
  ts: Date.now(),
  ...over,
});

// The test Worker runs with FLIGHTDECK_DEV=1 and no Access config, so the dev principal applies.
const get = (path: string, headers: Record<string, string> = {}) =>
  exports.default.fetch(`https://flightdeck.test${path}`, { headers });

describe("Access", () => {
  const configured = { ...env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, FLIGHTDECK_DEV: "0" };
  const call = async (path: string, token?: string, headers: Record<string, string> = {}) =>
    apiRoutes(
      new Request(`https://flightdeck.test${path}`, {
        headers: { ...headers, ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}) },
      }),
      configured,
      createExecutionContext(),
      { keys },
    );
  const sign = () =>
    new SignJWT({ email: "me@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setSubject("user-1")
      .setIssuer(TEAM)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  it("requires a valid Access token for live, the live socket and trends", async () => {
    vi.spyOn(sinks, "events").mockResolvedValue();
    for (const path of [
      "/api/apps/app_live_auth/live",
      "/api/apps/app_live_auth/live/ws",
      "/api/apps/app_live_auth/trends",
    ]) {
      expect((await call(path, undefined, { Upgrade: "websocket" })).status).toBe(401);
      expect((await call(path, "not-a-jwt", { Upgrade: "websocket" })).status).toBe(401);
    }
    const token = await sign();
    expect((await call("/api/apps/app_live_auth/live", token)).status).toBe(200);
    expect((await call("/api/apps/app_live_auth/trends", token)).status).toBe(200);
    const ws = await call("/api/apps/app_live_auth/live/ws", token, { Upgrade: "websocket" });
    expect(ws.status).toBe(101);
    ws.webSocket?.accept();
    ws.webSocket?.close();
  });
});

describe("GET /api/apps/:id/live", () => {
  it("404s for apps that are not registered, before touching any shard", async () => {
    for (const path of [
      "/api/apps/app_nope/live",
      "/api/apps/app_nope/live/ws",
      "/api/apps/app_nope/trends",
    ]) {
      const res = await get(path, { Upgrade: "websocket" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Unknown app" });
    }
  });

  it("validates hours and the method", async () => {
    for (const hours of ["0", "25", "1.5", "abc"]) {
      expect((await get(`/api/apps/app_live/live?hours=${hours}`)).status).toBe(400);
    }
    const post = await exports.default.fetch("https://flightdeck.test/api/apps/app_live/live", {
      method: "POST",
    });
    expect(post.status).toBe(405);
  });

  it("returns the current and previous hour snapshots", async () => {
    vi.spyOn(sinks, "events").mockResolvedValue();
    const now = Date.now();
    const hour = hourKey(now);
    await appShard(env, "app_live", hour).recordEvents("app_live", hour, [
      counter({ ts: now }),
      counter({ kind: "click", name: "cta", path: null, ts: now }),
    ]);
    const res = await get("/api/apps/app_live/live");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json<{ hours: { hour: string }[] }>();
    expect(body).toMatchObject({
      app_id: "app_live",
      now: expect.any(Number),
      active_window_ms: 5 * MIN,
      active_sessions: 1,
    });
    expect(body.hours.map((h) => h.hour)).toEqual([hour, hourKey(now - HOUR_MS)]);
    expect(body.hours[0]).toEqual({
      hour,
      start: Date.parse(`${hour}:00:00.000Z`),
      totals: [
        { kind: "click", count: 1 },
        { kind: "page", count: 1 },
      ],
      counters: [
        { kind: "click", name: "cta", count: 1 },
        { kind: "page", name: "/", count: 1 },
      ],
      transitions: [],
      sessions: 1,
      minutes: [{ minute: Math.floor(now / MIN) * MIN, count: 2 }],
    });
    expect((await get("/api/apps/app_live/live?hours=1")).status).toBe(200);
  });

  it("records a query.run dogfood event with only the endpoint and range", async () => {
    const events = vi.spyOn(sinks, "events").mockResolvedValue();
    const ctx = createExecutionContext();
    await apiRoutes(
      new Request("https://flightdeck.test/api/apps/app_live/live?hours=3"),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    // Earlier tests' fire-and-forget events may land here too; find this request's.
    const sent = events.mock.calls.flatMap(([, rows]) => rows);
    expect(sent.find((e) => e.props?.range === "3h")).toMatchObject({
      app_id: "app_flightdeck",
      kind: "track",
      name: "query.run",
      props: { endpoint: "live", range: "3h" },
    });
  });
});

describe("active sessions", () => {
  it("de-duplicates sessions active on both sides of the hour boundary", async () => {
    const top = Date.UTC(2026, 9, 30, 14);
    const prev = "2026-10-30T13";
    const cur = "2026-10-30T14";
    await appShard(env, "app_active_x", prev).recordEvents("app_active_x", prev, [
      counter({ session_id: sid("a"), ts: top - 1 * MIN }),
      counter({ session_id: sid("b"), ts: top - 2 * MIN }),
      counter({ session_id: sid("c"), ts: top - 30 * MIN }),
    ]);
    await appShard(env, "app_active_x", cur).recordEvents("app_active_x", cur, [
      counter({ session_id: sid("a"), ts: top + 1 * MIN }),
    ]);
    const view = await liveView(env, "app_active_x", 2, top + 2 * MIN);
    // a (both hours) and b (previous hour, 4 minutes ago); c went quiet 32 minutes ago.
    expect(view.active_sessions).toBe(2);
    // Later in the hour only the current shard can hold active sessions.
    expect((await liveView(env, "app_active_x", 2, top + 5 * MIN)).active_sessions).toBe(1);
  });
});

describe("GET /api/apps/:id/live/ws", () => {
  it("needs an upgrade and a same-origin Origin", async () => {
    expect((await get("/api/apps/app_live_ws/live/ws")).status).toBe(426);
    const cross = await get("/api/apps/app_live_ws/live/ws", {
      Upgrade: "websocket",
      Origin: "https://evil.test",
    });
    expect(cross.status).toBe(403);
  });

  it("connects to the current hour's shard and streams deltas", async () => {
    vi.spyOn(sinks, "events").mockResolvedValue();
    const res = await get("/api/apps/app_live_ws/live/ws", {
      Upgrade: "websocket",
      Origin: "https://flightdeck.test",
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    if (!ws) throw new Error("no webSocket");
    ws.accept();
    const messages: { type: string; events: number }[] = [];
    ws.addEventListener("message", (e) => messages.push(JSON.parse(e.data as string)));
    const now = Date.now();
    await appShard(env, "app_live_ws", hourKey(now)).recordEvents("app_live_ws", hourKey(now), [
      counter({ ts: now }),
    ]);
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toMatchObject({ type: "delta", events: 1 });
    ws.close();
  });
});
