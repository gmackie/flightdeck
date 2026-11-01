/** Explicit package v1 transport, separate from bounded-read-bridge@1. */

import { RECIPE_IDS } from "@flightdeckhq/lifecycle-investigations";
import { DIMENSIONS } from "@flightdeckhq/lifecycle-queries";
import { z } from "zod";

const token = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/);
const utc = z.iso.datetime({ precision: 3 });
const num = z.number().finite();
const count = num.int().nonnegative();
const texts = z.array(z.string());
const ids = z.array(token);
const dimension = z.enum(DIMENSIONS);
const group = z.strictObject(Object.fromEntries(DIMENSIONS.map((key) => [key, token.optional()])));
const cohort = z.strictObject({ id: token, caseMix: ids.min(1).max(4) });
const window = z.strictObject({ from: utc, to: utc });
const budgetShape = {
  maxQueries: count.min(1).max(14),
  maxStages: count.min(1).max(8),
  maxWindowDays: count.min(1).max(92),
  maxConcurrency: count.min(1).max(2),
  queryTimeoutMs: count.min(1).max(1_000),
  totalTimeoutMs: count.min(1).max(2_000),
  maxCostUnits: count.min(1).max(600),
  maxRowsPerQuery: count.min(1).max(20),
};
const budget = z.strictObject(budgetShape);
const policy = z.strictObject({
  minEffectRatio: num,
  minShareDifference: num,
  materialShare: num,
  maxCensoredShare: num,
  maxCensoredShareGap: num,
  minCoverageRatio: num,
  maxWatermarkLagMs: num,
});
const scope = z.strictObject({
  appId: token,
  definitionId: token,
  definitionVersions: ids,
  baselineDefinitionVersions: ids,
  comparisonKey: token,
  metricVersion: z.literal("lifecycle.v1"),
  catalogRevision: token,
});
const recipe = z.strictObject({ id: z.enum(RECIPE_IDS), version: count });
const stage = z.strictObject({ id: token, lane: token });
const hypothesis = z.strictObject({
  id: token,
  statement: z.string(),
  supportedWhen: z.string(),
  falsifiedWhen: z.string(),
});
const metric = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("stage-dwell"), stageId: token }),
  z.strictObject({ kind: z.literal("current-open-age") }),
  z.strictObject({ kind: z.literal("outcomes") }),
  z.strictObject({ kind: z.literal("funnel"), checkpoints: ids }),
  z.strictObject({ kind: z.literal("variant-counts") }),
  z.strictObject({ kind: z.literal("case-counts") }),
  z.strictObject({ kind: z.literal("comparison"), stageId: token, reference: cohort }),
]);
const query = z.strictObject({
  appId: token,
  definitionId: token,
  definitionVersions: ids,
  metricVersion: z.literal("lifecycle.v1"),
  from: utc,
  to: utc,
  asOf: utc,
  cohort,
  metric,
  groupBy: z.array(dimension),
  filters: z.array(z.strictObject({ field: dimension, values: ids })),
  topN: count,
});
const purpose = z.enum(["case-counts", "outcomes", "open-age", "stage-dwell", "stage-comparison"]);
const arm = z.enum(["current", "baseline", "reference"]);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const packagePlanSchema = z.strictObject({
  schema: z.literal("flightdeck.investigation-plan.v1"),
  id: token,
  digest,
  recipe,
  question: z.string(),
  scope,
  asOf: utc,
  window,
  baselineWindow: window.nullable(),
  cohort,
  baselineCohort: cohort.nullable(),
  stages: z.array(stage),
  queries: z.array(
    z.strictObject({
      id: token,
      purpose,
      role: z.enum(["gate", "evidence"]),
      arm,
      stageId: token.nullable(),
      query,
      digest,
      costUnits: num,
    }),
  ),
  budget,
  policy,
  hypotheses: z.array(hypothesis),
  alternatives: texts,
  safeguards: texts,
  warnings: texts,
});
const sample = z.strictObject({
  sampleSize: count.nullable(),
  observedCases: count.nullable(),
  censoredCases: count.nullable(),
  count: count.nullable(),
  p50Ms: num.nonnegative().nullable(),
  p75Ms: num.nonnegative().nullable(),
  p90Ms: num.nonnegative().nullable(),
  suppressed: z.boolean(),
  suppression: z.strictObject({
    sample: z.boolean(),
    counts: z.boolean(),
    percentiles: z.boolean(),
  }),
});
const missingReason = z.enum([
  "suppressed",
  "insufficient-sample",
  "missing-stratum",
  "no-rows",
  "right-censoring",
  "censoring-imbalance",
  "low-coverage",
  "unknown-coverage",
  "incomplete-window",
  "truncated",
  "stale-watermark",
  "inconsistent-watermark",
  "query-failed",
  "timeout",
  "invalid-result",
  "skipped",
  "insufficient-population",
]);
const finding = z.strictObject({
  id: z.string(),
  hypothesisId: token,
  kind: z.enum([
    "stage-median-rank",
    "stage-open-work-rank",
    "dwell-change",
    "variant-dwell-difference",
    "outcome-share-difference",
    "cohort-dwell-difference",
    "case-mix-shift",
    "arrival-change",
    "open-share",
    "open-age",
    "terminal-outcome-share",
  ]),
  status: z.enum(["observed", "not_observed", "cannot_determine"]),
  statement: z.string(),
  measure: z
    .strictObject({ name: z.string(), value: num, unit: z.enum(["ms", "ratio", "cases"]) })
    .nullable(),
  stratum: group,
  evidenceRefs: texts,
  metadataRefs: texts,
  uncertainty: z.strictObject({
    samples: z.array(
      z.strictObject({
        ref: z.string(),
        sampleSize: count.nullable(),
        observedCases: count.nullable(),
        censoredCases: count.nullable(),
      }),
    ),
    approximation: texts,
    notes: texts,
  }),
  reasons: z.array(missingReason),
  inference: z.enum(["descriptive", "observational-association"]),
});
export const packageEvidenceSchema = z.strictObject({
  schema: z.literal("flightdeck.evidence-pack.v1"),
  id: token,
  digest,
  status: z.enum(["complete", "partial", "cannot_determine"]),
  recipe,
  question: z.string(),
  planDigest: digest,
  scope,
  knowledge: z.strictObject({
    asOf: utc,
    watermark: utc.nullable(),
    distinctWatermarks: count,
    lagMs: num.nullable(),
    stale: z.boolean(),
    maturity: z.array(z.strictObject({ window, maturityMs: num, arm })),
  }),
  cohort,
  baselineCohort: cohort.nullable(),
  evidence: z.array(
    z.strictObject({
      ref: z.string(),
      queryId: token,
      purpose,
      arm,
      stageId: token.nullable(),
      queryDigest: digest,
      status: z.enum(["ok", "failed", "timeout", "invalid_result", "skipped"]),
      resultDigest: digest.nullable(),
      metadata: z
        .strictObject({
          definitionVersions: ids,
          asOf: utc,
          watermark: utc,
          sourceFreshness: z.strictObject({ lagMs: num, coversWindow: z.boolean() }),
          sampleSize: count.nullable(),
          coverage: z.strictObject({
            eligibleCases: count.nullable(),
            coveredCases: count.nullable(),
            ratio: num.nullable(),
          }),
          suppression: z.strictObject({ minSampleSize: count, suppressedRows: count }),
          cohort,
          approximation: z.string(),
          truncated: z.boolean(),
        })
        .nullable(),
      rows: z.array(
        z.strictObject({
          ref: z.string(),
          key: token,
          group,
          sample: sample.nullable(),
          reference: sample.nullable(),
          comparable: z.boolean().nullable(),
          reason: z.enum(["missing-stratum", "suppressed"]).nullable(),
          deltaP50Ms: num.nullable(),
        }),
      ),
    }),
  ),
  findings: z.array(finding),
  hypotheses: z.array(
    hypothesis.extend({
      status: z.enum(["supported", "not_supported", "cannot_determine", "descriptive"]),
      findingIds: texts,
    }),
  ),
  alternatives: texts,
  missing: z.array(
    z.strictObject({ ref: z.string(), reason: missingReason, stratum: group.optional() }),
  ),
  confounders: texts,
  unsupportedClaims: texts,
  warnings: texts,
  safeguards: texts,
  policy,
  limits: z.strictObject({ plannedQueries: count, answeredQueries: count, costUnits: num }),
});

export const engineRequestSchema = z.strictObject({
  recipe: z.enum(RECIPE_IDS),
  recipeVersion: z.literal(1).optional(),
  appId: token,
  definitionId: token,
  definitionVersions: ids.min(1).max(2),
  metricVersion: z.literal("lifecycle.v1"),
  asOf: utc,
  window,
  cohort,
  baseline: z
    .strictObject({
      window: window.optional(),
      cohort: cohort.optional(),
      definitionVersions: ids.min(1).max(2).optional(),
    })
    .optional(),
  stages: ids.min(1).max(8).optional(),
  groupBy: z.array(dimension).max(1).optional(),
  topN: count.min(1).max(20).optional(),
  budget: budget.partial().optional(),
});
// Text is accepted only as bounded client analysis to validate, never as query instructions.
const advisory = z.string().max(500);
const analysis = z.strictObject({
  evidencePackId: token,
  claims: z
    .array(
      z.strictObject({
        claim: advisory,
        kind: z.enum(["observation", "association", "hypothesis", "cannot_determine"]),
        findingIds: z.array(z.string().max(1_024)).max(1),
        evidenceRefs: z.array(z.string().max(160)).max(6),
        uncertainty: z.strictObject({ level: z.enum(["low", "medium", "high"]), notes: advisory }),
        counterevidence: z.array(advisory).max(2),
        actionProposal: z.strictObject({
          kind: z.enum(["none", "next-measurement", "data-quality-fix", "process-experiment"]),
          description: advisory,
        }),
      }),
    )
    .max(1),
  missingEvidence: z.array(advisory).max(2),
  nextMeasurements: z.array(advisory).max(2),
});
export const engineInput = z.strictObject({
  contract_version: z.literal("package-investigation@1"),
  request: engineRequestSchema,
  dependency_scope: z.enum(["workflow_only", "child_dependencies"]).default("workflow_only"),
});
export const engineExecutionInput = engineInput.extend({
  expected_plan_digest: digest,
  analysis: analysis.optional(),
});
const source = z.strictObject({
  kind: z.enum(["fixture", "normalized"]),
  historical_as_of: z.literal(true),
});
export const enginePlanOutput = z.strictObject({
  contract_version: z.literal("package-investigation@1"),
  source,
  plan: packagePlanSchema,
});
export const engineExecutionOutput = z.strictObject({
  contract_version: z.literal("package-investigation@1"),
  source,
  pack: packageEvidenceSchema,
  validation: z
    .strictObject({
      valid: z.boolean(),
      issues: z.array(
        z.strictObject({
          claim: count.nullable(),
          issue: z.enum([
            "wrong-pack",
            "malformed",
            "no-evidence",
            "unknown-finding",
            "unknown-ref",
            "ref-not-in-finding",
            "undetermined-finding-as-fact",
            "pack-cannot-determine",
            "causal-language",
            "unsupported-experiment",
            "unstated-uncertainty",
            "unsupported-statement",
            "incomplete-refs",
          ]),
        }),
      ),
    })
    .nullable(),
});
export type EngineInput = z.infer<typeof engineInput>;
export type EngineExecutionInput = z.infer<typeof engineExecutionInput>;
