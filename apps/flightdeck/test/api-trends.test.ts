import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { apiRoutes } from "../src/api";
import { parseTrendsQuery, trendsView } from "../src/api/trends";
import type { CounterRow } from "../src/do/app";
import { appShard } from "../src/do/shards";
import { writeHourlyRollup } from "../src/rollups";
import { sinks } from "../src/sinks";
import { sid } from "./fixtures";

const NOW = Date.UTC(2026, 9, 30, 14, 30);
const APP = "app_trends";
const hourMs = (key: string) => Date.parse(`${key}:00:00.000Z`);
const dayMs = (key: string) => Date.parse(`${key}T00:00:00.000Z`);
const counter = (over: Partial<CounterRow> = {}): CounterRow => ({
  kind: "page",
  name: "/",
  path: "/",
  session_id: sid("a"),
  ts: NOW,
  ...over,
});
const c = (kind: string, name: string, count: number) => ({ kind, name, count });

beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO apps (id, name) VALUES (?, ?)")
    .bind(APP, "Trends")
    .run();
  // Warm tier: flushed hours.
  await writeHourlyRollup(env.DB, APP, "2026-10-30T10", {
    counters: [c("page", "/", 3), c("page", "/docs", 1), c("click", "cta", 2)],
    sessions: 2,
  });
  await writeHourlyRollup(env.DB, APP, "2026-10-28T09", {
    counters: [c("page", "/", 5), c("track", "signup", 1)],
    sessions: 4,
  });
  // Outside every range.
  await writeHourlyRollup(env.DB, APP, "2026-09-01T00", {
    counters: [c("page", "/", 100)],
    sessions: 50,
  });
  // A stale flush of the previous hour: its shard is still authoritative, so this is ignored.
  await writeHourlyRollup(env.DB, APP, "2026-10-30T13", {
    counters: [c("click", "cta", 1)],
    sessions: 1,
  });
  // Hot tier: the previous and current hours.
  await appShard(env, APP, "2026-10-30T13").recordEvents(APP, "2026-10-30T13", [
    counter({ kind: "click", name: "cta", path: null, ts: NOW - 3_600_000 }),
    counter({ kind: "click", name: "cta", path: null, ts: NOW - 3_600_000 }),
  ]);
  await appShard(env, APP, "2026-10-30T14").recordEvents(APP, "2026-10-30T14", [
    counter(),
    counter({ session_id: sid("b") }),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("parseTrendsQuery", () => {
  const parse = (q: string) => parseTrendsQuery(new URLSearchParams(q));
  it("defaults to 24h by kind", () => {
    expect(parse("")).toEqual({ range: "24h", breakdown: "kind", kind: null });
    expect(parse("range=7d&breakdown=name&kind=click")).toEqual({
      range: "7d",
      breakdown: "name",
      kind: "click",
    });
  });
  it("rejects unknown values", () => {
    for (const q of ["range=1y", "breakdown=props", "kind=", "kind=Bad Kind"]) {
      expect(parse(q)).toBeTypeOf("string");
    }
  });
});

describe("trendsView", () => {
  it("returns hourly buckets for 24h, merging D1 hours with the live shards", async () => {
    const view = await trendsView(env, APP, { range: "24h", breakdown: "kind", kind: null }, NOW);
    expect(view.bucket).toBe("hour");
    expect(view.buckets).toHaveLength(24);
    expect(view.buckets[0]).toBe(hourMs("2026-10-29T15"));
    expect(view.buckets.at(-1)).toBe(hourMs("2026-10-30T14"));
    const at = (key: string) => view.buckets.indexOf(hourMs(key));
    const page = view.series.find((s) => s.name === "page");
    const click = view.series.find((s) => s.name === "click");
    expect(page?.total).toBe(6);
    expect(page?.counts[at("2026-10-30T10")]).toBe(4);
    expect(page?.counts[at("2026-10-30T14")]).toBe(2);
    expect(click?.total).toBe(4);
    expect(click?.counts[at("2026-10-30T13")]).toBe(2);
    expect(view.series.map((s) => s.name)).toEqual(["page", "click"]);
    expect(view.totals).toEqual({ events: 10, sessions: 2 + 1 + 2 });
  });

  it("returns daily buckets for 7d and 30d", async () => {
    const week = await trendsView(env, APP, { range: "7d", breakdown: "kind", kind: null }, NOW);
    expect(week.bucket).toBe("day");
    expect(week.buckets).toHaveLength(7);
    expect(week.buckets[0]).toBe(dayMs("2026-10-24"));
    expect(week.buckets.at(-1)).toBe(dayMs("2026-10-30"));
    const page = week.series.find((s) => s.name === "page");
    expect(page?.counts[week.buckets.indexOf(dayMs("2026-10-28"))]).toBe(5);
    expect(page?.counts.at(-1)).toBe(6);
    expect(week.totals).toEqual({ events: 16, sessions: 9 });
    const month = await trendsView(env, APP, { range: "30d", breakdown: "kind", kind: null }, NOW);
    expect(month.buckets).toHaveLength(30);
    expect(month.totals.events).toBe(16);
  });

  it("breaks down by page path and by event name within a kind", async () => {
    const pages = await trendsView(env, APP, { range: "24h", breakdown: "page", kind: null }, NOW);
    expect(pages.series.map((s) => [s.name, s.total])).toEqual([
      ["/", 5],
      ["/docs", 1],
    ]);
    const clicks = await trendsView(
      env,
      APP,
      { range: "24h", breakdown: "name", kind: "click" },
      NOW,
    );
    expect(clicks.series.map((s) => [s.name, s.total])).toEqual([["cta", 4]]);
    expect(clicks.totals.events).toBe(4);
    // Without a kind, names exclude page views, whose names are paths.
    const names = await trendsView(env, APP, { range: "7d", breakdown: "name", kind: null }, NOW);
    expect(names.series.map((s) => s.name)).toEqual(["cta", "signup"]);
  });

  it("keeps the top series and folds the rest into $other", async () => {
    const app = "app_trends_top";
    await writeHourlyRollup(env.DB, app, "2026-10-30T09", {
      counters: [
        ...Array.from({ length: 7 }, (_, i) => c("click", `b${i}`, 10 - i)),
        c("click", "$other", 2),
      ],
      sessions: 1,
    });
    const view = await trendsView(env, app, { range: "24h", breakdown: "name", kind: null }, NOW);
    expect(view.series.map((s) => [s.name, s.total])).toEqual([
      ["b0", 10],
      ["b1", 9],
      ["b2", 8],
      ["b3", 7],
      ["b4", 6],
      ["$other", 5 + 4 + 2],
    ]);
  });
});

describe("GET /api/apps/:id/trends", () => {
  it("serves the view, rejects bad queries and dogfoods query.run", async () => {
    const events = vi.spyOn(sinks, "events").mockResolvedValue();
    const res = await exports.default.fetch(
      `https://flightdeck.test/api/apps/${APP}/trends?range=7d&breakdown=page`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      app_id: APP,
      range: "7d",
      breakdown: "page",
      kind: null,
      bucket: "day",
      buckets: expect.any(Array),
      series: expect.any(Array),
      totals: { events: expect.any(Number), sessions: expect.any(Number) },
    });
    const bad = await exports.default.fetch(
      `https://flightdeck.test/api/apps/${APP}/trends?range=1y`,
    );
    expect(bad.status).toBe(400);

    events.mockClear();
    const ctx = createExecutionContext();
    await apiRoutes(
      new Request(`https://flightdeck.test/api/apps/${APP}/trends?range=30d`),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const sent = events.mock.calls.flatMap(([, rows]) => rows);
    expect(sent.find((e) => e.props?.range === "30d")).toMatchObject({
      name: "query.run",
      props: { endpoint: "trends", range: "30d" },
    });
  });
});
