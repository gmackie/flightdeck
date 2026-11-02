import { servingId } from "../lifecycle-projection/snapshot";
import { RETIRED_REASON } from "../lifecycle-projection/store";
import type { RetentionConfig } from "./config";
import { type ErasureActor, requireOperator } from "./jobs";
import { authenticate, type ReceiptVerifier, sha256Hex } from "./receipt";

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
  /** False when the app has more cases than one run examines (the report covers the first SCAN_CAP). */
  scan_complete: boolean;
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
      `SELECT reconciled_through_seq AS through, verified_at, scan_cursor AS cursor
       FROM lifecycle_retention_checkpoints WHERE app_id = ?`,
    )
    .bind(appId)
    .first<{ through: number; verified_at: number; cursor: string }>();
}

/** Cases examined per page, and the most examined in one run (bounds D1 work per invocation). */
const PAGE = 200;
export const SCAN_CAP = 2000;

type Verdict = { c: Candidate; reason: BlockReason | null };

/** Classifies a page of cases, in order. `reason` null means eligible. */
async function classifyCases(
  deps: Deps,
  appId: string,
  results: CaseRow[],
  checkpoint: { through: number } | null,
): Promise<Verdict[]> {
  const { db, config } = deps;
  const now = deps.now();
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
  return cases.map((c) => {
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
    return { c, reason };
  });
}

/**
 * Walks the app's cases in id order from `after`, a page at a time, until `stopAt` eligible cases
 * are found, `SCAN_CAP` are examined, or the end. Blocked cases consume scan budget, not batch
 * slots, and the returned cursor resumes right after the last case looked at, so a case that is
 * blocked for good can never hide the ones behind it.
 */
async function scan(deps: Deps, appId: string, after: string, stopAt: number | null) {
  const checkpoint = await checkpointOf(deps.db, appId);
  const eligible: Candidate[] = [];
  const blocked = emptyBlocked();
  let cursor = after;
  let examined = 0;
  let exhausted = false;
  scanning: while (examined < SCAN_CAP) {
    const limit = Math.min(PAGE, SCAN_CAP - examined);
    const { results } = await deps.db
      .prepare(
        `SELECT case_id, max(seq) AS max_seq, count(*) AS events, sum(length(record_json)) AS bytes,
           max(received_at) AS newest, sum(forwarded_at IS NULL) AS unforwarded
         FROM ${LOG} l WHERE app_id = ?1 AND case_id > ?2 AND NOT EXISTS (
           SELECT 1 FROM lifecycle_case_tombstones t WHERE t.app_id = ?1 AND t.case_id = l.case_id)
         GROUP BY case_id ORDER BY case_id LIMIT ?3`,
      )
      .bind(appId, cursor, limit)
      .all<CaseRow>();
    for (const { c, reason } of await classifyCases(deps, appId, results, checkpoint)) {
      examined += 1;
      cursor = c.case_id;
      if (reason) blocked[reason] += 1;
      else eligible.push(c);
      if (stopAt !== null && eligible.length >= stopAt) break scanning;
    }
    if (results.length < limit) {
      exhausted = true;
      break;
    }
  }
  return { eligible, blocked, checkpoint, examined, exhausted, cursor: exhausted ? "" : cursor };
}

/** Dry-run and impact report. Read-only, in every mode, and never lists ids. */
export async function inspectRetention(deps: Deps, appId: string): Promise<RetentionReport> {
  const now = deps.now();
  const [{ examined, eligible, blocked, checkpoint, exhausted }, totals, retired] =
    await Promise.all([
      scan(deps, appId, "", null),
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
    scanned_cases: examined,
    scan_complete: exhausted,
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
  const start = await checkpointOf(deps.db, appId);
  if (!start) return none; // nothing is covered by a verified reconciliation yet
  const { eligible, cursor } = await scan(deps, appId, start.cursor, deps.config.batch);
  const now = deps.now();
  const { db, config } = deps;
  let retired = 0;
  let events = 0;
  for (const c of eligible) {
    // Same conditions as classifyCases(), evaluated inside the transaction.
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
  // Resume after the last case looked at next time, so blocked cases cannot hold up later ones.
  await db
    .prepare("UPDATE lifecycle_retention_checkpoints SET scan_cursor = ? WHERE app_id = ?")
    .bind(cursor, appId)
    .run();
  return { retired_cases: retired, retired_events: events, skipped: eligible.length - retired };
}

/** Most rows one attestation may cover; larger ranges are attested in steps. */
export const MAX_RECONCILE_ROWS = 20_000;
const DIGEST_PAGE = 500;

/** Highest `lifecycle_event_log.seq` ever allocated. Never goes down, even when rows are deleted. */
export async function allocatedSeq(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'lifecycle_event_log'")
    .first<{ seq: number }>();
  return row?.seq ?? 0;
}

/**
 * Immutable evidence for the app's log rows in (after, through]: how many, whether any is still
 * unforwarded, and a hash chain over `seq|event_id|fingerprint` in seq order, a page of 500 at a
 * time: h0 = sha256("flightdeck.reconcile.v1|<app>|<after>|<through>"), then
 * h = sha256(h + "\n" + page lines). A runner computes the same chain over what Basin holds.
 */
export async function rowsDigest(db: D1Database, appId: string, after: number, through: number) {
  let digest = await sha256Hex(`flightdeck.reconcile.v1|${appId}|${after}|${through}`);
  let count = 0;
  let unforwarded = 0;
  let cursor = after;
  while (count <= MAX_RECONCILE_ROWS) {
    const { results } = await db
      .prepare(
        `SELECT seq, event_id, fingerprint, forwarded_at IS NULL AS pending FROM ${LOG}
         WHERE app_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`,
      )
      .bind(appId, cursor, through, DIGEST_PAGE)
      .all<{ seq: number; event_id: string; fingerprint: string; pending: number }>();
    if (!results.length) break;
    digest = await sha256Hex(
      `${digest}\n${results.map((r) => `${r.seq}|${r.event_id}|${r.fingerprint}`).join("\n")}`,
    );
    count += results.length;
    unforwarded += results.reduce((n, r) => n + r.pending, 0);
    cursor = results[results.length - 1]?.seq ?? through;
    if (results.length < DIGEST_PAGE) break;
  }
  return { count, digest, unforwarded };
}

/**
 * Records that Basin was confirmed to hold the app's log rows in (after_seq, through_seq].
 * Operator only, and only from a signed attestation that is checked against D1 right now:
 *  - the range cannot extend past the highest seq ever allocated, so a checkpoint can never cover
 *    rows that do not exist yet (an empty app's checkpoint covers nothing that arrives later);
 *  - it must start at or below the current checkpoint (no unattested gap) and must advance it;
 *  - the row count AND the digest of exactly those rows must match, and none may be unforwarded.
 * Retention retires nothing beyond the checkpoint.
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
  const allocated = await allocatedSeq(deps.db);
  if (r.through_seq > allocated || r.allocated_seq > allocated) {
    return { recorded: false, code: "receipt_reconciliation_future" };
  }
  if (r.through_seq < r.after_seq || r.allocated_seq < r.through_seq) {
    return { recorded: false, code: "receipt_malformed" };
  }
  const current = await checkpointOf(deps.db, appId);
  if (r.after_seq > (current?.through ?? 0)) {
    return { recorded: false, code: "receipt_reconciliation_gap" };
  }
  if (current && r.through_seq <= current.through) {
    return { recorded: false, code: "checkpoint_not_advanced" };
  }
  const evidence = await rowsDigest(deps.db, appId, r.after_seq, r.through_seq);
  if (evidence.count > MAX_RECONCILE_ROWS) {
    return { recorded: false, code: "reconciliation_range_too_large" };
  }
  // Rows erased, retired or changed since the attestation make this differ: attest again.
  if (
    evidence.count !== r.event_count ||
    evidence.digest !== r.rows_digest ||
    evidence.unforwarded > 0
  ) {
    return { recorded: false, code: "receipt_reconciliation_mismatch" };
  }
  await deps.db
    .prepare(
      `INSERT INTO lifecycle_retention_checkpoints
         (app_id, reconciled_through_seq, allocated_seq, rows_digest, verified_at, evidence_checksum, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5)
       ON CONFLICT (app_id) DO UPDATE SET reconciled_through_seq = excluded.reconciled_through_seq,
         allocated_seq = excluded.allocated_seq, rows_digest = excluded.rows_digest,
         verified_at = excluded.verified_at, evidence_checksum = excluded.evidence_checksum,
         updated_at = excluded.updated_at
       WHERE excluded.reconciled_through_seq > reconciled_through_seq`,
    )
    .bind(appId, r.through_seq, r.allocated_seq, r.rows_digest, now, parsed.checksum)
    .run();
  return { recorded: true, reconciled_through_seq: r.through_seq };
}
