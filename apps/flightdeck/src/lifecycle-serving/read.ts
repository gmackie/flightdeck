import type { IntervalState } from "./model";

/**
 * Read queries over the serving tables. Every statement binds `appId` first and skips
 * soft-deleted rows; callers pass an app id only after authorization.
 */

const CASES = "lifecycle_case_snapshots";
/** Bounds on the per-case lists in a detail response. */
export const MAX_CHILDREN = 100;
export const MAX_INCOMING = 100;

export type StageDef = { key: string; label: string; terminal: boolean };

export type ProcessDefinition = {
  process_key: string;
  version: number;
  label: string;
  stages: StageDef[];
  as_of: number;
};

export type CaseSummary = {
  case_id: string;
  process_key: string;
  process_version: number;
  status: "open" | "closed";
  outcome: string | null;
  current_stage: string | null;
  parent_case_id: string | null;
  started_at: number;
  ended_at: number | null;
  last_event_at: number;
};

const SUMMARY_COLUMNS = `case_id, process_key, process_version, status, outcome, current_stage,
  parent_case_id, started_at, ended_at, last_event_at`;

export async function listProcesses(
  db: D1Database,
  appId: string,
  q: { processKey: string | null; limit: number; after: [string, number] | null },
): Promise<ProcessDefinition[]> {
  const where = ["app_id = ?", "deleted_at IS NULL"];
  const binds: (string | number)[] = [appId];
  if (q.processKey !== null) {
    where.push("process_key = ?");
    binds.push(q.processKey);
  }
  if (q.after) {
    where.push("(process_key > ? OR (process_key = ? AND version < ?))");
    binds.push(q.after[0], q.after[0], q.after[1]);
  }
  const { results } = await db
    .prepare(
      `SELECT process_key, version, label, stages_json, as_of
       FROM lifecycle_process_definitions WHERE ${where.join(" AND ")}
       ORDER BY process_key, version DESC LIMIT ?`,
    )
    .bind(...binds, q.limit)
    .all<Omit<ProcessDefinition, "stages"> & { stages_json: string }>();
  return results.map(({ stages_json, ...d }) => ({ ...d, stages: JSON.parse(stages_json) }));
}

export type CaseFilters = {
  processKey: string | null;
  version: number | null;
  status: "open" | "closed" | null;
  outcome: string | null;
  stage: string | null;
  parent: string | null;
  startedAfter: number | null;
  startedBefore: number | null;
};

/** Newest first; `after` is the (started_at, case_id) of the previous page's last row. */
export async function listCases(
  db: D1Database,
  appId: string,
  f: CaseFilters,
  page: { limit: number; after: [number, string] | null },
): Promise<CaseSummary[]> {
  const where = ["app_id = ?", "deleted_at IS NULL"];
  const binds: (string | number)[] = [appId];
  const eq = (column: string, value: string | number | null) => {
    if (value === null) return;
    where.push(`${column} = ?`);
    binds.push(value);
  };
  eq("process_key", f.processKey);
  eq("process_version", f.version);
  eq("status", f.status);
  eq("outcome", f.outcome);
  eq("current_stage", f.stage);
  eq("parent_case_id", f.parent);
  if (f.startedAfter !== null) {
    where.push("started_at >= ?");
    binds.push(f.startedAfter);
  }
  if (f.startedBefore !== null) {
    where.push("started_at < ?");
    binds.push(f.startedBefore);
  }
  if (page.after) {
    where.push("(started_at < ? OR (started_at = ? AND case_id < ?))");
    binds.push(page.after[0], page.after[0], page.after[1]);
  }
  const { results } = await db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM ${CASES} WHERE ${where.join(" AND ")}
       ORDER BY started_at DESC, case_id DESC LIMIT ?`,
    )
    .bind(...binds, page.limit)
    .all<CaseSummary>();
  return results;
}

export type CaseDetail = CaseSummary & {
  provenance: {
    generation: number;
    source_watermark: number;
    reducer_version: string;
    as_of: number;
  };
  intervals: {
    stage_key: string;
    state: IntervalState;
    entered_at: number;
    exited_at: number | null;
    outcome: string | null;
  }[];
  /** null when the case has no parent; `available: false` when it is not projected (yet). */
  parent: { case_id: string; available: boolean; summary: CaseSummary | null } | null;
  children: { items: CaseSummary[]; truncated: boolean };
  relations: {
    outgoing: { relation: string; case_id: string }[];
    incoming: { items: { relation: string; case_id: string }[]; truncated: boolean };
  };
};

/** One case with its intervals, parent, direct children and relations; null when absent. */
export async function caseDetail(
  db: D1Database,
  appId: string,
  caseId: string,
): Promise<CaseDetail | null> {
  const row = await db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS}, generation, source_watermark, reducer_version, as_of
       FROM ${CASES} WHERE app_id = ? AND case_id = ? AND deleted_at IS NULL`,
    )
    .bind(appId, caseId)
    .first<CaseSummary & CaseDetail["provenance"]>();
  if (!row) return null;
  const { generation, source_watermark, reducer_version, as_of, ...summary } = row;
  // Relations to deleted (or never projected) cases are hidden rather than dangling.
  const live = (column: string) => `EXISTS (SELECT 1 FROM ${CASES} c WHERE c.app_id = e.app_id
    AND c.case_id = e.${column} AND c.deleted_at IS NULL)`;
  const [intervals, parent, children, outgoing, incoming] = await db.batch<Record<string, unknown>>(
    [
      db
        .prepare(
          `SELECT stage_key, state, entered_at, exited_at, outcome FROM lifecycle_stage_intervals
         WHERE app_id = ? AND case_id = ? ORDER BY seq`,
        )
        .bind(appId, caseId),
      db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} FROM ${CASES}
         WHERE app_id = ? AND case_id = ? AND deleted_at IS NULL`,
        )
        .bind(appId, summary.parent_case_id ?? ""),
      db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} FROM ${CASES}
         WHERE app_id = ? AND parent_case_id = ? AND deleted_at IS NULL
         ORDER BY started_at DESC, case_id DESC LIMIT ?`,
        )
        .bind(appId, caseId, MAX_CHILDREN + 1),
      db
        .prepare(
          `SELECT relation, to_case_id AS case_id FROM lifecycle_case_edges e
         WHERE app_id = ? AND from_case_id = ? AND ${live("to_case_id")}
         ORDER BY relation, to_case_id`,
        )
        .bind(appId, caseId),
      db
        .prepare(
          `SELECT relation, from_case_id AS case_id FROM lifecycle_case_edges e
         WHERE app_id = ? AND to_case_id = ? AND ${live("from_case_id")}
         ORDER BY relation, from_case_id LIMIT ?`,
        )
        .bind(appId, caseId, MAX_INCOMING + 1),
    ],
  );
  const rows = <T>(r: D1Result<Record<string, unknown>> | undefined) => (r?.results ?? []) as T[];
  const kids = rows<CaseSummary>(children);
  const inbound = rows<{ relation: string; case_id: string }>(incoming);
  const parentRow = rows<CaseSummary>(parent)[0] ?? null;
  return {
    ...summary,
    provenance: { generation, source_watermark, reducer_version, as_of },
    intervals: rows(intervals),
    parent: summary.parent_case_id
      ? { case_id: summary.parent_case_id, available: !!parentRow, summary: parentRow }
      : null,
    children: { items: kids.slice(0, MAX_CHILDREN), truncated: kids.length > MAX_CHILDREN },
    relations: {
      outgoing: rows(outgoing),
      incoming: { items: inbound.slice(0, MAX_INCOMING), truncated: inbound.length > MAX_INCOMING },
    },
  };
}

/** Aggregates compare one process version over a bounded start window. */
export type Cohort = {
  processKey: string;
  version: number;
  status: "open" | "closed" | null;
  startedAfter: number;
  startedBefore: number;
};

const COHORT = `cohort AS (
  SELECT case_id, status, outcome, started_at, ended_at FROM ${CASES}
  WHERE app_id = ? AND process_key = ? AND process_version = ? AND deleted_at IS NULL
    AND started_at >= ? AND started_at < ? AND (? IS NULL OR status = ?))`;
const cohortBinds = (appId: string, c: Cohort) => [
  appId,
  c.processKey,
  c.version,
  c.startedAfter,
  c.startedBefore,
  c.status,
  c.status,
];

/** Nearest-rank percentiles over `value`, per group, from row_number/count windows. */
const percentile = (p: number) => `min(CASE WHEN rn >= ${p} * n THEN value END)`;

export type StageGroup = {
  stage_key: string;
  state: IntervalState;
  case_count: number;
  /** Intervals that have ended; only these contribute to dwell. */
  closed_intervals: number;
  /** Intervals still open at as_of: right-censored, excluded from dwell. */
  open_intervals: number;
  dwell_ms: {
    mean: number | null;
    p50: number | null;
    p90: number | null;
    min: number | null;
    max: number | null;
  };
};

/**
 * Dwell per (stage, state) over the cohort's intervals. Groups with fewer than `minCohort`
 * distinct cases are dropped; `sample_count` counts distinct cases in the released groups only.
 */
export async function stageSummary(
  db: D1Database,
  appId: string,
  c: Cohort,
  minCohort: number,
): Promise<{ groups: StageGroup[]; sample_count: number; suppressed: boolean }> {
  const intervals = `${COHORT},
    iv AS (SELECT i.stage_key, i.state, i.case_id, i.exited_at - i.entered_at AS value
      FROM lifecycle_stage_intervals i JOIN cohort ON cohort.case_id = i.case_id
      WHERE i.app_id = ?)`;
  const binds = [...cohortBinds(appId, c), appId];
  const [stats, sample] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `WITH ${intervals},
         ranked AS (SELECT stage_key, state, value,
             row_number() OVER (PARTITION BY stage_key, state ORDER BY value) AS rn,
             count(*) OVER (PARTITION BY stage_key, state) AS n
           FROM iv WHERE value IS NOT NULL),
         pct AS (SELECT stage_key, state, ${percentile(0.5)} AS p50, ${percentile(0.9)} AS p90
           FROM ranked GROUP BY stage_key, state)
         SELECT iv.stage_key, iv.state, count(DISTINCT iv.case_id) AS case_count,
           count(iv.value) AS closed_intervals, sum(iv.value IS NULL) AS open_intervals,
           avg(iv.value) AS mean, min(iv.value) AS min, max(iv.value) AS max,
           pct.p50, pct.p90
         FROM iv LEFT JOIN pct ON pct.stage_key = iv.stage_key AND pct.state = iv.state
         GROUP BY iv.stage_key, iv.state`,
      )
      .bind(...binds),
    db
      .prepare(
        `WITH ${intervals},
         released AS (SELECT stage_key, state FROM iv GROUP BY stage_key, state
           HAVING count(DISTINCT case_id) >= ?)
         SELECT count(DISTINCT iv.case_id) AS n FROM iv
         JOIN released ON released.stage_key = iv.stage_key AND released.state = iv.state`,
      )
      .bind(...binds, minCohort),
  ]);
  type Row = Omit<StageGroup, "dwell_ms"> &
    Record<"mean" | "p50" | "p90" | "min" | "max", number | null>;
  const all = (stats?.results ?? []) as Row[];
  const groups = all
    .filter((g) => g.case_count >= minCohort)
    .map(({ mean, p50, p90, min, max, ...g }) => ({
      ...g,
      dwell_ms: { mean: mean === null ? null : Math.round(mean), p50, p90, min, max },
    }));
  const n = (sample?.results?.[0] as { n?: number } | undefined)?.n ?? 0;
  return { groups, sample_count: n, suppressed: groups.length < all.length };
}

export type OutcomeGroup = {
  status: "open" | "closed";
  outcome: string | null;
  case_count: number;
  /** Start-to-end duration of closed cases; null for the open group. */
  duration_ms: { mean: number | null; p50: number | null; p90: number | null };
};

/** Closed cases by outcome, plus one group of still-open cases. Small groups are dropped. */
export async function outcomeSummary(
  db: D1Database,
  appId: string,
  c: Cohort,
  minCohort: number,
): Promise<{ groups: OutcomeGroup[]; sample_count: number; suppressed: boolean }> {
  const { results } = await db
    .prepare(
      `WITH ${COHORT},
       ranked AS (SELECT outcome, ended_at - started_at AS value,
           row_number() OVER (PARTITION BY outcome ORDER BY ended_at - started_at) AS rn,
           count(*) OVER (PARTITION BY outcome) AS n
         FROM cohort WHERE status = 'closed')
       SELECT 'closed' AS status, outcome, count(*) AS case_count, avg(value) AS mean,
         ${percentile(0.5)} AS p50, ${percentile(0.9)} AS p90
       FROM ranked GROUP BY outcome
       UNION ALL
       SELECT 'open', NULL, count(*), NULL, NULL, NULL FROM cohort WHERE status = 'open'`,
    )
    .bind(...cohortBinds(appId, c))
    .all<Omit<OutcomeGroup, "duration_ms"> & Record<"mean" | "p50" | "p90", number | null>>();
  const present = results.filter((g) => g.case_count > 0);
  const groups = present
    .filter((g) => g.case_count >= minCohort)
    .map(({ mean, p50, p90, ...g }) => ({
      ...g,
      duration_ms: { mean: mean === null ? null : Math.round(mean), p50, p90 },
    }));
  return {
    groups,
    sample_count: groups.reduce((n, g) => n + g.case_count, 0),
    suppressed: groups.length < present.length,
  };
}
