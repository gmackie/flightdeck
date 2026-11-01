/**
 * Entirely synthetic lifecycle facts for three unrelated process domains. Every identifier and
 * timestamp is generated here; nothing is derived from production records or real people.
 */
import {
  createFakeAdapter,
  type FactBase,
  type LifecycleFact,
  type QueryAdapter,
  type QueryRegistry,
} from "@flightdeckhq/lifecycle-queries";
import type {
  AuthorizeInvestigation,
  InvestigationCatalog,
  InvestigationRequest,
  RecipeId,
} from "../src/index.js";

const HOUR = 3_600_000;
export const BASELINE = { from: "2026-01-01T00:00:00.000Z", to: "2026-01-15T00:00:00.000Z" };
export const CURRENT = { from: "2026-01-15T00:00:00.000Z", to: "2026-01-29T00:00:00.000Z" };
export const RECORDED_AT = "2026-02-01T00:00:00.000Z";
export const AS_OF = "2026-02-05T00:00:00.000Z";
export const NOW = () => Date.parse("2026-02-06T00:00:00.000Z");

interface StageSpec {
  id: string;
  lane: string;
  hours: number;
  /** Starts together with the previous stage (parallel lane). */
  parallel?: boolean;
}
export interface DomainSpec {
  name: "hiring" | "deploy" | "incident";
  appId: string;
  definitionId: string;
  stages: StageSpec[];
  caseMix: [string, string];
  variants: [string, string];
  /** Stage that is slower for the control cohort in the current window. */
  regressionStage: string;
  /** Stage that is faster for the pilot cohort in the current window. */
  interventionStage: string;
  /** Pilot cohort's non-completed terminal outcome (counterevidence when "failed"). */
  pilotTerminal: "cancelled" | "failed";
  /** Extra current-window control cases per case mix (arrival growth). */
  extraArrivals: number;
  /** Optional tiny stratum that must stay suppressed. */
  rareCaseMix?: string;
}

export const DOMAINS: Record<DomainSpec["name"], DomainSpec> = {
  hiring: {
    name: "hiring",
    appId: "talent-demo",
    definitionId: "hiring-pipeline",
    stages: [
      { id: "screen", lane: "main", hours: 4 },
      { id: "interview", lane: "main", hours: 12 },
      { id: "reference-check", lane: "checks", hours: 8 },
      { id: "background-check", lane: "compliance", hours: 6, parallel: true },
      { id: "offer", lane: "main", hours: 2 },
    ],
    caseMix: ["standard", "priority"],
    variants: ["panel", "async"],
    regressionStage: "screen",
    interventionStage: "interview",
    pilotTerminal: "failed",
    extraArrivals: 0,
  },
  deploy: {
    name: "deploy",
    appId: "release-demo",
    definitionId: "deploy-pipeline",
    stages: [
      { id: "build", lane: "main", hours: 1 },
      { id: "review", lane: "main", hours: 8 },
      { id: "canary", lane: "main", hours: 4 },
      { id: "rollout", lane: "main", hours: 2 },
    ],
    caseMix: ["minor", "major"],
    variants: ["manual", "auto"],
    regressionStage: "review",
    interventionStage: "review",
    pilotTerminal: "cancelled",
    extraArrivals: 0,
  },
  incident: {
    name: "incident",
    appId: "incident-demo",
    definitionId: "incident-response",
    stages: [
      { id: "triage", lane: "main", hours: 2 },
      { id: "mitigate", lane: "main", hours: 6 },
      { id: "resolve", lane: "main", hours: 12 },
    ],
    caseMix: ["sev2", "sev3"],
    variants: ["paged", "queued"],
    regressionStage: "mitigate",
    interventionStage: "triage",
    pilotTerminal: "cancelled",
    extraArrivals: 6,
    rareCaseMix: "sev1",
  },
};

export function registryFor(domain: DomainSpec): QueryRegistry {
  const stages = Object.fromEntries(domain.stages.map((stage) => [stage.id, stage.id]));
  const variants = Object.fromEntries(domain.variants.map((variant) => [variant, variant]));
  const caseMix = [...domain.caseMix, ...(domain.rareCaseMix ? [domain.rareCaseMix] : [])];
  return {
    appId: domain.appId,
    definitionId: domain.definitionId,
    metricVersion: "lifecycle.v1",
    availableFrom: BASELINE.from,
    maxWindowDays: 31,
    minSampleSize: 3,
    versions: {
      v1: { comparisonKey: `${domain.name}.k1`, stages, checkpoints: {}, variants },
      v2: { comparisonKey: `${domain.name}.k1`, stages, checkpoints: {}, variants },
      v3: { comparisonKey: `${domain.name}.k2`, stages, checkpoints: {}, variants },
    },
    filterValues: {
      caseMix,
      cohortId: ["control", "pilot"],
      definitionVersion: ["v1", "v2", "v3"],
      variantId: [...domain.variants],
      outcome: ["open", "completed", "cancelled", "failed"],
    },
  };
}

export function catalogFor(domain: DomainSpec, revision = "rev-1"): InvestigationCatalog {
  return {
    revision,
    registry: registryFor(domain),
    stages: domain.stages.map(({ id, lane }) => ({ id, lane })),
    allowedGroupBy: ["definitionVersion", "variantId"],
    policy: { maxWatermarkLagMs: 24 * HOUR },
  };
}

export interface FactOptions {
  /** Open (censored) cases per control/caseMix/variant group in the current window. */
  currentOpenCases?: number;
}

export function factsFor(domain: DomainSpec, options: FactOptions = {}): LifecycleFact[] {
  const facts: LifecycleFact[] = [];
  const windows = [
    { name: "baseline", start: Date.parse(BASELINE.from) },
    { name: "current", start: Date.parse(CURRENT.from) },
  ];
  const emit = (
    caseId: string,
    attrs: Omit<FactBase, "factId" | "caseId">,
    intervals: [string, number, number | null][],
  ) => {
    const base: FactBase = { ...attrs, factId: `${caseId}:case`, caseId };
    facts.push({ ...base, kind: "case" });
    for (const [stageId, entered, exited] of intervals)
      facts.push({
        ...base,
        factId: `${caseId}:${stageId}`,
        kind: "interval",
        stageId,
        enteredAt: new Date(entered).toISOString(),
        exitedAt: exited === null ? null : new Date(exited).toISOString(),
      });
  };
  for (const window of windows)
    for (const cohortId of ["control", "pilot"] as const)
      for (const [mixIndex, caseMix] of domain.caseMix.entries())
        for (const [variantIndex, variantId] of domain.variants.entries()) {
          const extra =
            window.name === "current" && cohortId === "control" ? domain.extraArrivals : 0;
          for (let index = 1; index <= 6 + extra; index++) {
            const caseId = `${domain.name}-${window.name}-${cohortId}-${caseMix}-${variantId}-${index}`;
            const started =
              window.start + (index % 12) * 24 * HOUR + mixIndex * HOUR + variantIndex * 2 * HOUR;
            const openCount =
              window.name === "current" &&
              cohortId === "control" &&
              options.currentOpenCases !== undefined
                ? options.currentOpenCases
                : variantIndex === 0
                  ? 3
                  : 0;
            const open = index > 6 - openCount && index <= 6;
            const terminalOther = variantIndex === 1 && index <= 3;
            let cursor = started,
              previousEnter = started;
            const intervals: [string, number, number | null][] = [];
            for (const [stageIndex, stage] of domain.stages.entries()) {
              let hours =
                stage.hours * (1 + mixIndex * 0.5) * (1 + variantIndex * 0.2) * (1 + index * 0.1);
              if (
                window.name === "current" &&
                cohortId === "control" &&
                stage.id === domain.regressionStage
              )
                hours *= 1.6;
              if (
                window.name === "current" &&
                cohortId === "pilot" &&
                stage.id === domain.interventionStage
              )
                hours *= 0.6;
              const entered = stage.parallel ? previousEnter : cursor;
              const last = stageIndex === domain.stages.length - 1;
              const exited = open && last ? null : entered + Math.round(hours * HOUR);
              intervals.push([stage.id, entered, exited]);
              previousEnter = entered;
              if (exited !== null) cursor = Math.max(cursor, exited);
            }
            const outcome = open
              ? "open"
              : terminalOther
                ? cohortId === "pilot" && window.name === "current"
                  ? domain.pilotTerminal
                  : "cancelled"
                : "completed";
            emit(
              caseId,
              {
                revision: 1,
                recordedAt: RECORDED_AT,
                appId: domain.appId,
                definitionId: domain.definitionId,
                definitionVersion: "v1",
                cohortId,
                caseMix,
                variantId,
                caseStartedAt: new Date(started).toISOString(),
                caseEndedAt: open ? null : new Date(cursor).toISOString(),
                outcome,
              },
              intervals,
            );
          }
        }
  if (domain.rareCaseMix)
    for (let index = 1; index <= 2; index++) {
      const started = Date.parse(CURRENT.from) + index * HOUR;
      const intervals: [string, number, number | null][] = domain.stages.map(
        (stage, stageIndex) => [
          stage.id,
          started + stageIndex * HOUR,
          started + (stageIndex + 1) * HOUR,
        ],
      );
      emit(
        `${domain.name}-rare-${index}`,
        {
          revision: 1,
          recordedAt: RECORDED_AT,
          appId: domain.appId,
          definitionId: domain.definitionId,
          definitionVersion: "v1",
          cohortId: "control",
          caseMix: domain.rareCaseMix,
          variantId: domain.variants[0],
          caseStartedAt: new Date(started).toISOString(),
          caseEndedAt: new Date(started + domain.stages.length * HOUR).toISOString(),
          outcome: "completed",
        },
        intervals,
      );
    }
  return facts;
}

export function adapterFor(
  domain: DomainSpec,
  options: FactOptions & { watermark?: string } = {},
): QueryAdapter {
  return createFakeAdapter(
    factsFor(domain, options),
    registryFor(domain),
    options.watermark ?? AS_OF,
  );
}

/** Counts adapter calls and in-flight concurrency; optional per-call delay/transform. */
export function instrument(
  inner: QueryAdapter,
  hooks: {
    delayMs?: (index: number, query: Parameters<QueryAdapter["query"]>[0]) => number;
    transform?: (result: unknown, query: Parameters<QueryAdapter["query"]>[0]) => unknown;
    fail?: (query: Parameters<QueryAdapter["query"]>[0]) => unknown;
  } = {},
) {
  const stats = {
    calls: 0,
    inFlight: 0,
    maxInFlight: 0,
    queries: [] as Parameters<QueryAdapter["query"]>[0][],
  };
  const adapter: QueryAdapter = {
    async query(query) {
      const index = stats.calls++;
      stats.queries.push(query);
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        const wait = hooks.delayMs?.(index, query) ?? 0;
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        const failure = hooks.fail?.(query);
        if (failure) throw failure;
        const result = await inner.query(query);
        return (hooks.transform ? hooks.transform(result, query) : result) as never;
      } finally {
        stats.inFlight--;
      }
    },
  };
  return { adapter, stats };
}

export const allow =
  (appId: string, scopeKey = "scope-alice-r1"): AuthorizeInvestigation =>
  (request) =>
    request.appId === appId ? { allowed: true, appId, scopeKey } : { allowed: false };

export function requestFor(
  domain: DomainSpec,
  recipe: RecipeId,
  overrides: Partial<InvestigationRequest> = {},
): InvestigationRequest {
  const base: InvestigationRequest = {
    recipe,
    appId: domain.appId,
    definitionId: domain.definitionId,
    definitionVersions: ["v1"],
    metricVersion: "lifecycle.v1",
    asOf: AS_OF,
    window: { ...CURRENT },
    cohort: { id: "control", caseMix: [...domain.caseMix] },
  };
  if (recipe === "dwell-regression" || recipe === "capacity-risk")
    base.baseline = { window: { ...BASELINE } };
  if (recipe === "intervention-review") {
    base.cohort = { id: "pilot", caseMix: [...domain.caseMix] };
    base.baseline = { cohort: { id: "control", caseMix: [...domain.caseMix] } };
  }
  return { ...base, ...overrides };
}
