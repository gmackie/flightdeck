import { LIMITS } from "./bounds";
import { MIN_COHORT_FLOOR } from "./config";

/** Attached to every aggregate: these are observed process patterns, not causal findings. */
export const OBSERVATIONAL_CAVEATS = [
  "Observed process pattern over the selected cohort; it is not a causal conclusion.",
  "Differences can reflect case mix, seasonality, workload, data completeness or concurrent changes.",
  "Elapsed time in a stage is calendar time, not effort or hands-on work.",
] as const;

export const CASE_CAVEATS = [
  "One case's recorded stage history; it does not explain why the case moved as it did.",
] as const;

export type MetricId =
  | "stage_dwell"
  | "open_in_stage"
  | "funnel_reach_rate"
  | "step_conversion"
  | "cycle_time"
  | "completion_rate"
  | "variant_share"
  | "bottleneck_signal"
  | "data_freshness"
  | "small_cohort_suppression";

export type MetricDescription = {
  id: MetricId;
  label: string;
  unit: string;
  definition: string;
  computation: string;
  caveats: string[];
  used_by: string[];
};

export const METRICS: Record<MetricId, MetricDescription> = {
  stage_dwell: {
    id: "stage_dwell",
    label: "Stage dwell time (p50, p90, mean)",
    unit: "milliseconds",
    definition: "Elapsed time from entering a stage to leaving it, over completed stage visits.",
    computation:
      "Nearest-rank p50 and p90 and the arithmetic mean over completed intervals of cases that started in the window. Each re-entry is a separate interval. Open intervals are excluded and reported as open_n.",
    caveats: [
      "Censoring: long-running open cases are excluded until they leave the stage, which biases recent windows low.",
      "Calendar time, not effort.",
    ],
    used_by: ["get_stage_dwell", "list_bottlenecks"],
  },
  open_in_stage: {
    id: "open_in_stage",
    label: "Open cases in stage",
    unit: "cases",
    definition: "Distinct cases currently in the stage, as of the data watermark.",
    computation: "Cases whose latest interval in the stage has no exit time.",
    caveats: [`Reported as null when between 1 and k-1 cases are open (k >= ${MIN_COHORT_FLOOR}).`],
    used_by: ["get_stage_dwell", "list_bottlenecks"],
  },
  funnel_reach_rate: {
    id: "funnel_reach_rate",
    label: "Funnel reach rate",
    unit: "ratio 0..1",
    definition: "Share of the cohort that reached a stage at least once.",
    computation: "reached_n / cohort_n, where the cohort is the cases that started in the window.",
    caveats: [
      "Open cases may still reach later stages; recent cohorts understate eventual reach.",
      "Cases can skip stages, so reach is not always monotone along the funnel.",
    ],
    used_by: ["get_funnel"],
  },
  step_conversion: {
    id: "step_conversion",
    label: "Step conversion",
    unit: "ratio",
    definition: "Cases reaching a step divided by cases reaching the previous step.",
    computation:
      "reached_n(step) / reached_n(previous step); null when either step is withheld. It can exceed 1 when cases skip the previous step.",
    caveats: ["An observed ratio, not the probability that one step causes the next."],
    used_by: ["get_funnel"],
  },
  cycle_time: {
    id: "cycle_time",
    label: "Cycle time",
    unit: "milliseconds",
    definition: "Elapsed time from case start to case end, for closed cases.",
    computation: "Median over closed cases of the cohort (or of one path variant).",
    caveats: ["Excludes open cases, so it is biased toward cases that finished quickly."],
    used_by: ["compare_workflow_variants"],
  },
  completion_rate: {
    id: "completion_rate",
    label: "Completion rate",
    unit: "ratio 0..1",
    definition: "Share of the cohort that is closed, with any outcome.",
    computation: "completed_n / total_n.",
    caveats: ["Depends on how long the cohort has had to finish."],
    used_by: ["compare_workflow_variants"],
  },
  variant_share: {
    id: "variant_share",
    label: "Path variant share",
    unit: "ratio 0..1",
    definition: "Share of the cohort that followed one exact sequence of stage visits.",
    computation: `Cases per distinct path / total cases. Paths with fewer than k cases are pooled into "other"; at most ${LIMITS.maxVariants} variants are listed.`,
    caveats: ["Open cases have partial paths and count under the path so far."],
    used_by: ["compare_workflow_variants"],
  },
  bottleneck_signal: {
    id: "bottleneck_signal",
    label: "Bottleneck signal",
    unit: "score 0..1 plus observed values",
    definition:
      "A ranking of stages by observed waiting: share of the median end-to-end time spent in the stage, tail spread (p90 / p50) and open work.",
    computation:
      "score = 0.6 * (stage p50 / sum of released stage p50s) + 0.25 * min(1, (p90/p50 - 1) / 4) + 0.15 * (open_n / sum of open_n). Only released (unsuppressed) stages are scored.",
    caveats: [
      "A heuristic for where to look, not a diagnosis: a long stage can be intended (for example, a deliberate soak period).",
      "Not causal: removing the stage's delay need not shorten the process by the same amount.",
    ],
    used_by: ["list_bottlenecks"],
  },
  data_freshness: {
    id: "data_freshness",
    label: "Data freshness",
    unit: "milliseconds of lag",
    definition: "How far the read model trails the newest events it has accepted.",
    computation:
      "lag_ms = as_of - watermark. Status is fresh within 15 minutes, stale after that, unavailable before any projection exists.",
    caveats: ["Late or corrected events can still change past numbers after they are fresh."],
    used_by: ["get_data_freshness", "every tool's provenance"],
  },
  small_cohort_suppression: {
    id: "small_cohort_suppression",
    label: "Small-cohort suppression",
    unit: "rule",
    definition: `Groups with fewer than k distinct cases (k >= ${MIN_COHORT_FLOOR}) are withheld without any count.`,
    computation:
      'When exactly one group of a breakdown is withheld, the next smallest is withheld too ("complementary"). Rare path variants are pooled into "other".',
    caveats: [
      "Results remain observational aggregates; combining many overlapping queries can still narrow down small groups, so access is limited to analysts.",
    ],
    used_by: ["every aggregate tool"],
  },
};

export const METRIC_IDS = Object.keys(METRICS) as [MetricId, ...MetricId[]];

/** The `lifecycle://spec/workflow-definition` resource. */
export const WORKFLOW_DEFINITION_SPEC = {
  $id: "lifecycle://spec/workflow-definition",
  title: "Lifecycle workflow definition and read contract",
  description:
    "A workflow definition describes a generic, versioned process: ordered stages, terminal outcomes and the categorical dimensions aggregates may be grouped or filtered by. It holds no case data.",
  definition: {
    workflow_key: "Slug [a-z0-9][a-z0-9_-]{0,63}, stable across versions.",
    version: "Positive integer. Cases record the version they started on.",
    label: "Display name, at most 120 characters.",
    description: "Short description, at most 120 characters.",
    stages: "Ordered list of { key (slug), label, order, terminal }. At most 50.",
    outcomes: "Slugs a closed case can end with, e.g. completed or abandoned.",
    dimensions:
      "Categorical fields { key, label, values[] }. Only listed values are ever returned, grouped or filtered by. No free text, identifiers or personal attributes.",
    published_at: "When the version was published (ms since epoch; tools return ISO 8601).",
  },
  case_model: {
    case_id: "Opaque id [A-Za-z0-9_-]{1,64}. Never an email, name or natural key.",
    status: "open or closed.",
    timeline:
      "Stage intervals { stage_key, attempt, state, entered_at, exited_at }. state is active, completed, skipped or interrupted. No actors, notes or comments.",
  },
  read_contract: {
    source_of_truth:
      "The Workstream H lifecycle read API (a derived, rebuildable read model). The MCP server never reads raw event storage and accepts no SQL.",
    authorization:
      "Cloudflare Access identity plus an app-scoped grant. Definitions and single cases need lifecycle:read (reader+); aggregates need process:read (analyst+). Service tokens act as reader at most.",
    bounds: {
      max_page_size: LIMITS.maxPageSize,
      max_timeline_page: LIMITS.maxTimelinePage,
      max_pages_per_cursor: LIMITS.maxPages,
      max_window_days: LIMITS.maxWindowDays,
      default_window_days: LIMITS.defaultWindowDays,
      max_funnel_stages: LIMITS.maxFunnelStages,
      max_filters: LIMITS.maxFilters,
      max_result_chars: LIMITS.maxResultChars,
    },
    suppression: METRICS.small_cohort_suppression.definition,
    provenance:
      "Every result carries provenance: source, synthetic flag, source version, as_of, freshness and the normalized query.",
    interpretation: OBSERVATIONAL_CAVEATS[0],
  },
} as const;
