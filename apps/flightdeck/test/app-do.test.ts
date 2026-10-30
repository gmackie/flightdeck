import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { type CounterRow, SNAPSHOT_LIMIT } from "../src/do/app";
import { appShard } from "../src/do/shards";
import { sid } from "./fixtures";

const HOUR = "2026-10-30T14";
const counter = (over: Partial<CounterRow> = {}): CounterRow => ({
  kind: "page",
  name: "/",
  path: "/",
  session_id: sid("a"),
  ...over,
});

it("keys shards by app, hour, and a reserved shard index", () => {
  expect(appShard(env, "app_key", HOUR).id.equals(env.APP.idFromName(`app_key:${HOUR}:0`))).toBe(
    true,
  );
  expect(appShard(env, "app_key", HOUR, 1).id.equals(env.APP.idFromName(`app_key:${HOUR}:1`))).toBe(
    true,
  );
});

it("counts events by kind and name, and unique sessions", async () => {
  const shard = appShard(env, "app_count", HOUR);
  await shard.recordEvents(HOUR, [
    counter(),
    counter(),
    counter({ kind: "click", name: "cta", path: null, session_id: sid("b") }),
  ]);
  expect(await shard.snapshot()).toEqual({
    counters: [
      { kind: "page", name: "/", count: 2 },
      { kind: "click", name: "cta", count: 1 },
    ],
    transitions: [],
    sessions: 2,
  });
});

it("counts sessionless rows without counting a session", async () => {
  const shard = appShard(env, "app_nosession", HOUR);
  await shard.recordEvents(HOUR, [
    counter({ kind: "track", name: "signup", session_id: null }),
    counter({ kind: "track", name: "signup", session_id: null }),
  ]);
  expect(await shard.snapshot()).toEqual({
    counters: [{ kind: "track", name: "signup", count: 2 }],
    transitions: [],
    sessions: 0,
  });
});

it("accumulates transitions", async () => {
  const shard = appShard(env, "app_tr", HOUR);
  await shard.recordTransitions(HOUR, [{ source: "$start", target: "/", count: 1 }]);
  await shard.recordTransitions(HOUR, [
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
  await shard.recordEvents(HOUR, [...rows, counter({ kind: "click", name: "c0500", path: null })]);
  await shard.recordTransitions(
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
  expect(snap.transitions).toHaveLength(SNAPSHOT_LIMIT);
  expect(snap.transitions[0]).toEqual({ source: "/", target: "t0500", count: 5 });
  expect(snap.transitions.at(-1)?.target).toBe("t0498");
});

it("expires 48h after the end of its hour and clears its data", async () => {
  const shard = appShard(env, "app_expire", HOUR);
  await shard.recordTransitions(HOUR, [{ source: "$start", target: "/", count: 1 }]);
  const endOfHour = Date.UTC(2026, 9, 30, 15);
  expect(await runInDurableObject(shard, (_, state) => state.storage.getAlarm())).toBe(
    endOfHour + 48 * 3_600_000,
  );
  await shard.recordEvents(HOUR, [counter()]);

  expect(await runDurableObjectAlarm(shard)).toBe(true);
  expect(await shard.snapshot()).toEqual({ counters: [], transitions: [], sessions: 0 });
  expect(await runInDurableObject(shard, (_, state) => state.storage.getAlarm())).toBeNull();
});
