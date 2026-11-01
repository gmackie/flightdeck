import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { LifecycleEventInput } from "@flightdeckhq/schema";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { diagnoseWorkflowSnapshot } from "../../dashboard/src/workflows/adapter";
import {
  isCaseDetailEnvelope,
  isCaseList,
  isProcessList,
  liveSnapshot,
} from "../../dashboard/src/workflows/live-adapter";
import { lifecycleIngest } from "../src/ingest/lifecycle-http";
import { LifecycleProjector } from "../src/lifecycle-projection/projector";
import { drainLifecycle } from "../src/lifecycle-projection/schedule";
import { eraseCase } from "../src/lifecycle-projection/store";
import { LifecycleSnapshotRepository } from "../src/lifecycle-serving/repository";
import { adaptFixtures, type DeliveryRecord } from "./support/fixture-adapter";
import {
  deliver,
  grant,
  type Json,
  producerApp,
  project,
  read,
  servedModel,
  token,
} from "./support/harness";

/**
 * The integrated read path and projection invariants: scoped grants on the served routes, no
 * cross-app reads, parent/child interview loops, duplicate and reordered delivery, rebuilds,
 * erasure, freshness, retries and the Basin outbox.
 */

const scenario = (name: string) =>
  (
    Object.values(
      import.meta.glob("../../../examples/lifecycle-fixtures/fixtures/scenarios/*.json", {
        eager: true,
        import: "default",
      }),
    ) as { name: string; records: DeliveryRecord[] }[]
  ).find((s) => s.name === name)?.records ?? [];

/** One fixture app's events, adapted to the wire contract. */
async function eventsOf(name: string, fixtureApp?: string): Promise<LifecycleEventInput[]> {
  const { byApp } = await adaptFixtures(scenario(name));
  const events = fixtureApp ? byApp.get(fixtureApp) : [...byApp.values()][0];
  if (!events) throw new Error(`no events for ${name}`);
  return events;
}

/** The served model without provenance (which legitimately differs between equal projections). */
async function content(appId: string) {
  const model = await servedModel(appId);
  return { ...model, cases: model.cases.map(({ source_watermark: _w, ...c }: Json) => c) };
}

const READER = "reader-person";
const ANALYST = "analyst-person";
const OUTSIDER = "outsider-person";
const SERVICE = "svc-reader.access";
const APP = "app_int_talent";
const OTHER = "app_int_other";
const SCOPED = "app_int_scoped";
const UNKNOWN = "app_int_missing";
let events: LifecycleEventInput[];
let pipelineKey: string;

beforeAll(async () => {
  events = await eventsOf("recruiting-pipeline");
  pipelineKey = await producerApp(APP);
  await deliver(pipelineKey, events);
  await project(APP);
  // Two apps whose histories reuse identical event and case ids (app-scope-separation).
  for (const [appId, fixtureApp] of [
    [SCOPED, "app_talent"],
    [OTHER, "app_hiring2"],
  ] as const) {
    await deliver(await producerApp(appId), await eventsOf("app-scope-separation", fixtureApp));
    await project(appId);
  }
  await grant(READER, "reader", APP);
  await grant(ANALYST, "analyst", APP);
  await grant(READER, "reader", SCOPED);
  await grant(OUTSIDER, "reader", OTHER);
  await grant(SERVICE, "reader", APP, "service");
});
afterEach(() => vi.restoreAllMocks());

describe("served lifecycle routes under read grants", () => {
  it("serves a reader's granted app with freshness provenance", async () => {
    const res = await read(`/api/apps/${APP}/lifecycle/cases?limit=100`, await token(READER));
    expect(res.status).toBe(200);
    expect(res.body.app_id).toBe(APP);
    expect(res.body.data.length).toBeGreaterThan(5);
    expect(res.body.data_freshness).toMatchObject({
      status: "fresh",
      projection: "ready",
      pending_cases: 0,
      generation: 1,
    });
    const processes = await read(`/api/apps/${APP}/lifecycle/processes`, await token(READER));
    expect(processes.body.data.map((p: Json) => p.process_key)).toContain(
      "recruiting.interview_loop",
    );
  });

  it("answers an ungranted app and an unknown app identically, without enumerating", async () => {
    const jwt = await token(READER);
    const ungranted = await read(`/api/apps/${OTHER}/lifecycle/cases`, jwt);
    const unknown = await read(`/api/apps/${UNKNOWN}/lifecycle/cases`, jwt);
    expect(ungranted).toEqual({ status: 403, body: { error: "Forbidden" } });
    expect(unknown).toEqual(ungranted);
    for (const path of ["processes", "diagnostics", "summaries/outcomes", "cases/abcdefgh12"]) {
      expect((await read(`/api/apps/${OTHER}/lifecycle/${path}`, jwt)).status).toBe(403);
    }
  });

  it("keeps colliding case ids apart: each app reads only its own history", async () => {
    const mine = await servedModel(SCOPED);
    const theirs = await servedModel(OTHER);
    const shared = mine.cases
      .map((c: Json) => c.case_id)
      .filter((id: string) => theirs.cases.some((t: Json) => t.case_id === id));
    expect(shared.length).toBeGreaterThan(0);
    for (const id of shared) {
      const own = await read(`/api/apps/${SCOPED}/lifecycle/cases/${id}`, await token(READER));
      const other = await read(`/api/apps/${OTHER}/lifecycle/cases/${id}`, await token(OUTSIDER));
      const row = (model: typeof mine) => model.cases.find((c: Json) => c.case_id === id) as Json;
      expect(own.body.data).toMatchObject({
        outcome: row(mine).outcome,
        ended_at: row(mine).ended_at,
      });
      expect(other.body.data).toMatchObject({
        outcome: row(theirs).outcome,
        ended_at: row(theirs).ended_at,
      });
      // Neither principal can read the other app's copy.
      expect(
        (await read(`/api/apps/${OTHER}/lifecycle/cases/${id}`, await token(READER))).status,
      ).toBe(403);
    }
  });

  it("requires process:read (analyst) for aggregates; reader gets 403", async () => {
    const path = `/api/apps/${APP}/lifecycle/summaries/outcomes?process_key=recruiting.candidate&version=1&started_after=2026-01-01&started_before=2026-12-31`;
    expect((await read(path, await token(READER))).status).toBe(403);
    const analyst = await read(path, await token(ANALYST));
    expect(analyst.status).toBe(503);
    expect(analyst.body).toEqual({ error: "Lifecycle aggregate adapter unavailable" });
  });

  it("caps service tokens at app-scoped reader and needs an Access assertion at all", async () => {
    const service = await token(SERVICE, true);
    expect((await read(`/api/apps/${APP}/lifecycle/cases`, service)).status).toBe(200);
    const aggregate = `/api/apps/${APP}/lifecycle/summaries/stages?process_key=recruiting.candidate&version=1`;
    expect((await read(aggregate, service)).status).toBe(403);
    expect((await read(`/api/apps/${APP}/lifecycle/cases`, null)).status).toBe(401);
  });

  it("applies revocation on the next request", async () => {
    const subject = "revoked-person";
    await grant(subject, "reader", APP);
    expect((await read(`/api/apps/${APP}/lifecycle/cases`, await token(subject))).status).toBe(200);
    await env.DB.prepare("UPDATE authz_grants SET revoked_at = ? WHERE principal_subject = ?")
      .bind(Date.now(), subject)
      .run();
    expect((await read(`/api/apps/${APP}/lifecycle/cases`, await token(subject))).status).toBe(403);
  });

  it("still reserves the rest of the lifecycle namespace behind grants", async () => {
    expect((await read(`/api/apps/${APP}/lifecycle/policy`, await token(READER))).status).toBe(200);
    expect((await read(`/api/apps/${OTHER}/lifecycle/policy`, await token(READER))).status).toBe(
      403,
    );
    expect((await read(`/api/apps/${APP}/lifecycle/nope`, await token(READER))).status).toBe(404);
  });
});

describe("parent-child interview loops", () => {
  it("serves candidate -> interview loop -> assessment hierarchies both ways", async () => {
    const model = await servedModel(APP);
    const loops = model.cases.filter((c: Json) => c.process_key === "recruiting.interview_loop");
    expect(loops.length).toBe(2);
    const jwt = await token(READER);
    for (const loop of loops) {
      expect(loop.parent_case_id).toBeTruthy();
      const parent = await read(`/api/apps/${APP}/lifecycle/cases/${loop.parent_case_id}`, jwt);
      expect(parent.body.data.process_key).toBe("recruiting.candidate");
      expect(parent.body.data.children.items.map((c: Json) => c.case_id)).toContain(loop.case_id);
      const detail = await read(`/api/apps/${APP}/lifecycle/cases/${loop.case_id}`, jwt);
      expect(detail.body.data.parent).toMatchObject({
        case_id: loop.parent_case_id,
        available: true,
      });
      const assessments = await read(
        `/api/apps/${APP}/lifecycle/cases?parent=${loop.case_id}`,
        jwt,
      );
      for (const a of assessments.body.data) expect(a.process_key).toBe("recruiting.assessment");
    }
  });
});

describe("dashboard contract", () => {
  it("real API responses pass the dashboard's guards and map into its live view model", async () => {
    const jwt = await token(READER);
    const processes = await read(`/api/apps/${APP}/lifecycle/processes`, jwt);
    expect(isProcessList(processes.body)).toBe(true);
    const groups = [];
    for (const process of processes.body.data) {
      const list = await read(
        `/api/apps/${APP}/lifecycle/cases?process_key=${process.process_key}&version=${process.version}&limit=100`,
        jwt,
      );
      expect(isCaseList(list.body)).toBe(true);
      const cases = [];
      for (const c of list.body.data) {
        const detail = await read(`/api/apps/${APP}/lifecycle/cases/${c.case_id}`, jwt);
        expect(isCaseDetailEnvelope(detail.body)).toBe(true);
        cases.push(detail.body.data);
      }
      groups.push({ process, cases });
    }
    const snapshot = liveSnapshot(groups, processes.body.as_of);
    expect(snapshot.source.synthetic).toBe(false);
    expect(diagnoseWorkflowSnapshot(snapshot)).toEqual([]);
    // Interview loops nest under their candidate in the dashboard hierarchy.
    const nested = (nodes: readonly Json[]): Json[] =>
      nodes.flatMap((n) => [n, ...nested(n.children ?? [])]);
    const all = snapshot.portfolios.flatMap((p) => nested(p.roots));
    const loops = (await servedModel(APP)).cases.filter(
      (c: Json) => c.process_key === "recruiting.interview_loop",
    );
    for (const loop of loops) {
      const parent = all.find((n) => n.id === loop.parent_case_id);
      expect(parent?.children?.map((c: Json) => c.id)).toContain(loop.case_id);
    }
  });
});

describe("delivery invariants", () => {
  it("redelivering every event changes nothing: log dedupe and idempotent projection", async () => {
    const count = () =>
      env.DB.prepare("SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id = ?")
        .bind(APP)
        .first<{ n: number }>();
    const before = { rows: await count(), model: await servedModel(APP) };
    await deliver(pipelineKey, events);
    await project(APP);
    expect(await count()).toEqual(before.rows);
    expect(await servedModel(APP)).toEqual(before.model);
  });

  it("reversed (late, newest-first) delivery projects the same model as in-order", async () => {
    const appId = "app_int_reversed";
    await deliver(await producerApp(appId), [...events].reverse());
    await project(appId);
    expect(await content(appId)).toEqual(await content(APP));
  });

  it("projects incrementally: a late event lands without disturbing other cases", async () => {
    const appId = "app_int_late";
    const key = await producerApp(appId);
    const [first, ...rest] = [...events].sort((a, b) => a.sourceSequence - b.sourceSequence);
    await deliver(key, rest.slice(0, 20));
    await project(appId);
    await deliver(key, [...rest.slice(20), first as LifecycleEventInput]);
    await project(appId);
    expect(await content(appId)).toEqual(await content(APP));
  });

  it("a rebuild reproduces the same model in a new generation", async () => {
    const before = await content(APP);
    await new LifecycleProjector(env.DB).rebuild(APP);
    expect(await content(APP)).toEqual(before);
    const state = await new LifecycleSnapshotRepository(env.DB).state(APP);
    expect(state).toMatchObject({
      status: "ready",
      active_generation: 2,
      building_generation: null,
    });
  });

  it("keeps both copies of a conflicting event id and reports the conflict", async () => {
    const appId = "app_int_conflict";
    await deliver(await producerApp(appId), await eventsOf("duplicate-id-conflict"));
    await project(appId);
    const rows = await env.DB.prepare(
      "SELECT event_id, count(*) AS n FROM lifecycle_event_log WHERE app_id = ? GROUP BY event_id HAVING n > 1",
    )
      .bind(appId)
      .all();
    expect(rows.results).toHaveLength(1);
    await grant(READER, "reader", appId);
    const diagnostics = await read(`/api/apps/${appId}/lifecycle/diagnostics`, await token(READER));
    expect(diagnostics.body.data.diagnostics).toContainEqual({
      code: "duplicate_conflict",
      count: 1,
    });
  });
});

describe("erasure", () => {
  it("removes a case and suppresses later deliveries instead of resurrecting it", async () => {
    const appId = "app_int_erase";
    const key = await producerApp(appId);
    await deliver(key, events);
    await project(appId);
    const victim = (await servedModel(appId)).cases.find(
      (c: Json) => c.process_key === "recruiting.candidate",
    ) as Json;
    await eraseCase(env.DB, appId, victim.case_id, victim.case_id, "source_deleted", Date.now());
    const mine = events.filter((e) => e.caseId === victim.case_id);
    await deliver(key, mine);
    await project(appId);
    const model = await servedModel(appId);
    expect(model.cases.map((c: Json) => c.case_id)).not.toContain(victim.case_id);
    expect(model.intervals.filter((i: Json) => i.case_id === victim.case_id)).toEqual([]);
    await grant(READER, "reader", appId);
    const jwt = await token(READER);
    expect((await read(`/api/apps/${appId}/lifecycle/cases/${victim.case_id}`, jwt)).status).toBe(
      404,
    );
    const diagnostics = await read(`/api/apps/${appId}/lifecycle/diagnostics`, jwt);
    expect(diagnostics.body.data.diagnostics).toContainEqual({
      code: "erased_case_event",
      count: mine.length,
    });
  });

  it("an erasure before the first projection still wins over a later backfill", async () => {
    const appId = "app_int_erase_first";
    const key = await producerApp(appId);
    const victim = events.find((e) => e.processId === "recruiting.candidate")?.caseId as string;
    await eraseCase(env.DB, appId, victim, victim, "source_deleted", Date.now());
    await deliver(key, events);
    await project(appId);
    const ids = (await servedModel(appId)).cases.map((c: Json) => c.case_id);
    expect(ids).not.toContain(victim);
    expect(ids.length).toBe((await servedModel(APP)).cases.length - 1);
  });
});

describe("freshness, retries and the Basin outbox", () => {
  it("reports unprojected work as unavailable, then fresh with the watermark advanced", async () => {
    const appId = "app_int_fresh";
    const key = await producerApp(appId);
    await grant(READER, "reader", appId);
    await deliver(key, events.slice(0, 10));
    const before = await read(`/api/apps/${appId}/lifecycle/cases`, await token(READER));
    expect(before.body.data_freshness).toMatchObject({ status: "unavailable", projection: "none" });
    expect(before.body.data_freshness.pending_cases).toBeGreaterThan(0);
    await project(appId);
    const after = await read(`/api/apps/${appId}/lifecycle/cases`, await token(READER));
    expect(after.body.data_freshness).toMatchObject({ status: "fresh", pending_cases: 0 });
    await deliver(key, events.slice(10));
    const pending = await read(`/api/apps/${appId}/lifecycle/cases`, await token(READER));
    expect(pending.body.data_freshness.pending_cases).toBeGreaterThan(0);
    expect(pending.body.data_freshness.source_watermark).toBe(
      after.body.data_freshness.source_watermark,
    );
    await project(appId);
    const done = await read(`/api/apps/${appId}/lifecycle/cases`, await token(READER));
    expect(done.body.data_freshness.pending_cases).toBe(0);
    expect(done.body.data_freshness.source_watermark).toBeGreaterThan(
      after.body.data_freshness.source_watermark,
    );
  });

  it("retries a failed case projection with backoff and records only a code", async () => {
    const appId = "app_int_retry";
    const key = await producerApp(appId);
    await deliver(key, events.slice(0, 5));
    await project(appId);
    await deliver(key, events.slice(5, 12));
    const upsert = vi
      .spyOn(LifecycleSnapshotRepository.prototype, "upsertCase")
      .mockRejectedValueOnce(new Error("d1 overloaded with secret detail"));
    let now = Date.now();
    const projector = new LifecycleProjector(env.DB, { now: () => now });
    const first = await projector.drain(appId);
    expect(first.failed).toBe(1);
    await grant(READER, "reader", appId);
    const report = await read(`/api/apps/${appId}/lifecycle/diagnostics`, await token(READER));
    expect(report.body.data.queue).toMatchObject({
      retrying_cases: 1,
      error_codes: [{ code: "projection_error", cases: 1 }],
    });
    expect(JSON.stringify(report.body)).not.toContain("secret");
    // Not yet due: the backoff holds the case back.
    expect((await projector.drain(appId)).projected).toBe(0);
    now += 60_000;
    expect((await projector.drain(appId)).remaining).toBe(0);
    expect(upsert).toHaveBeenCalled();
  });

  it("forwards pending events to the Basin stream from the scheduled drain, with retries", async () => {
    const pending = () =>
      env.DB.prepare("SELECT count(*) AS n FROM lifecycle_event_log WHERE forwarded_at IS NULL")
        .first<{ n: number }>()
        .then((r) => r?.n ?? 0);
    expect(await pending()).toBeGreaterThan(0); // the test Worker has no stream bound
    const failing = { send: vi.fn().mockRejectedValue(new Error("stream down")) };
    await drainLifecycle({ ...env, LIFECYCLE_EVENTS: failing } as unknown as Env);
    expect(failing.send).toHaveBeenCalledTimes(1);
    const failed = await env.DB.prepare(
      "SELECT count(*) AS n FROM lifecycle_event_log WHERE forward_error = 'send_failed'",
    ).first<{ n: number }>();
    expect(failed?.n).toBeGreaterThan(0);
    const sent: unknown[] = [];
    const stream = { send: vi.fn(async (rows: unknown[]) => void sent.push(...rows)) };
    const later = Date.now() + 2 * 60 * 60_000;
    for (let i = 0; i < 100 && (await pending()) > 0; i++) {
      await drainLifecycle({ ...env, LIFECYCLE_EVENTS: stream } as unknown as Env, () => later);
    }
    expect(await pending()).toBe(0);
    expect(sent.length).toBeGreaterThan(0);
  });

  it("projects after the response when ingest runs with an execution context", async () => {
    const appId = "app_int_auto";
    const key = await producerApp(appId);
    const ctx = createExecutionContext();
    const res = await lifecycleIngest(
      new Request("https://flightdeck.test/v1/lifecycle/events", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ events: events.slice(0, 30) }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    await waitOnExecutionContext(ctx);
    expect((await servedModel(appId)).cases.length).toBeGreaterThan(0);
  });
});
