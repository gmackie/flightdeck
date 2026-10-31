import { DatabaseSync } from "node:sqlite";
import type { AggregateRow, LifecycleFact, SqlPlan } from "../src/index.js";

/** SQLite exercises portable SQL semantics, not Basin/DataFusion compatibility.
 * Percentile stand-in uses exact nearest rank so differential fixtures can compare values.
 */
export function sqlFixture(facts: readonly LifecycleFact[]) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE lifecycle_facts (
    fact_id TEXT, case_id TEXT, revision INTEGER, recorded_at_ms INTEGER,
    app_id TEXT, definition_id TEXT, definition_version TEXT, cohort_id TEXT, case_mix TEXT,
    variant_id TEXT, case_started_at_ms INTEGER, case_ended_at_ms INTEGER, outcome TEXT,
    fact_kind TEXT, stage_id TEXT, entered_at_ms INTEGER, exited_at_ms INTEGER,
    checkpoint_id TEXT, reached_at_ms INTEGER, sequence_no INTEGER, cohort_day TEXT
  )`);
  db.aggregate("APPROX_PERCENTILE_CONT", {
    start: "",
    step: (state: string, value, p) =>
      value === null ? state : `${state}${Number(p)}:${Number(value)},`,
    result: (state: string) => {
      if (!state) return null;
      const pairs = state
        .slice(0, -1)
        .split(",")
        .map((entry) => entry.split(":").map(Number));
      const p = pairs[0]?.[0] ?? 0.5;
      const values = pairs.map((entry) => entry[1] ?? 0).sort((a, b) => a - b);
      return values[Math.ceil(values.length * p) - 1] ?? null;
    },
  });
  const insert = db.prepare(
    `INSERT INTO lifecycle_facts VALUES (${Array(21).fill("?").join(",")})`,
  );
  const ms = (value: string | null) => (value === null ? null : Date.parse(value));
  for (const fact of facts)
    insert.run(
      fact.factId,
      fact.caseId,
      fact.revision,
      ms(fact.recordedAt),
      fact.appId,
      fact.definitionId,
      fact.definitionVersion,
      fact.cohortId,
      fact.caseMix,
      fact.variantId,
      ms(fact.caseStartedAt),
      ms(fact.caseEndedAt),
      fact.outcome,
      fact.kind,
      fact.kind === "interval" ? fact.stageId : null,
      fact.kind === "interval" ? ms(fact.enteredAt) : null,
      fact.kind === "interval" ? ms(fact.exitedAt) : null,
      fact.kind === "checkpoint" ? fact.checkpointId : null,
      fact.kind === "checkpoint" ? ms(fact.reachedAt) : null,
      fact.kind === "checkpoint" ? fact.sequence : null,
      fact.caseStartedAt?.slice(0, 10) ?? null,
    );
  return {
    close: () => db.close(),
    execute: (plan: SqlPlan): AggregateRow[] =>
      db
        .prepare(plan.sql)
        .all()
        .map((row) => ({
          key: String(row.key),
          arm: String(row.arm) as AggregateRow["arm"],
          group: Object.fromEntries(
            plan.groupColumns.map((dimension) => [dimension, String(row[dimension])]),
          ),
          sampleSize: Number(row.sample_size),
          observedCases: Number(row.observed_cases),
          censoredCases: Number(row.censored_cases),
          count: Number(row.count),
          p50Ms: row.p50_ms === null ? null : Number(row.p50_ms),
          p75Ms: row.p75_ms === null ? null : Number(row.p75_ms),
          p90Ms: row.p90_ms === null ? null : Number(row.p90_ms),
        })),
  };
}
