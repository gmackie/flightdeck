import { env } from "cloudflare:workers";
import type { LifecycleEventInput } from "@flightdeckhq/schema";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { erasureConfig } from "../src/lifecycle-erasure/config";
import {
  ExecutorError,
  ExecutorPending,
  failClosedExecutor,
} from "../src/lifecycle-erasure/executor";
import {
  drainJob,
  type ErasureActor,
  type ErasureDeps,
  ErasureDisabled,
  ErasureForbidden,
  erasureHealth,
  getJob,
  reopenJob,
  requestErasure,
  submitReceipt,
} from "../src/lifecycle-erasure/jobs";
import { rejectAll } from "../src/lifecycle-erasure/receipt";
import { maintainErasure } from "../src/lifecycle-erasure/schedule";
import { caseDigest, cleanupStatements, deleteStatement } from "../src/lifecycle-erasure/spark";
import { servingId } from "../src/lifecycle-projection/snapshot";
import { appendLifecycle, forwardOutbox } from "../src/lifecycle-projection/store";
import { LifecycleSnapshotRepository } from "../src/lifecycle-serving/repository";
import { sinks } from "../src/sinks";
import { makeSigner, type Signer, syntheticRunner } from "./support/erasure";
import { adaptFixtures, type DeliveryRecord } from "./support/fixture-adapter";
import { deliver, producerApp, project, servedModel } from "./support/harness";

const T0 = 1_900_000_000_000;
const MIN = 60_000;
const TABLE = "r2dc.flightdeck.lifecycle_events";
const ON = {
  LIFECYCLE_ERASURE_MODE: "enforce",
  LIFECYCLE_BASIN_TABLE: TABLE,
  LIFECYCLE_ERASURE_POLICY_VERSION: "erasure-1",
};
const OP: ErasureActor = { kind: "operator", id: "op_ada", apps: "*" };

let events: LifecycleEventInput[];
let signer: Signer;
let clock = T0;
const now = () => clock;

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

function deps(over: Partial<ErasureDeps> = {}, vars: Record<string, string> = ON): ErasureDeps {
  return {
    db: env.DB,
    config: erasureConfig(vars),
    executor: failClosedExecutor,
    verifier: signer.verifier,
    now,
    ...over,
  };
}

/** A projected app with all fixture cases; returns one case id that has served rows. */
async function seed(appId: string) {
  await deliver(await producerApp(appId), events);
  await project(appId);
  const model = await servedModel(appId);
  const caseId = (model.cases[0] as { case_id: string }).case_id;
  return { caseId, cases: model.cases.length };
}

const rows = (sql: string, ...binds: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...binds)
    .all<Record<string, unknown>>()
    .then((r) => r.results);

/** Moves the clock past the settle window and drains. */
async function pass(d: ErasureDeps, appId: string, caseId: string, gen = 1, minutes = 30) {
  clock += minutes * MIN;
  return drainJob(d, { appId, caseId, purgeGeneration: gen });
}

describe("default off", () => {
  it("refuses requests and writes nothing when the mode is off or invalid", async () => {
    for (const vars of [
      {} as Record<string, string>,
      { LIFECYCLE_ERASURE_MODE: "ENFORCE" },
      { ...ON, LIFECYCLE_BASIN_TABLE: "bad table;" },
    ]) {
      await expect(
        requestErasure(deps({}, vars), OP, {
          appId: "app_off",
          caseId: "c1",
          reason: "subject_request",
        }),
      ).rejects.toBeInstanceOf(ErasureDisabled);
    }
    expect(await rows("SELECT * FROM lifecycle_erasure_jobs WHERE app_id = 'app_off'")).toEqual([]);
    expect(await rows("SELECT * FROM lifecycle_case_tombstones WHERE app_id = 'app_off'")).toEqual(
      [],
    );
    expect(erasureConfig({ ...ON, LIFECYCLE_BASIN_TABLE: "x" }).problems).toContain(
      "invalid_lifecycle_basin_table",
    );
  });

  it("ships with erasure and retention off in the deployed config", () => {
    const e = env as unknown as Record<string, string>;
    expect(e.LIFECYCLE_ERASURE_MODE).toBe("off");
    expect(e.LIFECYCLE_RETENTION_MODE).toBe("off");
  });

  it("scheduled maintenance is a no-op while off", async () => {
    const spy = vi.spyOn(env.DB, "prepare");
    await maintainErasure(env, now);
    expect(spy).not.toHaveBeenCalled();
  });

  it("dry_run plans without writing, and never includes the case id in the statements", async () => {
    const res = await requestErasure(deps({}, { ...ON, LIFECYCLE_ERASURE_MODE: "dry_run" }), OP, {
      appId: "app_dry",
      caseId: "case_dry_1",
      reason: "subject_request",
    });
    expect(res.status).toBe("dry_run");
    if (res.status !== "dry_run") return;
    expect(res.plan.external.delete).not.toContain("case_dry_1");
    expect(res.plan.external.delete).toContain(
      "sha2(concat_ws('|', 'flightdeck.erasure.v1', app_id, case_id), 256)",
    );
    expect(await rows("SELECT * FROM lifecycle_erasure_jobs WHERE app_id = 'app_dry'")).toEqual([]);
    expect(await rows("SELECT * FROM lifecycle_case_tombstones WHERE app_id = 'app_dry'")).toEqual(
      [],
    );
  });
});

describe("authorization boundary", () => {
  it("only an operator scoped to the app may request, receive receipts or reopen", async () => {
    const d = deps();
    const input = { appId: "app_authz", caseId: "case_a", reason: "subject_request" };
    const bad: ErasureActor[] = [
      { kind: "system" },
      { kind: "operator", id: "op_x", apps: ["app_other"] },
      { kind: "operator", id: "Op X!", apps: "*" },
      undefined as unknown as ErasureActor,
    ];
    for (const actor of bad) {
      await expect(requestErasure(d, actor, input)).rejects.toBeInstanceOf(ErasureForbidden);
      await expect(getJob(env.DB, actor, input.appId, input.caseId)).rejects.toBeInstanceOf(
        ErasureForbidden,
      );
      await expect(
        submitReceipt(d, actor, {
          appId: input.appId,
          caseId: input.caseId,
          purgeGeneration: 1,
          receipt: {},
        }),
      ).rejects.toBeInstanceOf(ErasureForbidden);
      await expect(
        reopenJob(d, actor, { appId: input.appId, caseId: input.caseId, purgeGeneration: 1 }),
      ).rejects.toBeInstanceOf(ErasureForbidden);
    }
    expect(await rows("SELECT * FROM lifecycle_erasure_jobs WHERE app_id = 'app_authz'")).toEqual(
      [],
    );
    const scoped: ErasureActor = { kind: "operator", id: "op_scoped", apps: ["app_authz"] };
    expect((await requestErasure(d, scoped, input)).status).toBe("created");
  });

  it("rejects malformed ids and reason codes before touching D1", async () => {
    const d = deps();
    for (const bad of [
      { appId: "app x", caseId: "c", reason: "r" },
      { appId: "a", caseId: "has space@example.com", reason: "r" },
      { appId: "a", caseId: "c", reason: "Free text reason" },
    ]) {
      await expect(requestErasure(d, OP, bad)).rejects.toMatchObject({ name: "ErasureInvalid" });
    }
  });
});

describe("local hold and idempotence", () => {
  it("erasing a case that was never seen holds, and a later backfill is denied", async () => {
    const appId = "app_absent";
    const caseId = "case_not_yet_seen";
    const res = await requestErasure(deps(), OP, { appId, caseId, reason: "subject_request" });
    expect(res.status).toBe("created");
    if (res.status === "dry_run") return;
    expect(res.job.stage).toBe("basin_pending");
    const key = await producerApp(appId);
    const mine = events.map((e) => ({ ...e, caseId }));
    await deliver(key, mine.slice(0, 5));
    expect(await rows("SELECT * FROM lifecycle_event_log WHERE app_id = ?", appId)).toEqual([]);
    const diag = await rows(
      "SELECT code, count FROM lifecycle_projection_diagnostics WHERE app_id = ?",
      appId,
    );
    expect(diag).toContainEqual({ code: "erased_case_event", count: 5 });
  });

  it("hides the case atomically and is idempotent when repeated", async () => {
    const appId = "app_hide";
    const { caseId, cases } = await seed(appId);
    const d = deps();
    const first = await requestErasure(d, OP, { appId, caseId, reason: "subject_request" });
    const second = await requestErasure(d, OP, { appId, caseId, reason: "subject_request" });
    const third = await requestErasure(d, OP, { appId, caseId, reason: "other_reason" });
    expect([first.status, second.status, third.status]).toEqual([
      "created",
      "existing",
      "existing",
    ]);
    expect(await rows("SELECT * FROM lifecycle_erasure_jobs WHERE app_id = ?", appId)).toHaveLength(
      1,
    );
    expect(
      await rows(
        "SELECT * FROM lifecycle_event_log WHERE app_id = ? AND case_id = ?",
        appId,
        caseId,
      ),
    ).toEqual([]);
    const model = await servedModel(appId);
    expect(model.cases).toHaveLength(cases - 1);
    expect(model.cases.map((c) => (c as { case_id: string }).case_id)).not.toContain(
      await servingId(caseId),
    );
    // One audit row for the request, one per transition so far; none repeated by the retries.
    const audit = await rows(
      "SELECT stage, code FROM lifecycle_erasure_events WHERE app_id = ? ORDER BY id",
      appId,
    );
    expect(audit.map((a) => a.code)).toEqual(["requested", "local_hidden", "settle_scheduled"]);
  });

  it("denies late replay and event ingestion after the tombstone, including a retried batch", async () => {
    const appId = "app_late";
    const { caseId } = await seed(appId);
    const stored = (
      await rows(
        "SELECT record_json FROM lifecycle_event_log WHERE app_id = ? AND case_id = ?",
        appId,
        caseId,
      )
    ).map((r) => JSON.parse(r.record_json as string));
    expect(stored.length).toBeGreaterThan(0);
    await requestErasure(deps(), OP, { appId, caseId, reason: "subject_request" });
    // A late replay of the exact stored rows (a forward retry or backfill), then fresh ingestion.
    const result = await appendLifecycle(env.DB, appId, stored, clock);
    expect(result).toMatchObject({ stored: 0, suppressed: stored.length });
    const mine = events.filter((e) => e.caseId === caseId);
    await deliver(await producerApp(`${appId}_b`), mine); // other app: its own case is unaffected
    expect(
      (
        await rows("SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id = ?", `${appId}_b`)
      )[0]?.n,
    ).toBeGreaterThan(0);
    expect(
      await rows(
        "SELECT * FROM lifecycle_event_log WHERE app_id = ? AND case_id = ?",
        appId,
        caseId,
      ),
    ).toEqual([]);
    expect(
      await rows(
        "SELECT * FROM lifecycle_projection_queue WHERE app_id = ? AND case_id = ?",
        appId,
        caseId,
      ),
    ).toEqual([]);
    expect(
      await rows(
        "SELECT count FROM lifecycle_projection_diagnostics WHERE app_id = ? AND case_id = '' AND code = 'erased_case_event'",
        appId,
      ),
    ).toEqual([{ count: stored.length }]);
  });

  it("a pending Basin outbox row is removed locally and never forwarded afterwards", async () => {
    const appId = "app_outbox";
    const { caseId } = await seed(appId);
    const pending = await rows(
      "SELECT count(*) AS n FROM lifecycle_event_log WHERE app_id = ? AND case_id = ? AND forwarded_at IS NULL",
      appId,
      caseId,
    );
    expect(Number(pending[0]?.n)).toBeGreaterThan(0);
    const sent: string[] = [];
    vi.spyOn(sinks, "lifecycle").mockImplementation(async (_e, batch) => {
      sent.push(...batch.map((r) => r.case_id));
    });
    await requestErasure(deps(), OP, { appId, caseId, reason: "subject_request" });
    await forwardOutbox(env, clock);
    expect(sent).not.toContain(caseId);
    const job = (
      await rows(
        "SELECT local_rows_removed, forwarded_rows FROM lifecycle_erasure_jobs WHERE app_id = ?",
        appId,
      )
    )[0];
    expect(Number(job?.local_rows_removed)).toBeGreaterThan(0);
  });

  it("also tombstones the read model, and an authorized serving restore cannot revive the case", async () => {
    const appId = "app_serving_tomb";
    const { caseId } = await seed(appId);
    const served = await servingId(caseId);
    await requestErasure(deps(), OP, { appId, caseId, reason: "subject_request" });
    expect(
      await rows(
        "SELECT reason, restored_at FROM lifecycle_snapshot_tombstones WHERE app_id = ? AND case_id = ?",
        appId,
        served,
      ),
    ).toEqual([{ reason: "erased", restored_at: null }]);
    const repo = new LifecycleSnapshotRepository(env.DB, () => clock);
    expect(
      await repo.restoreCase(
        appId,
        served,
        { reason: "operator_error", approval_ref: "appr_1" },
        async () => true,
      ),
    ).toBe(true);
    // The evidence is gone and ingest still drops the case, so a restore has nothing to show.
    await deliver(await producerApp(`${appId}_x`), []);
    await appendLifecycle(env.DB, appId, [], clock);
    await project(appId);
    expect(
      (await servedModel(appId)).cases.map((c) => (c as { case_id: string }).case_id),
    ).not.toContain(served);
    expect(
      await rows(
        "SELECT * FROM lifecycle_event_log WHERE app_id = ? AND case_id = ?",
        appId,
        caseId,
      ),
    ).toEqual([]);
    // Requesting again re-arms the tombstone.
    await requestErasure(deps(), OP, { appId, caseId, reason: "subject_request", repurge: true });
  });

  it("legacy tombstones are upgraded to tracked jobs without erasing twice", async () => {
    const appId = "app_legacy";
    const { caseId } = await seed(appId);
    const { eraseCase } = await import("../src/lifecycle-projection/store");
    await eraseCase(env.DB, appId, caseId, await servingId(caseId), "source_deleted", clock);
    const res = await requestErasure(deps(), OP, { appId, caseId, reason: "subject_request" });
    expect(res.status).toBe("created");
  });
});

describe("fail-closed executor", () => {
  it("never completes: stays waiting, spends no attempts, and reports not verified", async () => {
    const appId = "app_closed";
    const { caseId } = await seed(appId);
    const d = deps();
    await requestErasure(d, OP, { appId, caseId, reason: "subject_request" });
    for (let i = 0; i < 40; i++) await pass(d, appId, caseId, 1, 90);
    const job = await getJob(env.DB, OP, appId, caseId);
    expect(job).toMatchObject({
      stage: "basin_pending",
      proof: "none",
      attempts: 0,
      last_error_code: "executor_unconfigured",
      completed_at: null,
    });
    const health = await erasureHealth(d, appId);
    expect(health).toMatchObject({
      executor_configured: false,
      blocked: 1,
      proof: { none: 1, logical_only: 0, physical_verified: 0 },
    });
    expect(health.jobs.complete).toBe(0);
  });

  it("the Worker's scheduled maintenance uses the fail-closed executor by default", async () => {
    const appId = "app_sched";
    const { caseId } = await seed(appId);
    const e = { ...env, ...ON } as unknown as Env;
    await requestErasure(deps(), OP, { appId, caseId, reason: "subject_request" });
    clock += 3 * 60 * MIN;
    await maintainErasure(e, now);
    expect((await getJob(env.DB, OP, appId, caseId))?.stage).toBe("basin_pending");
  });
});

describe("receipts drive completion", () => {
  async function run(
    appId: string,
    opts: Parameters<typeof syntheticRunner>[0] extends infer O ? Partial<O> : never = {},
  ) {
    const { caseId } = await seed(appId);
    const { runner, calls } = syntheticRunner({ signer, now, ...opts });
    const d = deps({ executor: runner });
    await requestErasure(d, OP, { appId, caseId, reason: "subject_request" });
    return { d, caseId, calls };
  }

  it("completes only through logical then physical receipts, and records evidence", async () => {
    const appId = "app_full";
    const { d, caseId, calls } = await run(appId);
    // Inside the settle window nothing is sent to the runner.
    expect((await drainJob(d, { appId, caseId, purgeGeneration: 1 }))?.stage).toBe("basin_pending");
    expect(calls).toEqual([]);

    let job = await pass(d, appId, caseId);
    expect(job).toMatchObject({
      stage: "files_cleanup_pending",
      proof: "logical_only",
      completed_at: null,
    });
    expect(calls.map((c) => c.op)).toEqual(["delete"]);
    const logicalOnly = await erasureHealth(d, appId);
    expect(logicalOnly.proof).toEqual({ none: 0, logical_only: 1, physical_verified: 0 });

    job = await pass(d, appId, caseId, 1, 90);
    expect(job).toMatchObject({
      stage: "complete",
      proof: "physical_verified",
      retention_policy_version: "erasure-1",
    });
    expect(job?.evidence_checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(job?.last_verified_at).toBe(clock);
    expect(calls.map((c) => c.op)).toEqual(["delete", "cleanup"]);
    // Re-running a complete job is a no-op.
    const before = await rows(
      "SELECT count(*) AS n FROM lifecycle_erasure_events WHERE app_id = ?",
      appId,
    );
    await pass(d, appId, caseId);
    expect(
      await rows("SELECT count(*) AS n FROM lifecycle_erasure_events WHERE app_id = ?", appId),
    ).toEqual(before);
    const stages = (
      await rows("SELECT stage FROM lifecycle_erasure_events WHERE app_id = ? ORDER BY id", appId)
    ).map((r) => r.stage);
    expect(stages).toEqual([
      "requested",
      "local_hidden",
      "basin_pending",
      "basin_verified",
      "files_cleanup_pending",
      "complete",
    ]);
    // Repeating the request after completion returns the completed job, with no new generation.
    const again = await requestErasure(d, OP, { appId, caseId, reason: "subject_request" });
    expect(again).toMatchObject({ status: "existing", job: { stage: "complete" } });
  });

  it("the request carries the hashed identity, nonce and settle time, not receipts or payloads", async () => {
    const { d, caseId, calls } = await run("app_req");
    await pass(d, "app_req", caseId);
    const req = calls[0]?.request;
    expect(req?.caseDigest).toBe(await caseDigest("app_req", caseId));
    expect(req?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(req?.table).toBe(TABLE);
    expect(req?.notBefore).toBeGreaterThan(T0);
  });

  it("rejects a receipt signed by an untrusted key", async () => {
    const appId = "app_forged";
    const { caseId } = await seed(appId);
    const attacker = await makeSigner(signer.keyId); // same key id, different key
    const { runner } = syntheticRunner({ signer: attacker, now });
    const d = deps({ executor: runner });
    await requestErasure(d, OP, { appId, caseId, reason: "subject_request" });
    const job = await pass(d, appId, caseId);
    expect(job).toMatchObject({
      stage: "basin_pending",
      proof: "none",
      attempts: 1,
      last_error_code: "receipt_signature_invalid",
    });
  });

  it("with no verifier configured nothing can be accepted", async () => {
    const appId = "app_noverifier";
    const { caseId } = await seed(appId);
    const { runner } = syntheticRunner({ signer, now });
    const d = deps({ executor: runner, verifier: rejectAll });
    await requestErasure(d, OP, { appId, caseId, reason: "subject_request" });
    expect((await pass(d, appId, caseId))?.last_error_code).toBe("receipt_signature_invalid");
  });

  it.each([
    ["another case", { case_digest: "a".repeat(64) }, "receipt_wrong_job"],
    ["another generation", { purge_generation: 2 }, "receipt_wrong_job"],
    ["a replayed nonce", { nonce: "b".repeat(32) }, "receipt_wrong_job"],
    ["another table", { table: "r2dc.other.table" }, "receipt_wrong_table"],
    ["rows still present", { rows_remaining: 2 }, "receipt_rows_remaining"],
    ["a delete before the settle window", { committed_at: T0 }, "receipt_before_settle"],
    [
      "a future commit",
      { committed_at: T0 + 10 * 365 * 24 * 60 * MIN, issued_at: T0 + 10 * 365 * 24 * 60 * MIN },
      "receipt_from_future",
    ],
  ])("rejects a logical receipt for %s", async (_name, tamper, code) => {
    const appId = `app_bad_${code}_${Object.keys(tamper).join("")}`.slice(0, 60);
    const { d, caseId } = await run(appId, { tamperLogical: tamper });
    const job = await pass(d, appId, caseId);
    expect(job).toMatchObject({ stage: "basin_pending", proof: "none", last_error_code: code });
  });

  it("rejects a malformed receipt carrying extra or unsafe fields", async () => {
    const appId = "app_malformed";
    const { d, caseId } = await run(appId, { tamperLogical: { email: "someone@example.com" } });
    expect((await pass(d, appId, caseId))?.last_error_code).toBe("receipt_malformed");
    expect(
      JSON.stringify(await rows("SELECT * FROM lifecycle_erasure_events WHERE app_id = ?", appId)),
    ).not.toContain("example.com");
  });

  it("does not accept a logical receipt in place of a physical one (or the reverse)", async () => {
    const appId = "app_kinds";
    const { d, caseId } = await run(appId);
    await pass(d, appId, caseId);
    // At files_cleanup_pending a replayed logical receipt must be refused.
    const { runner } = syntheticRunner({ signer, now });
    const logical = await runner.deleteForwardedRows({
      appId,
      caseId,
      caseDigest: await caseDigest(appId, caseId),
      purgeGeneration: 1,
      nonce: (await rows("SELECT nonce FROM lifecycle_erasure_jobs WHERE app_id = ?", appId))[0]
        ?.nonce as string,
      table: TABLE,
      notBefore: clock,
    });
    const res = await submitReceipt(d, OP, { appId, caseId, purgeGeneration: 1, receipt: logical });
    expect(res).toEqual({ accepted: false, code: "receipt_wrong_kind" });
    expect((await getJob(env.DB, OP, appId, caseId))?.stage).toBe("files_cleanup_pending");
  });

  it.each([
    [
      "retained snapshots still hold rows",
      { retained_snapshots_with_rows: 1 },
      "receipt_snapshots_retained",
    ],
    [
      "an old snapshot was kept",
      { oldest_retained_committed_at: T0 },
      "receipt_snapshots_retained",
    ],
    [
      "snapshots were not expired past the delete",
      { expired_before: T0 },
      "receipt_snapshots_retained",
    ],
    ["orphan files remain", { orphan_files_removed: false }, "receipt_orphans_not_removed"],
    ["it is for a different delete snapshot", { snapshot_id: "123" }, "receipt_wrong_snapshot"],
    [
      "it does not match the logical receipt",
      { logical_receipt_checksum: "c".repeat(64) },
      "receipt_wrong_snapshot",
    ],
  ])("never completes when %s", async (_name, tamper, code) => {
    const appId = `app_phys_${code}_${Object.keys(tamper)[0]}`.slice(0, 60);
    const { d, caseId } = await run(appId, { tamperPhysical: tamper });
    await pass(d, appId, caseId);
    const job = await pass(d, appId, caseId, 1, 90);
    expect(job).toMatchObject({
      stage: "files_cleanup_pending",
      proof: "logical_only",
      completed_at: null,
      last_error_code: code,
    });
  });

  it("a failing external purge retries with backoff, then fails and can be reopened", async () => {
    const appId = "app_failing";
    const { d, caseId, calls } = await run(appId, {
      failWith: new ExecutorError("spark_job_failed"),
    });
    let job = await pass(d, appId, caseId);
    expect(job).toMatchObject({
      stage: "basin_pending",
      attempts: 1,
      last_error_code: "spark_job_failed",
    });
    const wait = job?.next_attempt_at ?? 0;
    expect(wait).toBeGreaterThan(clock);
    // Not due yet: no second call before the backoff elapses.
    const before = calls.length;
    await drainJob(d, { appId, caseId, purgeGeneration: 1 });
    expect(calls.length).toBe(before);
    for (let i = 0; i < 12; i++) job = await pass(d, appId, caseId, 1, 8 * 60);
    expect(job).toMatchObject({ stage: "failed", failed_stage: "basin_pending", proof: "none" });
    // The local hold is untouched by the failure.
    expect(
      await rows(
        "SELECT * FROM lifecycle_case_tombstones WHERE app_id = ? AND case_id = ?",
        appId,
        caseId,
      ),
    ).toHaveLength(1);
    // Fix the runner and reopen: it resumes where it stopped.
    const healthy = syntheticRunner({ signer, now }).runner;
    const d2 = deps({ executor: healthy });
    expect((await reopenJob(d2, OP, { appId, caseId, purgeGeneration: 1 }))?.stage).toBe(
      "basin_pending",
    );
    expect((await pass(d2, appId, caseId))?.stage).toBe("files_cleanup_pending");
  });

  it("a runner that is still working does not spend attempts", async () => {
    const appId = "app_pending";
    const { d, caseId } = await run(appId, { failWith: new ExecutorPending() });
    const job = await pass(d, appId, caseId);
    expect(job).toMatchObject({
      stage: "basin_pending",
      attempts: 0,
      last_error_code: "executor_pending",
    });
  });

  it("an out-of-band receipt is checked like an executor result, and bad ones do not fail the job", async () => {
    const appId = "app_oob";
    const { d, caseId } = await run(appId, { failWith: new ExecutorPending() });
    await pass(d, appId, caseId);
    const nonce = (
      await rows("SELECT nonce, settle_until FROM lifecycle_erasure_jobs WHERE app_id = ?", appId)
    )[0] as { nonce: string; settle_until: number };
    const digest = await caseDigest(appId, caseId);
    const payload = {
      v: 1,
      kind: "logical_delete",
      app_id: appId,
      case_digest: digest,
      purge_generation: 1,
      nonce: nonce.nonce,
      table: TABLE,
      issued_at: clock,
      predicate: "digest_v1",
      snapshot_id: "7000000000000000009",
      committed_at: nonce.settle_until + MIN,
      rows_deleted: 4,
      rows_remaining: 0,
    };
    const key = { appId, caseId, purgeGeneration: 1 };
    for (let i = 0; i < 20; i++) {
      expect(
        await submitReceipt(d, OP, {
          ...key,
          receipt: { ...(await signer.sign(payload)), signature: "x" },
        }),
      ).toEqual({ accepted: false, code: "receipt_malformed" });
    }
    expect(await getJob(env.DB, OP, appId, caseId)).toMatchObject({
      stage: "basin_pending",
      attempts: 0,
    });
    const forged = (await makeSigner(signer.keyId)).sign(payload);
    expect(await submitReceipt(d, OP, { ...key, receipt: await forged })).toEqual({
      accepted: false,
      code: "receipt_signature_invalid",
    });
    const good = await submitReceipt(d, OP, { ...key, receipt: await signer.sign(payload) });
    expect(good).toMatchObject({
      accepted: true,
      job: { stage: "files_cleanup_pending", proof: "logical_only" },
    });
    // A duplicate delivery of the same receipt is not accepted twice.
    expect(
      await submitReceipt(d, OP, { ...key, receipt: await signer.sign(payload) }),
    ).toMatchObject({ accepted: false });
  });
});

describe("app separation and purge generations", () => {
  it("the same case id in two apps gets independent jobs, digests and holds", async () => {
    const d = deps();
    const a = await requestErasure(d, OP, {
      appId: "app_sep_a",
      caseId: "shared_case",
      reason: "subject_request",
    });
    expect(await caseDigest("app_sep_a", "shared_case")).not.toBe(
      await caseDigest("app_sep_b", "shared_case"),
    );
    expect(
      await rows("SELECT * FROM lifecycle_erasure_jobs WHERE case_id = 'shared_case'"),
    ).toHaveLength(1);
    const b = await requestErasure(d, OP, {
      appId: "app_sep_b",
      caseId: "shared_case",
      reason: "subject_request",
    });
    expect([a.status, b.status]).toEqual(["created", "created"]);
    expect(
      await rows("SELECT * FROM lifecycle_case_tombstones WHERE app_id = 'app_sep_a'"),
    ).toHaveLength(1);
    expect((await erasureHealth(d, "app_sep_a")).jobs.basin_pending).toBe(1);
    expect((await erasureHealth(d, "app_sep_c")).jobs.basin_pending).toBe(0);
  });

  it("a re-purge opens generation 2 only after generation 1 completed", async () => {
    const appId = "app_regen";
    const { caseId } = await seed(appId);
    const { runner } = syntheticRunner({ signer, now });
    const d = deps({ executor: runner });
    await requestErasure(d, OP, { appId, caseId, reason: "subject_request" });
    const early = await requestErasure(d, OP, {
      appId,
      caseId,
      reason: "subject_request",
      repurge: true,
    });
    expect(early.status).toBe("existing");
    await pass(d, appId, caseId);
    await pass(d, appId, caseId, 1, 90);
    const again = await requestErasure(d, OP, {
      appId,
      caseId,
      reason: "residue_found",
      repurge: true,
    });
    expect(again).toMatchObject({
      status: "created",
      job: { purge_generation: 2, stage: "basin_pending" },
    });
    // Generation 1 receipts cannot satisfy generation 2.
    expect(
      await rows(
        "SELECT purge_generation FROM lifecycle_erasure_jobs WHERE app_id = ? ORDER BY 1",
        appId,
      ),
    ).toEqual([{ purge_generation: 1 }, { purge_generation: 2 }]);
  });
});

describe("database invariants and audit hygiene", () => {
  it("D1 itself refuses a job that claims completion without both verified receipts", async () => {
    const appId = "app_checks";
    await requestErasure(deps(), OP, { appId, caseId: "case_checks", reason: "subject_request" });
    const attempt = (set: string) =>
      env.DB.prepare(`UPDATE lifecycle_erasure_jobs SET ${set} WHERE app_id = ?`).bind(appId).run();
    await expect(attempt("stage = 'complete', completed_at = 1")).rejects.toThrow();
    await expect(attempt("stage = 'basin_verified'")).rejects.toThrow();
    await expect(
      attempt(
        "stage = 'complete', completed_at = 1, logical_receipt_checksum = '" +
          "a".repeat(64) +
          "', logical_snapshot_id = 's', logical_committed_at = 1, logical_verified_at = 1",
      ),
    ).rejects.toThrow();
    await expect(attempt("last_error_code = 'Contains PII: jane@example.com'")).rejects.toThrow();
  });

  it("the audit trail is machine-only: codes, hashes and stages, never the case id or payloads", async () => {
    const appId = "app_audit";
    const secretish = "case_with_distinct_token_9f3a";
    const logs = ["log", "info", "warn", "error", "debug"].map((m) =>
      vi.spyOn(console, m as "log").mockImplementation(() => undefined),
    );
    const { runner } = syntheticRunner({ signer, now });
    const d = deps({ executor: runner });
    await requestErasure(d, OP, { appId, caseId: secretish, reason: "subject_request" });
    await pass(d, appId, secretish);
    await pass(d, appId, secretish, 1, 90);
    const audit = JSON.stringify(
      await rows("SELECT * FROM lifecycle_erasure_events WHERE app_id = ?", appId),
    );
    expect(audit).not.toContain(secretish);
    for (const row of await rows(
      "SELECT * FROM lifecycle_erasure_events WHERE app_id = ?",
      appId,
    )) {
      expect(row.code).toMatch(/^[a-z0-9_.:-]{1,64}$/);
      expect(row.case_digest).toMatch(/^[0-9a-f]{64}$/);
    }
    const health = JSON.stringify(await erasureHealth(d, appId));
    expect(health).not.toContain(secretish);
    expect(JSON.stringify(await getJob(env.DB, OP, appId, secretish))).not.toContain(secretish);
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it("renders the documented Iceberg statements without executing anything", () => {
    expect(deleteStatement(TABLE)).toBe(
      `DELETE FROM ${TABLE}\nWHERE app_id = :app_id\n  AND sha2(concat_ws('|', 'flightdeck.erasure.v1', app_id, case_id), 256) = :case_digest`,
    );
    const [expire, orphans] = cleanupStatements(TABLE, Date.UTC(2026, 10, 1, 12, 0, 0, 123));
    expect(expire).toBe(
      "CALL r2dc.system.expire_snapshots(table => 'flightdeck.lifecycle_events', older_than => TIMESTAMP '2026-11-01 12:00:00.123', retain_last => 1)",
    );
    expect(orphans).toBe(
      "CALL r2dc.system.remove_orphan_files(table => 'flightdeck.lifecycle_events')",
    );
    expect(() => deleteStatement("x; DROP TABLE y")).toThrow("invalid_iceberg_identifier");
  });
});
