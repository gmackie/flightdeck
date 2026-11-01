import { servingId } from "../lifecycle-projection/snapshot";
import { canonical, eraseCaseStatements, RETIRED_REASON } from "../lifecycle-projection/store";
import type { ErasureConfig } from "./config";
import {
  type BasinErasureExecutor,
  ExecutorError,
  ExecutorPending,
  ExecutorUnavailable,
  failClosedExecutor,
} from "./executor";
import {
  type ActiveStage,
  isActive,
  isDue,
  type MachineEvent,
  type MachineState,
  STAGES,
  type Stage,
  transition,
} from "./machine";
import {
  authenticate,
  checkLogical,
  checkPhysical,
  type JobBinding,
  type ReceiptVerifier,
  sha256Hex,
} from "./receipt";
import { caseDigest, cleanupStatements, deleteStatement } from "./spark";

/**
 * The D1 side of an erasure request (migration 0041). Requesting hides the case locally in one
 * atomic batch and opens a job; the job then waits for an external Iceberg-compatible runner to
 * delete the forwarded rows and expire snapshots, and advances only on signed, job-bound
 * receipts. There is no HTTP route or binding method for any of this: callers are operator code.
 */

const JOBS = "lifecycle_erasure_jobs";
const EVENTS = "lifecycle_erasure_events";
const LOG = "lifecycle_event_log";
const LEASE_MS = 10 * 60_000;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const APP_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const CODE = /^[a-z0-9_.:-]{1,64}$/;

/** Who is asking. Operators act on listed apps (or "*"); the cron acts as `system`. */
export type ErasureActor =
  | { kind: "operator"; id: string; apps: "*" | readonly string[] }
  | { kind: "system" };

export class ErasureForbidden extends Error {
  constructor() {
    super("erasure_forbidden");
    this.name = "ErasureForbidden";
  }
}
export class ErasureDisabled extends Error {
  constructor() {
    super("erasure_disabled");
    this.name = "ErasureDisabled";
  }
}
export class ErasureInvalid extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ErasureInvalid";
  }
}

export type ErasureDeps = {
  db: D1Database;
  config: ErasureConfig;
  executor: BasinErasureExecutor;
  verifier: ReceiptVerifier;
  now: () => number;
  /** 16 random bytes as hex; injectable for tests. */
  nonce?: () => string;
};

/** Creating or changing a job needs an operator scoped to the app. Never inferred from input. */
export function requireOperator(actor: ErasureActor, appId: string): { id: string } {
  if (actor?.kind === "operator" && CODE.test(actor.id)) {
    if (actor.apps === "*" || (Array.isArray(actor.apps) && actor.apps.includes(appId))) {
      return { id: actor.id };
    }
  }
  throw new ErasureForbidden();
}

export type Proof = "none" | "logical_only" | "physical_verified";

export type JobRow = {
  app_id: string;
  case_id: string;
  purge_generation: number;
  case_digest: string;
  nonce: string;
  stage: Stage;
  failed_stage: ActiveStage | null;
  reason: string;
  requested_by: string;
  requested_at: number;
  retention_policy_version: string;
  version: number;
  lease_until: number | null;
  attempts: number;
  next_attempt_at: number;
  last_error_code: string | null;
  settle_until: number | null;
  local_rows_removed: number;
  forwarded_rows: number;
  last_verified_at: number | null;
  evidence_checksum: string | null;
  logical_snapshot_id: string | null;
  logical_committed_at: number | null;
  logical_rows_deleted: number | null;
  logical_receipt_checksum: string | null;
  logical_verified_at: number | null;
  physical_receipt_checksum: string | null;
  physical_verified_at: number | null;
  completed_at: number | null;
};

/** What a caller sees: hashed identity, codes and counts. Never the case id or any receipt body. */
export type JobSummary = {
  app_id: string;
  case_digest: string;
  purge_generation: number;
  stage: Stage;
  failed_stage: ActiveStage | null;
  /** `physical_verified` is the only value that supports saying the data was erased. */
  proof: Proof;
  attempts: number;
  next_attempt_at: number;
  last_error_code: string | null;
  last_verified_at: number | null;
  retention_policy_version: string;
  evidence_checksum: string | null;
  requested_at: number;
  completed_at: number | null;
};

export const proofOf = (row: Pick<JobRow, "stage" | "logical_receipt_checksum">): Proof =>
  row.stage === "complete"
    ? "physical_verified"
    : row.logical_receipt_checksum
      ? "logical_only"
      : "none";

export const summarize = (row: JobRow): JobSummary => ({
  app_id: row.app_id,
  case_digest: row.case_digest,
  purge_generation: row.purge_generation,
  stage: row.stage,
  failed_stage: row.failed_stage,
  proof: proofOf(row),
  attempts: row.attempts,
  next_attempt_at: row.next_attempt_at,
  last_error_code: row.last_error_code,
  last_verified_at: row.last_verified_at,
  retention_policy_version: row.retention_policy_version,
  evidence_checksum: row.evidence_checksum,
  requested_at: row.requested_at,
  completed_at: row.completed_at,
});

const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

type Key = { appId: string; caseId: string; purgeGeneration: number };
const keyOf = (r: JobRow): Key => ({
  appId: r.app_id,
  caseId: r.case_id,
  purgeGeneration: r.purge_generation,
});

async function readJob(db: D1Database, k: Key): Promise<JobRow | null> {
  return db
    .prepare(`SELECT * FROM ${JOBS} WHERE app_id = ? AND case_id = ? AND purge_generation = ?`)
    .bind(k.appId, k.caseId, k.purgeGeneration)
    .first<JobRow>();
}

async function latestJob(db: D1Database, appId: string, caseId: string): Promise<JobRow | null> {
  return db
    .prepare(
      `SELECT * FROM ${JOBS} WHERE app_id = ? AND case_id = ? ORDER BY purge_generation DESC LIMIT 1`,
    )
    .bind(appId, caseId)
    .first<JobRow>();
}

export type ErasurePlan = {
  app_id: string;
  case_digest: string;
  tombstoned: boolean;
  open_job_stage: Stage | null;
  local_log_rows: number;
  /** Rows that may already be in Basin. Informational: Basin can drop non-conforming rows. */
  may_be_forwarded_rows: number;
  /** Rendered, never executed here. Values are named parameters; no case id appears. */
  external: {
    delete: string;
    cleanup: string[];
    parameters: { app_id: string; case_digest: string };
  };
};

export type RequestResult =
  | { status: "created" | "existing"; job: JobSummary }
  | { status: "dry_run"; plan: ErasurePlan };

export type RequestInput = { appId: string; caseId: string; reason: string; repurge?: boolean };

/**
 * Idempotent erasure request. Repeating it for the same case returns the same job. `repurge`
 * opens a new purge generation, but only once the previous one is complete (for example after a
 * later audit finds residue). A legacy tombstone from `eraseCase` is upgraded: the request adds
 * the job that tracks the Basin side the tombstone never covered.
 */
export async function requestErasure(
  deps: ErasureDeps,
  actor: ErasureActor,
  input: RequestInput,
): Promise<RequestResult> {
  const { id: actorId } = requireOperator(actor, input.appId);
  if (!APP_ID.test(input.appId) || !ID.test(input.caseId)) throw new ErasureInvalid("invalid_id");
  if (!CODE.test(input.reason)) throw new ErasureInvalid("invalid_reason");
  const { config, db } = deps;
  if (config.mode === "off") throw new ErasureDisabled();
  const { appId, caseId } = input;
  const digest = await caseDigest(appId, caseId);

  if (config.mode === "dry_run")
    return { status: "dry_run", plan: await plan(deps, appId, caseId, digest) };

  const now = deps.now();
  const nonce = (deps.nonce ?? randomHex)();
  const served = await servingId(caseId);
  const repurge = input.repurge ? 1 : 0;
  const statements = [
    db
      .prepare(
        `INSERT OR IGNORE INTO ${JOBS} (app_id, case_id, purge_generation, case_digest, nonce, stage,
           reason, requested_by, requested_at, retention_policy_version, next_attempt_at,
           local_rows_removed, forwarded_rows, updated_at)
         SELECT ?1, ?2,
           (SELECT coalesce(max(purge_generation), 0) + 1 FROM ${JOBS} WHERE app_id = ?1 AND case_id = ?2),
           ?3, ?4, 'requested', ?5, ?6, ?7, ?8, ?7,
           (SELECT count(*) FROM ${LOG} WHERE app_id = ?1 AND case_id = ?2),
           (SELECT count(*) FROM ${LOG} WHERE app_id = ?1 AND case_id = ?2
              AND (forwarded_at IS NOT NULL OR forward_attempts > 0)),
           ?7
         WHERE NOT EXISTS (SELECT 1 FROM ${JOBS} j WHERE j.app_id = ?1 AND j.case_id = ?2
           AND (?9 = 0 OR j.stage != 'complete'))`,
      )
      .bind(
        appId,
        caseId,
        digest,
        nonce,
        input.reason,
        actorId,
        now,
        config.policyVersion,
        repurge,
      ),
    // Serving-side tombstone (0031), so the read model refuses the case even if the ingest-side
    // one were bypassed. Re-arms a restored tombstone; a later authorized restore cannot revive
    // the case because its evidence is gone and ingest still drops it.
    db
      .prepare(
        `INSERT INTO lifecycle_snapshot_tombstones (app_id, case_id, reason, source_watermark, as_of, deleted_at)
         SELECT ?1, ?2, 'erased', coalesce(max(seq), 0), ?3, ?3 FROM ${LOG} WHERE app_id = ?1
         ON CONFLICT (app_id, case_id) DO UPDATE SET reason = 'erased',
           source_watermark = max(source_watermark, excluded.source_watermark),
           as_of = max(as_of, excluded.as_of), deleted_at = excluded.deleted_at,
           restored_at = NULL, restore_reason = NULL, restore_ref = NULL`,
      )
      .bind(appId, served, now),
    ...eraseCaseStatements(db, appId, caseId, served, input.reason, now),
    // A case retention already retired is now erased: say so (it only changes diagnostics' label).
    db
      .prepare(
        `UPDATE lifecycle_case_tombstones SET reason = ?, erased_at = ?
         WHERE app_id = ? AND case_id = ? AND reason = ?`,
      )
      .bind(input.reason, now, appId, caseId, RETIRED_REASON),
    db
      .prepare(
        `INSERT INTO ${EVENTS} (app_id, case_digest, purge_generation, stage, code, actor_kind,
           actor_id, at, retention_policy_version)
         SELECT app_id, case_digest, purge_generation, 'requested', 'requested', 'operator', ?, ?, ?
         FROM ${JOBS} WHERE app_id = ? AND case_id = ? AND nonce = ?`,
      )
      .bind(actorId, now, config.policyVersion, appId, caseId, nonce),
  ];
  await db.batch(statements);
  const latest = await latestJob(db, appId, caseId);
  if (!latest) throw new ErasureInvalid("job_missing");
  const created = latest.nonce === nonce;
  const job = created ? await drainJob(deps, keyOf(latest)) : summarize(latest);
  return { status: created ? "created" : "existing", job: job ?? summarize(latest) };
}

async function plan(
  deps: ErasureDeps,
  appId: string,
  caseId: string,
  digest: string,
): Promise<ErasurePlan> {
  const [log, tomb, job] = await deps.db.batch<Record<string, number | string | null>>([
    deps.db
      .prepare(
        `SELECT count(*) AS rows, coalesce(sum(forwarded_at IS NOT NULL OR forward_attempts > 0), 0) AS sent
         FROM ${LOG} WHERE app_id = ? AND case_id = ?`,
      )
      .bind(appId, caseId),
    deps.db
      .prepare(
        "SELECT count(*) AS n FROM lifecycle_case_tombstones WHERE app_id = ? AND case_id = ?",
      )
      .bind(appId, caseId),
    deps.db
      .prepare(
        `SELECT stage FROM ${JOBS} WHERE app_id = ? AND case_id = ? ORDER BY purge_generation DESC LIMIT 1`,
      )
      .bind(appId, caseId),
  ]);
  const l = log?.results?.[0] ?? {};
  return {
    app_id: appId,
    case_digest: digest,
    tombstoned: Number(tomb?.results?.[0]?.n ?? 0) > 0,
    open_job_stage: (job?.results?.[0]?.stage as Stage | undefined) ?? null,
    local_log_rows: Number(l.rows ?? 0),
    may_be_forwarded_rows: Number(l.sent ?? 0),
    external: {
      delete: deleteStatement(deps.config.table),
      cleanup: cleanupStatements(deps.config.table, deps.now()),
      parameters: { app_id: appId, case_digest: digest },
    },
  };
}

// --- stepping ---------------------------------------------------------------------------------

type AuditActor = "operator" | "system" | "executor";

type Patch = Partial<
  Pick<
    JobRow,
    | "last_verified_at"
    | "evidence_checksum"
    | "logical_snapshot_id"
    | "logical_committed_at"
    | "logical_rows_deleted"
    | "logical_receipt_checksum"
    | "logical_verified_at"
    | "physical_receipt_checksum"
    | "physical_verified_at"
    | "completed_at"
  >
>;

const toState = (r: JobRow): MachineState => ({
  stage: r.stage,
  failedStage: r.failed_stage,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  lastErrorCode: r.last_error_code,
  settleUntil: r.settle_until,
});

/** Takes the job's lease, or null if it is finished, leased by someone else, or changed. */
async function claim(deps: ErasureDeps, row: JobRow): Promise<JobRow | null> {
  const now = deps.now();
  const result = await deps.db
    .prepare(
      `UPDATE ${JOBS} SET lease_until = ?, version = version + 1
       WHERE app_id = ? AND case_id = ? AND purge_generation = ? AND version = ?
         AND stage NOT IN ('complete', 'failed') AND (lease_until IS NULL OR lease_until <= ?)`,
    )
    .bind(now + LEASE_MS, row.app_id, row.case_id, row.purge_generation, row.version, now)
    .run();
  if (!result.meta.changes) return null;
  return readJob(deps.db, keyOf(row));
}

/**
 * Persists one transition and its audit row atomically, guarded by the claimed version. Returns
 * false if another writer got there first (nothing was written).
 */
async function commit(
  deps: ErasureDeps,
  row: JobRow,
  event: MachineEvent,
  patch: Patch,
  actor: AuditActor,
  actorId: string,
): Promise<boolean> {
  const now = deps.now();
  const t = transition(toState(row), event, now);
  if (!t.ok) return false;
  const s = t.state;
  const next = { ...row, ...patch };
  const update = deps.db
    .prepare(
      `UPDATE ${JOBS} SET stage = ?, failed_stage = ?, attempts = ?, next_attempt_at = ?,
         last_error_code = ?, settle_until = ?, last_verified_at = ?, evidence_checksum = ?,
         logical_snapshot_id = ?, logical_committed_at = ?, logical_rows_deleted = ?,
         logical_receipt_checksum = ?, logical_verified_at = ?, physical_receipt_checksum = ?,
         physical_verified_at = ?, completed_at = ?, lease_until = NULL, version = version + 1,
         updated_at = ?
       WHERE app_id = ? AND case_id = ? AND purge_generation = ? AND version = ?`,
    )
    .bind(
      s.stage,
      s.failedStage,
      s.attempts,
      s.nextAttemptAt,
      s.lastErrorCode,
      s.settleUntil,
      next.last_verified_at,
      next.evidence_checksum,
      next.logical_snapshot_id,
      next.logical_committed_at,
      next.logical_rows_deleted,
      next.logical_receipt_checksum,
      next.logical_verified_at,
      next.physical_receipt_checksum,
      next.physical_verified_at,
      next.completed_at,
      now,
      row.app_id,
      row.case_id,
      row.purge_generation,
      row.version,
    );
  const audit = deps.db
    .prepare(
      `INSERT INTO ${EVENTS} (app_id, case_digest, purge_generation, stage, code, actor_kind,
         actor_id, at, last_verified_at, retention_policy_version, evidence_checksum)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM ${JOBS} WHERE app_id = ? AND case_id = ? AND purge_generation = ?
           AND version = ?)`,
    )
    .bind(
      row.app_id,
      row.case_digest,
      row.purge_generation,
      s.stage,
      t.code.slice(0, 64),
      actor,
      actorId,
      now,
      next.last_verified_at,
      row.retention_policy_version,
      next.evidence_checksum,
      row.app_id,
      row.case_id,
      row.purge_generation,
      row.version + 1,
    );
  const [result] = await deps.db.batch([update, audit]);
  return Boolean(result?.meta.changes);
}

/** Releases the lease and records a rejected receipt without changing the job's stage. */
async function recordRejection(
  deps: ErasureDeps,
  row: JobRow,
  code: string,
  actor: AuditActor,
  actorId: string,
) {
  const now = deps.now();
  await deps.db.batch([
    deps.db
      .prepare(
        `UPDATE ${JOBS} SET lease_until = NULL, version = version + 1, updated_at = ?
         WHERE app_id = ? AND case_id = ? AND purge_generation = ? AND version = ?`,
      )
      .bind(now, row.app_id, row.case_id, row.purge_generation, row.version),
    deps.db
      .prepare(
        `INSERT INTO ${EVENTS} (app_id, case_digest, purge_generation, stage, code, actor_kind,
           actor_id, at, last_verified_at, retention_policy_version, evidence_checksum)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.app_id,
        row.case_digest,
        row.purge_generation,
        row.stage,
        code,
        actor,
        actorId,
        now,
        row.last_verified_at,
        row.retention_policy_version,
        row.evidence_checksum,
      ),
  ]);
}

const bindingOf = (r: JobRow): JobBinding => ({
  appId: r.app_id,
  caseDigest: r.case_digest,
  purgeGeneration: r.purge_generation,
  nonce: r.nonce,
  settleUntil: r.settle_until,
  logicalSnapshotId: r.logical_snapshot_id,
  logicalCommittedAt: r.logical_committed_at,
  logicalReceiptChecksum: r.logical_receipt_checksum,
});

type Evaluated = { ok: true; event: MachineEvent; patch: Patch } | { ok: false; code: string };

/** Authenticates `signed` for the job's current stage and derives what to persist. */
async function evaluateReceipt(
  deps: ErasureDeps,
  row: JobRow,
  signed: unknown,
): Promise<Evaluated> {
  const now = deps.now();
  if (row.stage === "basin_pending") {
    const parsed = await authenticate(signed, "logical_delete", deps.verifier);
    if (!parsed.ok) return parsed;
    const code = checkLogical(parsed.receipt, bindingOf(row), deps.config.table, now);
    if (code) return { ok: false, code };
    return {
      ok: true,
      event: { type: "logical_accepted" },
      patch: {
        last_verified_at: now,
        logical_snapshot_id: parsed.receipt.snapshot_id,
        logical_committed_at: parsed.receipt.committed_at,
        logical_rows_deleted: parsed.receipt.rows_deleted,
        logical_receipt_checksum: parsed.checksum,
        logical_verified_at: now,
        evidence_checksum: await sha256Hex(
          canonical({
            stage: "basin_verified",
            logical: parsed.checksum,
            policy: row.retention_policy_version,
          }),
        ),
      },
    };
  }
  if (row.stage === "files_cleanup_pending") {
    const parsed = await authenticate(signed, "physical_cleanup", deps.verifier);
    if (!parsed.ok) return parsed;
    const code = checkPhysical(parsed.receipt, bindingOf(row), deps.config.table, now);
    if (code) return { ok: false, code };
    return {
      ok: true,
      event: { type: "physical_accepted" },
      patch: {
        last_verified_at: now,
        physical_receipt_checksum: parsed.checksum,
        physical_verified_at: now,
        completed_at: now,
        evidence_checksum: await sha256Hex(
          canonical({
            stage: "complete",
            logical: row.logical_receipt_checksum,
            physical: parsed.checksum,
            policy: row.retention_policy_version,
          }),
        ),
      },
    };
  }
  return { ok: false, code: "receipt_not_expected" };
}

const safeCode = (code: unknown) =>
  typeof code === "string" && CODE.test(code) ? code : "executor_error";

/** Runs one stage of a leased job. */
async function runStage(deps: ErasureDeps, row: JobRow): Promise<void> {
  const now = deps.now();
  switch (row.stage) {
    case "requested": {
      const served = await servingId(row.case_id);
      await deps.db.batch(
        eraseCaseStatements(deps.db, row.app_id, row.case_id, served, row.reason, now),
      );
      const residue = await localResidue(deps.db, row.app_id, row.case_id, served);
      if (residue.rows > 0 || !residue.tombstoned) {
        await commit(deps, row, { type: "local_residue" }, {}, "system", "local");
        return;
      }
      await commit(
        deps,
        row,
        { type: "local_verified" },
        {
          last_verified_at: now,
          evidence_checksum: await sha256Hex(
            canonical({
              stage: "local_hidden",
              digest: row.case_digest,
              generation: row.purge_generation,
              residue: 0,
              policy: row.retention_policy_version,
            }),
          ),
        },
        "system",
        "local",
      );
      return;
    }
    case "local_hidden":
      await commit(
        deps,
        row,
        { type: "settle_scheduled", settleUntil: row.requested_at + deps.config.settleMs },
        {},
        "system",
        "local",
      );
      return;
    case "basin_verified":
      await commit(
        deps,
        row,
        {
          type: "cleanup_scheduled",
          notBefore: (row.logical_committed_at ?? now) + deps.config.cleanupDelayMs,
        },
        {},
        "system",
        "local",
      );
      return;
    case "basin_pending":
    case "files_cleanup_pending": {
      if (row.stage === "basin_pending" && (row.settle_until ?? 0) > now) {
        await commit(
          deps,
          row,
          { type: "step_blocked", code: "settling", retryAfterMs: (row.settle_until ?? now) - now },
          {},
          "system",
          "local",
        );
        return;
      }
      let signed: unknown;
      try {
        const base = {
          appId: row.app_id,
          caseId: row.case_id,
          caseDigest: row.case_digest,
          purgeGeneration: row.purge_generation,
          nonce: row.nonce,
          table: deps.config.table,
          notBefore: row.settle_until ?? now,
        };
        signed =
          row.stage === "basin_pending"
            ? await deps.executor.deleteForwardedRows(base)
            : await deps.executor.expireAndCleanup({
                ...base,
                deleteSnapshotId: row.logical_snapshot_id ?? "",
                deleteCommittedAt: row.logical_committed_at ?? 0,
                logicalReceiptChecksum: row.logical_receipt_checksum ?? "",
              });
      } catch (error) {
        const event: MachineEvent =
          error instanceof ExecutorUnavailable
            ? { type: "step_blocked", code: "executor_unconfigured", retryAfterMs: 60 * 60_000 }
            : error instanceof ExecutorPending
              ? { type: "step_blocked", code: "executor_pending", retryAfterMs: 5 * 60_000 }
              : {
                  type: "step_failed",
                  code: safeCode(error instanceof ExecutorError ? error.code : undefined),
                  retryable: error instanceof ExecutorError ? error.retryable : true,
                };
        await commit(deps, row, event, {}, "executor", "runner");
        return;
      }
      const evaluated = await evaluateReceipt(deps, row, signed);
      if (!evaluated.ok) {
        await commit(
          deps,
          row,
          { type: "step_failed", code: evaluated.code, retryable: true },
          {},
          "executor",
          "runner",
        );
        return;
      }
      await commit(deps, row, evaluated.event, evaluated.patch, "executor", "runner");
      return;
    }
  }
}

async function localResidue(db: D1Database, appId: string, caseId: string, served: string) {
  const [log, queue, diag, snap, intervals, edges, tomb] = await db.batch<{ n: number }>([
    db
      .prepare(`SELECT count(*) AS n FROM ${LOG} WHERE app_id = ? AND case_id = ?`)
      .bind(appId, caseId),
    db
      .prepare(
        "SELECT count(*) AS n FROM lifecycle_projection_queue WHERE app_id = ? AND case_id = ?",
      )
      .bind(appId, caseId),
    db
      .prepare(
        "SELECT count(*) AS n FROM lifecycle_projection_diagnostics WHERE app_id = ? AND case_id = ?",
      )
      .bind(appId, caseId),
    db
      .prepare(
        "SELECT count(*) AS n FROM lifecycle_case_snapshots WHERE app_id = ? AND case_id = ?",
      )
      .bind(appId, served),
    db
      .prepare(
        "SELECT count(*) AS n FROM lifecycle_stage_intervals WHERE app_id = ? AND case_id = ?",
      )
      .bind(appId, served),
    db
      .prepare(
        "SELECT count(*) AS n FROM lifecycle_case_edges WHERE app_id = ? AND from_case_id = ?",
      )
      .bind(appId, served),
    db
      .prepare(
        "SELECT count(*) AS n FROM lifecycle_case_tombstones WHERE app_id = ? AND case_id = ?",
      )
      .bind(appId, caseId),
  ]);
  const n = (r: D1Result<{ n: number }> | undefined) => Number(r?.results?.[0]?.n ?? 0);
  return {
    rows: n(log) + n(queue) + n(diag) + n(snap) + n(intervals) + n(edges),
    tombstoned: n(tomb) > 0,
  };
}

/**
 * Advances a job through every stage that is due now (local stages chain; external stages wait
 * for their runner and back off). One stage per claim, so a crashed run resumes where it stopped.
 * Returns null if the job does not exist for this key.
 */
export async function drainJob(
  deps: ErasureDeps,
  key: Key,
  maxSteps = 6,
): Promise<JobSummary | null> {
  if (deps.config.mode !== "enforce") return null;
  let row = await readJob(deps.db, key);
  for (let i = 0; row && i < maxSteps; i++) {
    if (!isDue(toState(row), deps.now())) break;
    const claimed = await claim(deps, row);
    if (!claimed) break;
    await runStage(deps, claimed);
    row = await readJob(deps.db, key);
  }
  return row ? summarize(row) : null;
}

/** Due jobs across apps, oldest first. The cron calls this; it creates no jobs. */
export async function dueJobs(db: D1Database, now: number, limit = 20): Promise<Key[]> {
  const { results } = await db
    .prepare(
      `SELECT app_id, case_id, purge_generation FROM ${JOBS}
       WHERE stage NOT IN ('complete', 'failed') AND next_attempt_at <= ?
         AND (lease_until IS NULL OR lease_until <= ?)
       ORDER BY next_attempt_at LIMIT ?`,
    )
    .bind(now, now, limit)
    .all<{ app_id: string; case_id: string; purge_generation: number }>();
  return results.map((r) => ({
    appId: r.app_id,
    caseId: r.case_id,
    purgeGeneration: r.purge_generation,
  }));
}

export type ReceiptInput = Key & { receipt: unknown };

/**
 * Accepts a receipt produced out of band (a runner that cannot be called from the Worker).
 * Operator-only, and no more trusted than an executor result: the signature, job binding and
 * semantic checks are identical. A rejected receipt changes nothing but the audit trail.
 */
export async function submitReceipt(
  deps: ErasureDeps,
  actor: ErasureActor,
  input: ReceiptInput,
): Promise<{ accepted: true; job: JobSummary } | { accepted: false; code: string }> {
  const { id } = requireOperator(actor, input.appId);
  if (deps.config.mode !== "enforce") throw new ErasureDisabled();
  const row = await readJob(deps.db, input);
  if (!row) return { accepted: false, code: "job_not_found" };
  const claimed = isActive(row.stage) ? await claim(deps, row) : null;
  if (!claimed) return { accepted: false, code: "job_not_open" };
  const evaluated = await evaluateReceipt(deps, claimed, input.receipt);
  if (!evaluated.ok) {
    await recordRejection(deps, claimed, evaluated.code.slice(0, 64), "operator", id);
    return { accepted: false, code: evaluated.code };
  }
  const ok = await commit(deps, claimed, evaluated.event, evaluated.patch, "operator", id);
  if (!ok) return { accepted: false, code: "job_changed" };
  const job = (await drainJob(deps, input)) ?? summarize((await readJob(deps.db, input)) as JobRow);
  return { accepted: true, job };
}

/** Operator action: resumes a failed job at the stage it failed in. */
export async function reopenJob(
  deps: ErasureDeps,
  actor: ErasureActor,
  key: Key,
): Promise<JobSummary | null> {
  const { id } = requireOperator(actor, key.appId);
  if (deps.config.mode !== "enforce") throw new ErasureDisabled();
  const row = await readJob(deps.db, key);
  if (row?.stage !== "failed") return row ? summarize(row) : null;
  const claimed = await deps.db
    .prepare(
      `UPDATE ${JOBS} SET version = version + 1
       WHERE app_id = ? AND case_id = ? AND purge_generation = ? AND version = ? AND stage = 'failed'`,
    )
    .bind(row.app_id, row.case_id, row.purge_generation, row.version)
    .run();
  if (!claimed.meta.changes) return summarize((await readJob(deps.db, key)) as JobRow);
  await commit(
    deps,
    { ...row, version: row.version + 1 },
    { type: "reopened" },
    {},
    "operator",
    id,
  );
  return summarize((await readJob(deps.db, key)) as JobRow);
}

export async function getJob(
  db: D1Database,
  actor: ErasureActor,
  appId: string,
  caseId: string,
): Promise<JobSummary | null> {
  requireOperator(actor, appId);
  const row = await latestJob(db, appId, caseId);
  return row ? summarize(row) : null;
}

export type ErasureHealth = {
  mode: ErasureConfig["mode"];
  requested_mode: ErasureConfig["requestedMode"];
  config_problems: string[];
  executor_configured: boolean;
  jobs: Record<Stage, number>;
  proof: Record<Proof, number>;
  /** Not complete, and past the configured deadline. */
  overdue: number;
  /** Waiting on a missing or pending runner. */
  blocked: number;
  oldest_open_age_ms: number | null;
};

/** Aggregate counts and codes for one app; no ids, hashes or payloads. */
export async function erasureHealth(
  deps: Pick<ErasureDeps, "db" | "config" | "executor" | "now">,
  appId: string,
): Promise<ErasureHealth> {
  const now = deps.now();
  const [stages, proofs, open] = await deps.db.batch<Record<string, number | string | null>>([
    deps.db
      .prepare(`SELECT stage, count(*) AS n FROM ${JOBS} WHERE app_id = ? GROUP BY stage`)
      .bind(appId),
    deps.db
      .prepare(
        `SELECT CASE WHEN stage = 'complete' THEN 'physical_verified'
           WHEN logical_receipt_checksum IS NOT NULL THEN 'logical_only' ELSE 'none' END AS proof,
           count(*) AS n FROM ${JOBS} WHERE app_id = ? GROUP BY proof`,
      )
      .bind(appId),
    deps.db
      .prepare(
        `SELECT min(requested_at) AS oldest,
           coalesce(sum(requested_at < ?), 0) AS overdue,
           coalesce(sum(last_error_code IN ('executor_unconfigured', 'executor_pending')), 0) AS blocked
         FROM ${JOBS} WHERE app_id = ? AND stage != 'complete'`,
      )
      .bind(now - deps.config.overdueMs, appId),
  ]);
  const jobs = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const r of stages?.results ?? []) jobs[r.stage as Stage] = Number(r.n);
  const proof: Record<Proof, number> = { none: 0, logical_only: 0, physical_verified: 0 };
  for (const r of proofs?.results ?? []) proof[r.proof as Proof] = Number(r.n);
  const o = open?.results?.[0] ?? {};
  return {
    mode: deps.config.mode,
    requested_mode: deps.config.requestedMode,
    config_problems: deps.config.problems,
    executor_configured: deps.executor !== failClosedExecutor,
    jobs,
    proof,
    overdue: Number(o.overdue ?? 0),
    blocked: Number(o.blocked ?? 0),
    oldest_open_age_ms: o.oldest == null ? null : now - Number(o.oldest),
  };
}
