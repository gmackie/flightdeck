import type { FactBase, LifecycleFact, Query, QueryRegistry } from "./types.js";

export const demoRegistry: QueryRegistry = {
  appId: "demo",
  definitionId: "intake",
  metricVersion: "lifecycle.v1",
  availableFrom: "2026-01-01T00:00:00.000Z",
  maxWindowDays: 31,
  minSampleSize: 3,
  versions: {
    v1: {
      comparisonKey: "intake.v1",
      stages: { review: "review" },
      checkpoints: { start: "start", finish: "finish" },
      variants: { standard: "standard" },
    },
    v2: {
      comparisonKey: "intake.v1",
      stages: { assess: "review" },
      checkpoints: { begin: "start", done: "finish" },
      variants: { normal: "standard" },
    },
    v3: {
      comparisonKey: "intake.changed",
      stages: { review: "review" },
      checkpoints: { start: "start" },
      variants: { standard: "standard" },
    },
  },
  filterValues: {
    caseMix: ["routine", "urgent"],
    cohortId: ["before", "after"],
    definitionVersion: ["v1", "v2", "v3"],
    variantId: ["standard"],
    outcome: ["open", "completed", "cancelled", "failed"],
  },
};
export const demoQuery: Query<{ kind: "stage-dwell"; stageId: string }> = {
  appId: "demo",
  definitionId: "intake",
  definitionVersions: ["v1", "v2"],
  metricVersion: "lifecycle.v1",
  from: "2026-01-01T00:00:00.000Z",
  to: "2026-01-10T00:00:00.000Z",
  asOf: "2026-01-12T00:00:00.000Z",
  cohort: { id: "after", caseMix: ["routine", "urgent"] },
  metric: { kind: "stage-dwell", stageId: "review" },
  groupBy: ["caseMix"],
  filters: [],
  topN: 20,
};
export const demoWatermark = "2026-01-12T00:00:00.000Z";
export function syntheticFacts(): LifecycleFact[] {
  const facts: LifecycleFact[] = [];
  for (const cohortId of ["before", "after"]) {
    for (const caseMix of ["routine", "urgent"]) {
      for (let index = 1; index <= 6; index++) {
        const caseId = `${cohortId}-${caseMix}-${index}`;
        const version = cohortId === "before" ? "v1" : "v2";
        const started = Date.parse("2026-01-02T00:00:00.000Z");
        const duration =
          (index + (caseMix === "urgent" ? 10 : 0) + (cohortId === "before" ? 2 : 0)) * 3600000;
        const ended = new Date(started + duration).toISOString();
        const base: FactBase = {
          factId: `${caseId}-case`,
          caseId,
          revision: 1,
          recordedAt: demoWatermark,
          appId: "demo",
          definitionId: "intake",
          definitionVersion: version,
          cohortId,
          caseMix,
          variantId: version === "v1" ? "standard" : "normal",
          caseStartedAt: new Date(started).toISOString(),
          caseEndedAt: index === 6 ? null : ended,
          outcome: index === 6 ? "open" : "completed",
        };
        facts.push(
          { ...base, kind: "case" },
          {
            ...base,
            factId: `${caseId}-visit`,
            kind: "interval",
            stageId: version === "v1" ? "review" : "assess",
            enteredAt: base.caseStartedAt,
            exitedAt: base.caseEndedAt,
          },
          {
            ...base,
            factId: `${caseId}-start`,
            kind: "checkpoint",
            checkpointId: version === "v1" ? "start" : "begin",
            reachedAt: base.caseStartedAt,
            sequence: 0,
          },
        );
        if (index !== 6)
          facts.push({
            ...base,
            factId: `${caseId}-finish`,
            kind: "checkpoint",
            checkpointId: version === "v1" ? "finish" : "done",
            reachedAt: ended,
            sequence: 1,
          });
      }
    }
  }
  return facts;
}
