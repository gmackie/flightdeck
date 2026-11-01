/** Projection health for one app: aggregate counts and codes only, never ids or payloads. */
export type ProjectionDiagnostics = {
  projection: {
    status: string;
    active_generation: number;
    building_generation: number | null;
    reducer_version: string | null;
    last_success_at: number | null;
    last_failure_at: number | null;
    last_error_code: string | null;
  } | null;
  queue: {
    pending_cases: number;
    retrying_cases: number;
    oldest_pending_seq: number | null;
    error_codes: { code: string; cases: number }[];
  };
  event_log: { events: number; unforwarded: number; forward_failures: number };
  /** Engine and adapter codes summed over cases (see vocabulary.ts ADAPTER_CODES). */
  diagnostics: { code: string; count: number }[];
};

export async function projectionDiagnostics(
  db: D1Database,
  appId: string,
): Promise<ProjectionDiagnostics> {
  const [state, queue, errors, log, codes] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT status, active_generation, building_generation, reducer_version, last_success_at,
           last_failure_at, last_error_code FROM lifecycle_projection_state WHERE app_id = ?`,
      )
      .bind(appId),
    db
      .prepare(
        `SELECT count(*) AS pending, sum(attempts > 0) AS retrying, min(enqueued_seq) AS oldest
         FROM lifecycle_projection_queue WHERE app_id = ?`,
      )
      .bind(appId),
    db
      .prepare(
        `SELECT last_error_code AS code, count(*) AS cases FROM lifecycle_projection_queue
         WHERE app_id = ? AND last_error_code IS NOT NULL GROUP BY last_error_code ORDER BY code`,
      )
      .bind(appId),
    db
      .prepare(
        `SELECT count(*) AS events, sum(forwarded_at IS NULL) AS unforwarded,
           sum(forward_error IS NOT NULL) AS failures FROM lifecycle_event_log WHERE app_id = ?`,
      )
      .bind(appId),
    db
      .prepare(
        `SELECT code, sum(count) AS count FROM lifecycle_projection_diagnostics WHERE app_id = ?
         GROUP BY code ORDER BY code`,
      )
      .bind(appId),
  ]);
  const one = <T>(r: D1Result<Record<string, unknown>> | undefined) =>
    (r?.results?.[0] ?? null) as T | null;
  const q = one<{ pending: number; retrying: number | null; oldest: number | null }>(queue);
  const l = one<{ events: number; unforwarded: number | null; failures: number | null }>(log);
  return {
    projection: one<NonNullable<ProjectionDiagnostics["projection"]>>(state),
    queue: {
      pending_cases: q?.pending ?? 0,
      retrying_cases: q?.retrying ?? 0,
      oldest_pending_seq: q?.oldest ?? null,
      error_codes: (errors?.results ?? []) as { code: string; cases: number }[],
    },
    event_log: {
      events: l?.events ?? 0,
      unforwarded: l?.unforwarded ?? 0,
      forward_failures: l?.failures ?? 0,
    },
    diagnostics: (codes?.results ?? []) as { code: string; count: number }[],
  };
}
