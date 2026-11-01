import type { LifecycleReadRequest } from "@flightdeckhq/schema";
import type { AccessPrincipal } from "../access";
import { BadQuery, decodeCursor, encodeCursor } from "../lifecycle-serving/params";
import { caseDetail, listProcesses, type ProcessDefinition } from "../lifecycle-serving/read";

const MAX_CASES = 1000;
const MAX_INTERVALS = 10_000;
const unavailable = (): never => {
  throw new Error("unsupported or unavailable read model");
};

/** Bounded, authenticated grant expansion; no global grants or existence probes. */
export async function readGrants(db: D1Database, p: AccessPrincipal) {
  const { results } = await db
    .prepare(`SELECT DISTINCT a.id AS appId, g.role, g.expires_at AS expiresAt
    FROM authz_grants g JOIN apps a ON g.app_id = a.id OR EXISTS
      (SELECT 1 FROM authz_app_projects ap WHERE ap.app_id = a.id AND ap.project_id = g.project_id)
    WHERE g.principal_kind = ? AND g.principal_subject = ? AND g.revoked_at IS NULL
      AND (g.expires_at IS NULL OR g.expires_at > ?)
      AND (? = 0 OR (g.role = 'reader' AND g.app_id = a.id))
    ORDER BY a.id, g.role LIMIT 257`)
    .bind(p.serviceToken ? "service" : "person", p.sub, Date.now(), p.serviceToken ? 1 : 0)
    .all<{ appId: string; role: string; expiresAt: number | null }>();
  if (results.length > 256) unavailable();
  return results;
}

async function metadata(db: D1Database, appId: string) {
  const state = await db
    .prepare(`SELECT active_generation, status, source_watermark, as_of, reducer_version
    FROM lifecycle_projection_state WHERE app_id = ?`)
    .bind(appId)
    .first<{
      active_generation: number;
      status: "ready" | "empty" | "failed" | "rebuilding";
      source_watermark: number | null;
      as_of: number | null;
      reducer_version: string | null;
    }>();
  // Do not return empty successes for an unprojected or partially rebuilding source.
  if (
    !state ||
    state.as_of === null ||
    state.source_watermark === null ||
    !state.active_generation ||
    state.status !== "ready"
  )
    return unavailable();
  const pending = await db
    .prepare("SELECT case_id FROM lifecycle_projection_queue WHERE app_id = ? LIMIT 1")
    .bind(appId)
    .first();
  if (pending) return unavailable();
  const lag = Math.max(0, Date.now() - state.as_of);
  return {
    as_of: state.as_of,
    freshness: {
      status: lag > 900_000 ? ("stale" as const) : ("fresh" as const),
      watermark: null,
      lag_ms: null,
    },
    source_version: "lifecycle-d1-rpc@1",
    projection: {
      source_watermark: state.source_watermark,
      generation: state.active_generation,
      status: state.status,
      lag_ms: lag,
    },
  };
}

function definition(row: ProcessDefinition) {
  return {
    workflow_key: row.process_key,
    version: row.version,
    label: row.label,
    description: "" as const,
    stages: row.stages.map((s, order) => ({ ...s, order })),
    outcomes: [],
    dimensions: [],
    published_at: row.as_of,
  };
}

export async function executeRead(
  db: D1Database,
  appId: string,
  q: Exclude<LifecycleReadRequest, { method: "grantsFor" }>,
) {
  const meta = await metadata(db, appId);
  const sourced = async <T>(data: T) => {
    const after = await metadata(db, appId);
    if (
      after.as_of !== meta.as_of ||
      after.projection.generation !== meta.projection.generation ||
      after.projection.source_watermark !== meta.projection.source_watermark
    )
      return unavailable();
    return { data, meta };
  };
  if (q.method === "listWorkflowDefinitions") {
    const scope = `mcp definitions ${appId} ${q.workflowKey}`;
    const params = new URLSearchParams(q.cursor ? { cursor: q.cursor } : {});
    const after = decodeCursor(params, scope, ["string", "number"]) as [string, number] | null;
    const rows = await listProcesses(db, appId, {
      processKey: q.workflowKey,
      limit: q.limit + 1,
      after,
    });
    const items = rows.slice(0, q.limit);
    const last = items.at(-1);
    return sourced({
      items: items.map(definition),
      next_cursor:
        rows.length > q.limit && last
          ? encodeCursor(scope, [last.process_key, last.version])
          : null,
    });
  }
  if (q.method === "getWorkflowDefinition") {
    // Select exactly the registered serving version; never scan the first page for a version.
    const row = await db
      .prepare(`SELECT process_key, version, label, stages_json, as_of FROM lifecycle_process_definitions
      WHERE app_id = ? AND process_key = ? AND deleted_at IS NULL AND (? IS NULL OR version = ?)
      ORDER BY version DESC LIMIT 1`)
      .bind(appId, q.workflowKey, q.version, q.version)
      .first<Omit<ProcessDefinition, "stages"> & { stages_json: string }>();
    return sourced(row ? definition({ ...row, stages: JSON.parse(row.stages_json) }) : null);
  }
  if (q.method === "getCaseSummary" || q.method === "getCaseTimeline") {
    const c = await caseDetail(db, appId, q.caseId);
    if (!c) return sourced(null);
    if (q.method === "getCaseSummary")
      return sourced({
        case_id: c.case_id,
        workflow_key: c.process_key,
        version: c.process_version,
        status: c.status,
        outcome: c.outcome,
        current_stage: c.current_stage,
        started_at: c.started_at,
        ended_at: c.ended_at,
        last_event_at: c.last_event_at,
        dimensions: {},
      });
    // H does not persist attempt identity. Only all-active histories preserve visits exactly.
    if (c.intervals.some((i) => i.state !== "active")) return unavailable();
    const scope = `mcp timeline ${appId} ${q.caseId} ${c.provenance.generation} ${c.provenance.source_watermark}`;
    const after = decodeCursor(new URLSearchParams(q.cursor ? { cursor: q.cursor } : {}), scope, [
      "number",
    ]);
    const offset = after?.[0] ?? 0;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > 500)
      throw new BadQuery();
    const attempts = new Map<string, number>();
    const entries = c.intervals.map((i) => {
      const attempt = (attempts.get(i.stage_key) ?? 0) + 1;
      attempts.set(i.stage_key, attempt);
      return {
        stage_key: i.stage_key,
        attempt,
        state: i.exited_at === null ? "active" : "completed",
        entered_at: i.entered_at,
        exited_at: i.exited_at,
      };
    });
    return sourced({
      items: entries.slice(offset, offset + q.limit),
      next_cursor:
        entries.length > offset + q.limit ? encodeCursor(scope, [offset + q.limit]) : null,
    });
  }
  if (q.method === "getFreshness") {
    const { results } = await db
      .prepare(`SELECT process_key AS workflow_key, max(last_event_at) AS last_event_at
      FROM lifecycle_case_snapshots WHERE app_id = ? AND deleted_at IS NULL GROUP BY process_key ORDER BY process_key LIMIT 101`)
      .bind(appId)
      .all<{ workflow_key: string; last_event_at: number | null }>();
    if (results.length > 100) return unavailable();
    return sourced({ ...meta.freshness, workflows: results });
  }
  if (q.method === "getFunnel" || q.method === "getVariantStats") return unavailable();
  if (
    q.groupBy !== null ||
    Object.keys(q.filters).length ||
    q.from >= q.to ||
    q.to - q.from > 366 * 86_400_000
  )
    return unavailable();
  const { results: cases } = await db
    .prepare(`SELECT case_id FROM lifecycle_case_snapshots
    WHERE app_id = ? AND process_key = ? AND process_version = ? AND deleted_at IS NULL
      AND started_at >= ? AND started_at < ? ORDER BY started_at, case_id LIMIT ?`)
    .bind(appId, q.workflowKey, q.version, q.from, q.to, MAX_CASES + 1)
    .all<{ case_id: string }>();
  if (cases.length > MAX_CASES) return unavailable();
  const { results: intervals } = await db
    .prepare(`SELECT i.case_id, i.stage_key, i.state, i.entered_at, i.exited_at
    FROM lifecycle_stage_intervals i JOIN lifecycle_case_snapshots c ON c.app_id = i.app_id AND c.case_id = i.case_id
    WHERE i.app_id = ? AND c.process_key = ? AND c.process_version = ? AND c.deleted_at IS NULL
      AND c.started_at >= ? AND c.started_at < ? ORDER BY i.case_id, i.seq LIMIT ?`)
    .bind(appId, q.workflowKey, q.version, q.from, q.to, MAX_INTERVALS + 1)
    .all<{
      case_id: string;
      stage_key: string;
      state: string;
      entered_at: number;
      exited_at: number | null;
    }>();
  if (intervals.length > MAX_INTERVALS || intervals.some((i) => i.state !== "active"))
    return unavailable();
  const groups = new Map<string, { completed: Set<string>; open: Set<string>; values: number[] }>();
  for (const iv of intervals) {
    const g = groups.get(iv.stage_key) ?? {
      completed: new Set<string>(),
      open: new Set<string>(),
      values: [],
    };
    groups.set(iv.stage_key, g);
    if (iv.exited_at === null) g.open.add(iv.case_id);
    else {
      g.completed.add(iv.case_id);
      g.values.push(iv.exited_at - iv.entered_at);
    }
  }
  return sourced(
    [...groups].map(([stage_key, g]) => {
      // Do not expose small completed OR censored cohorts, including through residual counts.
      const suppressed =
        (g.completed.size > 0 && g.completed.size < 5) || (g.open.size > 0 && g.open.size < 5);
      const values = g.values.sort((a, b) => a - b);
      const pct = (p: number) => values[Math.ceil(values.length * p) - 1] ?? null;
      return {
        stage_key,
        group: null,
        n: suppressed ? 0 : g.completed.size,
        open_n: suppressed ? 0 : g.open.size,
        p50_ms: suppressed ? null : pct(0.5),
        p90_ms: suppressed ? null : pct(0.9),
        mean_ms:
          suppressed || !values.length
            ? null
            : Math.round(values.reduce((n, x) => n + x, 0) / values.length),
        suppressed,
      };
    }),
  );
}
