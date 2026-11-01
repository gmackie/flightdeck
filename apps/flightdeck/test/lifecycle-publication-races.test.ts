/** Deterministic Miniflare reproductions supplied by the independent PR56 reviewer. */
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { LifecycleProjector, REDUCER_VERSION } from "../src/lifecycle-projection/projector";
import { servingId } from "../src/lifecycle-projection/snapshot";
import { eraseCase } from "../src/lifecycle-projection/store";
import { caseDetail } from "../src/lifecycle-serving/read";
import { LifecycleSnapshotRepository } from "../src/lifecycle-serving/repository";
import { HOUR, openSnap, prov, repo, seed, snap, T0 } from "./lifecycle-fixtures";
import { deliver, producerApp } from "./support/harness";

it("probe: a pre-existing active drain must not acknowledge evidence refused during staging", async () => {
  const app = "app_review_race";
  const key = await producerApp(app);
  const now = Date.now() + 10_000;
  const p = new LifecycleProjector(env.DB, { now: () => now });
  const r = new LifecycleSnapshotRepository(env.DB);
  const base = {
    schemaVersion: 1 as const,
    processId: "recruiting.candidate",
    processVersion: 1,
    caseId: "race_case",
  };
  await deliver(key, [
    {
      ...base,
      eventId: "race_start",
      type: "case.started",
      occurredAt: now - 1000,
      sourceSequence: 1,
    },
  ]);
  await p.drain(app);
  // Exact retry queues the open case, so an actual drain can capture generation 1.
  await deliver(key, [
    {
      ...base,
      eventId: "race_start",
      type: "case.started",
      occurredAt: now - 1000,
      sourceSequence: 1,
    },
  ]);
  const captured = (await r.state(app))?.source_watermark ?? 0;
  let gen = 0;
  let injected = false;
  const crossing = {
    prepare(query: string) {
      const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(stmt, {
          get(target, prop) {
            if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
            if (
              prop === "all" &&
              query.includes("SELECT case_id, attempts FROM lifecycle_projection_queue")
            )
              return async () => {
                if (!injected) {
                  injected = true;
                  gen = await r.beginRebuild(app);
                  await p.projectCase(app, base.caseId, gen, false);
                  await deliver(key, [
                    {
                      ...base,
                      eventId: "race_end",
                      type: "case.completed",
                      occurredAt: now,
                      sourceSequence: 2,
                    },
                  ]);
                }
                return target.all();
              };
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      return wrap(env.DB.prepare(query));
    },
    batch: env.DB.batch.bind(env.DB),
  } as D1Database;
  const racing = await new LifecycleProjector(crossing, { now: () => now }).drain(app);
  expect(racing.remaining).toBe(1);
  expect(racing.failed).toBe(1);
  expect((await r.state(app))?.source_watermark).toBe(captured);
  const top = await env.DB.prepare(
    "SELECT max(seq) AS seq FROM lifecycle_event_log WHERE app_id = ?",
  )
    .bind(app)
    .first<{ seq: number }>();
  await r.commitRebuild(app, {
    generation: gen,
    source_watermark: captured,
    as_of: now,
    reducer_version: REDUCER_VERSION,
  });
  const drain = await p.drain(app);
  expect(drain.remaining).toBe(0);
  expect((await r.state(app))?.source_watermark).toBe(top?.seq);
  const detail = await caseDetail(env.DB, app, base.caseId);
  expect(detail?.status).toBe("closed");
});

it("probe: retention applied while a case is staged must survive publication", async () => {
  const app = "app_review_retention";
  const { repo: r } = repo(env.DB);
  await seed(r, app, [snap("expired")]);
  const gen = await r.beginRebuild(app);
  await r.upsertCase(app, snap("expired"), prov(gen, 200));
  expect(await r.applyRetention(app, T0 + 3 * HOUR)).toBe(1);
  expect(await caseDetail(env.DB, app, "expired")).toBeNull();
  await r.commitRebuild(app, prov(gen, 200));
  const detail = await caseDetail(env.DB, app, "expired");
  expect(detail).toBeNull();
});

it("probe: a read crossing publication must not mix generations", async () => {
  const app = "app_review_read";
  const { repo: r } = repo(env.DB);
  await seed(r, app, [snap("keep")]);
  const gen = await r.beginRebuild(app);
  await r.upsertCase(app, openSnap("keep"), prov(gen, 200));
  // caseDetail has fetched its summary when it calls batch for the remaining data.
  let fired = false;
  const crossing = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      if (!fired) {
        fired = true;
        await r.commitRebuild(app, prov(gen, 200));
      }
      return env.DB.batch(statements);
    },
  } as D1Database;
  const detail = await caseDetail(crossing, app, "keep");
  expect(detail?.intervals).toHaveLength(detail?.status === "closed" ? 2 : 1);
  expect(detail).toMatchObject({ status: "open", provenance: { generation: gen } });
});

it("probe: source erasure must block an already replayed in-flight snapshot", async () => {
  const app = "app_review_erase_race";
  const key = await producerApp(app);
  const now = Date.now() + 10_000;
  const base = {
    schemaVersion: 1 as const,
    processId: "recruiting.candidate",
    processVersion: 1,
    caseId: "erase_race_case",
  };
  await deliver(key, [
    {
      ...base,
      eventId: "erase_race_start",
      type: "case.started",
      occurredAt: now - 1000,
      sourceSequence: 1,
    },
  ]);
  await new LifecycleProjector(env.DB, { now: () => now }).drain(app);
  let erased = false;
  const crossing = {
    prepare(query: string) {
      const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(stmt, {
          get(target, prop) {
            if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
            if (prop === "run" && query.includes("INSERT INTO lifecycle_process_definitions"))
              return async () => {
                if (!erased) {
                  erased = true;
                  await eraseCase(env.DB, app, base.caseId, base.caseId, "source_deleted", now);
                }
                return target.run();
              };
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      return wrap(env.DB.prepare(query));
    },
    batch: env.DB.batch.bind(env.DB),
  } as D1Database;
  await new LifecycleProjector(crossing, { now: () => now }).projectCase(app, base.caseId, 1);
  const detail = await caseDetail(env.DB, app, base.caseId);
  const source = await env.DB.prepare(
    "SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id=?",
  )
    .bind(app)
    .first();
  const tombstone = await env.DB.prepare(
    "SELECT count(*) AS n FROM lifecycle_case_tombstones WHERE app_id=?",
  )
    .bind(app)
    .first();
  expect(detail).toBeNull();
  expect(source).toEqual({ n: 0 });
  expect(tombstone).toEqual({ n: 1 });
});

it("keeps work pending when a rebuild starts after a successful write but before acknowledgement", async () => {
  const app = "app_review_ack_fence";
  const key = await producerApp(app);
  const now = Date.now() + 10_000;
  const projector = new LifecycleProjector(env.DB, { now: () => now });
  const r = new LifecycleSnapshotRepository(env.DB);
  const base = {
    schemaVersion: 1 as const,
    processId: "recruiting.candidate",
    processVersion: 1,
    caseId: "ack_case",
  };
  await deliver(key, [
    {
      ...base,
      eventId: "ack_start",
      type: "case.started",
      occurredAt: now - 1000,
      sourceSequence: 1,
    },
  ]);
  await projector.drain(app);
  await deliver(key, [
    { ...base, eventId: "ack_finish", type: "case.completed", occurredAt: now, sourceSequence: 2 },
  ]);
  let fired = false;
  let generation = 0;
  const crossing = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      const results = await env.DB.batch(statements);
      // The first batch persists the case. The next one records diagnostics and acknowledges.
      if (!fired) {
        fired = true;
        generation = await r.beginRebuild(app);
      }
      return results;
    },
  } as D1Database;
  expect((await new LifecycleProjector(crossing, { now: () => now }).drain(app)).remaining).toBe(1);
  await r.failRebuild(app, generation, "synthetic_failure");
  expect((await projector.drain(app)).remaining).toBe(0);
  expect(await caseDetail(env.DB, app, base.caseId)).toMatchObject({ status: "closed" });
});

it("retention survives purge, late staging, and repeated rebuilds while keeping open cases", async () => {
  const app = "app_review_retention_purge";
  const { repo: r, clock } = repo(env.DB);
  await seed(r, app, [snap("expired"), openSnap("still_open")]);
  const generation = await r.beginRebuild(app);
  expect(await r.applyRetention(app, T0 + 3 * HOUR)).toBe(1);
  clock.now += HOUR;
  await r.purgeDeleted(app, clock.now);
  await r.upsertCase(app, snap("expired"), prov(generation, 200));
  await r.upsertCase(app, openSnap("still_open"), prov(generation, 200));
  await r.commitRebuild(app, prov(generation, 200));
  expect(await caseDetail(env.DB, app, "expired")).toBeNull();
  expect(await caseDetail(env.DB, app, "still_open")).toMatchObject({ status: "open" });
  const next = await r.beginRebuild(app);
  await r.upsertCase(app, snap("expired"), prov(next, 300));
  await r.commitRebuild(app, prov(next, 300));
  expect(await caseDetail(env.DB, app, "expired")).toBeNull();
});

it("keeps rebuild work pending if another rebuild starts between publication and acknowledgement", async () => {
  const app = "app_review_rebuild_ack";
  const key = await producerApp(app);
  const now = Date.now() + 10_000;
  const projector = new LifecycleProjector(env.DB, { now: () => now });
  const r = new LifecycleSnapshotRepository(env.DB);
  await deliver(key, [
    {
      schemaVersion: 1,
      processId: "recruiting.candidate",
      processVersion: 1,
      caseId: "rebuild_ack_case",
      eventId: "rebuild_ack_start",
      type: "case.started",
      occurredAt: now - 1000,
      sourceSequence: 1,
    },
  ]);
  let generation = 0;
  const crossing = {
    prepare(query: string) {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, prop) {
            if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args));
            if (prop === "run" && query.includes("case_id IN (SELECT value FROM json_each"))
              return async () => {
                generation = await r.beginRebuild(app);
                return target.run();
              };
            const value = Reflect.get(target, prop);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      return wrap(env.DB.prepare(query));
    },
    batch: env.DB.batch.bind(env.DB),
  } as D1Database;
  await new LifecycleProjector(crossing, { now: () => now }).rebuild(app);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM lifecycle_projection_queue WHERE app_id = ?")
      .bind(app)
      .first(),
  ).toEqual({ n: 1 });
  await r.failRebuild(app, generation, "synthetic_failure");
  expect((await projector.drain(app)).remaining).toBe(0);
});

it("checks existing source tombstones inside persistence, including mapped producer ids", async () => {
  const app = "app_review_source_fence";
  const { repo: r } = repo(env.DB);
  await seed(r, app, []);
  await env.DB.prepare(
    "INSERT INTO lifecycle_case_tombstones (app_id, case_id, reason, erased_at) VALUES (?, ?, 'source_deleted', ?)",
  )
    .bind(app, "producer:case:erased", Date.now())
    .run();
  expect(await r.upsertCase(app, snap("mapped_case"), prov(1, 200), "producer:case:erased")).toBe(
    "tombstoned",
  );
  expect(await caseDetail(env.DB, app, "mapped_case")).toBeNull();
});

it("fences mapped source erasure immediately before the snapshot transaction and refuses serving-only restore", async () => {
  const app = "app_review_erase_before_batch";
  const { repo: r } = repo(env.DB);
  await seed(r, app, []);
  const sourceId = "producer:erased:case";
  const mapped = await servingId(sourceId);
  let fired = false;
  const crossing = {
    prepare: env.DB.prepare.bind(env.DB),
    async batch(statements: D1PreparedStatement[]) {
      if (!fired) {
        fired = true;
        await eraseCase(env.DB, app, sourceId, mapped, "source_deleted", Date.now());
      }
      return env.DB.batch(statements);
    },
  } as D1Database;
  expect(
    await new LifecycleSnapshotRepository(crossing).upsertCase(
      app,
      snap(mapped),
      prov(1, 200),
      sourceId,
    ),
  ).toBe("tombstoned");
  expect(await caseDetail(env.DB, app, mapped)).toBeNull();
  expect(
    await r.restoreCase(
      app,
      mapped,
      { reason: "operator_restore", approval_ref: "apr_source" },
      async () => true,
    ),
  ).toBe(false);
  // Re-tombstoning cannot turn an irreversible source erasure into a restorable serving deletion.
  await r.tombstoneCase(app, mapped, prov(1, 300));
  expect(
    await r.restoreCase(
      app,
      mapped,
      { reason: "operator_restore", approval_ref: "apr_source" },
      async () => true,
    ),
  ).toBe(false);
  expect(await r.upsertCase(app, snap(mapped), prov(1, 400), sourceId)).toBe("tombstoned");
});
