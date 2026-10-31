import { expect, it, vi } from "vitest";
import { DeltaBuffer, MAX_DELTA_COUNTERS, minuteOf, Throttle } from "../src/do/live";

const MIN = 60_000;
const T = Date.UTC(2026, 9, 30, 14, 5, 30);

it("buckets timestamps by UTC minute", () => {
  expect(minuteOf(T)).toBe(Date.UTC(2026, 9, 30, 14, 5));
  expect(minuteOf(Date.UTC(2026, 9, 30, 14, 6))).toBe(Date.UTC(2026, 9, 30, 14, 6));
});

it("coalesces counter and minute increments until taken", () => {
  const buf = new DeltaBuffer();
  expect(buf.take()).toBeNull();
  buf.add({ kind: "page", name: "/", minute: minuteOf(T) }, 4);
  // Only the first add after a take sets `since`: the sequence the delta continues from.
  buf.add({ kind: "page", name: "/", minute: minuteOf(T) }, 5);
  buf.add({ kind: "click", name: "cta", minute: minuteOf(T + MIN) }, 4);
  expect(buf.take()).toEqual({
    events: 3,
    counters: [
      { kind: "page", name: "/", count: 2 },
      { kind: "click", name: "cta", count: 1 },
    ],
    minutes: [
      { minute: minuteOf(T), count: 2 },
      { minute: minuteOf(T + MIN), count: 1 },
    ],
    truncated: false,
    since: 4,
  });
  expect(buf.take()).toBeNull();
  buf.add({ kind: "page", name: "/", minute: minuteOf(T) }, 9);
  expect(buf.take()?.since).toBe(9);
});

it("stops itemizing counters past the cap but keeps counting", () => {
  const buf = new DeltaBuffer();
  for (let i = 0; i <= MAX_DELTA_COUNTERS; i++) {
    buf.add({ kind: "click", name: `c${i}`, minute: minuteOf(T) }, 4);
  }
  buf.add({ kind: "click", name: "c0", minute: minuteOf(T) }, 4);
  const delta = buf.take();
  expect(delta?.events).toBe(MAX_DELTA_COUNTERS + 2);
  expect(delta?.counters).toHaveLength(MAX_DELTA_COUNTERS);
  expect(delta?.counters[0]).toEqual({ kind: "click", name: "c0", count: 2 });
  expect(delta?.truncated).toBe(true);
  expect(delta?.minutes).toEqual([{ minute: minuteOf(T), count: MAX_DELTA_COUNTERS + 2 }]);
});

function clock() {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ at: now + ms, fn });
    },
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers.splice(0, timers.length, ...timers.filter((t) => t.at > now));
      for (const t of due) t.fn();
    },
    pending: () => timers.length,
  };
}

it("sends the first poke at once, then at most once per interval", () => {
  const c = clock();
  const send = vi.fn();
  const throttle = new Throttle(1_000, send, c);
  throttle.poke();
  expect(send).toHaveBeenCalledTimes(1);
  // Pokes inside the interval share one trailing send.
  c.advance(100);
  throttle.poke();
  throttle.poke();
  c.advance(300);
  throttle.poke();
  expect(send).toHaveBeenCalledTimes(1);
  expect(c.pending()).toBe(1);
  c.advance(599);
  expect(send).toHaveBeenCalledTimes(1);
  c.advance(1);
  expect(send).toHaveBeenCalledTimes(2);
  // A quiet period resets: the next poke goes out immediately.
  c.advance(5_000);
  throttle.poke();
  expect(send).toHaveBeenCalledTimes(3);
});
