import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { appsWithDueWork, LifecycleProjector } from "../src/lifecycle-projection/projector";
import { caseDetail, stageSummary } from "../src/lifecycle-serving/read";
import { LifecycleSnapshotRepository } from "../src/lifecycle-serving/repository";
import { DAY, openSnap, repo, seed, snap, T0 } from "./lifecycle-fixtures";
import { deliver, producerApp } from "./support/harness";

describe("P1 future evidence", () => {
  it("keeps eligible history visible through a rebuild and never acknowledges later evidence past an earlier future row", async () => {
    const app = "app_future_rebuild_history";
    const key = await producerApp(app);
    let now = Date.now();
    const projector = new LifecycleProjector(env.DB, { now: () => now });
    const base = {
      schemaVersion: 1 as const,
      processId: "recruiting.candidate",
      processVersion: 1,
      caseId: "history_case",
    };
    await deliver(key, [
      {
        ...base,
        eventId: "history_start",
        type: "case.started",
        occurredAt: now - 1000,
        sourceSequence: 1,
      },
    ]);
    await projector.drain(app);
    const before = await caseDetail(env.DB, app, base.caseId);
    await deliver(key, [
      {
        ...base,
        eventId: "history_future",
        type: "case.completed",
        occurredAt: now + 120_000,
        sourceSequence: 3,
      },
      {
        ...base,
        eventId: "history_pause",
        type: "case.paused",
        occurredAt: now,
        sourceSequence: 2,
      },
    ]);
    const future = await env.DB.prepare(
      "SELECT seq FROM lifecycle_event_log WHERE app_id = ? AND event_id = 'history_future'",
    )
      .bind(app)
      .first<{ seq: number }>();
    expect((await projector.drain(app)).remaining).toBe(1);
    await projector.rebuild(app);
    expect(await caseDetail(env.DB, app, base.caseId)).toMatchObject({
      status: "open",
      started_at: before?.started_at,
    });
    expect(
      (await new LifecycleSnapshotRepository(env.DB).state(app))?.source_watermark,
    ).toBeLessThan(future?.seq ?? 0);
    now += 120_000;
    expect((await projector.drain(app)).remaining).toBe(0);
    expect(await caseDetail(env.DB, app, base.caseId)).toMatchObject({
      status: "closed",
      ended_at: now,
    });
  });

  for (const initial of [true, false]) {
    it(`retries future evidence at event time (${initial ? "initial rebuild" : "incremental"})`, async () => {
      const app = `app_future_${initial}`;
      const key = await producerApp(app);
      let now = Date.now();
      const projector = new LifecycleProjector(env.DB, { now: () => now });
      if (!initial) await projector.drain(app);
      const eligible = now + 120_000;
      await deliver(key, [
        {
          schemaVersion: 1,
          eventId: "future_start",
          processId: "recruiting.candidate",
          processVersion: 1,
          type: "case.started",
          caseId: "future_case",
          occurredAt: eligible,
          sourceSequence: 1,
        },
      ]);
      const top = await env.DB.prepare(
        "SELECT max(seq) AS seq FROM lifecycle_event_log WHERE app_id = ?",
      )
        .bind(app)
        .first<{ seq: number }>();
      expect((await projector.drain(app)).remaining).toBe(1);
      expect(await caseDetail(env.DB, app, "future_case")).toBeNull();
      const state = await new LifecycleSnapshotRepository(env.DB).state(app);
      expect(state?.source_watermark).toBeLessThan(top?.seq ?? 0);
      expect(await appsWithDueWork(env.DB, now)).not.toContain(app);
      now = eligible - 1;
      expect((await projector.drain(app)).remaining).toBe(1);
      now = eligible;
      expect(await appsWithDueWork(env.DB, now)).toContain(app);
      expect((await projector.drain(app)).remaining).toBe(0);
      expect(await caseDetail(env.DB, app, "future_case")).toMatchObject({
        status: "open",
        started_at: eligible,
      });
      expect((await new LifecycleSnapshotRepository(env.DB).state(app))?.source_watermark).toBe(
        top?.seq,
      );
    });
  }
});

describe("P1 completed cohort suppression", () => {
  for (const [closed, open] of [
    [1, 4],
    [5, 1],
    [1, 5],
    [0, 5],
    [5, 5],
  ]) {
    it(`protects ${closed} completed / ${open} censored cases`, async () => {
      const app = `app_singleton_${closed}_${open}`;
      const { repo: r } = repo(env.DB);
      await seed(r, app, [
        ...Array.from({ length: closed ?? 0 }, (_, i) => snap(`closed_${i}`)),
        ...Array.from({ length: open ?? 0 }, (_, i) => openSnap(`open_${i}`)),
      ]);
      const summary = await stageSummary(
        env.DB,
        app,
        {
          processKey: "deploy",
          version: 1,
          status: null,
          startedAfter: T0,
          startedBefore: T0 + DAY,
        },
        5,
      );
      const small = (closed !== 0 && (closed ?? 0) < 5) || (open !== 0 && (open ?? 0) < 5);
      if (small) {
        expect(summary.groups.find((g) => g.stage_key === "build")).toBeUndefined();
        expect(summary.suppressed).toBe(true);
      } else {
        const build = summary.groups.find((g) => g.stage_key === "build");
        expect(build?.closed_intervals).toBe(closed);
        expect(build?.open_intervals).toBe(open);
        expect(build?.dwell_ms.p50 === null).toBe(closed === 0);
      }
    });
  }
});
