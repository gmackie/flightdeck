import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { hourKey } from "@flightdeckhq/schema";
import { afterEach, expect, it, vi } from "vitest";
import {
  ACTIVE_WINDOW_MS,
  type AppDO,
  type CounterRow,
  FLUSH_GRACE_MS,
  HOUR_CLOSED,
  ROLLUP_LIMIT,
  SNAPSHOT_LIMIT,
} from "../src/do/app";
import { appShard } from "../src/do/shards";
import { rollups } from "../src/rollups";
import { sid, T0 } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

const HOUR = "2026-10-30T14";
const HOUR_MS = 3_600_000;
const MIN = 60_000;
const counter = (over: Partial<CounterRow> = {}): CounterRow => ({
  kind: "page",
  name: "/",
  path: "/",
  session_id: sid("a"),
  ts: T0,
  ...over,
});
const alarmOf = (shard: ReturnType<typeof appShard>) =>
  runInDurableObject(shard, (_, state) => state.storage.getAlarm());
const rollupRows = (appId: string, hour: string) =>
  env.DB.prepare(
    "SELECT kind, name, count FROM hourly_rollups WHERE app_id = ? AND hour = ? ORDER BY kind, name",
  )
    .bind(appId, hour)
    .all()
    .then((r) => r.results);
const rollupSessions = (appId: string, hour: string) =>
  env.DB.prepare("SELECT sessions FROM hourly_sessions WHERE app_id = ? AND hour = ?")
    .bind(appId, hour)
    .first<number>("sessions");

it("keys shards by app, hour, and a reserved shard index", () => {
  expect(appShard(env, "app_key", HOUR).id.equals(env.APP.idFromName(`app_key:${HOUR}:0`))).toBe(
    true,
  );
  expect(appShard(env, "app_key", HOUR, 1).id.equals(env.APP.idFromName(`app_key:${HOUR}:1`))).toBe(
    true,
  );
});

it("counts events by kind and name, totals by kind, unique sessions and minutes", async () => {
  const shard = appShard(env, "app_count", HOUR);
  await shard.recordEvents("app_count", HOUR, [
    counter(),
    counter({ ts: T0 + 30_000 }),
    counter({ kind: "click", name: "cta", path: null, session_id: sid("b"), ts: T0 + 2 * MIN }),
  ]);
  expect(await shard.snapshot()).toEqual({
    totals: [
      { kind: "page", count: 2 },
      { kind: "click", count: 1 },
    ],
    counters: [
      { kind: "page", name: "/", count: 2 },
      { kind: "click", name: "cta", count: 1 },
    ],
    transitions: [],
    sessions: 2,
    minutes: [
      { minute: T0, count: 2 },
      { minute: T0 + 2 * MIN, count: 1 },
    ],
    active: 0,
    seq: 1,
  });
});

it("counts sessionless rows without counting a session", async () => {
  const shard = appShard(env, "app_nosession", HOUR);
  await shard.recordEvents("app_nosession", HOUR, [
    counter({ kind: "track", name: "signup", session_id: null }),
    counter({ kind: "track", name: "signup", session_id: null }),
  ]);
  const snap = await shard.snapshot();
  expect(snap.counters).toEqual([{ kind: "track", name: "signup", count: 2 }]);
  expect(snap.sessions).toBe(0);
});

it("keeps minute buckets inside its hour, so there are at most 60", async () => {
  const shard = appShard(env, "app_minutes", HOUR);
  await shard.recordEvents("app_minutes", HOUR, [
    counter({ ts: T0 - 5 * MIN }),
    counter({ ts: T0 + HOUR_MS + MIN }),
    ...Array.from({ length: 70 }, (_, i) => counter({ ts: T0 + i * MIN })),
  ]);
  const { minutes } = await shard.snapshot();
  expect(minutes).toHaveLength(60);
  expect(minutes[0]).toEqual({ minute: T0, count: 2 });
  expect(minutes.at(-1)).toEqual({ minute: T0 + 59 * MIN, count: 12 });
});

it("counts sessions active since a time by their latest event", async () => {
  const shard = appShard(env, "app_active", HOUR);
  await shard.recordEvents("app_active", HOUR, [
    counter({ session_id: sid("a"), ts: T0 + 10 * MIN }),
    counter({ session_id: sid("b"), ts: T0 + 20 * MIN }),
    counter({ session_id: sid("c"), ts: T0 + 26 * MIN }),
  ]);
  // A later event moves a session's last activity forward; an older one never moves it back.
  await shard.recordEvents("app_active", HOUR, [
    counter({ session_id: sid("a"), ts: T0 + 27 * MIN }),
    counter({ session_id: sid("c"), ts: T0 + 1 * MIN }),
  ]);
  const since = T0 + 30 * MIN - ACTIVE_WINDOW_MS;
  expect((await shard.snapshot(since)).active).toBe(2);
  expect((await shard.activeSessionIds(since)).sort()).toEqual([sid("a"), sid("c")]);
});

it("accumulates transitions", async () => {
  const shard = appShard(env, "app_tr", HOUR);
  await shard.recordTransitions("app_tr", HOUR, [{ source: "$start", target: "/", count: 1 }]);
  await shard.recordTransitions("app_tr", HOUR, [
    { source: "$start", target: "/", count: 2 },
    { source: "/", target: "cta", count: 1 },
  ]);
  expect((await shard.snapshot()).transitions).toEqual([
    { source: "$start", target: "/", count: 3 },
    { source: "/", target: "cta", count: 1 },
  ]);
});

it("returns at most the top counters and transitions by count, then name", async () => {
  const shard = appShard(env, "app_top", HOUR);
  const rows = Array.from({ length: SNAPSHOT_LIMIT + 1 }, (_, i) =>
    counter({ kind: "click", name: `c${String(i).padStart(4, "0")}`, path: null }),
  );
  await shard.recordEvents("app_top", HOUR, [
    ...rows,
    counter({ kind: "click", name: "c0500", path: null }),
  ]);
  await shard.recordTransitions(
    "app_top",
    HOUR,
    Array.from({ length: SNAPSHOT_LIMIT + 1 }, (_, i) => ({
      source: "/",
      target: `t${String(i).padStart(4, "0")}`,
      count: i === SNAPSHOT_LIMIT ? 5 : 1,
    })),
  );
  const snap = await shard.snapshot();
  expect(snap.counters).toHaveLength(SNAPSHOT_LIMIT);
  expect(snap.counters[0]).toEqual({ kind: "click", name: "c0500", count: 2 });
  expect(snap.counters[1]?.name).toBe("c0000");
  expect(snap.counters.at(-1)?.name).toBe("c0498");
  // Totals cover every counter, not just the top ones.
  expect(snap.totals).toEqual([{ kind: "click", count: SNAPSHOT_LIMIT + 2 }]);
  expect(snap.transitions).toHaveLength(SNAPSHOT_LIMIT);
  expect(snap.transitions[0]).toEqual({ source: "/", target: "t0500", count: 5 });
  expect(snap.transitions.at(-1)?.target).toBe("t0498");
});

it("arms the rollup flush for a grace period after its hour ends", async () => {
  const hour = hourKey(Date.now());
  const shard = appShard(env, "app_open", hour);
  await shard.recordEvents("app_open", hour, [counter({ ts: Date.now() })]);
  const end = Date.parse(`${hour}:00:00.000Z`) + HOUR_MS;
  expect(await alarmOf(shard)).toBe(end + FLUSH_GRACE_MS);
});

it("flushes a closed hour into D1, re-flushes late events, and overwrites idempotently", async () => {
  const start = Date.now() - 3 * HOUR_MS;
  const hour = hourKey(start);
  const ts = Date.parse(`${hour}:00:00.000Z`) + MIN;
  const shard = appShard(env, "app_flush", hour);
  await shard.recordEvents("app_flush", hour, [
    counter({ ts }),
    counter({ ts, session_id: sid("b") }),
    counter({ ts, kind: "click", name: "cta", path: null }),
  ]);
  expect(await runDurableObjectAlarm(shard)).toBe(true);
  expect(await rollupRows("app_flush", hour)).toEqual([
    { kind: "click", name: "cta", count: 1 },
    { kind: "page", name: "/", count: 2 },
  ]);
  expect(await rollupSessions("app_flush", hour)).toBe(2);
  // Flushed: the shard now waits for its expiry, 48h after the hour ends.
  const expiry = Date.parse(`${hour}:00:00.000Z`) + HOUR_MS + 48 * HOUR_MS;
  expect(await alarmOf(shard)).toBe(expiry);

  // A late event re-arms a prompt flush that overwrites the rows rather than adding to them.
  const before = Date.now();
  await shard.recordEvents("app_flush", hour, [counter({ ts, session_id: sid("c") })]);
  const alarm = await alarmOf(shard);
  expect(alarm).toBeGreaterThan(before);
  expect(alarm).toBeLessThan(expiry);
  expect(await runDurableObjectAlarm(shard)).toBe(true);
  expect(await runDurableObjectAlarm(shard)).toBe(true);
  expect(await rollupRows("app_flush", hour)).toEqual([
    { kind: "click", name: "cta", count: 1 },
    { kind: "page", name: "/", count: 3 },
  ]);
  expect(await rollupSessions("app_flush", hour)).toBe(3);
  // Still intact until expiry, so the live view can read the previous hour.
  expect((await shard.snapshot()).sessions).toBe(3);
});

it("rolls names past the limit into one $other row per kind", async () => {
  const hour = hourKey(Date.now() - 4 * HOUR_MS);
  const ts = Date.parse(`${hour}:00:00.000Z`);
  const shard = appShard(env, "app_rollcap", hour);
  await shard.recordEvents("app_rollcap", hour, [
    ...Array.from({ length: ROLLUP_LIMIT + 2 }, (_, i) =>
      counter({ kind: "click", name: `c${String(i).padStart(5, "0")}`, path: null, ts }),
    ),
    counter({ ts }),
    counter({ ts }),
  ]);
  const rollup = await shard.rollup();
  expect(rollup.counters).toHaveLength(ROLLUP_LIMIT + 1);
  expect(rollup.counters[0]).toEqual({ kind: "page", name: "/", count: 2 });
  expect(rollup.counters.at(-1)).toEqual({ kind: "click", name: "$other", count: 3 });
  expect(rollup.counters.reduce((n, c) => n + c.count, 0)).toBe(ROLLUP_LIMIT + 4);
});

it("expires 48h after the end of its hour and clears its data", async () => {
  const hour = hourKey(Date.now() - 50 * HOUR_MS);
  const shard = appShard(env, "app_expire", hour);
  await shard.recordTransitions("app_expire", hour, [{ source: "$start", target: "/", count: 1 }]);
  await shard.recordEvents("app_expire", hour, [counter()]);
  expect(await runDurableObjectAlarm(shard)).toBe(true);
  expect(await shard.snapshot()).toMatchObject({ counters: [], transitions: [], sessions: 0 });
  expect(await alarmOf(shard)).toBeNull();
});

it("rejects a bad hour key before writing", async () => {
  const shard = appShard(env, "app_badhour", "nope");
  const err = await shard.recordEvents("app_badhour", "nope", [counter()]).then(
    () => null,
    (e: Error) => e,
  );
  expect(err?.message).toMatch(/invalid hour key/);
  expect((await shard.snapshot()).counters).toEqual([]);
});

it("answers non-upgrade requests with 426", async () => {
  const res = await appShard(env, "app_ws", HOUR).fetch("https://do/live");
  expect(res.status).toBe(426);
});

const connect = async (shard: ReturnType<typeof appShard>, appId: string, hour: string) => {
  const res = await shard.fetch(`https://do/live?app=${appId}&hour=${hour}`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket;
  const messages: Record<string, unknown>[] = [];
  let closed: number | null = null;
  if (ws) {
    ws.accept();
    ws.addEventListener("message", (e) => messages.push(JSON.parse(e.data as string)));
    ws.addEventListener("close", (e) => {
      closed = e.code;
    });
  }
  return { res, ws, messages, closed: () => closed };
};

it("greets a live client with the server's hour end and sequence", async () => {
  const now = Date.now();
  const hour = hourKey(now);
  const shard = appShard(env, "app_hello", hour);
  await shard.recordEvents("app_hello", hour, [counter({ ts: now })]);
  const { res, ws, messages } = await connect(shard, "app_hello", hour);
  expect(res.status).toBe(101);
  await expect.poll(() => messages.length).toBe(1);
  expect(messages[0]).toEqual({
    type: "hello",
    hour,
    hour_end: Date.parse(`${hour}:00:00.000Z`) + HOUR_MS,
    seq: 1,
    now: expect.any(Number),
  });
  ws?.close();
});

it("refuses live clients once its hour is over, and closes them at the hour end", async () => {
  const past = hourKey(Date.now() - HOUR_MS);
  const late = await connect(appShard(env, "app_past", past), "app_past", past);
  expect(late.res.status).toBe(410);

  const hour = hourKey(Date.now());
  const shard = appShard(env, "app_close", hour);
  const { ws, closed } = await connect(shard, "app_close", hour);
  const end = Date.parse(`${hour}:00:00.000Z`) + HOUR_MS;
  // Connecting arms an alarm for the end of the hour.
  expect(await alarmOf(shard)).toBe(end);
  // Pretend the hour is over: the alarm closes the socket with the hour-closed code.
  vi.spyOn(Date, "now").mockReturnValue(end + 1);
  await runDurableObjectAlarm(shard);
  vi.restoreAllMocks();
  await expect.poll(closed).toBe(HOUR_CLOSED);
  ws?.close();
});

it("broadcasts coalesced deltas with sequence numbers", async () => {
  const hour = hourKey(Date.now());
  const shard = appShard(env, "app_ws", hour);
  const { res, ws, messages } = await connect(shard, "app_ws", hour);
  expect(res.status).toBe(101);
  await expect.poll(() => messages.length).toBe(1);

  const now = Date.now();
  await shard.recordEvents("app_ws", hour, [
    counter({ ts: now }),
    counter({ ts: now, kind: "click", name: "cta", path: null, session_id: sid("b") }),
  ]);
  await expect.poll(() => messages.length).toBe(2);
  expect(messages[1]).toEqual({
    type: "delta",
    hour,
    events: 2,
    counters: [
      { kind: "page", name: "/", count: 1 },
      { kind: "click", name: "cta", count: 1 },
    ],
    minutes: [{ minute: Math.floor(now / MIN) * MIN, count: 2 }],
    truncated: false,
    since: 0,
    seq: 1,
    sessions: 2,
    active: 2,
    at: expect.any(Number),
  });

  // Writes inside the throttle interval arrive together in one trailing message.
  await shard.recordEvents("app_ws", hour, [counter({ ts: now })]);
  await shard.recordEvents("app_ws", hour, [counter({ ts: now })]);
  await expect.poll(() => messages.length, { timeout: 3_000 }).toBe(3);
  expect(messages[2]).toMatchObject({
    events: 2,
    counters: [{ name: "/", count: 2 }],
    since: 1,
    seq: 3,
  });
  expect((await shard.snapshot()).seq).toBe(3);
  ws?.close();
});

it("re-arms a prompt flush when events land while the D1 write is in flight", async () => {
  const hour = hourKey(Date.now() - 5 * HOUR_MS);
  const ts = Date.parse(`${hour}:00:00.000Z`);
  const shard = appShard(env, "app_race", hour);
  await shard.recordEvents("app_race", hour, [counter({ ts })]);
  const write = rollups.write;
  await runInDurableObject(shard, async (instance: AppDO) => {
    vi.spyOn(rollups, "write").mockImplementationOnce(async (...args) => {
      // A late event arrives after rollup() read the counters, before the write commits.
      await instance.recordEvents("app_race", hour, [counter({ ts })]);
      return write(...args);
    });
    await instance.alarm();
  });
  expect(await rollupRows("app_race", hour)).toEqual([{ kind: "page", name: "/", count: 1 }]);
  const expiry = Date.parse(`${hour}:00:00.000Z`) + HOUR_MS + 48 * HOUR_MS;
  const alarm = await alarmOf(shard);
  expect(alarm).toBeLessThan(expiry);
  expect(alarm).toBeGreaterThan(Date.now());
  // The re-armed flush picks the late event up.
  expect(await runDurableObjectAlarm(shard)).toBe(true);
  expect(await rollupRows("app_race", hour)).toEqual([{ kind: "page", name: "/", count: 2 }]);
  expect(await alarmOf(shard)).toBe(expiry);
});

it("merges a real $other name into the folded row instead of failing the flush", async () => {
  const hour = hourKey(Date.now() - 6 * HOUR_MS);
  const ts = Date.parse(`${hour}:00:00.000Z`);
  const shard = appShard(env, "app_realother", hour);
  await shard.recordEvents("app_realother", hour, [
    ...Array.from({ length: ROLLUP_LIMIT + 1 }, (_, i) =>
      counter({ kind: "click", name: `c${String(i).padStart(5, "0")}`, path: null, ts }),
    ),
    counter({ kind: "click", name: "$other", path: null, ts }),
  ]);
  const rollup = await shard.rollup();
  const others = rollup.counters.filter((c) => c.name === "$other");
  expect(others).toEqual([{ kind: "click", name: "$other", count: 3 }]);
  expect(await runDurableObjectAlarm(shard)).toBe(true);
  const rows = await rollupRows("app_realother", hour);
  expect(rows).toHaveLength(ROLLUP_LIMIT);
  expect(rows.reduce((n, r) => n + (r.count as number), 0)).toBe(ROLLUP_LIMIT + 2);
});

it("indexes sessions by last activity and keeps a running session count", async () => {
  const shard = appShard(env, "app_sessidx", HOUR);
  await shard.recordEvents("app_sessidx", HOUR, [
    counter({ session_id: sid("a") }),
    counter({ session_id: sid("a"), ts: T0 + MIN }),
    counter({ session_id: sid("b") }),
  ]);
  await shard.recordEvents("app_sessidx", HOUR, [counter({ session_id: sid("b") })]);
  expect((await shard.snapshot()).sessions).toBe(2);
  const plan = await runInDurableObject(shard, (_, state) =>
    state.storage.sql
      .exec<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT count(*) FROM sessions WHERE last_ts >= 0",
      )
      .toArray()
      .map((r) => r.detail)
      .join(" "),
  );
  expect(plan).toMatch(/INDEX sessions_last_ts/);
});

it("counts the union of its active sessions and another shard's", async () => {
  const shard = appShard(env, "app_union", HOUR);
  await shard.recordEvents("app_union", HOUR, [
    counter({ session_id: sid("a"), ts: T0 + MIN }),
    counter({ session_id: sid("b"), ts: T0 + MIN }),
    counter({ session_id: sid("c"), ts: T0 - 10 * MIN }),
  ]);
  // b is active on both sides; c is here but too old, so it counts only via the other shard.
  expect(await shard.activeUnion(T0, [sid("b"), sid("c"), sid("d")])).toBe(4);
});
