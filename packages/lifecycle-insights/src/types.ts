/** No entity rows, free text, people identifiers, or per-person scorecards belong here. */
export type Dimensions = Readonly<Record<string, string>>;
export interface Window {
  start: number;
  end: number;
}
export interface Clock {
  timeZone: string;
  /** Opaque identifier of the upstream business calendar, including its revision. */
  calendar: string;
}
export interface Units {
  duration: "ms";
  /** Common, upstream-normalized cost unit (e.g. USD-v1); never silently mix currencies. */
  cost: string;
  rework: "count";
  capacity: string;
}
export interface Scope {
  lifecycleId: string;
  populationId: string;
  /** Stage scope must identify the occurrence, not a reusable stage definition. */
  kind: "case" | "stage";
  stageOccurrenceId?: string;
}
export interface Moments {
  n: number;
  sum: number;
  sumSquares: number;
}
export interface ThresholdCount {
  thresholdMs: number;
  count: number;
  eligible: number;
}
export interface Cell {
  /** Unique aggregate cell ID, never an individual case ID. */
  id: string;
  variant: string;
  dimensions: Dimensions;
  cohortSize: number;
  suppressed: boolean;
  /** Open intervals remain censored; duration moments describe completed observations only. */
  censored: number;
  paused: number;
  currentDwell: { n: number; p90Ms: number | null };
  stuckOpen: ThresholdCount;
  agedBacklog: ThresholdCount;
  slaBreach: ThresholdCount;
  completed: number;
  outcomes: { total: number; rejected: number; cancelled: number };
  capacity: { used: number; available: number };
  duration: Moments;
  cost: Moments;
  rework: Moments;
}
export interface Snapshot {
  contractVersion: 1;
  id: string;
  sourceId: string;
  sourceVersion: string;
  definitionVersion: string;
  mappingVersion: string;
  scope: Scope;
  clock: Clock;
  units: Units;
  window: Window;
  /** UTC epoch ms. The producer must exclude records ingested after this cutoff. */
  asOf: number;
  producedAt: number;
  /** Completeness through event time, NOT the latest ingestion timestamp. */
  watermark: number;
  basis: "event-time";
  intervalPolicy: "union-active-excluding-pauses";
  /** Attestations from the trusted aggregate producer; this package cannot inspect raw rows. */
  disjointCells: boolean;
  overlappingIntervalsResolved: boolean;
  /** Canonical stage roles -> occurrence IDs. Reused roles must be disambiguated. */
  stageMapping: Readonly<Record<string, string>>;
  cells: readonly Cell[];
}
export interface Policy {
  permittedSources: readonly string[];
  /** Explicit allowed values also prevent individual identifiers entering filters. */
  dimensions: Readonly<Record<string, readonly string[]>>;
  minimumCohort: number;
}
export type Filter = Readonly<Record<string, readonly string[]>>;
export interface Selection {
  variant: string;
  filters: Filter;
}
export interface Contract {
  sourceId: string;
  sourceVersion: string;
  definitionVersion: string;
  mappingVersion: string;
  scope: Scope;
  clock: Clock;
  units: Units;
}
export interface EvaluationContext {
  asOf: number;
  policy: Policy;
}
export type Metric =
  | "p90-current-dwell"
  | "stuck-open-count"
  | "aged-backlog-count"
  | "throughput-drop"
  | "rejection-share"
  | "cancellation-share"
  | "capacity-saturation"
  | "sla-breach-share";
export interface Rule {
  id: string;
  version: number;
  severity: "info" | "warning" | "critical";
  ownerRef: string;
  contract: Contract;
  selection: Selection;
  window: Window;
  /** Mandatory for throughput-drop. Explicit bounds prevent accidentally choosing a baseline. */
  baselineWindow?: Window;
  metric: Metric;
  /** Strict >; shares and relative throughput drop are fractions in [0, 1]. */
  threshold: number;
  /** Required for stuck/aged/SLA, checked against upstream aggregate bucket definition. */
  ageThresholdMs?: number;
  minimumSamples: number;
  minimumCohort: number;
  cooldownMs: number;
}
export interface Drilldown {
  snapshotId: string;
  scope: Scope;
  selection: Selection;
  window: Window;
  asOf: number;
  watermark: number;
}
export interface Alert {
  key: string;
  ruleId: string;
  ruleVersion: number;
  severity: Rule["severity"];
  ownerRef: string;
  status: "open" | "cleared";
  openedAt: number;
  lastEvaluatedAt: number;
  lastEmittedAt: number;
  clearedAt?: number;
  acknowledged?: { ownerRef: string; at: number };
  occurrences: number;
  value: number;
  drilldown: Drilldown;
  baselineDrilldown?: Drilldown;
}
export type AlertEvaluation =
  | { status: "blocked"; reasons: readonly string[] }
  | {
      status: "evaluated";
      transition: "opened" | "updated" | "reopened" | "cleared" | "unchanged" | "cooldown";
      /** A pure emission intent, never a notification. */
      emit: boolean;
      value: number;
      alert?: Alert;
    };
export type ComparisonMetric =
  | "duration"
  | "cost"
  | "rework"
  | "rejection-share"
  | "cancellation-share";
export interface ComparisonSpec {
  contract: Contract;
  window: Window;
  left: Selection;
  right: Selection;
  /** Every allowed dimension must be controlled or explicitly marked uncontrolled. */
  controls: readonly string[];
  uncontrolled: readonly string[];
  minimumSamples: number;
  minimumCohort: number;
  minimumCoverage: number;
  metrics: readonly ComparisonMetric[];
}
export interface Difference {
  metric: ComparisonMetric;
  leftMean: number;
  rightMean: number;
  /** right minus left, using pooled cohort weights across matched strata. */
  observedDifference: number;
  crudeDifference: number;
  /** Approximate 95% normal interval, only when every stratum has >=30 observations per side. */
  confidenceInterval: readonly [number, number] | null;
  warnings: readonly string[];
}
export type Comparison =
  | { status: "blocked"; reasons: readonly string[] }
  | {
      status: "compared";
      interpretation: "descriptive-only";
      differences: readonly Difference[];
      warnings: readonly string[];
      coverage: { left: number; right: number; matchedStrata: number };
      drilldowns: readonly Drilldown[];
    };
