import type { LifecycleRecord } from "@flightdeckhq/schema";
import { LifecycleUnavailable } from "../ingest/lifecycle";
import { sinks } from "../sinks";

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

export const backoff = (attempts: number) =>
  Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempts, 20));

const encoder = new TextEncoder();

/** Canonical JSON: sorted keys, so equal payloads serialize identically. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

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
  /** Events for erased cases: accepted, never stored or forwarded, and counted. */
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
      `SELECT case_id FROM ${TOMBSTONES} WHERE app_id = ?
       AND case_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(appId, JSON.stringify(cases))
    .all<{ case_id: string }>();
  const gone = new Set(erased.map((e) => e.case_id));
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
  if (suppressed)
    statements.push(countAppDiagnostic(db, appId, "erased_case_event", suppressed, now));
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
  await db.batch([
    db
      .prepare(
        `INSERT INTO ${TOMBSTONES} (app_id, case_id, reason, erased_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (app_id, case_id) DO NOTHING`,
      )
      .bind(appId, caseId, reason, now),
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
  ]);
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
  const filter = only
    ? "AND app_id = ? AND event_id IN (SELECT value FROM json_each(?))"
    : "AND forward_next_at <= ?";
  const binds = only ? [only.appId, JSON.stringify(only.eventIds)] : [now];
  const { results } = await env.DB.prepare(
    `SELECT seq, forward_attempts, record_json FROM ${LOG}
     WHERE forwarded_at IS NULL ${filter} ORDER BY seq LIMIT ?`,
  )
    .bind(...binds, FORWARD_BATCH)
    .all<{ seq: number; forward_attempts: number; record_json: string }>();
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
