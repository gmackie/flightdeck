/** Entirely synthetic aggregate cells, with no individual records or sensitive attributes. */
import type { Cell, ComparisonSpec, Contract, EvaluationContext, Rule, Snapshot } from "./types.js";

export const DAY = 86_400_000;
export const AS_OF = Date.UTC(2026, 9, 30);
const window = { start: AS_OF - 7 * DAY, end: AS_OF };
const baselineWindow = { start: AS_OF - 14 * DAY, end: AS_OF - 7 * DAY };
export const syntheticContext: EvaluationContext = {
  asOf: AS_OF,
  policy: {
    permittedSources: ["synthetic"],
    minimumCohort: 10,
    dimensions: { category: ["standard", "complex"], level: ["tier-1"], region: ["zone-a"] },
  },
};
function cell(id: string, variant: string, category: string, mean: number): Cell {
  const n = 80;
  const moments = (value: number) => ({
    n,
    sum: value * n,
    sumSquares: n * value * value + ((n - 1) * value * value) / 4,
  });
  return {
    id,
    variant,
    dimensions: { category, level: "tier-1", region: "zone-a" },
    cohortSize: 100,
    suppressed: false,
    completed: n,
    censored: 20,
    paused: 2,
    currentDwell: { n: 18, p90Ms: 4 * DAY },
    stuckOpen: { thresholdMs: 3 * DAY, count: 8, eligible: 18 },
    agedBacklog: { thresholdMs: 7 * DAY, count: 4, eligible: 18 },
    slaBreach: { thresholdMs: 5 * DAY, count: 12, eligible: 80 },
    outcomes: { total: n, rejected: 12, cancelled: 8 },
    capacity: { used: 90, available: 100 },
    duration: moments(mean * DAY),
    cost: moments(mean * 20),
    rework: moments(mean / 10),
  };
}
export function syntheticFixture(lifecycleId: "hiring" | "release" | "incidents"): {
  snapshot: Snapshot;
  baseline: Snapshot;
  rule: Rule;
  comparison: ComparisonSpec;
} {
  const contract: Contract = {
    sourceId: "synthetic",
    sourceVersion: "1",
    definitionVersion: "1",
    mappingVersion: "1",
    scope: { lifecycleId, populationId: "synthetic-population", kind: "case" },
    clock: { timeZone: "America/Detroit", calendar: "elapsed-v1" },
    units: {
      duration: "ms",
      cost: "synthetic-credit",
      rework: "count",
      capacity: "synthetic-slot",
    },
  };
  const snapshot: Snapshot = {
    ...contract,
    contractVersion: 1,
    id: `${lifecycleId}-current`,
    window,
    asOf: AS_OF,
    producedAt: AS_OF,
    watermark: AS_OF,
    basis: "event-time",
    intervalPolicy: "union-active-excluding-pauses",
    disjointCells: true,
    overlappingIntervalsResolved: true,
    stageMapping: { start: "occurrence-1", review: "occurrence-2", repeatedReview: "occurrence-3" },
    cells: [
      cell("a-1", "a", "standard", 2),
      cell("a-2", "a", "complex", 8),
      cell("b-1", "b", "standard", 3),
      cell("b-2", "b", "complex", 7),
    ],
  };
  const fixture: {
    snapshot: Snapshot;
    baseline: Snapshot;
    rule: Rule;
    comparison: ComparisonSpec;
  } = {
    snapshot,
    baseline: { ...snapshot, id: `${lifecycleId}-baseline`, window: baselineWindow },
    rule: {
      id: `${lifecycleId}-capacity`,
      version: 1,
      severity: "warning",
      ownerRef: "process-ops",
      contract,
      selection: { variant: "a", filters: {} },
      window,
      metric: "capacity-saturation",
      threshold: 0.85,
      minimumSamples: 10,
      minimumCohort: 10,
      cooldownMs: DAY,
    },
    comparison: {
      contract,
      window,
      left: { variant: "a", filters: {} },
      right: { variant: "b", filters: {} },
      controls: ["category", "level", "region"],
      uncontrolled: [],
      minimumSamples: 10,
      minimumCohort: 10,
      minimumCoverage: 1,
      metrics: ["duration", "cost", "rework", "rejection-share", "cancellation-share"],
    },
  };
  // Clone separately so current, baseline, and expected contracts share no mutable references.
  return {
    snapshot: copy(fixture.snapshot),
    baseline: copy(fixture.baseline),
    rule: copy(fixture.rule),
    comparison: copy(fixture.comparison),
  };
}
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
