import { env } from "cloudflare:workers";
import { digest } from "../../src/lifecycle-privacy/guard";

/** Synthetic operator provisioning only: never inferred from request metadata or process names. */
export async function approveAggregate(app: string, process: string, classification = "aggregate") {
  const row = await env.DB.prepare(`SELECT definition FROM process_definitions
    WHERE app_id = ? AND process_id = ? AND version = 1`)
    .bind(app, process)
    .first<{ definition: string }>();
  if (!row) throw new Error("missing synthetic definition");
  await env.DB.prepare(`INSERT OR REPLACE INTO lifecycle_privacy_processes
    (app_id, process_id, version, definition_hash, classification, review_id, restricted_approved)
    VALUES (?, ?, 1, ?, ?, 'synthetic_review', 0)`)
    .bind(app, process, await digest(row.definition), classification)
    .run();
}
export async function budgets(app: string, appCount = 100, principalCount = 1000) {
  for (const [kind, scope, count] of [
    ["app", app, appCount],
    ["principal", "global", principalCount],
  ] as const)
    await env.DB.prepare(`INSERT OR REPLACE INTO lifecycle_privacy_limits
      (kind, scope, query_count, row_budget, scan_budget, time_budget_ms)
      VALUES (?, ?, ?, 11000000, 1000000000, 3600000)`)
      .bind(kind, scope, count)
      .run();
}
