import { env } from "cloudflare:workers";
import type { LifecycleEventInput } from "@flightdeckhq/schema";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { retentionConfig } from "../src/lifecycle-erasure/config";
import { type ErasureActor, ErasureForbidden } from "../src/lifecycle-erasure/jobs";
import { rejectAll } from "../src/lifecycle-erasure/receipt";
import {
  applyRetention,
  inspectRetention,
  recordReconciliation,
} from "../src/lifecycle-erasure/retention";
import { maintainErasure } from "../src/lifecycle-erasure/schedule";
import { LifecycleProjector } from "../src/lifecycle-projection/projector";
import { servingId } from "../src/lifecycle-projection/snapshot";
import { forwardOutbox } from "../src/lifecycle-projection/store";
import { LifecycleSnapshotRepository } from "../src/lifecycle-serving/repository";
import { sinks } from "../src/sinks";
import { makeSigner, type Signer } from "./support/erasure";
import { adaptFixtures, type DeliveryRecord } from "./support/fixture-adapter";
import { deliver, producerApp, project, servedModel } from "./support/harness";

const DAY = 86_400_000;
/** "Today" is long after every fixture case closed and every row was received. */
const NOW = Date.now() + 900 * DAY;
const ON = {
  LIFECYCLE_RETENTION_MODE: "enforce",
  LIFECYCLE_RETENTION_POLICY_VERSION: "retention-1",
  LIFECYCLE_RETENTION_CLOSED_DAYS: "400",
  LIFECYCLE_RETENTION_LOG_DAYS: "400",
};
const OP: ErasureActor = { kind: "operator", id: "op_ada", apps: "*" };
let events: LifecycleEventInput[];
let signer: Signer;
let n = 0;

beforeAll(async () => {
  const records = (
    Object.values(
      import.meta.glob("../../../examples/lifecycle-fixtures/fixtures/scenarios/*.json", {
        eager: true,
        import: "default",
      }),
    ) as { name: string; records: DeliveryRecord[] }[]
  ).find((s) => s.name === "recruiting-pipeline")?.records;
  events = [...(await adaptFixtures(records ?? [])).byApp.values()][0] ?? [];
  signer = await makeSigner();
});
afterEach(() => vi.restoreAllMocks());

const rows = (sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>()
    .then((r) => r.results);
const count = async (sql: string, ...binds: unknown[]) => Number((await rows(sql, ...binds))[0]?.n);

function deps(vars: Record<string, string> = ON, now = () => NOW) {
  return { db: env.DB, config: retentionConfig(vars), now };
}

/** A projected app whose rows are all forwarded. */
async function seed(forward = true) {
  const appId = `app_ret_${++n}`;
  const key = await producerApp(appId);
  await deliver(key, events);
  await project(appId);
  if (forward) {
    vi.spyOn(sinks, "lifecycle").mockResolvedValue();
    while ((await forwardOutbox(env, Date.now())).sent > 0);
    vi.restoreAllMocks();
  }
  return { appId, key };
}

const maxSeq = (appId: string) =>
  count("SELECT max(seq) AS n FROM lifecycle_event_log WHERE app_id = ?", appId);
const logRows = (appId: string) =>
  count("SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id = ?", appId);

async function attest(appId: string, through?: number, over: Record<string, unknown> = {}) {
  const t = through ?? (await maxSeq(appId));
  const events_ = await count(
    "SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id = ? AND seq <= ?",
    appId,
    t,
  );
  return signer.sign({
    v: 1,
    kind: "basin_reconciliation",
    app_id: appId,
    through_seq: t,
    event_count: events_,
    issued_at: NOW,
    ...over,
  });
}
const reconcile = async (appId: string, through?: number) =>
  recordReconciliation(
    { ...deps(), verifier: signer.verifier },
    OP,
    appId,
    await attest(appId, through),
  );

describe("default off", () => {
  it("retires nothing and reads no tables unless an operator enables it", async () => {
    const { appId } = await seed();
    await reconcile(appId);
    const before = await logRows(appId);
    for (const vars of [
      {} as Record<string, string>,
      { LIFECYCLE_RETENTION_MODE: "enforce" },
      { ...ON, LIFECYCLE_RETENTION_MODE: "yes" },
    ]) {
      expect(await applyRetention(deps(vars), appId)).toEqual({
        retired_cases: 0,
        retired_events: 0,
        skipped: 0,
      });
    }
    expect(await logRows(appId)).toBe(before);
    expect(retentionConfig({}).mode).toBe("off");
    expect(retentionConfig({ LIFECYCLE_RETENTION_MODE: "enforce" }).problems).toEqual(
      expect.arrayContaining([
        "invalid_lifecycle_retention_policy_version",
        "missing_lifecycle_retention_closed_days",
      ]),
    );
  });

  it("rejects policies that would retire cases inside the served window or before their snapshot", () => {
    expect(
      retentionConfig({
        ...ON,
        LIFECYCLE_RETENTION_CLOSED_DAYS: "90",
        LIFECYCLE_RETENTION_LOG_DAYS: "90",
      }),
    ).toMatchObject({ mode: "off", problems: ["closed_retention_inside_served_window"] });
    expect(retentionConfig({ ...ON, LIFECYCLE_RETENTION_LOG_DAYS: "399" }).problems).toContain(
      "log_retention_shorter_than_closed",
    );
    expect(retentionConfig({ ...ON, LIFECYCLE_RETENTION_BATCH: "0" }).mode).toBe("off");
  });

  it("scheduled maintenance leaves the log alone while off", async () => {
    const { appId } = await seed();
    await reconcile(appId);
    const before = await logRows(appId);
    await maintainErasure({ ...env, LIFECYCLE_RETENTION_MODE: "off" } as unknown as Env, () => NOW);
    expect(await logRows(appId)).toBe(before);
  });
});

describe("dry run, impact and health", () => {
  it("reports eligibility and blockers without changing anything, in dry_run", async () => {
    const { appId } = await seed();
    const dry = deps({ ...ON, LIFECYCLE_RETENTION_MODE: "dry_run" });
    const before = await rows("SELECT * FROM lifecycle_event_log WHERE app_id = ?", appId);
    // No checkpoint yet: everything closed is blocked on reconciliation.
    let report = await inspectRetention(dry, appId);
    expect(report).toMatchObject({
      mode: "dry_run",
      checkpoint: null,
      eligible: { cases: 0 },
      retired_cases: 0,
    });
    expect(report.blocked.beyond_checkpoint).toBeGreaterThan(0);
    await reconcile(appId);
    report = await inspectRetention(dry, appId);
    expect(report.eligible.cases).toBeGreaterThan(0);
    expect(report.eligible.events).toBeGreaterThan(0);
    expect(report.eligible.bytes).toBeGreaterThan(0);
    expect(report.checkpoint?.reconciled_through_seq).toBe(await maxSeq(appId));
    expect(await applyRetention(dry, appId)).toMatchObject({ retired_cases: 0 });
    expect(await rows("SELECT * FROM lifecycle_event_log WHERE app_id = ?", appId)).toEqual(before);
    expect(JSON.stringify(report)).not.toMatch(/case_|recruiting/);
  });
});

describe("what retention may touch", () => {
  it("never retires rows before a verified Basin reconciliation covers them", async () => {
    const { appId } = await seed();
    expect(await applyRetention(deps(), appId)).toMatchObject({ retired_cases: 0 });
    // A checkpoint that stops short covers only cases whose every row is at or below it.
    const first = (
      await rows(
        `SELECT l.case_id, max(l.seq) AS top FROM lifecycle_event_log l
       JOIN lifecycle_case_snapshots s ON s.app_id = l.app_id AND s.case_id = l.case_id AND s.status = 'closed'
       WHERE l.app_id = ? GROUP BY l.case_id ORDER BY top LIMIT 1`,
        appId,
      )
    )[0] as { case_id: string; top: number };
    expect((await reconcile(appId, first.top)).recorded).toBe(true);
    const run = await applyRetention(deps(), appId);
    const report = await inspectRetention(deps(), appId);
    expect(run.retired_cases).toBeGreaterThan(0);
    expect(report.blocked.beyond_checkpoint).toBeGreaterThan(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id = ? AND case_id = ?",
        appId,
        first.case_id,
      ),
    ).toBe(0);
    // Nothing above the checkpoint was touched.
    expect(
      await count(
        "SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id = ? AND seq > ?",
        appId,
        first.top,
      ),
    ).toBeGreaterThan(0);
    const retired = await rows(
      "SELECT case_id FROM lifecycle_retired_cases WHERE app_id = ?",
      appId,
    );
    for (const { case_id } of retired) {
      expect(
        await count(
          "SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id = ? AND case_id = ? AND seq > ?",
          appId,
          case_id,
          first.top,
        ),
      ).toBe(0);
    }
  });

  it("keeps unforwarded rows: the log may be the only copy", async () => {
    const { appId } = await seed(false);
    await env.DB.prepare("UPDATE lifecycle_event_log SET forwarded_at = 1 WHERE app_id = ?")
      .bind(appId)
      .run();
    await reconcile(appId);
    const victim = (
      await rows("SELECT case_id FROM lifecycle_event_log WHERE app_id = ? LIMIT 1", appId)
    )[0]?.case_id;
    await env.DB.prepare(
      "UPDATE lifecycle_event_log SET forwarded_at = NULL WHERE app_id = ? AND case_id = ?",
    )
      .bind(appId, victim)
      .run();
    const report = await inspectRetention(deps(), appId);
    expect(report.blocked.not_forwarded).toBe(1);
    await applyRetention(deps(), appId);
    expect(
      await count(
        "SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id = ? AND case_id = ?",
        appId,
        victim,
      ),
    ).toBeGreaterThan(0);
  });

  it("keeps cases that are open, queued, recent, or not reflected by the committed read model", async () => {
    const { appId } = await seed();
    await reconcile(appId);
    const open = await count(
      "SELECT count(*) AS n FROM lifecycle_case_snapshots WHERE app_id = ? AND status = 'open'",
      appId,
    );
    const report = await inspectRetention(deps(), appId);
    expect(report.blocked.not_closed).toBe(open);
    // Too recent: the same data under a "now" before the log window.
    const early = await inspectRetention(
      deps(ON, () => Date.now() + 10 * DAY),
      appId,
    );
    expect(early.eligible.cases).toBe(0);
    // Queued work blocks.
    const target = (
      await rows(
        "SELECT case_id FROM lifecycle_event_log l WHERE app_id = ? AND EXISTS (SELECT 1 FROM lifecycle_case_snapshots s WHERE s.app_id = l.app_id AND s.case_id = l.case_id AND s.status = 'closed') LIMIT 1",
        appId,
      )
    )[0]?.case_id as string;
    await env.DB.prepare(
      "INSERT INTO lifecycle_projection_queue (app_id, case_id, enqueued_seq, next_attempt_at) VALUES (?, ?, 1, 0)",
    )
      .bind(appId, target)
      .run();
    expect((await inspectRetention(deps(), appId)).blocked.queued).toBe(1);
    await applyRetention(deps(), appId);
    expect(
      await count(
        "SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id = ? AND case_id = ?",
        appId,
        target,
      ),
    ).toBeGreaterThan(0);
    // A snapshot from an old generation (rebuild in progress / failed) does not count.
    await env.DB.prepare("DELETE FROM lifecycle_projection_queue WHERE app_id = ?")
      .bind(appId)
      .run();
    await env.DB.prepare(
      "UPDATE lifecycle_projection_state SET status = 'rebuilding' WHERE app_id = ?",
    )
      .bind(appId)
      .run();
    expect((await inspectRetention(deps(), appId)).eligible.cases).toBe(0);
  });

  it("retires whole cases physically, leaves served rows untouched, and keeps other apps", async () => {
    const { appId } = await seed();
    const other = await seed();
    await reconcile(appId);
    await reconcile(other.appId);
    const servedBefore = await servedModel(appId);
    const otherBefore = await logRows(other.appId);
    const run = await applyRetention(deps(), appId);
    expect(run.retired_cases).toBeGreaterThan(0);
    // Whole-case: no case is left with a partial history.
    for (const { case_id } of await rows(
      "SELECT case_id FROM lifecycle_retired_cases WHERE app_id = ?",
      appId,
    )) {
      expect(
        await count(
          "SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id = ? AND case_id = ?",
          appId,
          case_id,
        ),
      ).toBe(0);
      expect(
        await count(
          "SELECT count(*) AS n FROM lifecycle_case_tombstones WHERE app_id = ? AND case_id = ? AND reason = 'retention_expired'",
          appId,
          case_id,
        ),
      ).toBe(1);
    }
    // Reversible vs physical: the served snapshots were neither soft- nor hard-deleted; the replay
    // log rows are gone for good (their copy is in Basin).
    expect(await servedModel(appId)).toEqual(servedBefore);
    expect(
      await count(
        "SELECT count(*) AS n FROM lifecycle_case_snapshots WHERE app_id = ? AND deleted_at IS NOT NULL",
        appId,
      ),
    ).toBe(0);
    expect(await logRows(other.appId)).toBe(otherBefore);
    // Idempotent.
    expect(await applyRetention(deps(), appId)).toMatchObject({ retired_cases: 0 });
    expect((await inspectRetention(deps(), appId)).retired_cases).toBe(run.retired_cases);
  });

  it("retention soft-deletion in the serving repository stays a different, reversible thing", async () => {
    const { appId } = await seed();
    const repo = new LifecycleSnapshotRepository(env.DB, () => NOW);
    expect(await repo.applyRetention(appId, NOW)).toBeGreaterThan(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM lifecycle_case_snapshots WHERE app_id = ? AND deleted_at IS NOT NULL AND deleted_reason = 'retention'",
        appId,
      ),
    ).toBeGreaterThan(0);
    // Our log retention refuses cases whose snapshot was soft-deleted (the read model no longer reflects them).
    await reconcile(appId);
    expect((await inspectRetention(deps(), appId)).eligible.cases).toBe(0);
  });
});

describe("no orphan resurrection", () => {
  it("suppresses late events, retries and backfills for a retired case, and rebuilds do not revive it", async () => {
    const { appId, key } = await seed();
    await reconcile(appId);
    await applyRetention(deps(), appId);
    const retired = (
      await rows("SELECT case_id FROM lifecycle_retired_cases WHERE app_id = ?", appId)
    ).map((r) => r.case_id as string);
    expect(retired.length).toBeGreaterThan(0);
    const late = events.filter((e) => retired.includes(e.caseId));
    const afterRetire = await logRows(appId);
    await deliver(key, late); // producer retry / backfill
    expect(await logRows(appId)).toBe(afterRetire);
    expect(
      await count(
        "SELECT sum(count) AS n FROM lifecycle_projection_diagnostics WHERE app_id = ? AND case_id = '' AND code = 'retention_expired_case_event'",
        appId,
      ),
    ).toBeGreaterThan(0);
    expect(
      await count("SELECT count(*) AS n FROM lifecycle_projection_queue WHERE app_id = ?", appId),
    ).toBe(0);
    // Forward retries do not resend what is gone.
    const sent: string[] = [];
    vi.spyOn(sinks, "lifecycle").mockImplementation(
      async (_e, batch) => void sent.push(...batch.map((r) => r.case_id)),
    );
    await forwardOutbox(env, Date.now() + DAY);
    expect(sent.filter((c) => retired.includes(c))).toEqual([]);
    vi.restoreAllMocks();
    // A rebuild from the log never creates a partial case from stragglers.
    await new LifecycleProjector(env.DB).rebuild(appId);
    const served = (await servedModel(appId)).cases.map((c) => (c as { case_id: string }).case_id);
    for (const id of retired) expect(served).not.toContain(await servingId(id));
  });

  it("an erasure of a retired case still works and relabels the tombstone", async () => {
    const { appId } = await seed();
    await reconcile(appId);
    await applyRetention(deps(), appId);
    const victim = (
      await rows("SELECT case_id FROM lifecycle_retired_cases WHERE app_id = ? LIMIT 1", appId)
    )[0]?.case_id as string;
    const { requestErasure } = await import("../src/lifecycle-erasure/jobs");
    const { erasureConfig } = await import("../src/lifecycle-erasure/config");
    const { failClosedExecutor } = await import("../src/lifecycle-erasure/executor");
    const res = await requestErasure(
      {
        db: env.DB,
        config: erasureConfig({
          LIFECYCLE_ERASURE_MODE: "enforce",
          LIFECYCLE_BASIN_TABLE: "r2dc.flightdeck.lifecycle_events",
          LIFECYCLE_ERASURE_POLICY_VERSION: "erasure-1",
        }),
        executor: failClosedExecutor,
        verifier: rejectAll,
        now: () => NOW,
      },
      OP,
      { appId, caseId: victim, reason: "subject_request" },
    );
    expect(res.status).toBe("created");
    expect(
      (
        await rows(
          "SELECT reason FROM lifecycle_case_tombstones WHERE app_id = ? AND case_id = ?",
          appId,
          victim,
        )
      )[0]?.reason,
    ).toBe("subject_request");
    expect(
      await count(
        "SELECT count(*) AS n FROM lifecycle_case_snapshots WHERE app_id = ? AND case_id = ?",
        appId,
        await servingId(victim),
      ),
    ).toBe(0);
  });

  it("re-checks eligibility inside the deleting transaction: ingest racing the run wins", async () => {
    const { appId } = await seed();
    await reconcile(appId);
    const eligible = (await inspectRetention(deps(), appId)).eligible.cases;
    expect(eligible).toBeGreaterThan(1);
    // The first retirement statement of the run triggers a "producer" write to the second case.
    const targets = (
      await rows(
        "SELECT case_id FROM lifecycle_event_log l WHERE app_id = ? AND EXISTS (SELECT 1 FROM lifecycle_case_snapshots s WHERE s.app_id = l.app_id AND s.case_id = l.case_id AND s.status = 'closed') GROUP BY case_id ORDER BY min(seq)",
        appId,
      )
    ).map((r) => r.case_id as string);
    const racer = targets[1] as string;
    const db = env.DB;
    let injected = false;
    const racing = new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop !== "batch") return typeof v === "function" ? v.bind(target) : v;
        return async (statements: D1PreparedStatement[]) => {
          if (!injected && statements.length === 4) {
            injected = true;
            await env.DB.prepare(
              "INSERT INTO lifecycle_event_log (app_id, event_id, fingerprint, case_id, received_at, record_json, forward_next_at) VALUES (?, ?, ?, ?, ?, '{}', 0)",
            )
              .bind(appId, "evt_race_000001", "f".repeat(64), racer, NOW)
              .run();
          }
          return db.batch(statements);
        };
      },
    });
    const run = await applyRetention({ ...deps(), db: racing }, appId);
    expect(injected).toBe(true);
    expect(
      await count(
        "SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id = ? AND case_id = ?",
        appId,
        racer,
      ),
    ).toBeGreaterThan(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM lifecycle_case_tombstones WHERE app_id = ? AND case_id = ?",
        appId,
        racer,
      ),
    ).toBe(0);
    expect(run.skipped).toBeGreaterThan(0);
  });
});

describe("reconciliation checkpoints cannot be forged", () => {
  it("accepts only operators, valid signatures, matching counts, and never moves backwards", async () => {
    const { appId } = await seed();
    const d = { ...deps(), verifier: signer.verifier };
    const good = await attest(appId);
    await expect(recordReconciliation(d, { kind: "system" }, appId, good)).rejects.toBeInstanceOf(
      ErasureForbidden,
    );
    await expect(
      recordReconciliation(d, { kind: "operator", id: "op_x", apps: ["app_other"] }, appId, good),
    ).rejects.toBeInstanceOf(ErasureForbidden);
    expect(await recordReconciliation({ ...d, verifier: rejectAll }, OP, appId, good)).toEqual({
      recorded: false,
      code: "receipt_signature_invalid",
    });
    const forger = await makeSigner(signer.keyId);
    expect(
      await recordReconciliation(
        d,
        OP,
        appId,
        await forger.sign((good as { payload: Record<string, unknown> }).payload),
      ),
    ).toEqual({ recorded: false, code: "receipt_signature_invalid" });
    expect(
      await recordReconciliation(d, OP, appId, await attest(appId, undefined, { event_count: 1 })),
    ).toEqual({ recorded: false, code: "receipt_reconciliation_mismatch" });
    expect(
      await recordReconciliation(
        d,
        OP,
        appId,
        await attest(appId, undefined, { app_id: "app_other" }),
      ),
    ).toEqual({ recorded: false, code: "receipt_wrong_job" });
    expect(
      await recordReconciliation(
        d,
        OP,
        appId,
        await attest(appId, undefined, { issued_at: NOW * 2 }),
      ),
    ).toEqual({ recorded: false, code: "receipt_from_future" });
    expect(
      await count(
        "SELECT count(*) AS n FROM lifecycle_retention_checkpoints WHERE app_id = ?",
        appId,
      ),
    ).toBe(0);
    expect(await recordReconciliation(d, OP, appId, good)).toMatchObject({ recorded: true });
    const lower = Math.floor((await maxSeq(appId)) / 2);
    await recordReconciliation(d, OP, appId, await attest(appId, lower));
    expect(
      (
        await rows(
          "SELECT reconciled_through_seq AS n FROM lifecycle_retention_checkpoints WHERE app_id = ?",
          appId,
        )
      )[0]?.n,
    ).toBe(await maxSeq(appId));
  });

  it("refuses to attest rows that Basin has not been sent", async () => {
    const { appId } = await seed(false);
    expect(
      await recordReconciliation(
        { ...deps(), verifier: signer.verifier },
        OP,
        appId,
        await attest(appId),
      ),
    ).toEqual({
      recorded: false,
      code: "receipt_reconciliation_mismatch",
    });
  });
});
