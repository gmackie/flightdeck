import { describe, expect, it } from "vitest";
import { applyDelta, type LiveDelta, type LiveView, summarize } from "../src/live/model";

const MIN = 60_000;
const HOUR = "2026-10-30T14";
const START = Date.UTC(2026, 9, 30, 14);
const PREV_START = START - 60 * MIN;

export function liveView(over: Partial<LiveView> = {}): LiveView {
  return {
    app_id: "app_alpha",
    now: START + 30 * MIN,
    active_window_ms: 5 * MIN,
    active_sessions: 3,
    hours: [
      {
        hour: HOUR,
        start: START,
        totals: [
          { kind: "page", count: 7 },
          { kind: "click", count: 2 },
        ],
        counters: [
          { kind: "page", name: "/", count: 5 },
          { kind: "click", name: "cta", count: 2 },
          { kind: "page", name: "/docs", count: 2 },
        ],
        transitions: [],
        sessions: 4,
        minutes: [
          { minute: START + 25 * MIN, count: 5 },
          { minute: START + 29 * MIN, count: 4 },
        ],
      },
      {
        hour: "2026-10-30T13",
        start: PREV_START,
        totals: [{ kind: "page", count: 3 }],
        counters: [{ kind: "page", name: "/docs", count: 3 }],
        transitions: [],
        sessions: 2,
        minutes: [{ minute: PREV_START + 59 * MIN, count: 3 }],
      },
    ],
    ...over,
  };
}

const delta = (over: Partial<LiveDelta> = {}): LiveDelta => ({
  type: "delta",
  hour: HOUR,
  events: 2,
  counters: [
    { kind: "page", name: "/docs", count: 1 },
    { kind: "track", name: "signup", count: 1 },
  ],
  minutes: [{ minute: START + 30 * MIN, count: 2 }],
  truncated: false,
  sessions: 5,
  active: 4,
  at: START + 30 * MIN,
  ...over,
});

describe("summarize", () => {
  it("derives the tiles, the 60-minute series and the top tables", () => {
    const s = summarize(liveView(), START + 30 * MIN + 10_000);
    expect(s.activeSessions).toBe(3);
    // The last five complete minutes (25..29) hold 9 events.
    expect(s.eventsPerMinute).toBeCloseTo(9 / 5);
    expect(s.pageViews).toBe(7);
    expect(s.perMinute).toHaveLength(60);
    expect(s.perMinute[0]).toEqual([START - 29 * MIN, 0]);
    expect(s.perMinute.at(-1)).toEqual([START + 30 * MIN, 0]);
    expect(s.perMinute.find(([t]) => t === START - MIN)).toEqual([START - MIN, 3]);
    expect(s.perMinute.find(([t]) => t === START + 25 * MIN)).toEqual([START + 25 * MIN, 5]);
    expect(s.topPages).toEqual([
      { name: "/", count: 5 },
      { name: "/docs", count: 5 },
    ]);
    expect(s.topEvents).toEqual([{ kind: "click", name: "cta", count: 2 }]);
    expect(s.hasEvents).toBe(true);
  });

  it("reports no events for empty shards", () => {
    const empty = liveView({
      active_sessions: 0,
      hours: liveView().hours.map((h) => ({
        ...h,
        totals: [],
        counters: [],
        minutes: [],
        sessions: 0,
      })),
    });
    expect(summarize(empty, START).hasEvents).toBe(false);
  });
});

describe("applyDelta", () => {
  it("adds increments to the current hour and takes absolute session counts", () => {
    const next = applyDelta(liveView(), delta());
    const [cur] = next.hours;
    expect(cur?.totals).toEqual([
      { kind: "page", count: 8 },
      { kind: "click", count: 2 },
      { kind: "track", count: 1 },
    ]);
    expect(cur?.counters).toContainEqual({ kind: "page", name: "/docs", count: 3 });
    expect(cur?.counters).toContainEqual({ kind: "track", name: "signup", count: 1 });
    expect(cur?.minutes.at(-1)).toEqual({ minute: START + 30 * MIN, count: 2 });
    expect(cur?.sessions).toBe(5);
    // Mid-hour the shard sees the whole active window, so its count is exact.
    expect(next.active_sessions).toBe(4);
    expect(next.now).toBe(START + 30 * MIN);
  });

  it("keeps the larger active count while the window reaches into the previous hour", () => {
    const next = applyDelta(liveView({ active_sessions: 6 }), delta({ at: START + 2 * MIN }));
    expect(next.active_sessions).toBe(6);
  });

  it("starts a new hour when the delta is for a later one", () => {
    const next = applyDelta(
      liveView(),
      delta({ hour: "2026-10-30T15", at: START + 61 * MIN, minutes: [] }),
    );
    expect(next.hours.map((h) => h.hour)).toEqual(["2026-10-30T15", HOUR]);
    expect(next.hours[0]?.totals).toEqual([
      { kind: "page", count: 1 },
      { kind: "track", count: 1 },
    ]);
  });

  it("ignores deltas for older hours", () => {
    const view = liveView();
    expect(applyDelta(view, delta({ hour: "2026-10-30T13" }))).toBe(view);
  });
});
