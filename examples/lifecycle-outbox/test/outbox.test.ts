import { env } from "cloudflare:workers";
import {
  checkAgainstDefinition,
  LifecycleEventV1,
  ProcessDefinitionV1,
} from "@flightdeckhq/schema";
import * as v from "valibot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { DEPLOY_PROCESS, drain } from "../src/index";

type Row = { seq: number; event_id: string; payload: string; sent_at: number | null };

/**
 * Stands in for Flightdeck's `Ingest` binding with its contract: the real schema and the
 * registered definition decide acceptance, a batch is all or nothing, and errors use the same
 * `lifecycle rejected (...)` / retryable messages.
 */
function fakeFlightdeck() {
  const definition = v.parse(ProcessDefinitionV1, DEPLOY_PROCESS);
  const stored: Record<string, unknown>[] = [];
  let outage: string | null = null;
  const check = (raw: unknown) => {
    const parsed = v.safeParse(LifecycleEventV1, raw);
    if (!parsed.success) throw new Error("lifecycle rejected (invalid_event): invalid");
    if (parsed.output.occurredAt > Date.now() + 5 * 60_000) {
      throw new Error("lifecycle rejected (future_occurred_at): ahead of the clock");
    }
    const problem = checkAgainstDefinition(parsed.output, definition)[0];
    if (problem) throw new Error(`lifecycle rejected (nonconforming_event): ${problem}`);
  };
  const binding = {
    registerProcess: vi.fn(async (d: unknown) => {
      v.parse(ProcessDefinitionV1, d);
      return { created: false };
    }),
    ingestLifecycleBatch: vi.fn(async (batch: { events: Record<string, unknown>[] }) => {
      if (outage) throw new Error(outage);
      batch.events.forEach(check);
      stored.push(...batch.events);
      return { accepted: batch.events.length };
    }),
    trackLifecycle: vi.fn(async (event: Record<string, unknown>) => {
      if (outage) throw new Error(outage);
      check(event);
      stored.push(event);
      return { accepted: 1 };
    }),
  };
  return {
    binding,
    stored,
    env: { ...env, FLIGHTDECK: binding } as unknown as Env,
    fail: (message: string | null) => {
      outage = message;
    },
  };
}

const post = (path: string) =>
  worker.fetch(new Request(`https://deploys.test${path}`, { method: "POST" }), env);

const outbox = async () =>
  (await env.DB.prepare("SELECT * FROM lifecycle_outbox ORDER BY seq").all<Row>()).results;
const types = (rows: Row[]) => rows.map((r) => JSON.parse(r.payload).type);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM lifecycle_outbox"),
    env.DB.prepare("DELETE FROM deploys"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

describe("transactional enqueue", () => {
  it("writes each state change and its lifecycle events together", async () => {
    expect((await post("/deploys/web-1/build")).status).toBe(200);
    expect(types(await outbox())).toEqual(["case.created", "stage.entered"]);
    expect((await post("/deploys/web-1/canary")).status).toBe(200);
    expect((await post("/deploys/web-1/done")).status).toBe(200);
    const rows = await outbox();
    expect(types(rows)).toEqual([
      "case.created",
      "stage.entered",
      "stage.exited",
      "stage.entered",
      "stage.exited",
      "stage.entered",
      "case.completed",
    ]);
    // Each exit names the instance the previous entry created.
    const events = rows.map((r) => JSON.parse(r.payload));
    expect(events[2].stageInstanceId).toBe(events[1].stageInstanceId);
    expect(events[4].stageInstanceId).toBe(events[3].stageInstanceId);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
    const deploy = await env.DB.prepare("SELECT stage, stage_instance FROM deploys").first();
    expect(deploy).toEqual({ stage: "done", stage_instance: events[5].stageInstanceId });
  });

  it("writes nothing for unknown stages or malformed ids", async () => {
    expect((await post("/deploys/web-1/teleport")).status).toBe(400);
    expect((await post("/deploys/_hidden/build")).status).toBe(404);
    expect(await outbox()).toEqual([]);
  });

  it("keeps the stage chain consistent under concurrent transitions", async () => {
    await post("/deploys/api-1/build");
    const statuses = await Promise.all(
      ["canary", "rollout", "canary", "done"].map(
        async (s) => (await post(`/deploys/api-1/${s}`)).status,
      ),
    );
    const won = statuses.filter((s) => s === 200).length;
    expect(won).toBeGreaterThanOrEqual(1);
    expect(won + statuses.filter((s) => s === 409).length).toBe(statuses.length);
    const events = (await outbox()).map((r) => JSON.parse(r.payload));
    const entered = events.filter((e) => e.type === "stage.entered");
    const exited = events.filter((e) => e.type === "stage.exited");
    // Only winners wrote events: one exit and one entry each, after the initial build entry.
    expect(exited).toHaveLength(won);
    expect(entered).toHaveLength(won + 1);
    // Every exit closes the instance entered just before it, and no instance closes twice.
    expect(exited.map((e) => e.stageInstanceId)).toEqual(
      entered.slice(0, won).map((e) => e.stageInstanceId),
    );
    const deploy = await env.DB.prepare("SELECT stage_instance FROM deploys").first();
    expect(deploy?.stage_instance).toBe(entered.at(-1)?.stageInstanceId);
  });
});

describe("drain", () => {
  it("registers the process, sends in order with sourceSequence = seq, then marks rows sent", async () => {
    const fd = fakeFlightdeck();
    await post("/deploys/web-2/build");
    await post("/deploys/web-2/canary");
    await drain(fd.env);
    expect(fd.binding.registerProcess).toHaveBeenCalledWith(DEPLOY_PROCESS);
    const rows = await outbox();
    expect(fd.stored.map((e) => e.eventId)).toEqual(rows.map((r) => r.event_id));
    expect(fd.stored.map((e) => e.sourceSequence)).toEqual(rows.map((r) => r.seq));
    expect(rows.every((r) => r.sent_at !== null)).toBe(true);
    await drain(fd.env);
    expect(fd.binding.ingestLifecycleBatch).toHaveBeenCalledTimes(1);
  });

  it("keeps rows pending through a retryable outage and resends the same event ids", async () => {
    const fd = fakeFlightdeck();
    await post("/deploys/web-3/build");
    fd.fail("lifecycle unavailable: LIFECYCLE_EVENTS is not bound");
    await expect(drain(fd.env)).rejects.toThrow(/lifecycle unavailable/);
    expect((await outbox()).every((r) => r.sent_at === null)).toBe(true);
    fd.fail(null);
    await drain(fd.env);
    expect(fd.stored.map((e) => e.eventId)).toEqual((await outbox()).map((r) => r.event_id));
  });

  it("quarantines only the events Flightdeck rejects for good", async () => {
    const fd = fakeFlightdeck();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await post("/deploys/web-4/build");
    const bad = {
      schemaVersion: 1,
      eventId: "evt_bad_dimension",
      processId: "deploy",
      processVersion: 1,
      type: "case.started",
      caseId: "deploy:web-4",
      occurredAt: Date.now(),
      dimensions: { tier: "gold" },
    };
    await env.DB.prepare("INSERT INTO lifecycle_outbox (event_id, payload) VALUES (?, ?)")
      .bind(bad.eventId, JSON.stringify(bad))
      .run();
    await post("/deploys/web-4/canary");
    await drain(fd.env);
    const rows = await env.DB.prepare(
      "SELECT event_id, sent_at, quarantined_at FROM lifecycle_outbox ORDER BY seq",
    ).all<{ event_id: string; sent_at: number | null; quarantined_at: number | null }>();
    const quarantined = rows.results.filter((r) => r.quarantined_at !== null);
    expect(quarantined.map((r) => r.event_id)).toEqual(["evt_bad_dimension"]);
    expect(rows.results.filter((r) => r.sent_at !== null)).toHaveLength(4);
    // Later drains neither resend sent rows nor retry quarantined ones.
    const calls = fd.binding.trackLifecycle.mock.calls.length;
    await drain(fd.env);
    expect(fd.binding.trackLifecycle).toHaveBeenCalledTimes(calls);
  });

  it("does not quarantine clock-skewed events: future_occurred_at is retryable", async () => {
    const fd = fakeFlightdeck();
    const ahead = {
      schemaVersion: 1,
      eventId: "evt_from_the_future",
      processId: "deploy",
      processVersion: 1,
      type: "case.created",
      caseId: "deploy:web-5",
      occurredAt: Date.now() + 60 * 60_000,
    };
    await env.DB.prepare("INSERT INTO lifecycle_outbox (event_id, payload) VALUES (?, ?)")
      .bind(ahead.eventId, JSON.stringify(ahead))
      .run();
    await expect(drain(fd.env)).rejects.toThrow(/future_occurred_at/);
    const row = await env.DB.prepare(
      "SELECT sent_at, quarantined_at FROM lifecycle_outbox WHERE event_id = ?",
    )
      .bind(ahead.eventId)
      .first();
    expect(row).toEqual({ sent_at: null, quarantined_at: null });
  });

  it("sends at most 100 events per run", async () => {
    const fd = fakeFlightdeck();
    for (let i = 0; i < 75; i++) await post(`/deploys/bulk-${i}/build`);
    await drain(fd.env);
    expect(fd.binding.ingestLifecycleBatch.mock.calls[0]?.[0].events).toHaveLength(100);
    await drain(fd.env);
    expect(fd.binding.ingestLifecycleBatch.mock.calls[1]?.[0].events).toHaveLength(50);
  });
});
