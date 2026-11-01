import {
  type Cohort,
  DIMENSIONS,
  type Dimension,
  type Query,
  validateQuery,
} from "@flightdeckhq/lifecycle-queries";
import { check, InvestigationError } from "./errors.js";
import { digestOf } from "./hash.js";
import { getRecipe, HARD_LIMITS } from "./recipes.js";
import {
  type Budget,
  type CatalogStage,
  type InterpretationPolicy,
  type InvestigationCatalog,
  type InvestigationPlan,
  type InvestigationRequest,
  type PlannedQuery,
  RECIPE_IDS,
  type TimeWindow,
} from "./types.js";

const DAY_MS = 86_400_000;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

export const DEFAULT_POLICY: InterpretationPolicy = Object.freeze({
  minEffectRatio: 0.1,
  minShareDifference: 0.05,
  materialShare: 0.2,
  maxCensoredShare: 0.5,
  maxCensoredShareGap: 0.15,
  minCoverageRatio: 0.8,
  maxWatermarkLagMs: 6 * 3_600_000,
});

export function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}
export function parseUtc(value: unknown): number | null {
  if (typeof value !== "string" || !UTC.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}
function utc(value: unknown, message: string): number {
  const time = parseUtc(value);
  check(time !== null, "invalid_window", message);
  return time;
}
function tokens(values: unknown, min: number, max: number, message: string): string[] {
  check(
    Array.isArray(values) &&
      values.length >= min &&
      values.length <= max &&
      values.every(isToken) &&
      new Set(values).size === values.length,
    "invalid_request",
    message,
  );
  return [...(values as string[])].sort();
}
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));

function resolvePolicy(policy: Partial<InterpretationPolicy> | undefined): InterpretationPolicy {
  const merged = { ...DEFAULT_POLICY, ...(policy ?? {}) };
  for (const [name, value] of Object.entries(merged)) {
    const bound = name === "maxWatermarkLagMs" ? 31 * DAY_MS : 1;
    check(
      typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= bound,
      "invalid_catalog",
      "Invalid interpretation policy",
    );
  }
  return Object.freeze(merged);
}

export function validateCatalog(catalog: InvestigationCatalog): InterpretationPolicy {
  check(catalog && typeof catalog === "object", "invalid_catalog", "Missing catalog");
  check(isToken(catalog.revision), "invalid_catalog", "Invalid catalog revision");
  check(
    catalog.registry && typeof catalog.registry === "object",
    "invalid_catalog",
    "Missing registry",
  );
  check(
    Array.isArray(catalog.stages) && catalog.stages.length >= 1 && catalog.stages.length <= 64,
    "invalid_catalog",
    "Invalid stage catalog",
  );
  const ids = new Set<string>();
  for (const stage of catalog.stages) {
    check(
      stage && isToken(stage.id) && isToken(stage.lane) && !ids.has(stage.id),
      "invalid_catalog",
      "Invalid or duplicate catalog stage",
    );
    ids.add(stage.id);
    // Every catalog stage must be mapped in at least one registered version.
    check(
      Object.values(catalog.registry.versions ?? {}).some((version) =>
        Object.values(version.stages ?? {}).includes(stage.id),
      ),
      "invalid_catalog",
      "Catalog stage is not mapped in the registry",
    );
  }
  check(
    Array.isArray(catalog.allowedGroupBy) &&
      catalog.allowedGroupBy.every((dimension) => DIMENSIONS.includes(dimension)) &&
      new Set(catalog.allowedGroupBy).size === catalog.allowedGroupBy.length,
    "invalid_catalog",
    "Invalid groupBy allowlist",
  );
  return resolvePolicy(catalog.policy);
}

function resolveBudget(base: Budget, requested: Partial<Budget> | undefined): Budget {
  const resolved = { ...base };
  if (requested !== undefined) {
    check(requested && typeof requested === "object", "invalid_request", "Invalid budget");
    for (const [name, value] of Object.entries(requested)) {
      check(Object.hasOwn(base, name), "invalid_request", "Unknown budget field");
      check(
        Number.isSafeInteger(value) && (value as number) >= 1,
        "invalid_request",
        "Invalid budget value",
      );
      const key = name as keyof Budget;
      resolved[key] = Math.min(resolved[key], value as number);
    }
  }
  for (const key of Object.keys(HARD_LIMITS) as (keyof Budget)[])
    resolved[key] = Math.min(resolved[key], HARD_LIMITS[key]);
  return Object.freeze(resolved);
}

function cohortOf(value: unknown, message: string): Cohort {
  check(value && typeof value === "object", "invalid_request", message);
  const cohort = value as Cohort;
  check(isToken(cohort.id), "invalid_request", message);
  return { id: cohort.id, caseMix: tokens(cohort.caseMix, 1, 20, message) };
}

function windowOf(value: unknown, asOf: number, maxDays: number, availableFrom: number) {
  check(value && typeof value === "object", "invalid_window", "Missing window");
  const window = value as TimeWindow;
  const from = utc(window.from, "Invalid window start"),
    to = utc(window.to, "Invalid window end");
  check(from < to, "invalid_window", "Window must start before it ends");
  check(to <= asOf, "invalid_window", "Window must end at or before asOf");
  check(from >= availableFrom, "invalid_window", "Window starts before retained data");
  check(to - from <= maxDays * DAY_MS, "invalid_window", "Window exceeds the allowed length");
  return { from, to, window: { from: window.from, to: window.to } };
}

function costOf(query: Query): number {
  const days = Math.ceil((Date.parse(query.to) - Date.parse(query.from)) / DAY_MS);
  const arms = query.metric.kind === "comparison" ? 2 : 1;
  return days * (1 + query.groupBy.length) * arms;
}

export interface PlanOptions {
  /** Trusted clock; defaults to Date.now. asOf may not be in the future. */
  now?: () => number;
}

/**
 * Compiles a recipe request into a bounded, validated list of lifecycle queries.
 * Pure: performs no I/O and no authorization; `executeInvestigation` authorizes first.
 */
export function planInvestigation(
  request: InvestigationRequest,
  catalog: InvestigationCatalog,
  options: PlanOptions = {},
): InvestigationPlan {
  const policy = validateCatalog(catalog);
  const registry = catalog.registry;
  check(request && typeof request === "object", "invalid_request", "Missing request");
  check(
    (RECIPE_IDS as readonly string[]).includes(request.recipe),
    "unsupported_recipe",
    "Unknown recipe",
  );
  check(
    request.recipeVersion === undefined || Number.isSafeInteger(request.recipeVersion),
    "unsupported_recipe",
    "Invalid recipe version",
  );
  const recipe = getRecipe(request.recipe, request.recipeVersion);
  check(recipe, "unsupported_recipe", "Unknown recipe version");

  // One registered app and definition for the whole plan.
  check(
    request.appId === registry.appId && request.definitionId === registry.definitionId,
    "forbidden",
    "Request scope does not match the trusted catalog",
  );
  check(
    request.metricVersion === registry.metricVersion,
    "invalid_request",
    "Unsupported metric version",
  );

  const budget = resolveBudget(recipe.budget, request.budget);
  const now = (options.now ?? Date.now)();
  const asOf = utc(request.asOf, "Invalid asOf");
  check(asOf <= now, "invalid_window", "asOf cannot be in the future");
  const availableFrom = utc(registry.availableFrom, "Invalid registry retention");
  const maxDays = Math.min(budget.maxWindowDays, registry.maxWindowDays);
  const current = windowOf(request.window, asOf, maxDays, availableFrom);

  // Definition versions: registered, and one comparison key across current and baseline.
  const versions = tokens(request.definitionVersions, 1, 10, "Invalid definition versions");
  const baselineVersions =
    request.baseline?.definitionVersions === undefined
      ? versions
      : tokens(request.baseline.definitionVersions, 1, 10, "Invalid baseline versions");
  const keys = new Set<string>();
  for (const version of [...versions, ...baselineVersions]) {
    check(Object.hasOwn(registry.versions, version), "unregistered", "Unregistered version");
    keys.add(registry.versions[version]?.comparisonKey ?? "");
  }
  check(keys.size === 1, "not_comparable", "Definition versions are not comparable");
  const comparisonKey = [...keys][0] as string;

  const cohort = cohortOf(request.cohort, "Invalid cohort");
  const baseline = request.baseline;
  check(
    baseline === undefined || (baseline && typeof baseline === "object"),
    "invalid_request",
    "Invalid baseline",
  );
  const { baselineWindow: windowRule, baselineCohort: cohortRule } = recipe.parameters;
  check(
    windowRule !== "forbidden" || baseline?.window === undefined,
    "invalid_request",
    "This recipe does not accept a baseline window",
  );
  check(
    windowRule !== "required" || baseline?.window !== undefined,
    "invalid_request",
    "This recipe requires a baseline window",
  );
  check(
    cohortRule !== "forbidden" || baseline?.cohort === undefined,
    "invalid_request",
    "This recipe does not accept a baseline cohort",
  );
  check(
    cohortRule !== "required" || baseline?.cohort !== undefined,
    "invalid_request",
    "This recipe requires a reference cohort",
  );
  check(
    windowRule !== "forbidden" || baseline?.definitionVersions === undefined,
    "invalid_request",
    "Baseline versions require a baseline window",
  );

  let baselineWindow: TimeWindow | null = null;
  if (baseline?.window !== undefined) {
    const prior = windowOf(baseline.window, asOf, maxDays, availableFrom);
    check(
      prior.to <= current.from,
      "invalid_window",
      "Baseline window must end before the current window starts",
    );
    check(
      prior.to - prior.from === current.to - current.from,
      "invalid_window",
      "Baseline and current windows must have equal length",
    );
    baselineWindow = prior.window;
  }
  let baselineCohort: Cohort | null = null;
  if (baseline?.cohort !== undefined) {
    baselineCohort = cohortOf(baseline.cohort, "Invalid baseline cohort");
    check(
      sameSet(baselineCohort.caseMix, cohort.caseMix),
      "not_comparable",
      "Baseline cohort must stratify exactly the same case mixes",
    );
  } else if (baselineWindow) baselineCohort = cohort;
  if (cohortRule === "required")
    check(
      baselineCohort && baselineCohort.id !== cohort.id,
      "not_comparable",
      "Reference cohort must differ from the intervention cohort",
    );

  // Stages come only from the trusted catalog.
  const catalogStages = new Map(catalog.stages.map((stage) => [stage.id, stage]));
  const requested =
    request.stages === undefined
      ? catalog.stages.map((stage) => stage.id).sort()
      : tokens(request.stages, 1, HARD_LIMITS.maxStages, "Invalid stages");
  check(requested.length <= budget.maxStages, "budget_exceeded", "Too many stages for the budget");
  const stages: CatalogStage[] = requested.map((id) => {
    const stage = catalogStages.get(id);
    check(stage, "unregistered", "Unregistered stage");
    return { id: stage.id, lane: stage.lane };
  });

  const extraGroupBy = [...(request.groupBy ?? [])];
  check(
    Array.isArray(request.groupBy ?? []) &&
      extraGroupBy.length <= 1 &&
      extraGroupBy.every(
        (dimension) =>
          catalog.allowedGroupBy.includes(dimension) &&
          recipe.parameters.extraGroupBy.includes(dimension),
      ),
    "unregistered",
    "groupBy is not allowlisted for this recipe",
  );
  const topN = request.topN ?? budget.maxRowsPerQuery;
  check(
    Number.isSafeInteger(topN) && topN >= 1 && topN <= budget.maxRowsPerQuery,
    "invalid_request",
    "Invalid topN",
  );

  const specs = recipe.specs({
    stages,
    extraGroupBy: extraGroupBy as Dimension[],
    referenceCaseMix: baselineCohort?.caseMix ?? cohort.caseMix,
    referenceCohortId: baselineCohort?.id ?? cohort.id,
  });
  check(specs.length <= budget.maxQueries, "budget_exceeded", "Plan exceeds the query budget");
  const seen = new Set<string>();
  const queries: PlannedQuery[] = specs.map((spec) => {
    check(!seen.has(spec.id), "invalid_request", "Duplicate query id");
    seen.add(spec.id);
    const isBaselineWindow = spec.arm === "baseline";
    const window = isBaselineWindow && baselineWindow ? baselineWindow : current.window;
    const armCohort =
      spec.arm === "current" ? cohort : ((baselineCohort as Cohort | null) ?? cohort);
    const query: Query = {
      appId: registry.appId,
      definitionId: registry.definitionId,
      definitionVersions: isBaselineWindow ? baselineVersions : versions,
      metricVersion: registry.metricVersion,
      from: window.from,
      to: window.to,
      asOf: request.asOf,
      cohort: { id: armCohort.id, caseMix: [...armCohort.caseMix] },
      metric: spec.metric,
      groupBy: [...spec.groupBy],
      filters: [],
      topN,
    };
    try {
      validateQuery(query, registry);
    } catch {
      // The query layer's message may echo values; translate to a fixed message.
      throw new InvestigationError("invalid_request", "A planned query failed validation");
    }
    return {
      id: spec.id,
      purpose: spec.purpose,
      role: spec.role,
      arm: spec.arm,
      stageId: spec.stageId,
      query,
      digest: digestOf(query),
      costUnits: costOf(query),
    };
  });
  const cost = queries.reduce((total, query) => total + query.costUnits, 0);
  check(cost <= budget.maxCostUnits, "budget_exceeded", "Plan exceeds the cost budget");

  const warnings: string[] = [];
  if (new Set(stages.map((stage) => stage.lane)).size > 1) warnings.push("parallel-lanes");
  if (versions.length > 1 || !sameSet(versions, baselineVersions))
    warnings.push("pooled-definition-versions");
  // Cases started late in the window have had less than one window length to finish.
  if (asOf - current.to < current.to - current.from) warnings.push("immature-current-window");

  const body = {
    schema: "flightdeck.investigation-plan.v1" as const,
    recipe: { id: recipe.id, version: recipe.version },
    question: recipe.question,
    scope: {
      appId: registry.appId,
      definitionId: registry.definitionId,
      definitionVersions: versions,
      baselineDefinitionVersions: baselineVersions,
      comparisonKey,
      metricVersion: registry.metricVersion,
      catalogRevision: catalog.revision,
    },
    asOf: request.asOf,
    window: current.window,
    baselineWindow,
    cohort,
    baselineCohort,
    stages,
    queries,
    budget,
    policy,
    hypotheses: structuredClone(recipe.hypotheses),
    alternatives: [...recipe.alternatives],
    safeguards: [...recipe.safeguards],
    warnings,
  };
  const digest = digestOf(body);
  return { ...body, id: `ip_${digest.slice(0, 32)}`, digest };
}
