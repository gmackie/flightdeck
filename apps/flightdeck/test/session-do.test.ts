import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { appShard, sessionStub } from "../src/do/shards";
import { sinks } from "../src/sinks";
import { row, sid, T0 } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

it("builds the journey and records transitions on the hour shard", async () => {
  const s = sid("a");
  await sessionStub(env, "app_j", s).append("app_j", s, [
    row({ app_id: "app_j", path: "/", ts: T0 }),
    row({ app_id: "app_j", path: "/", ts: T0 + 1_000 }),
    row({ app_id: "app_j", kind: "click", name: "pricing.cta", ts: T0 + 2_000 }),
  ]);
  expect((await appShard(env, "app_j", "2026-10-30T14").snapshot()).transitions).toEqual([
    { source: "$start", target: "/", count: 1 },
    { source: "/", target: "pricing.cta", count: 1 },
  ]);
});

it("routes transitions to the shard for the hour each step happened in", async () => {
  const s = sid("c");
  await sessionStub(env, "app_h", s).append("app_h", s, [
    row({ app_id: "app_h", path: "/", ts: T0 - 60_000 }),
    row({ app_id: "app_h", path: "/docs", ts: T0 + 60_000 }),
  ]);
  expect((await appShard(env, "app_h", "2026-10-30T13").snapshot()).transitions).toEqual([
    { source: "$start", target: "/", count: 1 },
  ]);
  expect((await appShard(env, "app_h", "2026-10-30T14").snapshot()).transitions).toEqual([
    { source: "/", target: "/docs", count: 1 },
  ]);
});

it("continues the same journey across separate appends", async () => {
  const sessions = vi.spyOn(sinks, "sessions").mockResolvedValue(undefined);
  const s = sid("d");
  const stub = sessionStub(env, "app_c", s);
  await stub.append("app_c", s, [
    row({ app_id: "app_c", session_id: s, path: "/", ts: T0 }),
    row({ app_id: "app_c", session_id: s, path: "/pricing", ts: T0 + 1_000 }),
  ]);
  await stub.append("app_c", s, [
    row({ app_id: "app_c", session_id: s, kind: "click", name: "buy", ts: T0 + 5_000 }),
  ]);
  expect((await appShard(env, "app_c", "2026-10-30T14").snapshot()).transitions).toEqual([
    { source: "$start", target: "/", count: 1 },
    { source: "/", target: "/pricing", count: 1 },
    { source: "/pricing", target: "buy", count: 1 },
  ]);

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(sessions.mock.calls[0]?.[1]).toEqual([
    expect.objectContaining({
      steps: JSON.stringify(["/", "/pricing", "buy"]),
      event_count: 3,
      duration_ms: 5_000,
    }),
  ]);
});

it("closes on alarm: writes the record, adds the exit transition, clears state", async () => {
  const sessions = vi.spyOn(sinks, "sessions").mockResolvedValue(undefined);
  const s = sid("b");
  const stub = sessionStub(env, "app_k", s);
  await stub.append("app_k", s, [
    row({ app_id: "app_k", session_id: s, path: "/", ts: T0 }),
    row({
      app_id: "app_k",
      session_id: s,
      kind: "identify",
      name: "identify",
      user_id: "user_1",
      ts: T0 + 500,
    }),
    row({ app_id: "app_k", session_id: s, path: "/pricing", ts: T0 + 60_000 }),
  ]);

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(sessions).toHaveBeenCalledOnce();
  expect(sessions.mock.calls[0]?.[1]).toEqual([
    expect.objectContaining({
      session_id: s,
      user_id: "user_1",
      entry: "/",
      exit: "/pricing",
      steps: JSON.stringify(["/", "/pricing"]),
      step_count: 2,
      event_count: 3,
      duration_ms: 60_000,
    }),
  ]);
  expect((await appShard(env, "app_k", "2026-10-30T14").snapshot()).transitions).toContainEqual({
    source: "/pricing",
    target: "$exit",
    count: 1,
  });
  expect(await runDurableObjectAlarm(stub)).toBe(false);
});
