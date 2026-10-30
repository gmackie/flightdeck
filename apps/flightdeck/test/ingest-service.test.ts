import type { StoredEvent } from "@flightdeckhq/schema";
import { describe, expect, it } from "vitest";
import { type IngestDeps, IngestError, ingestBatch, MAX_PROPS_BYTES } from "../src/ingest/service";
import { CHROME, sid } from "./fixtures";

const NOW = Date.UTC(2026, 9, 30, 14, 5);

function fakeDeps(overrides: Partial<IngestDeps> = {}) {
  const calls = {
    events: [] as StoredEvent[][],
    sessions: [] as [string, string, StoredEvent[]][],
    counts: [] as [string, string, StoredEvent[]][],
  };
  let n = 0;
  const deps: IngestDeps = {
    now: () => NOW,
    newId: () => `id${++n}`,
    resolveUser: async () => null,
    sendEvents: async (rows) => void calls.events.push(rows),
    appendToSession: async (a, s, rows) => void calls.sessions.push([a, s, rows]),
    recordCounts: async (a, h, rows) => void calls.counts.push([a, h, rows]),
    ...overrides,
  };
  return { deps, calls };
}

const page = (over = {}) => ({
  kind: "page",
  name: "/users/42",
  path: "/users/42",
  ts: NOW,
  sessionId: sid("a"),
  ...over,
});

describe("ingestBatch", () => {
  it("rejects invalid batches", async () => {
    const { deps } = fakeDeps();
    await expect(ingestBatch("app_1", { events: [] }, "browser", deps)).rejects.toBeInstanceOf(
      IngestError,
    );
    await expect(ingestBatch("app_1", "nope", "browser", deps)).rejects.toThrow(/^invalid batch/);
  });

  it("stamps, normalizes, and enriches rows", async () => {
    const { deps, calls } = fakeDeps();
    const res = await ingestBatch(
      "app_1",
      {
        events: [page({ referrer: "https://news.example.com/item?id=9" })],
        context: { country: "GB", userAgent: CHROME },
      },
      "browser",
      deps,
    );
    expect(res).toEqual({ accepted: 1, rejected: 0 });
    expect(calls.events[0]?.[0]).toEqual({
      event_id: "id1",
      app_id: "app_1",
      kind: "page",
      name: "/users/:id",
      ts: NOW,
      received_at: NOW,
      session_id: sid("a"),
      anonymous_id: null,
      user_id: null,
      path: "/users/:id",
      referrer: "news.example.com",
      props: null,
      country: "GB",
      device: "desktop",
      browser: "Chrome",
      os: "macOS",
      source: "browser",
    });
  });

  it("keeps the event name for non-page events", async () => {
    const { deps, calls } = fakeDeps();
    await ingestBatch(
      "app_1",
      {
        events: [
          { kind: "track", name: "signup", ts: NOW, path: "/users/42", props: { plan: "pro" } },
        ],
      },
      "server",
      deps,
    );
    expect(calls.events[0]?.[0]).toMatchObject({
      name: "signup",
      path: "/users/:id",
      props: '{"plan":"pro"}',
      source: "server",
    });
  });

  it("replaces client timestamps outside [-24h, +5m] with the receive time", async () => {
    const { deps, calls } = fakeDeps();
    await ingestBatch(
      "app_1",
      {
        events: [
          page({ ts: NOW + 10 * 60_000 }),
          page({ ts: NOW - 60_000 }),
          page({ ts: NOW - 25 * 3_600_000 }),
        ],
      },
      "browser",
      deps,
    );
    expect(calls.events[0]?.map((r) => r.ts)).toEqual([NOW, NOW - 60_000, NOW]);
  });

  it("uses the Access user unless the event names a user", async () => {
    const { deps, calls } = fakeDeps({ resolveUser: async () => "access-sub" });
    await ingestBatch(
      "app_1",
      { events: [page(), page({ userId: "explicit" })], accessJwt: "jwt" },
      "browser",
      deps,
    );
    expect(calls.events[0]?.map((r) => r.user_id)).toEqual(["access-sub", "explicit"]);
  });

  it("drops bot traffic without counting it as rejected", async () => {
    const { deps, calls } = fakeDeps();
    const res = await ingestBatch(
      "app_1",
      { events: [page()], context: { userAgent: "Googlebot/2.1" } },
      "browser",
      deps,
    );
    expect(res).toEqual({ accepted: 0, rejected: 0 });
    expect(calls).toEqual({ events: [], sessions: [], counts: [] });
  });

  it("fans out once to Pipelines, per session to SessionDOs, per hour to AppDOs", async () => {
    const { deps, calls } = fakeDeps();
    const lastHour = NOW - 10 * 60_000;
    await ingestBatch(
      "app_1",
      {
        events: [
          page(),
          page({ sessionId: sid("b") }),
          page({ sessionId: undefined }),
          page({ ts: lastHour }),
        ],
      },
      "browser",
      deps,
    );
    expect(calls.events).toHaveLength(1);
    expect(calls.sessions.map(([, s, rows]) => [s, rows.length])).toEqual([
      [sid("a"), 2],
      [sid("b"), 1],
    ]);
    expect(calls.counts.map(([, h, rows]) => [h, rows.length])).toEqual([
      ["2026-10-30T14", 3],
      ["2026-10-30T13", 1],
    ]);
  });

  it("drops and counts invalid events, fanning out only the valid ones", async () => {
    const { deps, calls } = fakeDeps();
    const res = await ingestBatch(
      "app_1",
      { events: [page(), { kind: "nope", name: "x", ts: NOW }] },
      "browser",
      deps,
    );
    expect(res).toEqual({ accepted: 1, rejected: 1 });
    expect(calls.events).toHaveLength(1);
    expect(calls.events[0]).toHaveLength(1);
    expect(calls.events[0]?.[0]?.kind).toBe("page");
    expect(calls.sessions).toHaveLength(1);
    expect(calls.sessions[0]?.[2]).toHaveLength(1);
    expect(calls.counts).toHaveLength(1);
    expect(calls.counts[0]?.[2]).toHaveLength(1);
  });

  it("fans out nothing when every event is invalid", async () => {
    const { deps, calls } = fakeDeps({
      resolveUser: async () => {
        throw new Error("should not resolve");
      },
    });
    const res = await ingestBatch(
      "app_1",
      { events: [{ kind: "identify", name: "x", ts: NOW }, 42, null], accessJwt: "jwt" },
      "browser",
      deps,
    );
    expect(res).toEqual({ accepted: 0, rejected: 3 });
    expect(calls).toEqual({ events: [], sessions: [], counts: [] });
  });

  it("rejects events whose serialized props exceed the size cap", async () => {
    const { deps, calls } = fakeDeps();
    const big: Record<string, string> = {};
    for (let i = 0; i < 10; i++) big[`k${i}`] = "x".repeat(500);
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_PROPS_BYTES);
    const res = await ingestBatch(
      "app_1",
      { events: [page({ props: big }), page({ props: { small: "ok" } })] },
      "browser",
      deps,
    );
    expect(res).toEqual({ accepted: 1, rejected: 1 });
    expect(calls.events[0]?.map((r) => r.props)).toEqual(['{"small":"ok"}']);
  });

  it("stores null optional fields as null and skips session fan-out", async () => {
    const { deps, calls } = fakeDeps();
    const res = await ingestBatch(
      "app_1",
      {
        events: [
          page({
            sessionId: null,
            userId: null,
            anonymousId: null,
            path: null,
            referrer: null,
            props: null,
          }),
        ],
      },
      "browser",
      deps,
    );
    expect(res).toEqual({ accepted: 1, rejected: 0 });
    expect(calls.events[0]?.[0]).toMatchObject({
      name: "/users/42",
      session_id: null,
      anonymous_id: null,
      user_id: null,
      path: null,
      referrer: null,
      props: null,
    });
    expect(calls.sessions).toEqual([]);
    expect(calls.counts).toHaveLength(1);
  });
});
