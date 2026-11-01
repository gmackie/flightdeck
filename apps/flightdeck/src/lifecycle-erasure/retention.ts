import { servingId } from "../lifecycle-projection/snapshot";
import { RETIRED_REASON } from "../lifecycle-projection/store";
import type { RetentionConfig } from "./config";
import { type ErasureActor, requireOperator } from "./jobs";
import { authenticate, type ReceiptVerifier } from "./receipt";

/**
 * D1 retention for the replay log (`lifecycle_event_log`), default OFF.
 *
 * The log is the projector's rebuild input and, until Basin is confirmed to hold a row, possibly
 * the only copy, so a case's rows are retired only when ALL of these hold (and re-checked inside
 * the deleting transaction, so concurrent ingest cannot slip past them):
 *   - the case is closed in the committed read-model generation, past `closedAfterMs`, and the
 *     snapshot reflects every one of its log rows (source_watermark >= its newest seq);
 *   - its newest row is older than `logAfterMs`, and nothing is queued for it;
 *   - every row is forwarded to Basin AND at or below a signed reconciliation checkpoint;
 *   - it carries no tombstone (erased cases are already gone; retired ones are done).
 * Retirement is whole-case (replay needs full history), physical in D1, and leaves a
 * `retention_expired` tombstone, so a late event, retry or backfill is suppressed instead of
 * resurrecting a partial case. It does not touch Basin, the served snapshot, or D1 backups. It is
 * not erasure: nothing here claims data was deleted from Basin.
 */

const LOG = "lifecycle_event_log";

export type BlockReason =
  | "not_closed"
  | "not_projected"
  | "too_recent"
  | "queued"
  | "not_forwarded"
  | "beyond_checkpoint";

type CaseRow = {
  case_id: string;
  max_seq: number;
  events: number;
  bytes: number;
  newest: number;
  unforwarded: number;
};

type Candidate = CaseRow & { served: string };

export type RetentionReport = {
  mode: RetentionConfig["mode"];
  requested_mode: RetentionConfig["requestedMode"];
  config_problems: string[];
  policy_version: string;
  checkpoint: { reconciled_through_seq: number; verified_at: number; age_ms: number } | null;
  log: { events: number; cases: number; bytes: number };
  /** Cases examined this run: the oldest `batch` cases of the app. */
  scanned_cases: number;
  eligible: { cases: number; events: number; bytes: number };
  blocked: Record<BlockReason, number>;
  retired_cases: number;
};

type Deps = { db: D1Database; config: RetentionConfig; now: () => number };

const emptyBlocked = (): Record<BlockReason, number> => ({
  not_closed: 0,
  not_projected: 0,
  too_recent: 0,
  queued: 0,
  not_forwarded: 0,
  beyond_checkpoint: 0,
});

async function checkpointOf(db: D1Database, appId: string) {
  return db
    .prepare(
      "SELECT reconciled_through_seq AS through, verified_at FROM lifecycle_retention_checkpoints WHERE app_id = ?",
    )
    .bind(appId)
    .first<{ through: number; verified_at: number }>();
}

async function classify(deps: Deps, appId: string) {
  const { db, config } = deps;
  const now = deps.now();
  const checkpoint = await checkpointOf(db, appId);
  const { results } = await db
    .prepare(
      `SELECT case_id, max(seq) AS max_seq, count(*) AS events, sum(length(record_json)) AS bytes,
         max(received_at) AS newest, sum(forwarded_at IS NULL) AS unforwarded
       FROM ${LOG} l WHERE app_id = ?1 AND NOT EXISTS (
         SELECT 1 FROM lifecycle_case_tombstones t WHERE t.app_id = ?1 AND t.case_id = l.case_id)
       GROUP BY case_id ORDER BY min(seq) LIMIT ?2`,
    )
    .bind(appId, config.batch)
    .all<CaseRow>();
  const cases: Candidate[] = await Promise.all(
    results.map(async (r) => ({ ...r, served: await servingId(r.case_id) })),
  );
  const ids = JSON.stringify(cases.map((c) => c.served));
  const raw = JSON.stringify(cases.map((c) => c.case_id));
  const [snapshots, queued, state] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT case_id, status, ended_at, deleted_at, generation, source_watermark
         FROM lifecycle_case_snapshots WHERE app_id = ? AND case_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(appId, ids),
    db
      .prepare(
        `SELECT case_id FROM lifecycle_projection_queue WHERE app_id = ?
         AND case_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(appId, raw),
    db
      .prepare("SELECT status, active_generation FROM lifecycle_projection_state WHERE app_id = ?")
      .bind(appId),
  ]);
  const snap = new Map(
    (
      (snapshots?.results ?? []) as {
        case_id: string;
        status: string;
        ended_at: number | null;
        deleted_at: number | null;
        generation: number;
        source_watermark: number;
      }[]
    ).map((s) => [s.case_id, s]),
  );
  const queuedIds = new Set(
    ((queued?.results ?? []) as { case_id: string }[]).map((q) => q.case_id),
  );
  const projection = (state?.results?.[0] ?? null) as {
    status: string;
    active_generation: number;
  } | null;
  const eligible: Candidate[] = [];
  const blocked = emptyBlocked();
  for (const c of cases) {
    const s = snap.get(c.served);
    let reason: BlockReason | null = null;
    if (
      !s ||
      s.deleted_at !== null ||
      !projection ||
      projection.status !== "ready" ||
      s.generation !== projection.active_generation ||
      s.source_watermark < c.max_seq
    )
      reason = "not_projected";
    else if (
      s.status !== "closed" ||
      s.ended_at === null ||
      s.ended_at > now - config.closedAfterMs
    )
      reason = "not_closed";
    else if (c.newest > now - config.logAfterMs) reason = "too_recent";
    else if (queuedIds.has(c.case_id)) reason = "queued";
    else if (c.unforwarded > 0) reason = "not_forwarded";
    else if (!checkpoint || c.max_seq > checkpoint.through) reason = "beyond_checkpoint";
    if (reason) blocked[reason] += 1;
    else eligible.push(c);
  }
  return { cases, eligible, blocked, checkpoint };
}

/** Dry-run and impact report. Read-only, in every mode, and never lists ids. */
export async function inspectRetention(deps: Deps, appId: string): Promise<RetentionReport> {
  const now = deps.now();
  const [{ cases, eligible, blocked, checkpoint }, totals, retired] = await Promise.all([
    classify(deps, appId),
    deps.db
      .prepare(
        `SELECT count(*) AS events, count(DISTINCT case_id) AS cases, coalesce(sum(length(record_json)), 0) AS bytes
         FROM ${LOG} WHERE app_id = ?`,
      )
      .bind(appId)
      .first<{ events: number; cases: number; bytes: number }>(),
    deps.db
      .prepare("SELECT count(*) AS n FROM lifecycle_retired_cases WHERE app_id = ?")
      .bind(appId)
      .first<{ n: number }>(),
  ]);
  return {
    mode: deps.config.mode,
    requested_mode: deps.config.requestedMode,
    config_problems: deps.config.problems,
    policy_version: deps.config.policyVersion,
    checkpoint: checkpoint
      ? {
          reconciled_through_seq: checkpoint.through,
          verified_at: checkpoint.verified_at,
          age_ms: now - checkpoint.verified_at,
        }
      : null,
    log: { events: totals?.events ?? 0, cases: totals?.cases ?? 0, bytes: totals?.bytes ?? 0 },
    scanned_cases: cases.length,
    eligible: {
      cases: eligible.length,
      events: eligible.reduce((n, c) => n + c.events, 0),
      bytes: eligible.reduce((n, c) => n + c.bytes, 0),
    },
    blocked,
    retired_cases: retired?.n ?? 0,
  };
}

export type RetentionRun = { retired_cases: number; retired_events: number; skipped: number };

/**
 * Retires eligible cases. Does nothing unless the mode is "enforce". Every statement carries the
 * eligibility guard again, so a case that changed since it was classified is left untouched.
 */
export async function applyRetention(deps: Deps, appId: string): Promise<RetentionRun> {
  const none = { retired_cases: 0, retired_events: 0, skipped: 0 };
  if (deps.config.mode !== "enforce") return none;
  const { eligible } = await classify(deps, appId);
  const now = deps.now();
  const { db, config } = deps;
  let retired = 0;
  let events = 0;
  for (const c of eligible) {
    // Same conditions as classify(), evaluated inside the transaction.
    const guard = `
      NOT EXISTS (SELECT 1 FROM ${LOG} WHERE app_id = ?1 AND case_id = ?2
        AND (seq > ?3 OR forwarded_at IS NULL OR received_at > ?4))
      AND NOT EXISTS (SELECT 1 FROM lifecycle_projection_queue WHERE app_id = ?1 AND case_id = ?2)
      AND NOT EXISTS (SELECT 1 FROM lifecycle_case_tombstones WHERE app_id = ?1 AND case_id = ?2)
      AND coalesce((SELECT reconciled_through_seq FROM lifecycle_retention_checkpoints WHERE app_id = ?1), -1) >= ?3
      AND EXISTS (SELECT 1 FROM lifecycle_case_snapshots s
        JOIN lifecycle_projection_state p ON p.app_id = s.app_id
        WHERE s.app_id = ?1 AND s.case_id = ?5 AND s.status = 'closed' AND s.deleted_at IS NULL
          AND s.ended_at <= ?6 AND p.status = 'ready' AND s.generation = p.active_generation
          AND s.source_watermark >= ?3)`;
    const binds = [
      appId,
      c.case_id,
      c.max_seq,
      now - config.logAfterMs,
      c.served,
      now - config.closedAfterMs,
    ];
    const retiredHere = `EXISTS (SELECT 1 FROM lifecycle_case_tombstones WHERE app_id = ?1 AND case_id = ?2
      AND reason = '${RETIRED_REASON}' AND erased_at = ?7)`;
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO lifecycle_case_tombstones (app_id, case_id, reason, erased_at)
           SELECT ?1, ?2, '${RETIRED_REASON}', ?7 WHERE ${guard}`,
        )
        .bind(...binds, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO lifecycle_retired_cases (app_id, case_id, policy_version, rows_removed, retired_at)
           SELECT ?1, ?2, ?8, (SELECT count(*) FROM ${LOG} WHERE app_id = ?1 AND case_id = ?2), ?7
           WHERE ${retiredHere}`,
        )
        .bind(appId, c.case_id, c.max_seq, 0, c.served, 0, now, config.policyVersion),
      db
        .prepare(`DELETE FROM ${LOG} WHERE app_id = ?1 AND case_id = ?2 AND ${retiredHere}`)
        .bind(appId, c.case_id, c.max_seq, 0, c.served, 0, now),
      db
        .prepare(
          `DELETE FROM lifecycle_projection_diagnostics WHERE app_id = ?1 AND case_id = ?2 AND ${retiredHere}`,
        )
        .bind(appId, c.case_id, c.max_seq, 0, c.served, 0, now),
    ]);
    if (results[0]?.meta.changes) {
      retired += 1;
      events += results[2]?.meta.changes ?? 0;
    }
  }
  return { retired_cases: retired, retired_events: events, skipped: eligible.length - retired };
}

export class RetentionInvalid extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RetentionInvalid";
  }
}

/**
 * Records that Basin was confirmed to hold every log row of the app up to `through_seq`. Operator
 * only, and only from a signed attestation whose count matches D1 now; the checkpoint never
 * moves backwards. Retention retires nothing beyond it.
 */
export async function recordReconciliation(
  deps: Deps & { verifier: ReceiptVerifier },
  actor: ErasureActor,
  appId: string,
  signed: unknown,
): Promise<{ recorded: true; reconciled_through_seq: number } | { recorded: false; code: string }> {
  requireOperator(actor, appId);
  const parsed = await authenticate(signed, "basin_reconciliation", deps.verifier);
  if (!parsed.ok) return { recorded: false, code: parsed.code };
  const r = parsed.receipt;
  const now = deps.now();
  if (r.app_id !== appId) return { recorded: false, code: "receipt_wrong_job" };
  if (r.issued_at > now + 5 * 60_000) return { recorded: false, code: "receipt_from_future" };
  const row = await deps.db
    .prepare(
      `SELECT count(*) AS events, coalesce(sum(forwarded_at IS NULL), 0) AS unforwarded
       FROM ${LOG} WHERE app_id = ? AND seq <= ?`,
    )
    .bind(appId, r.through_seq)
    .first<{ events: number; unforwarded: number }>();
  // Rows erased or retired since the attestation make the counts differ: re-run reconciliation.
  if (!row || row.events !== r.event_count || row.unforwarded > 0) {
    return { recorded: false, code: "receipt_reconciliation_mismatch" };
  }
  await deps.db
    .prepare(
      `INSERT INTO lifecycle_retention_checkpoints (app_id, reconciled_through_seq, verified_at, evidence_checksum, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?3)
       ON CONFLICT (app_id) DO UPDATE SET reconciled_through_seq = excluded.reconciled_through_seq,
         verified_at = excluded.verified_at, evidence_checksum = excluded.evidence_checksum,
         updated_at = excluded.updated_at
       WHERE excluded.reconciled_through_seq >= reconciled_through_seq`,
    )
    .bind(appId, r.through_seq, now, parsed.checksum)
    .run();
  return { recorded: true, reconciled_through_seq: r.through_seq };
}
