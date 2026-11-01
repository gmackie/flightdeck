import {
  type Budget,
  canonicalJson,
  describeRecipes,
  executeInvestigation,
  type InvestigationCatalog,
  InvestigationError,
  type InvestigationRequest,
  planInvestigation,
  sha256Hex,
  validateAgentAnalysis,
} from "@flightdeckhq/lifecycle-investigations";
import type { QueryAdapter } from "@flightdeckhq/lifecycle-queries";
import { Authorizer } from "./authorize";
import {
  type EngineExecutionInput,
  type EngineInput,
  engineExecutionOutput,
  enginePlanOutput,
} from "./investigation-engine-contract";
import { withInvestigationDeadline } from "./investigations";
import type { AppScope, LifecycleReadSource } from "./source";
import { scopeFor, type ToolContext, ToolError } from "./tools";

/** Trusted host configuration; never built from tool arguments or the legacy read source.
 * Catalog registries name exactly one app/definition. The adapter must independently enforce
 * the supplied scope and actually retain normalized complete revisions for historical asOf.
 */
export interface InvestigationQuerySource {
  kind: "fixture" | "normalized";
  historicalAsOf: true;
  catalogs: readonly InvestigationCatalog[];
  adapterFor(scope: AppScope, catalog: InvestigationCatalog): QueryAdapter;
}
export type InvestigationEngineConfig = {
  /** null explicitly enables the surface without an available engine; no fallback. */
  source: InvestigationQuerySource | null;
  /** Synchronous host admission gate. Production must inject a shared durable limiter. */
  admit?: (principalAppKey: string, costUnits: number) => boolean;
};
export const ENGINE_LIMITS = {
  maxQueries: 14,
  maxStages: 8,
  maxWindowDays: 92,
  maxConcurrency: 2,
  queryTimeoutMs: 1_000,
  totalTimeoutMs: 2_000,
  maxCostUnits: 600,
  maxRowsPerQuery: 20,
} as const;

/** Isolate-local safety floor, shared across requests. No eviction permits a quota bypass:
 * a full map fails closed until a bucket expires. This is not a distributed rate limit. */
export function createInvestigationAdmission(now: () => number = Date.now) {
  const buckets = new Map<string, { until: number; calls: number; cost: number }>();
  return (key: string, cost: number): boolean => {
    const time = now();
    for (const [id, bucket] of buckets) if (bucket.until <= time) buckets.delete(id);
    const bucket = buckets.get(key) ?? { until: time + 60_000, calls: 0, cost: 0 };
    if (
      (!buckets.has(key) && buckets.size >= 1_024) ||
      bucket.calls >= 10 ||
      bucket.cost + cost > 1_200
    )
      return false;
    bucket.calls++;
    bucket.cost += cost;
    buckets.set(key, bucket);
    return true;
  };
}
const localAdmission = createInvestigationAdmission();
const denied = () => new ToolError("forbidden", "Not authorized for this investigation");

/** Reuse MCP's policy on a freshly fetched grant snapshot, not Authorizer's request cache. */
async function currentAuthorization(ctx: ToolContext, initial: AppScope, active: () => void) {
  active();
  const grants = await ctx.source.grantsFor(initial.principal);
  active();
  if (!Array.isArray(grants)) throw denied();
  // The temporary source supplies only the snapshot Authorizer consumes; no data reads occur.
  const snapshot: LifecycleReadSource = Object.create(ctx.source);
  snapshot.grantsFor = async () => grants;
  const current = await new Authorizer(initial.principal, snapshot, ctx.now).authorize(
    initial.appId,
    "process:read",
  );
  if ("code" in current || current.appId !== initial.appId) throw denied();
  const principal = {
    sub: current.principal.sub,
    email: current.principal.email ?? null,
    serviceToken: current.principal.serviceToken,
  };
  const relevant = grants
    .filter((grant) => grant.appId === current.appId)
    .map(({ appId, role, expiresAt }) => ({ appId, role, expiresAt }))
    .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return {
    scope: current,
    scopeKey: sha256Hex(canonicalJson({ principal, grants: relevant })),
    principalAppKey: sha256Hex(canonicalJson({ principal, appId: current.appId })),
  };
}

export async function runEngineInvestigation(
  ctx: ToolContext,
  input: EngineInput | EngineExecutionInput,
  execute: boolean,
): Promise<object> {
  return withInvestigationDeadline(async (active) => {
    try {
      // Authorize before disclosing configuration, registered versions or a private plan.
      const scope = await scopeFor(ctx, input.request.appId, "process:read");
      active();
      const initial = await currentAuthorization(ctx, scope, active);
      if (input.dependency_scope !== "workflow_only")
        throw new ToolError("unsupported", "Relationship graphs are unsupported");
      const config = ctx.investigationEngine;
      const source = config?.source;
      if (source?.historicalAsOf !== true)
        throw new ToolError("engine_unavailable", "The typed investigation engine is unavailable");
      const matches = source.catalogs.filter(
        (catalog) =>
          catalog.registry.appId === scope.appId &&
          catalog.registry.definitionId === input.request.definitionId,
      );
      if (matches.length !== 1)
        throw new ToolError("unsupported", "No unique trusted investigation catalog is configured");
      const catalog = structuredClone(matches[0]) as InvestigationCatalog;
      // Reject weak disclosure configuration instead of rewriting source metadata or hashes.
      if (catalog.registry.minSampleSize < Math.max(5, ctx.minCohort))
        throw new ToolError("unsupported", "The configured query disclosure floor is too low");
      catalog.policy = {
        ...catalog.policy,
        maxWatermarkLagMs: Math.min(catalog.policy?.maxWatermarkLagMs ?? 900_000, 900_000),
      };
      const recipe = describeRecipes().find((item) => item.id === input.request.recipe);
      if (!recipe) throw new ToolError("unsupported", "The recipe is unsupported");
      const budget: Budget = { ...ENGINE_LIMITS };
      for (const name of Object.keys(budget) as (keyof typeof budget)[]) {
        budget[name] = Math.min(
          budget[name],
          recipe.budget[name],
          input.request.budget?.[name] ?? budget[name],
        );
      }
      const request: InvestigationRequest = { ...input.request, budget };
      const plan = planInvestigation(request, catalog, { now: ctx.now });
      const provenance = { kind: source.kind, historical_as_of: true as const };
      const requireCurrent = async () => {
        const current = await currentAuthorization(ctx, scope, active);
        if (current.scopeKey !== initial.scopeKey) throw denied();
        return current;
      };
      // Plan calls consume rate quota too; execution is charged its full planned heuristic cost.
      const admit = config?.admit ?? localAdmission;
      if (
        !admit(
          initial.principalAppKey,
          execute ? plan.queries.reduce((sum, query) => sum + query.costUnits, 0) : 0,
        )
      )
        throw new ToolError("budget_exceeded", "Investigation rate or cost budget exceeded");
      if (!execute) {
        await requireCurrent();
        return enginePlanOutput.parse({
          contract_version: input.contract_version,
          source: provenance,
          plan,
        });
      }
      const execution = input as EngineExecutionInput;
      if (execution.expected_plan_digest !== plan.digest)
        throw new ToolError("invalid_argument", "The reviewed plan has changed");
      let returnedRows = 0;
      let boundaryError: ToolError | null = null;
      const adapter: QueryAdapter = {
        async query(query) {
          const current = await requireCurrent();
          if (
            query.appId !== current.scope.appId ||
            query.definitionId !== catalog.registry.definitionId
          )
            throw denied();
          active();
          const result = await source
            .adapterFor(current.scope, structuredClone(catalog))
            .query(query);
          active();
          returnedRows += Array.isArray(result?.rows) ? result.rows.length : 0;
          if (
            !Array.isArray(result?.rows) ||
            result.rows.length > plan.budget.maxRowsPerQuery ||
            returnedRows > 256
          ) {
            boundaryError = new ToolError(
              "budget_exceeded",
              "Investigation source row budget exceeded",
            );
            throw boundaryError;
          }
          return result;
        },
      };
      const { pack } = await executeInvestigation(request, {
        catalog,
        adapter,
        now: ctx.now,
        expectedPlanDigest: execution.expected_plan_digest,
        authorize: async (requested) => {
          if (
            requested.appId !== scope.appId ||
            requested.definitionId !== catalog.registry.definitionId ||
            requested.capability !== "process:read"
          )
            return { allowed: false };
          const current = await requireCurrent();
          return { allowed: true, appId: current.scope.appId, scopeKey: current.scopeKey };
        },
      });
      active();
      if (boundaryError) throw boundaryError;
      await requireCurrent();
      return engineExecutionOutput.parse({
        contract_version: input.contract_version,
        source: provenance,
        pack,
        validation: execution.analysis ? validateAgentAnalysis(pack, execution.analysis) : null,
      });
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (error instanceof InvestigationError) {
        const code =
          error.code === "forbidden"
            ? "forbidden"
            : error.code === "budget_exceeded"
              ? "budget_exceeded"
              : "invalid_argument";
        throw new ToolError(code, "The typed investigation was refused");
      }
      throw new ToolError("source_unavailable", "The typed investigation source is unavailable");
    }
  });
}
