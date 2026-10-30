import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
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
      steps: ["/", "/pricing", "buy"],
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
      steps: ["/", "/pricing"],
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

const stateOf = (stub: ReturnType<typeof sessionStub>) =>
  runInDurableObject(stub, async (_, state) => ({
    state: await state.storage.get<{ eventCount: number; steps: string[]; closeAttempts?: number }>(
      "state",
    ),
    alarm: await state.storage.getAlarm(),
  }));

it("starts the session at the earliest event even when it arrives late", async () => {
  const sessions = vi.spyOn(sinks, "sessions").mockResolvedValue(undefined);
  const s = sid("e");
  const stub = sessionStub(env, "app_m1", s);
  await stub.append("app_m1", s, [row({ app_id: "app_m1", session_id: s, ts: T0 + 10_000 })]);
  await stub.append("app_m1", s, [row({ app_id: "app_m1", session_id: s, path: "/late", ts: T0 })]);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(sessions.mock.calls[0]?.[1][0]).toMatchObject({ started_at: T0, duration_ms: 10_000 });
});

it("keeps events appended while the close is in flight as a new open session", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sessions = vi.spyOn(sinks, "sessions").mockImplementation(() => held);
  const s = sid("f");
  const stub = sessionStub(env, "app_race", s);
  await stub.append("app_race", s, [row({ app_id: "app_race", session_id: s, path: "/", ts: T0 })]);

  const closing = runDurableObjectAlarm(stub);
  await vi.waitFor(() => expect(sessions).toHaveBeenCalledOnce());
  await stub.append("app_race", s, [
    row({ app_id: "app_race", session_id: s, path: "/again", ts: T0 + 40 * 60_000 }),
  ]);
  release();
  expect(await closing).toBe(true);

  expect(sessions).toHaveBeenCalledOnce();
  expect(sessions.mock.calls[0]?.[1]).toEqual([
    expect.objectContaining({ steps: ["/"], event_count: 1 }),
  ]);
  const after = await stateOf(stub);
  expect(after.state).toMatchObject({ eventCount: 1, steps: ["/again"] });
  expect(after.alarm).not.toBeNull();
});

it("restores state and re-arms the alarm with backoff when the close fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(sinks, "sessions").mockRejectedValue(new Error("pipeline down"));
  const s = sid("g");
  const stub = sessionStub(env, "app_fail", s);
  await stub.append("app_fail", s, [row({ app_id: "app_fail", session_id: s, ts: T0 })]);

  const before = Date.now();
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const after = await stateOf(stub);
  expect(after.state).toMatchObject({ eventCount: 1, closeAttempts: 1 });
  expect(after.alarm).toBeGreaterThanOrEqual(before + 60_000);
  expect(after.alarm).toBeLessThan(before + 120_000);

  expect(await runDurableObjectAlarm(stub)).toBe(true);
  const second = await stateOf(stub);
  expect(second.state?.closeAttempts).toBe(2);
  expect(second.alarm).toBeGreaterThanOrEqual(before + 120_000);
});

it("drops the session after five failed close attempts without throwing", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const sessions = vi.spyOn(sinks, "sessions").mockRejectedValue(new Error("pipeline down"));
  const s = sid("h");
  const stub = sessionStub(env, "app_drop", s);
  await stub.append("app_drop", s, [row({ app_id: "app_drop", session_id: s, ts: T0 })]);

  for (let i = 0; i < 5; i++) expect(await runDurableObjectAlarm(stub)).toBe(true);
  expect(sessions).toHaveBeenCalledTimes(5);
  expect(await stateOf(stub)).toEqual({ state: undefined, alarm: null });
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining("dropping session"),
    expect.anything(),
  );
  expect(await runDurableObjectAlarm(stub)).toBe(false);
});
