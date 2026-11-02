import { env } from "cloudflare:workers";
import type { LifecycleEventInput } from "@flightdeckhq/schema";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { retentionConfig } from "../src/lifecycle-erasure/config";
import { drainJob, getJob, requestErasure, submitReceipt } from "../src/lifecycle-erasure/jobs";
import {
  applyRetention,
  inspectRetention,
  recordReconciliation,
} from "../src/lifecycle-erasure/retention";
import { LifecycleProjector } from "../src/lifecycle-projection/projector";
import { servingId } from "../src/lifecycle-projection/snapshot";
import { sinks } from "../src/sinks";
import { makeSigner, type Signer, syntheticRunner } from "./support/erasure";
import {
  caseDigest,
  clockAt,
  count,
  envOn,
  erasureDeps,
  forwardOutbox,
  loadEvents,
  MIN,
  markForwarded,
  ON,
  OP,
  pausedSink,
  rows,
  seedApp,
  TABLE,
} from "./support/erasure-review";
import { deliver, producerApp, project, servedModel } from "./support/harness";

/**
 * One regression per finding of the independent PR #57 review (thread "Independent erasure and
 * retention PR57 review"). Receipts here deliberately use the shape the pre-fix contract
 * accepted, so these fail on the unfixed code for the reported reason. All data is synthetic.
 */

const T0 = 1_900_000_000_000;
const FAR = Date.now() + 900 * 86_400_000;
const RET = {
  LIFECYCLE_RETENTION_MODE: "enforce",
  LIFECYCLE_RETENTION_POLICY_VERSION: "retention-1",
  LIFECYCLE_RETENTION_CLOSED_DAYS: "400",
  LIFECYCLE_RETENTION_LOG_DAYS: "400",
};
let events: LifecycleEventInput[];
let signer: Signer;

beforeAll(async () => {
  events = await loadEvents();
  signer = await makeSigner();
});
afterEach(() => vi.restoreAllMocks());

const retDeps = (vars: Record<string, string> = RET) => ({
  db: env.DB,
  config: retentionConfig(vars),
  now: () => FAR,
});

/** Fixture shortcut for retention tests: set the checkpoint directly (attestation is tested elsewhere). */
async function forceCheckpoint(appId: string, through?: number) {
  const top =
    through ??
    (await count("SELECT max(seq) AS n FROM lifecycle_event_log WHERE app_id = ?", appId));
  const base = [appId, top, FAR, "a".repeat(64), FAR] as const;
  try {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO lifecycle_retention_checkpoints
         (app_id, reconciled_through_seq, verified_at, evidence_checksum, updated_at, allocated_seq, rows_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(...base, top, "b".repeat(64))
      .run();
  } catch {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO lifecycle_retention_checkpoints
         (app_id, reconciled_through_seq, verified_at, evidence_checksum, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(...base)
      .run();
  }
}

describe("P1-1: a reconciliation checkpoint cannot cover rows that do not exist yet", () => {
  it("rejects a future through_seq, and an empty-app checkpoint never authorizes later rows", async () => {
    const appId = "app_rev_future";
    const key = await producerApp(appId);
    const future = await signer.sign({
      v: 1,
      kind: "basin_reconciliation",
      app_id: appId,
      through_seq: 1_000_000,
      event_count: 0,
      issued_at: FAR,
    });
    const res = await recordReconciliation(
      { ...retDeps(), verifier: signer.verifier },
      OP,
      appId,
      future,
    );
    expect(res.recorded).toBe(false);
    expect(
      await count(
        "SELECT count(*) AS n FROM lifecycle_retention_checkpoints WHERE app_id = ?",
        appId,
      ),
    ).toBe(0);
    // Whatever happened above, rows ingested afterwards were never reconciled and must survive.
    await deliver(key, events);
    await project(appId);
    await markForwarded(appId);
    const before = await count(
      "SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id = ?",
      appId,
    );
    expect(await applyRetention(retDeps(), appId)).toMatchObject({ retired_cases: 0 });
    expect(
      await count("SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id = ?", appId),
    ).toBe(before);
    expect((await inspectRetention(retDeps(), appId)).eligible.cases).toBe(0);
  });
});

describe("P1-2: an in-flight outbox send cannot deliver an erased case after the job completes", () => {
  it("holds the job until the paused sender has released and the drain bound has passed", async () => {
    const { appId, caseId } = await (async () => {
      const seeded = await seedApp(events, "app_rev_fence");
      const first = (
        await rows(
          "SELECT case_id FROM lifecycle_event_log WHERE app_id = ? ORDER BY seq LIMIT 1",
          seeded.appId,
        )
      )[0]?.case_id as string;
      return { appId: seeded.appId, caseId: first };
    })();
    const { now, advance, clock } = clockAt(T0);
    const vars = {
      ...ON,
      LIFECYCLE_ERASURE_SETTLE_MS: "120000",
      LIFECYCLE_ERASURE_CLEANUP_DELAY_MS: "1000",
    };
    const { runner } = syntheticRunner({ signer, now });
    const d = erasureDeps(signer, now, runner, vars);
    const sink = pausedSink();
    const forwarding = forwardOutbox(envOn(), T0);
    await sink.reached; // rows for the case are now selected and mid-send
    expect(sink.sent).toEqual([]);

    await requestErasure(d, OP, { appId, caseId, reason: "subject_request" });
    for (let i = 0; i < 8; i++) {
      advance(MIN);
      await drainJob(d, { appId, caseId, purgeGeneration: 1 });
    }
    // Eight minutes later, well inside the sender's lease, with the send still unresolved:
    const mid = await getJob(env.DB, OP, appId, caseId);
    expect(mid?.stage).not.toBe("complete");
    expect(mid?.proof).toBe("none");

    sink.release();
    await forwarding;
    expect(sink.sent.some((s) => s.case_id === caseId)).toBe(true); // the erased case did arrive

    let job = await getJob(env.DB, OP, appId, caseId);
    for (let i = 0; i < 60 && job?.stage !== "complete"; i++) {
      advance(MIN);
      job = await drainJob(d, { appId, caseId, purgeGeneration: 1 });
    }
    expect(job?.stage).toBe("complete");
    // The DELETE was committed after the late delivery plus the drain bound, not before it.
    const released = await count(
      "SELECT max(released_at) AS n FROM lifecycle_forward_claims WHERE app_id = ? AND case_id = ?",
      appId,
      caseId,
    );
    const committed = await count(
      "SELECT logical_committed_at AS n FROM lifecycle_erasure_jobs WHERE app_id = ?",
      appId,
    );
    expect(released).toBeGreaterThan(0);
    expect(committed).toBeGreaterThanOrEqual(released + 15 * MIN);
    expect(clock.t).toBeGreaterThan(committed);
  });

  it("a send that was claimed for a case erased meanwhile never delivers that case", async () => {
    const { appId, caseId } = await seedApp(events, "app_rev_unclaimed");
    const { now } = clockAt(T0);
    const d = erasureDeps(signer, now, undefined, ON);
    // Erase before the outbox pass: the pass must not claim or send the case's rows.
    await requestErasure(d, OP, { appId, caseId, reason: "subject_request" });
    const sent: string[] = [];
    vi.spyOn(sinks, "lifecycle").mockImplementation(
      async (_e, batch) => void sent.push(...batch.map((r) => r.case_id)),
    );
    await forwardOutbox(envOn(), T0);
    expect(sent).not.toContain(caseId);
    expect(
      await count(
        "SELECT count(*) AS n FROM lifecycle_forward_claims WHERE app_id = ? AND case_id = ?",
        appId,
        caseId,
      ),
    ).toBe(0);
  });
});

describe("P1-3: zero query-visible rows plus orphan removal does not prove physical deletion", () => {
  it("a receipt chain that attests only that never completes a job", async () => {
    const { appId, caseId } = await seedApp(events, "app_rev_mor");
    const { now, advance } = clockAt(T0);
    const d = erasureDeps(signer, now, undefined, ON);
    await requestErasure(d, OP, { appId, caseId, reason: "subject_request" });
    advance(30 * MIN);
    const nonce = (
      await rows("SELECT nonce, settle_until FROM lifecycle_erasure_jobs WHERE app_id = ?", appId)
    )[0] as { nonce: string; settle_until: number };
    const digest = await caseDigest(appId, caseId);
    const common = {
      v: 1,
      app_id: appId,
      case_digest: digest,
      purge_generation: 1,
      nonce: nonce.nonce,
      table: TABLE,
    };
    const key = { appId, caseId, purgeGeneration: 1 };
    // Pre-fix contract: a logical receipt that does not say how the DELETE was written...
    const committed = nonce.settle_until + MIN;
    const logical = await signer.sign({
      ...common,
      kind: "logical_delete",
      issued_at: committed + MIN,
      predicate: "digest_v1",
      snapshot_id: "9000000000000000001",
      committed_at: committed,
      rows_deleted: 3,
      rows_remaining: 0,
    });
    const first = await submitReceipt(d, OP, { ...key, receipt: logical });
    const checksum = (
      await rows(
        "SELECT logical_receipt_checksum AS c FROM lifecycle_erasure_jobs WHERE app_id = ?",
        appId,
      )
    )[0]?.c as string | null;
    advance(3 * 60 * MIN);
    // ...and a physical receipt that only reports zero visible rows and removed orphans, with
    // every pre-fix field truthful and in order. A merge-on-read DELETE could produce exactly this
    // while the original data file, still referenced, keeps the deleted bytes.
    const physical = await signer.sign({
      ...common,
      kind: "physical_cleanup",
      issued_at: committed + 120 * MIN,
      logical_receipt_checksum: checksum ?? "0".repeat(64),
      snapshot_id: "9000000000000000001",
      expired_before: committed + MIN,
      oldest_retained_committed_at: committed + MIN,
      retained_snapshots_with_rows: 0,
      orphan_files_removed: true,
    });
    const second = await submitReceipt(d, OP, { ...key, receipt: physical });
    // Neither receipt of the old shape is accepted: the logical one does not say how the DELETE
    // was written, and the physical one cannot show the bytes are gone.
    expect(first.accepted).toBe(false);
    expect(second.accepted).toBe(false);
    const job = await getJob(env.DB, OP, appId, caseId);
    expect(job?.stage).not.toBe("complete");
    expect(job?.proof).not.toBe("physical_verified");
  });
});

describe("P2-4: an out-of-band physical receipt cannot skip the cleanup delay", () => {
  it("is refused while the cleanup deadline has not passed", async () => {
    const { appId, caseId } = await seedApp(events, "app_rev_early");
    const { now, advance } = clockAt(T0);
    const d = erasureDeps(signer, now, undefined, ON);
    await requestErasure(d, OP, { appId, caseId, reason: "subject_request" });
    advance(20 * MIN);
    const job0 = (
      await rows("SELECT nonce, settle_until FROM lifecycle_erasure_jobs WHERE app_id = ?", appId)
    )[0] as { nonce: string; settle_until: number };
    const common = {
      v: 1,
      app_id: appId,
      case_digest: await caseDigest(appId, caseId),
      purge_generation: 1,
      nonce: job0.nonce,
      table: TABLE,
    };
    const key = { appId, caseId, purgeGeneration: 1 };
    const committed = job0.settle_until;
    const logical = await signer.sign({
      ...common,
      kind: "logical_delete",
      issued_at: T0 + 20 * MIN,
      predicate: "digest_v1",
      snapshot_id: "9000000000000000002",
      committed_at: committed,
      rows_deleted: 1,
      rows_remaining: 0,
    });
    await submitReceipt(d, OP, { ...key, receipt: logical });
    // No time passes: cleanup is scheduled an hour out, yet a matching physical receipt arrives.
    const checksum = (
      await rows(
        "SELECT logical_receipt_checksum AS c FROM lifecycle_erasure_jobs WHERE app_id = ?",
        appId,
      )
    )[0]?.c as string | null;
    const physical = await signer.sign({
      ...common,
      kind: "physical_cleanup",
      issued_at: T0 + 20 * MIN,
      logical_receipt_checksum: checksum ?? "0".repeat(64),
      snapshot_id: "9000000000000000002",
      expired_before: committed,
      oldest_retained_committed_at: committed,
      retained_snapshots_with_rows: 0,
      orphan_files_removed: true,
    });
    const res = await submitReceipt(d, OP, { ...key, receipt: physical });
    expect(res.accepted).toBe(false);
    expect((await getJob(env.DB, OP, appId, caseId))?.stage).not.toBe("complete");
  });
});

describe("P2-5: a blocked oldest case does not starve later eligible ones", () => {
  it("scans past blocked cases when the batch is 1", async () => {
    const { appId } = await seedApp(events, "app_rev_starve");
    await markForwarded(appId);
    const oldest = (
      await rows(
        "SELECT case_id FROM lifecycle_event_log WHERE app_id = ? ORDER BY seq LIMIT 1",
        appId,
      )
    )[0]?.case_id as string;
    await env.DB.prepare(
      "UPDATE lifecycle_event_log SET forwarded_at = NULL WHERE app_id = ? AND case_id = ?",
    )
      .bind(appId, oldest)
      .run();
    await forceCheckpoint(appId);
    const deps = retDeps({ ...RET, LIFECYCLE_RETENTION_BATCH: "1" });
    const run = await applyRetention(deps, appId);
    expect(run.retired_cases).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id = ? AND case_id = ?",
        appId,
        oldest,
      ),
    ).toBeGreaterThan(0);
    // Repeated runs keep making progress, one case at a time.
    expect((await applyRetention(deps, appId)).retired_cases).toBe(1);
  });
});

describe("P2-6: a rebuild after retention keeps the historical snapshots", () => {
  it("carries retired cases (case rows, intervals, relations) into the rebuilt generation", async () => {
    const { appId } = await seedApp(events, "app_rev_rebuild");
    await markForwarded(appId);
    await forceCheckpoint(appId);
    const run = await applyRetention(retDeps(), appId);
    expect(run.retired_cases).toBeGreaterThan(0);
    const retired = (
      await rows("SELECT case_id FROM lifecycle_retired_cases WHERE app_id = ?", appId)
    ).map((r) => r.case_id as string);
    const served = await Promise.all(retired.map((c) => servingId(c)));
    const intervalsBefore = await count(
      "SELECT count(*) AS n FROM lifecycle_stage_intervals WHERE app_id = ? AND case_id IN (SELECT value FROM json_each(?))",
      appId,
      JSON.stringify(served),
    );
    expect(intervalsBefore).toBeGreaterThan(0);
    await new LifecycleProjector(env.DB).rebuild(appId);
    const visible = (await servedModel(appId)).cases.map((c) => (c as { case_id: string }).case_id);
    for (const id of served) expect(visible).toContain(id);
    expect(
      await count(
        "SELECT count(*) AS n FROM lifecycle_stage_intervals WHERE app_id = ? AND case_id IN (SELECT value FROM json_each(?))",
        appId,
        JSON.stringify(served),
      ),
    ).toBe(intervalsBefore);
  });
});

describe("P2-7: an in-flight projector cannot recreate residue after an erasure", () => {
  const residue = (appId: string, caseId: string, served: string) =>
    Promise.all([
      count(
        "SELECT count(*) AS n FROM lifecycle_projection_diagnostics WHERE app_id = ? AND case_id = ?",
        appId,
        caseId,
      ),
      count(
        "SELECT count(*) AS n FROM lifecycle_projection_queue WHERE app_id = ? AND case_id = ?",
        appId,
        caseId,
      ),
      count(
        "SELECT count(*) AS n FROM lifecycle_case_snapshots WHERE app_id = ? AND case_id = ?",
        appId,
        served,
      ),
      count(
        "SELECT count(*) AS n FROM lifecycle_stage_intervals WHERE app_id = ? AND case_id = ?",
        appId,
        served,
      ),
      count(
        "SELECT count(*) AS n FROM lifecycle_case_edges WHERE app_id = ? AND from_case_id = ?",
        appId,
        served,
      ),
    ]);

  it("does not write diagnostics or requeue a tombstoned case", async () => {
    const { appId, caseId } = await seedApp(events, "app_rev_proj");
    const served = await servingId(caseId);
    const { now } = clockAt(T0);
    await requestErasure(erasureDeps(signer, now, undefined, ON), OP, {
      appId,
      caseId,
      reason: "subject_request",
    });
    const projector = new LifecycleProjector(env.DB) as unknown as {
      finish(
        a: string,
        c: string,
        s: number,
        d: Map<string, number>,
        ack: boolean,
        gen: number,
      ): Promise<void>;
      requeue(a: string, c: string, n: number, code: string): Promise<void>;
    };
    await projector.finish(appId, caseId, 1, new Map([["late_diagnostic", 1]]), true, 1);
    await projector.requeue(appId, caseId, 1, "projection_error");
    expect(await residue(appId, caseId, served)).toEqual([0, 0, 0, 0, 0]);
  });

  it("an erasure landing between a projection's read and its writes leaves nothing behind", async () => {
    const { appId, caseId } = await seedApp(events, "app_rev_race");
    const served = await servingId(caseId);
    const { now } = clockAt(T0);
    const d = erasureDeps(signer, now, undefined, ON);
    let landed = false;
    const sqls = new WeakMap<object, string>();
    const racing = new Proxy(env.DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop === "prepare") {
          return (sql: string) => {
            const stmt = target.prepare(sql);
            return new Proxy(stmt, {
              get(t, p) {
                const x = Reflect.get(t, p, t);
                if (p !== "bind") return typeof x === "function" ? x.bind(t) : x;
                return (...a: unknown[]) => {
                  const bound = (x as (...b: unknown[]) => D1PreparedStatement).apply(t, a);
                  sqls.set(bound, sql);
                  return bound;
                };
              },
            });
          };
        }
        if (prop === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            const hit = statements.some((s) =>
              /lifecycle_projection_diagnostics|lifecycle_case_snapshots/.test(sqls.get(s) ?? ""),
            );
            if (!landed && hit) {
              landed = true;
              await requestErasure(d, OP, { appId, caseId, reason: "subject_request" });
            }
            return target.batch(statements);
          };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const projector = new LifecycleProjector(racing, { now: () => FAR });
    await projector.projectCase(appId, caseId, 1).catch(() => undefined);
    expect(landed).toBe(true);
    expect(await residue(appId, caseId, served)).toEqual([0, 0, 0, 0, 0]);
    // The completion gate would also notice and re-hide: simulate a write that slipped through.
    await env.DB.prepare(
      "INSERT INTO lifecycle_projection_diagnostics (app_id, case_id, code, count, updated_at) VALUES (?, ?, 'late', 1, 0)",
    )
      .bind(appId, caseId)
      .run();
    expect((await residue(appId, caseId, served))[0]).toBe(1);
  });
});
