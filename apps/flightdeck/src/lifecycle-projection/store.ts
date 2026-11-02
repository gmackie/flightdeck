import type { LifecycleRecord } from "@flightdeckhq/schema";
import { LifecycleUnavailable } from "../ingest/lifecycle";
import { parseMode } from "../lifecycle-erasure/config";
import { sinks } from "../sinks";
import { canonical } from "./identity";

/**
 * The projector's evidence log (migration 0030). Accepting a lifecycle batch appends it here and
 * queues its cases in one D1 transaction: that is the commit point. Basin forwarding happens
 * after, from the outbox columns, so an unbound or failing stream never loses an accepted event.
 */

const LOG = "lifecycle_event_log";
const QUEUE = "lifecycle_projection_queue";
const TOMBSTONES = "lifecycle_case_tombstones";
const DIAGNOSTICS = "lifecycle_projection_diagnostics";
/** Outbox rows sent per Pipelines call, and the retry backoff ceiling. */
export const FORWARD_BATCH = 100;
const MAX_BACKOFF_MS = 60 * 60_000;
const CLAIMS = "lifecycle_forward_claims";
/**
 * How long a send may hold a case before it is presumed dead. A Worker invocation cannot outlive
 * this (assumption: documented as a release gate), so an expired claim no longer blocks erasure.
 */
export const FORWARD_LEASE_MS = 15 * 60_000;
/** Tombstone reason written when retention compacts a case's replay log (not an erasure). */
export const RETIRED_REASON = "retention_expired";

export const backoff = (attempts: number) =>
  Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempts, 20));

const encoder = new TextEncoder();

/** What the producer said: receipt time and channel are not part of the event's identity. */
export async function fingerprint(row: LifecycleRecord): Promise<string> {
  const { received_at: _r, channel: _c, ...event } = row;
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical(event)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type AppendResult = {
  /** New log rows. Exact retries of stored events are not counted. */
  stored: number;
  duplicates: number;
  /** Events for erased or retention-retired cases: accepted, never stored or forwarded, counted. */
  suppressed: number;
};

/** Appends one accepted batch for `appId` and queues its cases, atomically. */
export async function appendLifecycle(
  db: D1Database,
  appId: string,
  rows: readonly LifecycleRecord[],
  now: number,
): Promise<AppendResult> {
  if (!rows.length) return { stored: 0, duplicates: 0, suppressed: 0 };
  const cases = [...new Set(rows.map((r) => r.case_id))];
  const { results: erased } = await db
    .prepare(
      `SELECT case_id, reason FROM ${TOMBSTONES} WHERE app_id = ?
       AND case_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(appId, JSON.stringify(cases))
    .all<{ case_id: string; reason: string }>();
  const gone = new Set(erased.map((e) => e.case_id));
  const retired = new Set(erased.filter((e) => e.reason === RETIRED_REASON).map((e) => e.case_id));
  const keep = rows.filter((r) => !gone.has(r.case_id));
  const suppressed = rows.length - keep.length;
  const notErased = `NOT EXISTS (SELECT 1 FROM ${TOMBSTONES} WHERE app_id = ? AND case_id = ?)`;
  const statements = await Promise.all(
    keep.map(async (r) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO ${LOG} (app_id, event_id, fingerprint, case_id, received_at,
             record_json, forward_next_at)
           SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${notErased}`,
        )
        .bind(
          appId,
          r.event_id,
          await fingerprint(r),
          r.case_id,
          r.received_at,
          JSON.stringify(r),
          now,
          appId,
          r.case_id,
        ),
    ),
  );
  for (const caseId of new Set(keep.map((r) => r.case_id))) {
    statements.push(
      db
        .prepare(
          `INSERT INTO ${QUEUE} (app_id, case_id, enqueued_seq, attempts, next_attempt_at)
           SELECT ?, ?, max(seq), 0, ? FROM ${LOG} WHERE app_id = ? AND case_id = ?
           HAVING max(seq) IS NOT NULL
           ON CONFLICT (app_id, case_id) DO UPDATE SET
             enqueued_seq = max(enqueued_seq, excluded.enqueued_seq), attempts = 0,
             next_attempt_at = excluded.next_attempt_at, last_error_code = NULL`,
        )
        .bind(appId, caseId, now, appId, caseId),
    );
  }
  const suppressedRetired = rows.filter((r) => retired.has(r.case_id)).length;
  if (suppressed - suppressedRetired) {
    statements.push(
      countAppDiagnostic(db, appId, "erased_case_event", suppressed - suppressedRetired, now),
    );
  }
  if (suppressedRetired) {
    statements.push(
      countAppDiagnostic(db, appId, "retention_expired_case_event", suppressedRetired, now),
    );
  }
  const results = await db.batch(statements);
  const stored = results.slice(0, keep.length).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  return { stored, duplicates: keep.length - stored, suppressed };
}

const countAppDiagnostic = (
  db: D1Database,
  appId: string,
  code: string,
  count: number,
  now: number,
) =>
  db
    .prepare(
      `INSERT INTO ${DIAGNOSTICS} (app_id, case_id, code, count, updated_at) VALUES (?, '', ?, ?, ?)
       ON CONFLICT (app_id, case_id, code) DO UPDATE SET count = count + excluded.count,
         updated_at = excluded.updated_at`,
    )
    .bind(appId, code, count, now);

export type LoggedEvent = { seq: number; record: LifecycleRecord };

/** Every stored row of one case, in commit order, and the highest seq among them. */
export async function caseLog(
  db: D1Database,
  appId: string,
  caseId: string,
): Promise<{ rows: LoggedEvent[]; maxSeq: number }> {
  const { results } = await db
    .prepare(`SELECT seq, record_json FROM ${LOG} WHERE app_id = ? AND case_id = ? ORDER BY seq`)
    .bind(appId, caseId)
    .all<{ seq: number; record_json: string }>();
  const rows = results.map((r) => ({ seq: r.seq, record: JSON.parse(r.record_json) }));
  return { rows, maxSeq: rows.at(-1)?.seq ?? 0 };
}

/**
 * Erases one case (operator action, e.g. a deletion request in the source system): deletes its
 * evidence, projection work, diagnostics and served snapshot, and records a tombstone so later
 * deliveries and backfills of the case are suppressed rather than resurrecting it. Basin's
 * historical copy is outside this function; see docs/operations/lifecycle-projection.md.
 */
export async function eraseCase(
  db: D1Database,
  appId: string,
  caseId: string,
  servedId: string,
  reason: string,
  now: number,
): Promise<void> {
  await db.batch(eraseCaseStatements(db, appId, caseId, servedId, reason, now));
}

/** The statements of `eraseCase`, so a caller can run them atomically with its own bookkeeping. */
export function eraseCaseStatements(
  db: D1Database,
  appId: string,
  caseId: string,
  servedId: string,
  reason: string,
  now: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO ${TOMBSTONES} (app_id, case_id, reason, erased_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (app_id, case_id) DO NOTHING`,
      )
      .bind(appId, caseId, reason, now),
    // The replay log uses producer ids while serving uses opaque ids. Record both fences
    // before deleting the log, so even a replay already held in memory is refused by D1.
    db
      .prepare(
        `INSERT INTO lifecycle_snapshot_tombstones
         (app_id, case_id, reason, source_watermark, as_of, deleted_at)
       SELECT ?, ?, 'source_erased', coalesce(max(seq), 0), ?, ? FROM ${LOG}
         WHERE app_id = ? AND case_id = ?
       ON CONFLICT (app_id, case_id) DO UPDATE SET reason = 'source_erased',
         source_watermark = max(source_watermark, excluded.source_watermark),
         as_of = max(as_of, excluded.as_of), deleted_at = excluded.deleted_at,
         restored_at = NULL, restore_reason = NULL, restore_ref = NULL`,
      )
      .bind(appId, servedId, now, now, appId, caseId),
    ...["lifecycle_case_snapshots", "lifecycle_stage_intervals"].map((table) =>
      db
        .prepare(`DELETE FROM ${table}_staging WHERE app_id = ? AND case_id = ?`)
        .bind(appId, servedId),
    ),
    db
      .prepare("DELETE FROM lifecycle_case_edges_staging WHERE app_id = ? AND from_case_id = ?")
      .bind(appId, servedId),
    db.prepare(`DELETE FROM ${LOG} WHERE app_id = ? AND case_id = ?`).bind(appId, caseId),
    db.prepare(`DELETE FROM ${QUEUE} WHERE app_id = ? AND case_id = ?`).bind(appId, caseId),
    db.prepare(`DELETE FROM ${DIAGNOSTICS} WHERE app_id = ? AND case_id = ?`).bind(appId, caseId),
    db
      .prepare("DELETE FROM lifecycle_stage_intervals WHERE app_id = ? AND case_id = ?")
      .bind(appId, servedId),
    db
      .prepare("DELETE FROM lifecycle_case_edges WHERE app_id = ? AND from_case_id = ?")
      .bind(appId, servedId),
    db
      .prepare("DELETE FROM lifecycle_case_snapshots WHERE app_id = ? AND case_id = ?")
      .bind(appId, servedId),
  ];
}

export type ForwardResult = { sent: number; failed: number; pending: number; bound: boolean };

/**
 * Sends unforwarded log rows to the Basin stream, oldest first. Unbound: nothing is attempted
 * and the rows stay pending (visible in diagnostics). A failed send is retried with backoff.
 * `only` restricts the pass to some event ids (the batch just accepted).
 */
export async function forwardOutbox(
  env: Env,
  now: number,
  only?: { appId: string; eventIds: string[] },
): Promise<ForwardResult> {
  // The writer fence exists only while erasure is enabled, so the default path is unchanged.
  if (parseMode((env as { LIFECYCLE_ERASURE_MODE?: unknown }).LIFECYCLE_ERASURE_MODE) === "off") {
    return forwardBatch(env, now, only, null);
  }
  const claimId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const started = Date.now();
  try {
    return await forwardBatch(env, now, only, claimId);
  } finally {
    // Released after the send returns or fails; a sender that died is covered by the lease.
    await env.DB.prepare(`UPDATE ${CLAIMS} SET released_at = ? WHERE claim_id = ?`)
      .bind(now + (Date.now() - started), claimId)
      .run()
      .catch(() => undefined);
  }
}

/**
 * Claims the cases of `rows` for this send, refusing tombstoned ones in the same statement, and
 * returns the claimed case keys. Erasure tombstones a case first and then waits for live claims
 * on it, so a row is either dropped here or its sender is waited for.
 */
async function claimCases(
  env: Env,
  claimId: string,
  rows: { app_id: string; case_id: string }[],
  now: number,
) {
  const cases = new Map(rows.map((r) => [`${r.app_id}\u0000${r.case_id}`, r]));
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM ${CLAIMS} WHERE coalesce(released_at, lease_until) < ?`).bind(
      now - 2 * 24 * 60 * 60_000,
    ),
    ...[...cases.values()].map((c) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO ${CLAIMS} (claim_id, app_id, case_id, claimed_at, lease_until)
         SELECT ?1, ?2, ?3, ?4, ?5 WHERE NOT EXISTS (
           SELECT 1 FROM ${TOMBSTONES} WHERE app_id = ?2 AND case_id = ?3)`,
      ).bind(claimId, c.app_id, c.case_id, now, now + FORWARD_LEASE_MS),
    ),
  ]);
  const { results } = await env.DB.prepare(
    `SELECT app_id, case_id FROM ${CLAIMS} WHERE claim_id = ?`,
  )
    .bind(claimId)
    .all<{ app_id: string; case_id: string }>();
  return new Set(results.map((r) => `${r.app_id}\u0000${r.case_id}`));
}

async function forwardBatch(
  env: Env,
  now: number,
  only: { appId: string; eventIds: string[] } | undefined,
  claimId: string | null,
): Promise<ForwardResult> {
  const filter = only
    ? "AND app_id = ? AND event_id IN (SELECT value FROM json_each(?))"
    : "AND forward_next_at <= ?";
  const binds = only ? [only.appId, JSON.stringify(only.eventIds)] : [now];
  const { results } = await env.DB.prepare(
    `SELECT seq, app_id, case_id, forward_attempts, record_json FROM ${LOG}
     WHERE forwarded_at IS NULL ${filter} ORDER BY seq LIMIT ?`,
  )
    .bind(...binds, FORWARD_BATCH)
    .all<{
      seq: number;
      app_id: string;
      case_id: string;
      forward_attempts: number;
      record_json: string;
    }>();
  if (claimId && results.length) {
    // Rows of a case erased since the read are dropped here, not sent.
    const claimed = await claimCases(env, claimId, results, now);
    for (let i = results.length - 1; i >= 0; i--) {
      const r = results[i];
      if (r && !claimed.has(`${r.app_id}\u0000${r.case_id}`)) results.splice(i, 1);
    }
  }
  if (!results.length) return { sent: 0, failed: 0, pending: 0, bound: true };
  const seqs = JSON.stringify(results.map((r) => r.seq));
  try {
    await sinks.lifecycle(
      env,
      results.map((r) => JSON.parse(r.record_json)),
    );
  } catch (error) {
    // Not provisioned yet: an operator action, not a delivery failure, so no backoff.
    if (error instanceof LifecycleUnavailable) {
      return { sent: 0, failed: 0, pending: results.length, bound: false };
    }
    const attempts = Math.max(...results.map((r) => r.forward_attempts)) + 1;
    await env.DB.prepare(
      `UPDATE ${LOG} SET forward_attempts = forward_attempts + 1, forward_next_at = ?,
         forward_error = 'send_failed' WHERE seq IN (SELECT value FROM json_each(?))`,
    )
      .bind(now + backoff(attempts), seqs)
      .run();
    return { sent: 0, failed: results.length, pending: results.length, bound: true };
  }
  await env.DB.prepare(
    `UPDATE ${LOG} SET forwarded_at = ?, forward_error = NULL
     WHERE seq IN (SELECT value FROM json_each(?))`,
  )
    .bind(now, seqs)
    .run();
  return { sent: results.length, failed: 0, pending: 0, bound: true };
}
