import {
  createFakeAdapter,
  type LifecycleFact,
  type Outcome,
  type QueryAdapter,
  type QueryRegistry,
} from "@flightdeckhq/lifecycle-queries";

/**
 * Typed bridge from the materialized D1 read model (migrations 0020/0030) to the lifecycle query
 * contracts (@flightdeckhq/lifecycle-queries, Workstream G). It turns served case snapshots into
 * G's revision facts and answers G queries with G's exact fixture executor, so query semantics,
 * validation and suppression are G's own.
 *
 * NOT the Basin path: the genuine Basin SQL executor (`createBasinAdapter`) needs a read-only
 * Basin credential and production data, and is a separate validation gate. Nothing here is
 * routed to the API yet; callers must pass an app id they already authorized (`process:read`).
 */

export type BridgeScope = {
  appId: string;
  processKey: string;
  /** Served process versions to include; queries may only combine comparable versions. */
  versions: readonly number[];
  /** The single registered cohort and case mix these facts belong to. */
  cohortId: string;
  caseMix: string;
  /**
   * Explicit served outcome code -> G outcome. Closed cases whose outcome is not listed are
   * excluded and counted in `unmapped`, never guessed.
   */
  outcomes: Readonly<Record<string, Exclude<Outcome, "open">>>;
};

export type QueryPolicy = { availableFrom: string; maxWindowDays: number; minSampleSize: number };

export type MaterializedFacts = {
  facts: LifecycleFact[];
  /** Newest `as_of` among the included snapshots: the facts' knowledge watermark. */
  watermark: string;
  stages: string[];
  /** Closed cases left out because their outcome has no explicit mapping, by outcome. */
  unmapped: Record<string, number>;
};

const VARIANT = "default";
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const versionId = (v: number) => `v${v}`;

type CaseRow = {
  case_id: string;
  process_version: number;
  status: "open" | "closed";
  outcome: string | null;
  started_at: number;
  ended_at: number | null;
  source_watermark: number;
  as_of: number;
};
type Segment = {
  case_id: string;
  stage_key: string;
  state: string;
  entered_at: number;
  exited_at: number | null;
};

/** Reads one process's served snapshots and converts them to G revision facts. */
export async function materializedFacts(
  db: D1Database,
  scope: BridgeScope,
): Promise<MaterializedFacts> {
  const versions = JSON.stringify(scope.versions);
  const [cases, segments, definitions] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT case_id, process_version, status, outcome, started_at, ended_at,
           source_watermark, as_of FROM lifecycle_case_snapshots
         WHERE app_id = ? AND process_key = ? AND deleted_at IS NULL
           AND process_version IN (SELECT value FROM json_each(?)) ORDER BY case_id`,
      )
      .bind(scope.appId, scope.processKey, versions),
    db
      .prepare(
        `SELECT i.case_id, i.stage_key, i.state, i.entered_at, i.exited_at
         FROM lifecycle_stage_intervals i JOIN lifecycle_case_snapshots c
           ON c.app_id = i.app_id AND c.case_id = i.case_id
         WHERE i.app_id = ? AND c.process_key = ? AND c.deleted_at IS NULL
           AND c.process_version IN (SELECT value FROM json_each(?))
         ORDER BY i.case_id, i.seq`,
      )
      .bind(scope.appId, scope.processKey, versions),
    db
      .prepare(
        `SELECT stages_json FROM lifecycle_process_definitions
         WHERE app_id = ? AND process_key = ? AND deleted_at IS NULL
           AND version IN (SELECT value FROM json_each(?))`,
      )
      .bind(scope.appId, scope.processKey, versions),
  ]);
  const stages = new Set<string>();
  for (const row of (definitions?.results ?? []) as { stages_json: string }[]) {
    for (const s of JSON.parse(row.stages_json) as { key: string }[]) stages.add(s.key);
  }
  const attemptsByCase = attempts((segments?.results ?? []) as Segment[]);
  const facts: LifecycleFact[] = [];
  const unmapped: Record<string, number> = {};
  let watermark = 0;
  for (const c of (cases?.results ?? []) as CaseRow[]) {
    let outcome: Outcome = "open";
    if (c.status === "closed") {
      const mapped = c.outcome === null ? undefined : scope.outcomes[c.outcome];
      if (!mapped) {
        const key = c.outcome ?? "null";
        unmapped[key] = (unmapped[key] ?? 0) + 1;
        continue;
      }
      outcome = mapped;
    }
    watermark = Math.max(watermark, c.as_of);
    const base = {
      caseId: c.case_id,
      revision: Math.max(1, c.source_watermark),
      recordedAt: iso(c.as_of) as string,
      appId: scope.appId,
      definitionId: scope.processKey,
      definitionVersion: versionId(c.process_version),
      cohortId: scope.cohortId,
      caseMix: scope.caseMix,
      variantId: VARIANT,
      caseStartedAt: iso(c.started_at),
      caseEndedAt: iso(c.ended_at),
      outcome,
    };
    facts.push({ ...base, factId: `${c.case_id}:case`, kind: "case" });
    for (const [i, a] of (attemptsByCase.get(c.case_id) ?? []).entries()) {
      facts.push({
        ...base,
        factId: `${c.case_id}:visit:${i}`,
        kind: "interval",
        stageId: a.stage,
        enteredAt: iso(a.entered),
        exitedAt: iso(a.exited),
      });
    }
  }
  return { facts, watermark: iso(watermark) as string, stages: [...stages].sort(), unmapped };
}

/**
 * Stage attempts from served segments: one attempt's segments are contiguous and alternate state
 * (same-state runs are merged when written), so wall-clock dwell includes paused/blocked time.
 */
function attempts(rows: readonly Segment[]) {
  const byCase = new Map<
    string,
    { stage: string; entered: number; exited: number | null; state: string }[]
  >();
  for (const row of rows) {
    const list = byCase.get(row.case_id) ?? [];
    byCase.set(row.case_id, list);
    const last = list.at(-1);
    if (
      last &&
      last.stage === row.stage_key &&
      last.exited === row.entered_at &&
      last.state !== row.state
    ) {
      last.exited = row.exited_at;
      last.state = row.state;
    } else {
      list.push({
        stage: row.stage_key,
        entered: row.entered_at,
        exited: row.exited_at,
        state: row.state,
      });
    }
  }
  return byCase;
}

/** The G registry for one process: identity stage mapping, one comparison key per process. */
export function registryFor(
  scope: BridgeScope,
  stages: readonly string[],
  policy: QueryPolicy,
): QueryRegistry {
  const identity = Object.fromEntries(stages.map((s) => [s, s]));
  return {
    appId: scope.appId,
    definitionId: scope.processKey,
    metricVersion: "lifecycle.v1",
    availableFrom: policy.availableFrom,
    maxWindowDays: policy.maxWindowDays,
    minSampleSize: policy.minSampleSize,
    versions: Object.fromEntries(
      scope.versions.map((v) => [
        versionId(v),
        {
          // Versions are not asserted comparable: each is its own comparison key.
          comparisonKey: `${scope.processKey}.${versionId(v)}`,
          stages: identity,
          checkpoints: {},
          variants: { [VARIANT]: VARIANT },
        },
      ]),
    ),
    filterValues: {
      caseMix: [scope.caseMix],
      cohortId: [scope.cohortId],
      definitionVersion: scope.versions.map(versionId),
      variantId: [VARIANT],
      outcome: ["open", "completed", "cancelled", "failed"],
    },
  };
}

/** A G query adapter over the app's materialized snapshots, plus what it had to leave out. */
export async function materializedAdapter(
  db: D1Database,
  scope: BridgeScope,
  policy: QueryPolicy,
): Promise<{ adapter: QueryAdapter; registry: QueryRegistry } & MaterializedFacts> {
  const materialized = await materializedFacts(db, scope);
  const registry = registryFor(scope, materialized.stages, policy);
  return {
    adapter: createFakeAdapter(materialized.facts, registry, materialized.watermark),
    registry,
    ...materialized,
  };
}
