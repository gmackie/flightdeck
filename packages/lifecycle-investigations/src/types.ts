import type {
  Cohort,
  Dimension,
  Metric,
  Outcome,
  Query,
  QueryRegistry,
  Sample,
  Utc,
} from "@flightdeckhq/lifecycle-queries";

export const RECIPE_IDS = [
  "process-health",
  "bottleneck-triage",
  "dwell-regression",
  "variant-comparison",
  "intervention-review",
  "capacity-risk",
] as const;
export type RecipeId = (typeof RECIPE_IDS)[number];

/** A canonical stage from the trusted catalog. Stages in different lanes can overlap in time. */
export interface CatalogStage {
  id: string;
  lane: string;
}

/** Trusted interpretation thresholds. These gate what the engine calls observed; they are
 * descriptive cut-offs, not significance tests. */
export interface InterpretationPolicy {
  /** Minimum relative change (e.g. 0.1 = 10%) before a difference is reported as observed. */
  minEffectRatio: number;
  /** Minimum absolute share difference (e.g. 0.05) for outcome/case-mix share findings. */
  minShareDifference: number;
  /** Share of a sample at or above which outcomes are called material (process health). */
  materialShare: number;
  /** A sample with a larger right-censored share yields biased observed percentiles. */
  maxCensoredShare: number;
  /** Two arms whose censored shares differ by more than this are not compared. */
  maxCensoredShareGap: number;
  /** Known coverage ratios below this make findings that use the query undeterminable. */
  minCoverageRatio: number;
  /** Source watermark may lag asOf by at most this much before evidence is stale. */
  maxWatermarkLagMs: number;
}

/** Trusted, server-loaded configuration for exactly one app and definition. Never built from
 * agent or request input. `revision` must change whenever registry, stages or policy change. */
export interface InvestigationCatalog {
  revision: string;
  registry: QueryRegistry;
  stages: readonly CatalogStage[];
  /** Extra grouping dimensions an investigation may request (case mix is always stratified). */
  allowedGroupBy: readonly Dimension[];
  policy?: Partial<InterpretationPolicy>;
}

export interface Budget {
  maxQueries: number;
  maxStages: number;
  maxWindowDays: number;
  maxConcurrency: number;
  queryTimeoutMs: number;
  totalTimeoutMs: number;
  /** Planning heuristic (window days x grouping x arms), not measured scan cost. */
  maxCostUnits: number;
  maxRowsPerQuery: number;
}

export interface TimeWindow {
  from: Utc;
  to: Utc;
}

export interface InvestigationRequest {
  recipe: RecipeId;
  recipeVersion?: number;
  appId: string;
  definitionId: string;
  definitionVersions: readonly string[];
  metricVersion: "lifecycle.v1";
  /** Single knowledge cut-off used by every query in the plan, including baselines. */
  asOf: Utc;
  window: TimeWindow;
  cohort: Cohort;
  baseline?: {
    window?: TimeWindow;
    /** Baseline/reference cohort; must stratify exactly the same case mixes. */
    cohort?: Cohort;
    definitionVersions?: readonly string[];
  };
  stages?: readonly string[];
  groupBy?: readonly Dimension[];
  topN?: number;
  /** Can only tighten the recipe budget. */
  budget?: Partial<Budget>;
}

export type Requirement = "required" | "optional" | "forbidden";

export interface Hypothesis {
  id: string;
  statement: string;
  supportedWhen: string;
  falsifiedWhen: string;
}

export type QueryPurpose =
  | "case-counts"
  | "outcomes"
  | "open-age"
  | "stage-dwell"
  | "stage-comparison";
export type QueryArm = "current" | "baseline" | "reference";

export interface PlannedQuery {
  id: string;
  purpose: QueryPurpose;
  /** Gate queries run first; insufficient or denied gates stop the investigation. */
  role: "gate" | "evidence";
  arm: QueryArm;
  stageId: string | null;
  query: Query;
  digest: string;
  costUnits: number;
}

export interface RecipeDescriptor {
  id: RecipeId;
  version: number;
  title: string;
  question: string;
  parameters: {
    baselineWindow: Requirement;
    baselineCohort: Requirement;
    stages: "optional";
    extraGroupBy: readonly Dimension[];
  };
  hypotheses: readonly Hypothesis[];
  alternatives: readonly string[];
  safeguards: readonly string[];
  budget: Budget;
  prompt: PromptName;
}

export interface InvestigationPlan {
  schema: "flightdeck.investigation-plan.v1";
  id: string;
  digest: string;
  recipe: { id: RecipeId; version: number };
  question: string;
  scope: {
    appId: string;
    definitionId: string;
    definitionVersions: readonly string[];
    baselineDefinitionVersions: readonly string[];
    comparisonKey: string;
    metricVersion: "lifecycle.v1";
    catalogRevision: string;
  };
  asOf: Utc;
  window: TimeWindow;
  baselineWindow: TimeWindow | null;
  cohort: Cohort;
  baselineCohort: Cohort | null;
  stages: readonly CatalogStage[];
  queries: readonly PlannedQuery[];
  budget: Budget;
  policy: InterpretationPolicy;
  hypotheses: readonly Hypothesis[];
  alternatives: readonly string[];
  safeguards: readonly string[];
  warnings: readonly string[];
}

export type MissingReason =
  | "suppressed"
  | "insufficient-sample"
  | "missing-stratum"
  | "no-rows"
  | "right-censoring"
  | "censoring-imbalance"
  | "low-coverage"
  | "unknown-coverage"
  | "incomplete-window"
  | "truncated"
  | "stale-watermark"
  | "inconsistent-watermark"
  | "query-failed"
  | "timeout"
  | "invalid-result"
  | "skipped"
  | "insufficient-population";

export interface MissingEvidence {
  ref: string;
  reason: MissingReason;
  stratum?: Readonly<Partial<Record<Dimension, string>>>;
}

/** Aggregate-only row copied from an adapter result; unknown fields are never copied. */
export interface EvidenceRow {
  ref: string;
  key: string;
  group: Readonly<Partial<Record<Dimension, string>>>;
  sample: Sample | null;
  reference: Sample | null;
  comparable: boolean | null;
  reason: "missing-stratum" | "suppressed" | null;
  deltaP50Ms: number | null;
}

export interface EvidenceMetadata {
  definitionVersions: readonly string[];
  asOf: Utc;
  watermark: Utc;
  sourceFreshness: { lagMs: number; coversWindow: boolean };
  sampleSize: number | null;
  coverage: { eligibleCases: number | null; coveredCases: number | null; ratio: number | null };
  suppression: { minSampleSize: number; suppressedRows: number };
  cohort: Cohort;
  approximation: string;
  truncated: boolean;
}

export type EntryStatus = "ok" | "failed" | "timeout" | "invalid_result" | "skipped";

export interface EvidenceEntry {
  ref: string;
  queryId: string;
  purpose: QueryPurpose;
  arm: QueryArm;
  stageId: string | null;
  queryDigest: string;
  status: EntryStatus;
  resultDigest: string | null;
  metadata: EvidenceMetadata | null;
  rows: readonly EvidenceRow[];
}

export type FindingStatus = "observed" | "not_observed" | "cannot_determine";

export interface FindingCandidate {
  id: string;
  hypothesisId: string;
  kind:
    | "stage-median-rank"
    | "stage-open-work-rank"
    | "dwell-change"
    | "variant-dwell-difference"
    | "outcome-share-difference"
    | "cohort-dwell-difference"
    | "case-mix-shift"
    | "arrival-change"
    | "open-share"
    | "open-age"
    | "terminal-outcome-share";
  status: FindingStatus;
  /** Descriptive, templated text. Never a causal statement. */
  statement: string;
  measure: { name: string; value: number; unit: "ms" | "ratio" | "cases" } | null;
  stratum: Readonly<Partial<Record<Dimension, string>>>;
  /** Exact row refs (`q:<queryId>#<n>`) the measure or the absence of one depends on. */
  evidenceRefs: readonly string[];
  /** Query refs (`q:<queryId>`) whose metadata (coverage, watermark, censoring) applies. */
  metadataRefs: readonly string[];
  uncertainty: {
    samples: readonly {
      ref: string;
      sampleSize: number | null;
      observedCases: number | null;
      censoredCases: number | null;
    }[];
    approximation: readonly string[];
    notes: readonly string[];
  };
  reasons: readonly MissingReason[];
  inference: "descriptive" | "observational-association";
}

export type HypothesisStatus = "supported" | "not_supported" | "cannot_determine" | "descriptive";

export interface EvidencePack {
  schema: "flightdeck.evidence-pack.v1";
  id: string;
  digest: string;
  status: "complete" | "partial" | "cannot_determine";
  recipe: { id: RecipeId; version: number };
  question: string;
  planDigest: string;
  scope: InvestigationPlan["scope"];
  knowledge: {
    asOf: Utc;
    /** Earliest watermark among answered queries, or null when none answered. */
    watermark: Utc | null;
    distinctWatermarks: number;
    lagMs: number | null;
    stale: boolean;
    maturity: { window: TimeWindow; maturityMs: number; arm: QueryArm }[];
  };
  cohort: Cohort;
  baselineCohort: Cohort | null;
  evidence: readonly EvidenceEntry[];
  findings: readonly FindingCandidate[];
  hypotheses: readonly (Hypothesis & { status: HypothesisStatus; findingIds: readonly string[] })[];
  alternatives: readonly string[];
  missing: readonly MissingEvidence[];
  confounders: readonly string[];
  unsupportedClaims: readonly string[];
  warnings: readonly string[];
  safeguards: readonly string[];
  policy: InterpretationPolicy;
  limits: { plannedQueries: number; answeredQueries: number; costUnits: number };
}

/** Caller authorization decision. `scopeKey` is an opaque, non-reversible identity of the
 * principal's current grant scope (e.g. hash of subject + grant revision). */
export type AuthorizationDecision =
  | { allowed: true; appId: string; scopeKey: string }
  | { allowed: false };

export interface AuthorizationRequest {
  appId: string;
  definitionId: string;
  capability: "process:read";
  recipe: RecipeId;
}

export type AuthorizeInvestigation = (
  request: AuthorizationRequest,
) => AuthorizationDecision | Promise<AuthorizationDecision>;

/** Optional result cache. Values are adapter results (aggregates only). */
export interface EvidenceCache {
  get(key: string): Promise<unknown> | unknown;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void> | void;
}

export interface EvidenceStore {
  put(key: string, json: string, ttlSeconds: number): Promise<void> | void;
}

export type { Cohort, Dimension, Metric, Outcome, Query, Sample, Utc };

export type PromptName =
  | "process-health"
  | "bottleneck-triage"
  | "dwell-regression"
  | "compare-cohorts"
  | "intervention-review"
  | "capacity-risk";
