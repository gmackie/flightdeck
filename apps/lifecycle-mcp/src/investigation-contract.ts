import { LIFECYCLE_READ_KEY } from "@flightdeckhq/schema";
import { z } from "zod";
import { ANALYSIS_GOALS } from "./prompts";
import { AppId, outputs } from "./schemas";

/** Transport contract for the future @flightdeckhq/lifecycle-investigations adapter.
 * No question text, executable steps, SQL, model configuration or cross-app scope is accepted.
 * The local bridge only orchestrates existing reads; it is not an investigation reasoning engine.
 */
export const INVESTIGATION_LIMITS = {
  maxCohorts: 2,
  maxSourceReads: 14,
  maxSourceRows: 256,
  timeoutMs: 3000,
  maxWatermarkLagMs: 15 * 60_000,
} as const;

const instant = z.iso.datetime({ offset: true });
const cohort = z.strictObject({
  version: z.number().int().min(1).max(10_000),
  from: instant,
  to: instant,
});

export const investigationInput = z.strictObject({
  app_id: AppId,
  workflow_key: z.string().regex(LIFECYCLE_READ_KEY),
  goal: z.enum(ANALYSIS_GOALS),
  dependency_scope: z
    .enum(["workflow_only", "child_dependencies"])
    .optional()
    .describe(
      "Use child_dependencies for parent blockers or critical-path questions; the current source cannot answer these.",
    ),
  cohorts: z.array(cohort).min(1).max(INVESTIGATION_LIMITS.maxCohorts),
});
export type InvestigationInput = z.infer<typeof investigationInput>;

const plan = z.strictObject({
  contract_version: z.literal("bounded-read-bridge@1"),
  app_id: AppId,
  workflow_key: z.string(),
  goal: z.enum(ANALYSIS_GOALS),
  cohorts: z.array(cohort.extend({ cohort_ref: z.string() })).max(2),
  required_tools: z
    .array(
      z.enum(["get_data_freshness", "get_stage_dwell", "get_funnel", "compare_workflow_variants"]),
    )
    .max(4),
  limits: z.strictObject({
    max_cohorts: z.number(),
    max_source_reads: z.number(),
    max_source_rows: z.number(),
    timeout_ms: z.number(),
    max_result_chars: z.number(),
    min_cohort: z.number(),
  }),
  data_queries_executed: z.literal(0),
  model_invoked: z.literal(false),
  dependency_graph: z.literal("unsupported"),
  guidance: z.string(),
  limitations: z.array(z.string()).max(10),
});
export type InvestigationPlan = z.infer<typeof plan>;

export const sourceSnapshot = z.strictObject({
  as_of: z.number().finite().int().nonnegative(),
  source_version: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9@._/-]+$/),
  event_time_completeness: z.literal("unknown").optional(),
  projection: outputs.get_data_freshness.shape.provenance.shape.projection,
  freshness: z.strictObject({
    status: z.enum(["fresh", "stale", "unavailable"]),
    watermark: z.number().finite().int().nonnegative().nullable(),
    lag_ms: z.number().finite().nonnegative().nullable(),
  }),
});

const entry = z.discriminatedUnion("tool", [
  z.strictObject({ tool: z.literal("get_stage_dwell"), result: outputs.get_stage_dwell }),
  z.strictObject({ tool: z.literal("get_funnel"), result: outputs.get_funnel }),
  z.strictObject({
    tool: z.literal("compare_workflow_variants"),
    result: outputs.compare_workflow_variants,
  }),
]);
const evidenceEntry = z.strictObject({
  ref: z.string(),
  cohort_ref: z.string(),
  query_id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  source_refs: z.array(z.string()).min(1).max(2),
  evidence: entry,
});
export type EvidenceEntry = z.infer<typeof evidenceEntry>;

export const investigationOutputs = {
  plan_investigation: plan,
  collect_investigation_evidence: z.strictObject({
    contract_version: z.literal("bounded-read-bridge@1"),
    app_id: AppId,
    workflow_key: z.string(),
    evidence_id: z.string(),
    evidence_ref: z.string(),
    synthetic: z.boolean(),
    // Null if reads did not share an as_of; never invent an atomic snapshot.
    as_of: z.string().nullable(),
    watermark: z.string().nullable(),
    plan,
    freshness: outputs.get_data_freshness,
    source_reads: z
      .array(
        z.strictObject({
          ref: z.string(),
          method: z.enum([
            "getFreshness",
            "getWorkflowDefinition",
            "getStageDwell",
            "getFunnel",
            "getVariantStats",
          ]),
          snapshot: sourceSnapshot,
        }),
      )
      .max(INVESTIGATION_LIMITS.maxSourceReads),
    entries: z.array(evidenceEntry).max(6),
    checks: z.strictObject({
      status: z.enum(["bounded_evidence", "insufficient_evidence"]),
      snapshot_consistent: z.boolean(),
      fresh: z.boolean(),
      window_covered: z.boolean(),
      min_cohort: z.number(),
      any_suppressed: z.boolean(),
      samples: z
        .array(
          z.strictObject({
            cohort_ref: z.string(),
            n: z.number().nullable(),
            completed_n: z.number().nullable(),
            open_n: z.number().nullable(),
          }),
        )
        .max(2),
      coverage: z.literal("upstream_event_coverage_unknown"),
      censoring: z.literal("completed_intervals_only_open_cases_right_censored"),
      matched_cohorts: z.literal("not_verified"),
      outcome_detail: z.literal("completion_only_no_outcome_breakdown"),
    }),
    warnings: z.array(z.string()).max(16),
    model_invoked: z.literal(false),
    causal: z.literal(false),
  }),
};
export type InvestigationEvidence = z.infer<
  typeof investigationOutputs.collect_investigation_evidence
>;

/** Replace this adapter with package calls when its reviewed public contract is available.
 * Authorization and bounded source access remain enforced by the MCP boundary.
 */
export interface InvestigationBridge {
  plan(input: InvestigationInput): Promise<InvestigationPlan>;
  collect(input: InvestigationInput): Promise<InvestigationEvidence>;
}
