import { servingId } from "../lifecycle-projection/snapshot";

/**
 * Served ids of the cases whose replay log retention retired, for rebuilds to carry over. Reads
 * nothing (and so changes nothing) unless the retention tables exist and hold a retired case.
 */
export async function retiredServedIds(db: D1Database, appId: string): Promise<string[]> {
  const table = await db
    .prepare(
      "SELECT 1 AS n FROM sqlite_master WHERE type = 'table' AND name = 'lifecycle_retired_cases'",
    )
    .first();
  if (!table) return [];
  const { results } = await db
    .prepare("SELECT case_id FROM lifecycle_retired_cases WHERE app_id = ?")
    .bind(appId)
    .all<{ case_id: string }>();
  return Promise.all(results.map((r) => servingId(r.case_id)));
}
