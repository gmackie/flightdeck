/** All timestamps are canonical UTC ISO strings with millisecond precision. */
export type Utc = string;
export const DIMENSIONS = [
  "caseMix",
  "cohortId",
  "definitionVersion",
  "variantId",
  "outcome",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type Outcome = "open" | "completed" | "cancelled" | "failed";
export interface Cohort {
  id: string;
  /** Explicit registered strata. No implicit pooling across case mixes. */
  caseMix: readonly string[];
}
export interface Filter {
  field: Dimension;
  values: readonly string[];
}
export type Metric =
  | { kind: "stage-dwell"; stageId: string }
  | { kind: "current-open-age" }
  | { kind: "outcomes" }
  | { kind: "funnel"; checkpoints: readonly string[] }
  | { kind: "variant-counts" }
  | { kind: "case-counts" }
  | { kind: "comparison"; stageId: string; reference: Cohort };
export interface Query<M extends Metric = Metric> {
  appId: string;
  definitionId: string;
  definitionVersions: readonly string[];
  metricVersion: "lifecycle.v1";
  from: Utc;
  to: Utc;
  asOf: Utc;
  cohort: Cohort;
  metric: M;
  groupBy: readonly Dimension[];
  filters: readonly Filter[];
  topN: number;
}
export interface VersionMapping {
  /** Equal keys are an explicit registry assertion of semantic comparability. */
  comparisonKey: string;
  /** Physical projector ID -> canonical query ID, independently for each version. */
  stages: Readonly<Record<string, string>>;
  checkpoints: Readonly<Record<string, string>>;
  variants: Readonly<Record<string, string>>;
}
export interface QueryRegistry {
  appId: string;
  definitionId: string;
  metricVersion: "lifecycle.v1";
  versions: Readonly<Record<string, VersionMapping>>;
  filterValues: Readonly<Record<Dimension, readonly string[]>>;
  /** Immutable cohort-start partition bounds that the serving store actually retains. */
  availableFrom: Utc;
  maxWindowDays: number;
  minSampleSize: number;
}
/** Complete revision snapshot: exactly one case fact plus zero or more interval/checkpoint facts.
 * All facts in one revision share case attributes and recordedAt. No partial revisions/tombstones.
 */
export interface FactBase {
  factId: string;
  caseId: string;
  revision: number;
  recordedAt: Utc;
  appId: string;
  definitionId: string;
  definitionVersion: string;
  cohortId: string;
  caseMix: string;
  variantId: string;
  caseStartedAt: Utc | null;
  caseEndedAt: Utc | null;
  outcome: Outcome;
}
export type LifecycleFact = FactBase &
  (
    | { kind: "case" }
    | { kind: "interval"; stageId: string; enteredAt: Utc | null; exitedAt: Utc | null }
    | { kind: "checkpoint"; checkpointId: string; reachedAt: Utc | null; sequence: number }
  );
export interface Percentiles {
  p50Ms: number | null;
  p75Ms: number | null;
  p90Ms: number | null;
}
export interface Sample extends Percentiles {
  sampleSize: number | null;
  observedCases: number | null;
  censoredCases: number | null;
  count: number | null;
  suppressed: boolean;
  suppression: { sample: boolean; counts: boolean; percentiles: boolean };
}
export interface MetricRow extends Sample {
  key: string;
  group: Readonly<Partial<Record<Dimension, string>>>;
}
export interface ComparisonRow {
  key: string;
  group: Readonly<Partial<Record<Dimension, string>>>;
  primary: Sample | null;
  reference: Sample | null;
  comparable: boolean;
  reason: "missing-stratum" | "suppressed" | null;
  deltaP50Ms: number | null;
}
/** Internal aggregate transport contract shared by the SQL executor and fake adapter. */
export interface AggregateRow {
  key: string;
  group: Partial<Record<Dimension, string>>;
  arm: "primary" | "reference";
  sampleSize: number;
  observedCases: number;
  censoredCases: number;
  count: number;
  p50Ms: number | null;
  p75Ms: number | null;
  p90Ms: number | null;
}
export interface Evidence {
  /** Source knowledge watermark, NOT query execution time. May lag asOf. */
  watermark: Utc;
  /** Query scoped distinct cases, before invalid-time exclusion; null if unknown. */
  eligibleCases: number | null;
  coveredCases: number;
}
export interface ResultMetadata {
  appId: string;
  definitionId: string;
  definitionVersions: readonly string[];
  metricVersion: "lifecycle.v1";
  asOf: Utc;
  watermark: Utc;
  sampleSize: number | null;
  coverage: { eligibleCases: number | null; coveredCases: number | null; ratio: number | null };
  suppression: { minSampleSize: number; suppressedRows: number };
  cohort: Cohort;
  approximation: "exact-nearest-rank-fixture" | "basin-approx-percentile";
  truncated: boolean;
}
export interface Result<M extends Metric = Metric> {
  metric: M;
  rows: M extends { kind: "comparison" } ? ComparisonRow[] : MetricRow[];
  metadata: ResultMetadata;
}
export interface QueryAdapter {
  query<M extends Metric>(query: Query<M>): Promise<Result<M>>;
}
