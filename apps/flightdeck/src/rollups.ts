import type { HourRollup } from "./do/app";

/** D1 binds at most 100 parameters per statement; five per row leaves room for 20 rows. */
const ROWS_PER_INSERT = 20;

/**
 * Replaces one app-hour in the warm tier (migration 0004). The delete and inserts run in one
 * batch, which D1 executes as a transaction, so re-flushing an hour overwrites it atomically.
 */
export async function writeHourlyRollup(
  db: D1Database,
  appId: string,
  hour: string,
  rollup: HourRollup,
): Promise<void> {
  const statements = [
    db.prepare("DELETE FROM hourly_rollups WHERE app_id = ? AND hour = ?").bind(appId, hour),
  ];
  for (let i = 0; i < rollup.counters.length; i += ROWS_PER_INSERT) {
    const chunk = rollup.counters.slice(i, i + ROWS_PER_INSERT);
    statements.push(
      db
        .prepare(
          `INSERT INTO hourly_rollups (app_id, hour, kind, name, count) VALUES ${chunk
            .map(() => "(?, ?, ?, ?, ?)")
            .join(", ")}`,
        )
        .bind(...chunk.flatMap((c) => [appId, hour, c.kind, c.name, c.count])),
    );
  }
  statements.push(
    db
      .prepare(
        "INSERT INTO hourly_sessions (app_id, hour, sessions) VALUES (?, ?, ?) ON CONFLICT (app_id, hour) DO UPDATE SET sessions = excluded.sessions",
      )
      .bind(appId, hour, rollup.sessions),
  );
  await db.batch(statements);
}
