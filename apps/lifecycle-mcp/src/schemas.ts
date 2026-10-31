import { z } from "zod";
import { LIMITS } from "./bounds";
import { METRIC_IDS } from "./glossary";

/**
 * Tool input and output schemas. Inputs accept only bounded, typed parameters (no SQL, no
 * expressions, no free-text search). Outputs are strict objects: a field the tools did not
 * deliberately add fails output validation instead of reaching the client.
 */

const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

export const AppId = z
  .string()
  .regex(/^[\w-]{3,64}$/)
  .describe("Flightdeck app id the caller holds a grant for, e.g. synthetic-release.");
const WorkflowKey = slug.describe("Workflow key from list_workflow_definitions.");
const CaseId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .describe("Opaque case id. Never an email or name.");
const Version = z.number().int().min(1).max(10_000);
const Instant = z
  .string()
  .max(40)
  .describe("YYYY-MM-DD (UTC) or an ISO 8601 date-time with an offset.");
const Cursor = z.string().max(1400).describe("next_cursor from the previous page.");
const Filters = z
  .array(z.strictObject({ dimension: slug, value: slug }))
  .max(LIMITS.maxFilters)
  .describe("Declared categorical dimension filters (see the workflow definition).");

const windowFields = {
  from: Instant.optional().describe(
    `Cohort start (inclusive): cases that started at or after it. Default: ${LIMITS.defaultWindowDays} days before \`to\`.`,
  ),
  to: Instant.optional().describe(
    `Cohort end (exclusive). Default: now. At most ${LIMITS.maxWindowDays} days after \`from\`.`,
  ),
};

const cohortSpec = z
  .strictObject({
    version: Version.optional().describe("Workflow version; default the latest."),
    ...windowFields,
  })
  .describe("One cohort: cases of one workflow version that started in [from, to).");

export const QUESTIONS = [
  "bottleneck",
  "dwell_change",
  "variants",
  "intervention",
  "health",
] as const;

export const inputs = {
  list_workflow_definitions: z.strictObject({
    app_id: AppId,
    workflow_key: WorkflowKey.optional(),
    limit: z.number().int().min(1).max(LIMITS.maxPageSize).optional(),
    cursor: Cursor.optional(),
  }),
  get_case_summary: z.strictObject({ app_id: AppId, case_id: CaseId }),
  get_case_timeline: z.strictObject({
    app_id: AppId,
    case_id: CaseId,
    limit: z.number().int().min(1).max(LIMITS.maxTimelinePage).optional(),
    cursor: Cursor.optional(),
  }),
  get_stage_dwell: z.strictObject({
    app_id: AppId,
    workflow_key: WorkflowKey,
    version: Version.optional().describe("Workflow version; default the latest."),
    ...windowFields,
    group_by: slug.optional().describe("A declared dimension to break results down by."),
    filters: Filters.optional(),
  }),
  get_funnel: z.strictObject({
    app_id: AppId,
    workflow_key: WorkflowKey,
    version: Version.optional().describe("Workflow version; default the latest."),
    stages: z
      .array(slug)
      .min(2)
      .max(LIMITS.maxFunnelStages)
      .optional()
      .describe("Ordered stage keys. Default: every stage in definition order."),
    ...windowFields,
    group_by: slug.optional(),
    filters: Filters.optional(),
  }),
  compare_workflow_variants: z.strictObject({
    app_id: AppId,
    workflow_key: WorkflowKey,
    baseline_version: Version.optional().describe("Default: the latest version."),
    candidate_version: Version.optional().describe(
      "Compare against this version. Omit to list the path variants of one version.",
    ),
    ...windowFields,
    filters: Filters.optional(),
    limit: z.number().int().min(1).max(LIMITS.maxVariants).optional(),
  }),
  list_bottlenecks: z.strictObject({
    app_id: AppId,
    workflow_key: WorkflowKey,
    version: Version.optional(),
    ...windowFields,
    filters: Filters.optional(),
    limit: z.number().int().min(1).max(LIMITS.maxBottlenecks).optional(),
  }),
  describe_metric: z.strictObject({
    metric: z
      .enum(METRIC_IDS)
      .describe("Metric id; the lifecycle://glossary/metrics resource lists all."),
  }),
  get_data_freshness: z.strictObject({ app_id: AppId }),
  get_data_quality: z.strictObject({
    app_id: AppId,
    workflow_key: WorkflowKey,
    version: Version.optional(),
    ...windowFields,
    filters: Filters.optional(),
  }),
  compare_case_mix: z.strictObject({
    app_id: AppId,
    workflow_key: WorkflowKey,
    baseline: cohortSpec,
    candidate: cohortSpec,
    dimensions: z
      .array(slug)
      .min(1)
      .max(5)
      .optional()
      .describe("Declared dimensions to compare. Default: all declared, at most 5."),
  }),
  build_evidence_pack: z.strictObject({
    app_id: AppId,
    workflow_key: WorkflowKey,
    question: z
      .enum(QUESTIONS)
      .describe(
        "bottleneck | health: one cohort. dwell_change | intervention: baseline vs candidate (before/after). variants: baseline vs candidate version.",
      ),
    baseline: cohortSpec.optional(),
    candidate: cohortSpec.optional(),
  }),
};

const iso = z.string();
const isoOrNull = iso.nullable();
const withheld = z.strictObject({
  suppressed: z.literal(true),
  reason: z.enum(["small_cohort", "complementary", "source"]),
});
const window = z.strictObject({ from: iso, to: iso });

const provenance = z.strictObject({
  source: z.enum(["synthetic", "lifecycle-read-api", "server"]),
  synthetic: z.boolean(),
  source_version: z.string(),
  as_of: iso,
  generated_at: iso,
  freshness: z.strictObject({
    status: z.enum(["fresh", "stale", "unavailable"]),
    watermark: isoOrNull,
    lag_ms: z.number().nullable(),
  }),
  tool: z.string(),
  query: z.record(z.string(), z.unknown()),
});

const interpretation = z.strictObject({
  kind: z.enum(["observed_process_pattern", "case_record", "definition", "reference", "freshness"]),
  causal: z.literal(false),
  caveats: z.array(z.string()),
});

const envelope = <T extends z.ZodType>(data: T) =>
  z.strictObject({
    app_id: z.string().nullable(),
    data,
    page: z
      .strictObject({ next_cursor: z.string().nullable(), page: z.number(), limit: z.number() })
      .optional(),
    privacy: z.strictObject({ min_cohort: z.number(), any_suppressed: z.boolean() }).optional(),
    provenance,
    interpretation,
  });

const definition = z.strictObject({
  workflow_key: z.string(),
  version: z.number(),
  label: z.string(),
  description: z.string(),
  stages: z.array(
    z.strictObject({
      key: z.string(),
      label: z.string(),
      order: z.number(),
      terminal: z.boolean(),
    }),
  ),
  outcomes: z.array(z.string()),
  dimensions: z.array(
    z.strictObject({ key: z.string(), label: z.string(), values: z.array(z.string()) }),
  ),
  published_at: iso,
  resource_uri: z.string(),
});

const caseSummary = z.strictObject({
  case_id: z.string(),
  workflow_key: z.string(),
  version: z.number(),
  status: z.enum(["open", "closed"]),
  outcome: z.string().nullable(),
  current_stage: z.string().nullable(),
  started_at: iso,
  ended_at: isoOrNull,
  last_event_at: iso,
  /** Calendar time from start to end, or to the data watermark for open cases. */
  elapsed_ms: z.number().nullable(),
  dimensions: z.record(z.string(), z.string()),
});

const dwellRow = z.union([
  z.strictObject({
    stage_key: z.string(),
    group: z.string().nullable(),
    suppressed: z.literal(false),
    n: z.number(),
    open_n: z.number().nullable(),
    p50_ms: z.number().nullable(),
    p90_ms: z.number().nullable(),
    mean_ms: z.number().nullable(),
  }),
  withheld.extend({ stage_key: z.string(), group: z.string().nullable() }),
]);

const funnelStep = z.union([
  z.strictObject({
    stage_key: z.string(),
    suppressed: z.literal(false),
    reached_n: z.number(),
    reach_rate: z.number().nullable(),
    conversion_from_previous: z.number().nullable(),
  }),
  withheld.extend({ stage_key: z.string() }),
]);

const funnelGroup = z.union([
  z.strictObject({
    group: z.string().nullable(),
    suppressed: z.literal(false),
    cohort_n: z.number(),
    steps: z.array(funnelStep),
  }),
  withheld.extend({ group: z.string().nullable() }),
]);

const variantCohort = z.union([
  z.strictObject({
    version: z.number(),
    suppressed: z.literal(false),
    total_n: z.number(),
    completed_n: z.number().nullable(),
    completion_rate: z.number().nullable(),
    median_cycle_ms: z.number().nullable(),
    variants: z.array(
      z.strictObject({
        path: z.array(z.string()),
        n: z.number(),
        share: z.number().nullable(),
        completed_n: z.number().nullable(),
        median_cycle_ms: z.number().nullable(),
        cycle_delta_vs_dominant_ms: z.number().nullable(),
      }),
    ),
    other: z
      .union([z.strictObject({ suppressed: z.literal(false), n: z.number() }), withheld])
      .nullable(),
  }),
  withheld.extend({ version: z.number() }),
]);

const cohortRef = z.strictObject({
  role: z.enum(["baseline", "candidate"]),
  version: z.number(),
  window,
  n: z.number().nullable(),
});

const metricDescription = z.strictObject({
  id: z.string(),
  label: z.string(),
  unit: z.string(),
  definition: z.string(),
  computation: z.string(),
  caveats: z.array(z.string()),
  used_by: z.array(z.string()),
});

export const outputs = {
  list_workflow_definitions: envelope(z.strictObject({ definitions: z.array(definition) })),
  get_case_summary: envelope(z.strictObject({ case: caseSummary })),
  get_case_timeline: envelope(
    z.strictObject({
      case_id: z.string(),
      entries: z.array(
        z.strictObject({
          stage_key: z.string(),
          attempt: z.number(),
          state: z.enum(["active", "completed", "skipped", "interrupted"]),
          entered_at: iso,
          exited_at: isoOrNull,
          dwell_ms: z.number().nullable(),
        }),
      ),
    }),
  ),
  get_stage_dwell: envelope(
    z.strictObject({
      workflow_key: z.string(),
      version: z.number(),
      window,
      group_by: z.string().nullable(),
      stages: z.array(dwellRow),
    }),
  ),
  get_funnel: envelope(
    z.strictObject({
      workflow_key: z.string(),
      version: z.number(),
      window,
      group_by: z.string().nullable(),
      stages: z.array(z.string()),
      groups: z.array(funnelGroup),
    }),
  ),
  compare_workflow_variants: envelope(
    z.strictObject({
      workflow_key: z.string(),
      window,
      cohorts: z.array(variantCohort),
      comparison: z
        .strictObject({
          baseline_version: z.number(),
          candidate_version: z.number(),
          comparable: z.boolean(),
          reasons: z.array(z.string()),
          deltas: z
            .strictObject({
              median_cycle_ms: z.number().nullable(),
              completion_rate: z.number().nullable(),
            })
            .nullable(),
        })
        .nullable(),
    }),
  ),
  list_bottlenecks: envelope(
    z.strictObject({
      workflow_key: z.string(),
      version: z.number(),
      window,
      bottlenecks: z.array(
        z.strictObject({
          rank: z.number(),
          stage_key: z.string(),
          score: z.number(),
          signals: z.strictObject({
            share_of_median_path: z.number(),
            tail_ratio: z.number().nullable(),
            share_of_open_work: z.number().nullable(),
          }),
          observed: z.strictObject({
            n: z.number(),
            open_n: z.number().nullable(),
            p50_ms: z.number(),
            p90_ms: z.number().nullable(),
          }),
          evidence: z.literal("observed_association"),
        }),
      ),
    }),
  ),
  describe_metric: envelope(
    z.strictObject({
      metric: z.strictObject({
        id: z.string(),
        label: z.string(),
        unit: z.string(),
        definition: z.string(),
        computation: z.string(),
        caveats: z.array(z.string()),
        used_by: z.array(z.string()),
      }),
    }),
  ),
  get_data_freshness: envelope(
    z.strictObject({
      status: z.enum(["fresh", "stale", "unavailable"]),
      watermark: isoOrNull,
      lag_ms: z.number().nullable(),
      workflows: z.array(z.strictObject({ workflow_key: z.string(), last_event_at: isoOrNull })),
    }),
  ),
  get_data_quality: envelope(
    z.strictObject({
      workflow_key: z.string(),
      version: z.number(),
      window,
      cohort_n: z.number().nullable(),
      checks: z.array(
        z.strictObject({
          check: z.string(),
          n: z.number().nullable(),
          share: z.number().nullable(),
          severity: z.enum(["info", "warning"]),
          note: z.string(),
        }),
      ),
    }),
  ),
  compare_case_mix: envelope(
    z.strictObject({
      workflow_key: z.string(),
      cohorts: z.array(cohortRef),
      dimensions: z.array(
        z.strictObject({
          dimension: z.string(),
          values: z.array(
            z.strictObject({
              value: z.string(),
              baseline_share: z.number().nullable(),
              candidate_share: z.number().nullable(),
              delta: z.number().nullable(),
            }),
          ),
          max_abs_delta: z.number().nullable(),
          balanced: z.boolean().nullable(),
        }),
      ),
    }),
  ),
  build_evidence_pack: envelope(
    z.strictObject({
      pack_version: z.literal("lifecycle-evidence-pack@1"),
      question: z.enum(QUESTIONS),
      scope: z.strictObject({
        app_id: z.string(),
        workflow_key: z.string(),
        cohorts: z.array(cohortRef),
      }),
      evidence: z.array(
        z.strictObject({
          id: z.string(),
          role: z.enum(["baseline", "candidate", "comparison", "context"]),
          tool: z.string(),
          kind: z.enum(["observed_process_pattern", "data_quality", "case_mix", "freshness"]),
          sample_n: z.number().nullable(),
          any_suppressed: z.boolean(),
          as_of: iso,
          watermark: isoOrNull,
          data: z.record(z.string(), z.unknown()),
        }),
      ),
      derived: z.array(
        z.strictObject({
          id: z.string(),
          from: z.array(z.string()),
          metric: z.string(),
          stage_key: z.string().nullable(),
          value: z.number().nullable(),
          unit: z.string(),
        }),
      ),
      metric_definitions: z.array(metricDescription),
      confounders_to_check: z.array(z.string()),
      censoring: z.array(z.string()),
      unsupported_claims: z.array(z.string()),
      analysis_instructions: z.string(),
    }),
  ),
};

export type ToolName = keyof typeof inputs;
export const TOOL_NAMES = Object.keys(inputs) as ToolName[];
