import type { Dimension, Metric } from "@flightdeckhq/lifecycle-queries";
import type {
  Budget,
  CatalogStage,
  QueryArm,
  QueryPurpose,
  RecipeDescriptor,
  RecipeId,
} from "./types.js";

/** Absolute ceilings. Recipe defaults and request budgets can never exceed these. */
export const HARD_LIMITS: Budget = Object.freeze({
  maxQueries: 24,
  maxStages: 8,
  maxWindowDays: 92,
  maxConcurrency: 4,
  queryTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
  maxCostUnits: 2_000,
  maxRowsPerQuery: 50,
});

const budget = (overrides: Partial<Budget> = {}): Budget =>
  Object.freeze({
    maxQueries: 12,
    maxStages: 6,
    maxWindowDays: 31,
    maxConcurrency: 3,
    queryTimeoutMs: 10_000,
    totalTimeoutMs: 45_000,
    maxCostUnits: 600,
    maxRowsPerQuery: 40,
    ...overrides,
  });

const COMMON_SAFEGUARDS = [
  "Every quantitative statement must cite evidence row refs from this pack; absent rows are not zeros.",
  "Suppressed, missing, stale or truncated evidence means cannot_determine, never an estimate.",
  "Percentiles are over observed (exited) samples only; right-censored open work is reported separately.",
  "Per-stage dwell is not additive: stages in different lanes can overlap, so never sum stage dwell into a cycle time.",
  "Findings are descriptive or observational associations, not causal effects or significance tests.",
] as const;

const CONTEXT = {
  id: "context",
  statement: "Descriptive measurements needed to interpret the other hypotheses.",
  supportedWhen: "Not applicable: context is never supported or falsified.",
  falsifiedWhen: "Not applicable.",
} as const;

export interface QuerySpec {
  id: string;
  purpose: QueryPurpose;
  role: "gate" | "evidence";
  arm: QueryArm;
  stageId: string | null;
  metric: Metric;
  groupBy: readonly Dimension[];
}

export interface Recipe extends RecipeDescriptor {
  specs(context: {
    stages: readonly CatalogStage[];
    extraGroupBy: readonly Dimension[];
    referenceCaseMix: readonly string[];
    referenceCohortId: string;
  }): QuerySpec[];
}

const strata = (extra: readonly Dimension[]): Dimension[] => ["caseMix", ...extra];
const spec = (
  purpose: QueryPurpose,
  arm: QueryArm,
  metric: Metric,
  groupBy: readonly Dimension[],
  role: "gate" | "evidence" = "evidence",
  stageId: string | null = null,
): QuerySpec => ({
  id: [purpose, arm, ...(stageId === null ? [] : [stageId])].join("."),
  purpose,
  role,
  arm,
  stageId,
  metric,
  groupBy,
});
const dwell = (arm: QueryArm, stage: CatalogStage, groupBy: readonly Dimension[]) =>
  spec(
    "stage-dwell",
    arm,
    { kind: "stage-dwell", stageId: stage.id },
    groupBy,
    "evidence",
    stage.id,
  );

const RECIPES: readonly Recipe[] = [
  {
    id: "process-health",
    version: 1,
    title: "Process health",
    question:
      "What is the current state of this process: volume, open work, outcomes and stage dwell?",
    parameters: {
      baselineWindow: "forbidden",
      baselineCohort: "forbidden",
      stages: "optional",
      extraGroupBy: ["definitionVersion", "variantId"],
    },
    hypotheses: [
      CONTEXT,
      {
        id: "H1",
        statement: "A large share of cases in the window is still open (right-censored) at asOf.",
        supportedWhen: "Open share is at or above the material share threshold in a stratum.",
        falsifiedWhen: "Open share is below the threshold in every determinable stratum.",
      },
      {
        id: "H2",
        statement: "Failed or cancelled outcomes are a material share of cases.",
        supportedWhen: "Failed + cancelled share is at or above the material share threshold.",
        falsifiedWhen: "The share is below the threshold in every determinable stratum.",
      },
    ],
    alternatives: [
      "A recent window is immature: open share reflects elapsed time, not a stuck process.",
      "Case mix or definition version changed, altering what counts as a case.",
    ],
    safeguards: COMMON_SAFEGUARDS,
    budget: budget(),
    prompt: "process-health",
    specs: ({ stages, extraGroupBy }) => [
      spec("case-counts", "current", { kind: "case-counts" }, strata(extraGroupBy), "gate"),
      spec("outcomes", "current", { kind: "outcomes" }, strata(extraGroupBy)),
      spec("open-age", "current", { kind: "current-open-age" }, strata(extraGroupBy)),
      ...stages.map((stage) => dwell("current", stage, strata(extraGroupBy))),
    ],
  },
  {
    id: "bottleneck-triage",
    version: 1,
    title: "Bottleneck triage",
    question: "Where is stage dwell, and open work, concentrated within each case-mix stratum?",
    parameters: {
      baselineWindow: "forbidden",
      baselineCohort: "forbidden",
      stages: "optional",
      extraGroupBy: [],
    },
    hypotheses: [
      CONTEXT,
      {
        id: "H1",
        statement: "Observed median dwell is concentrated in one stage rather than spread evenly.",
        supportedWhen:
          "The highest stage median exceeds the next highest by at least the minimum effect ratio.",
        falsifiedWhen: "The top two stage medians are within the minimum effect ratio.",
      },
      {
        id: "H2",
        statement: "Open (right-censored) work is concentrated in one stage.",
        supportedWhen: "One stage holds strictly the most censored cases with visible counts.",
        falsifiedWhen: "No stage holds open work, or the top stages are tied.",
      },
    ],
    alternatives: [
      "Long dwell reflects waiting on an external party or calendar time rather than capacity.",
      "A parallel stage overlaps others, so its dwell does not lengthen total cycle time.",
      "Case-mix composition differs between stages that are reached by different cases.",
    ],
    safeguards: COMMON_SAFEGUARDS,
    budget: budget(),
    prompt: "bottleneck-triage",
    specs: ({ stages }) => [
      spec("case-counts", "current", { kind: "case-counts" }, ["caseMix"], "gate"),
      ...stages.map((stage) => dwell("current", stage, ["caseMix"])),
      spec("open-age", "current", { kind: "current-open-age" }, ["caseMix"]),
    ],
  },
  {
    id: "dwell-regression",
    version: 1,
    title: "Dwell regression",
    question: "Did observed stage dwell slow down versus an equal-length baseline window?",
    parameters: {
      baselineWindow: "required",
      baselineCohort: "optional",
      stages: "optional",
      extraGroupBy: [],
    },
    hypotheses: [
      CONTEXT,
      {
        id: "H1",
        statement: "Observed median stage dwell increased versus the baseline window.",
        supportedWhen:
          "A matched stratum's p50 rose by at least the minimum effect ratio with comparable censoring and coverage.",
        falsifiedWhen:
          "All determinable matched strata changed less than the minimum effect ratio or fell.",
      },
      {
        id: "H2",
        statement: "Case-mix composition shifted between the windows (alternative explanation).",
        supportedWhen:
          "A stratum's share of cases changed by at least the minimum share difference.",
        falsifiedWhen: "All stratum shares are within the minimum share difference.",
      },
    ],
    alternatives: [
      "Case-mix shift: a pooled slowdown can come from more slow cases rather than slower stages.",
      "Maturity: the newer window has had less time to finish, so observed samples favor fast cases.",
      "Definition-version or instrumentation change between windows.",
      "Seasonality or calendar effects (holidays, release freezes).",
    ],
    safeguards: [
      ...COMMON_SAFEGUARDS,
      "Both windows share one knowledge asOf; differing maturity is reported, not corrected.",
    ],
    budget: budget({ maxQueries: 16, maxCostUnits: 900 }),
    prompt: "dwell-regression",
    specs: ({ stages }) => [
      spec("case-counts", "current", { kind: "case-counts" }, ["caseMix"], "gate"),
      spec("case-counts", "baseline", { kind: "case-counts" }, ["caseMix"], "gate"),
      ...stages.flatMap((stage) => [
        dwell("current", stage, ["caseMix"]),
        dwell("baseline", stage, ["caseMix"]),
      ]),
    ],
  },
  {
    id: "variant-comparison",
    version: 1,
    title: "Process variant comparison",
    question: "Within matched case mix, do process variants differ in stage dwell or outcomes?",
    parameters: {
      baselineWindow: "forbidden",
      baselineCohort: "forbidden",
      stages: "optional",
      extraGroupBy: [],
    },
    hypotheses: [
      CONTEXT,
      {
        id: "H1",
        statement: "Variants differ in observed stage dwell within the same case-mix stratum.",
        supportedWhen:
          "A variant's p50 differs from the reference variant by at least the minimum effect ratio.",
        falsifiedWhen: "All determinable variant pairs are within the minimum effect ratio.",
      },
      {
        id: "H2",
        statement: "Variants differ in terminal outcome mix within the same case-mix stratum.",
        supportedWhen:
          "Completed or failed share differs by at least the minimum share difference.",
        falsifiedWhen: "All determinable shares are within the minimum share difference.",
      },
    ],
    alternatives: [
      "Selection: cases are routed to variants by attributes that also drive dwell.",
      "Variants reach stages at different rates, so per-stage samples cover different cases.",
    ],
    safeguards: [
      ...COMMON_SAFEGUARDS,
      "Variants are compared only within the same case-mix stratum, against the largest variant.",
    ],
    budget: budget(),
    prompt: "compare-cohorts",
    specs: ({ stages }) => [
      spec("case-counts", "current", { kind: "case-counts" }, ["caseMix", "variantId"], "gate"),
      spec("outcomes", "current", { kind: "outcomes" }, ["caseMix", "variantId"]),
      ...stages.map((stage) => dwell("current", stage, ["caseMix", "variantId"])),
    ],
  },
  {
    id: "intervention-review",
    version: 1,
    title: "Intervention review",
    question:
      "Is an intervention cohort associated with different stage dwell and independent outcomes than a matched reference cohort?",
    parameters: {
      baselineWindow: "forbidden",
      baselineCohort: "required",
      stages: "optional",
      extraGroupBy: [],
    },
    hypotheses: [
      CONTEXT,
      {
        id: "H1",
        statement: "The intervention cohort shows lower observed stage dwell than the reference.",
        supportedWhen:
          "A matched stratum's p50 is lower by at least the minimum effect ratio with comparable censoring.",
        falsifiedWhen: "All determinable strata are within the minimum effect ratio or higher.",
      },
      {
        id: "H2",
        statement: "Independent outcomes worsened in the intervention cohort (counterevidence).",
        supportedWhen:
          "Completed share fell or failed share rose by at least the minimum share difference.",
        falsifiedWhen: "Outcome shares held within the minimum share difference.",
      },
    ],
    alternatives: [
      "Cohort assignment was not random; differences may reflect who was enrolled.",
      "Faster dwell can come from earlier abandonment (cancellations) rather than better flow.",
      "Concurrent changes affected both cohorts unequally.",
    ],
    safeguards: [
      ...COMMON_SAFEGUARDS,
      "Intervention and reference must stratify identical case mixes in the same window and asOf.",
      "An improvement claim needs dwell evidence AND non-worsening independent outcomes.",
    ],
    budget: budget({ maxQueries: 14 }),
    prompt: "intervention-review",
    specs: ({ stages, referenceCaseMix, referenceCohortId }) => [
      spec("case-counts", "current", { kind: "case-counts" }, ["caseMix"], "gate"),
      spec("case-counts", "reference", { kind: "case-counts" }, ["caseMix"], "gate"),
      ...stages.map((stage) =>
        spec(
          "stage-comparison",
          "current",
          {
            kind: "comparison",
            stageId: stage.id,
            reference: { id: referenceCohortId, caseMix: referenceCaseMix },
          },
          [],
          "evidence",
          stage.id,
        ),
      ),
      spec("outcomes", "current", { kind: "outcomes" }, ["caseMix"]),
      spec("outcomes", "reference", { kind: "outcomes" }, ["caseMix"]),
    ],
  },
  {
    id: "capacity-risk",
    version: 1,
    title: "Capacity risk",
    question: "Are arrivals rising and where is open work accumulating?",
    parameters: {
      baselineWindow: "required",
      baselineCohort: "optional",
      stages: "optional",
      extraGroupBy: [],
    },
    hypotheses: [
      CONTEXT,
      {
        id: "H1",
        statement: "Arrivals (case starts) increased versus the equal-length baseline window.",
        supportedWhen: "A stratum's case count rose by at least the minimum effect ratio.",
        falsifiedWhen: "All determinable strata rose less than the minimum effect ratio or fell.",
      },
      {
        id: "H2",
        statement: "Open (right-censored) work is accumulating in one stage.",
        supportedWhen: "One stage holds strictly the most censored cases with visible counts.",
        falsifiedWhen: "No stage holds open work, or the top stages are tied.",
      },
    ],
    alternatives: [
      "Arrivals counts depend on case-start cohort membership, not workload per case.",
      "Open work in the newest window is expected; compare open age before inferring backlog.",
    ],
    safeguards: COMMON_SAFEGUARDS,
    budget: budget(),
    prompt: "capacity-risk",
    specs: ({ stages }) => [
      spec("case-counts", "current", { kind: "case-counts" }, ["caseMix"], "gate"),
      spec("case-counts", "baseline", { kind: "case-counts" }, ["caseMix"], "gate"),
      spec("open-age", "current", { kind: "current-open-age" }, ["caseMix"]),
      ...stages.map((stage) => dwell("current", stage, ["caseMix"])),
    ],
  },
];

export function getRecipe(id: RecipeId, version?: number): Recipe | undefined {
  return RECIPES.find(
    (recipe) => recipe.id === id && (version === undefined || recipe.version === version),
  );
}

/** Serializable descriptors, e.g. for an MCP tool listing. */
export function describeRecipes(): RecipeDescriptor[] {
  return RECIPES.map(({ specs: _, ...descriptor }) => structuredClone(descriptor));
}
