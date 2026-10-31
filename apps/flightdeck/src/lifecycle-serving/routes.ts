import type { AccessPrincipal } from "../access";
import { fail, json } from "../api/http";
import {
  aggregateWindow,
  BadQuery,
  decodeCursor,
  encodeCursor,
  idParam,
  limitParam,
  onlyParams,
  slugParam,
  startedRange,
  versionParam,
} from "./params";
import {
  type CaseFilters,
  type CaseSummary,
  type Cohort,
  caseDetail,
  listCases,
  listProcesses,
  outcomeSummary,
  stageSummary,
} from "./read";
import type { ProjectionState } from "./repository";

/**
 * Read-only lifecycle serving API over the derived read model (migration 0020).
 *
 * NOT ROUTED: nothing calls `lifecycleServingRoutes` yet. Integration hook, once the app-scoped
 * RBAC module (FLIG-18) lands: from the `/api/*` dispatcher, after `authenticate()`, call
 *
 *   const served = await lifecycleServingRoutes(request, env, principal, {
 *     authorize: ({ principal, appId, capability }) =>
 *       authorizeLifecycleRead(env, principal, appId, capability),
 *   });
 *   if (served) return served;
 *
 * Without an `authorize` option every request is denied, so wiring the routes alone exposes
 * nothing.
 */

export type LifecycleCapability = "lifecycle:read" | "process:read";

/** Resolves a principal's right to one capability on one app: a scope, or the denial response. */
export type LifecycleReadAuthorizer = (check: {
  principal: AccessPrincipal;
  appId: string;
  capability: LifecycleCapability;
}) => Promise<{ readonly appId: string } | Response>;

/** The default: fail closed until a real permission checker is injected. */
export const denyLifecycleReads: LifecycleReadAuthorizer = async () => fail(403, "Forbidden");

export type ServingOptions = {
  authorize?: LifecycleReadAuthorizer;
  now?: () => number;
  /** Aggregate groups with fewer distinct cases are withheld. At least 2; default 5. */
  minCohort?: number;
  /** A committed projection older than this reports `stale`. Default 15 minutes. */
  staleAfterMs?: number;
};

export const DEFAULT_MIN_COHORT = 5;
export const DEFAULT_STALE_AFTER_MS = 15 * 60_000;

export const LIFECYCLE_SERVING_ROUTE =
  /^\/api\/apps\/([\w-]{3,64})\/lifecycle\/(processes|cases|cases\/([A-Za-z0-9_-]{1,64})|summaries\/stages|summaries\/outcomes)$/;

type Freshness = {
  /** `unavailable` until a projection has been committed for the app. */
  status: "fresh" | "stale" | "unavailable";
  projection: ProjectionState["status"] | "none";
  lag_ms: number | null;
  generation: number | null;
  source_watermark: number | null;
};

type Envelope = {
  app_id: string;
  as_of: number | null;
  data_freshness: Freshness;
  cohort: Record<string, string | number | null>;
  sample_count: number;
  suppressed: boolean;
  data: unknown;
  page?: { limit: number; next_cursor: string | null };
};

/**
 * Handles `/api/apps/:app/lifecycle/{processes,cases,cases/:id,summaries/*}`; returns null for
 * any other path so the caller can fall through. Authorization runs before anything else.
 */
export async function lifecycleServingRoutes(
  request: Request,
  env: Env,
  principal: AccessPrincipal,
  options: ServingOptions = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(LIFECYCLE_SERVING_ROUTE);
  if (!match?.[1] || !match[2]) return null;
  const appId = match[1];
  const endpoint = match[2];
  const capability: LifecycleCapability = endpoint.startsWith("summaries/")
    ? "process:read"
    : "lifecycle:read";

  const authorize = options.authorize ?? denyLifecycleReads;
  let scope: Awaited<ReturnType<LifecycleReadAuthorizer>>;
  try {
    scope = await authorize({ principal, appId, capability });
  } catch {
    return fail(503, "Authorization unavailable");
  }
  if (scope instanceof Response) return scope;
  // A checker must scope to the app it was asked about; anything else is a bug, so deny.
  if (scope?.appId !== appId) return fail(403, "Forbidden");
  if (request.method !== "GET") return fail(405, "Method not allowed", { Allow: "GET" });

  const ctx: Ctx = {
    db: env.DB,
    appId: scope.appId,
    params: url.searchParams,
    now: (options.now ?? Date.now)(),
    minCohort: Math.max(2, Math.floor(options.minCohort ?? DEFAULT_MIN_COHORT)),
    staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
  };
  try {
    if (endpoint === "processes") return await processes(ctx);
    if (endpoint === "cases") return await cases(ctx);
    if (match[3]) return await detail(ctx, match[3]);
    return await summary(ctx, endpoint === "summaries/stages" ? "stages" : "outcomes");
  } catch (error) {
    if (error instanceof BadQuery) return fail(400, error.message);
    // Missing migration, D1 outage, etc. Never echo errors: they could carry query values.
    return fail(503, "Lifecycle read model unavailable");
  }
}

type Ctx = {
  db: D1Database;
  appId: string;
  params: URLSearchParams;
  now: number;
  minCohort: number;
  staleAfterMs: number;
};

async function freshness(ctx: Ctx): Promise<{ as_of: number | null; data_freshness: Freshness }> {
  const state = await ctx.db
    .prepare(
      `SELECT status, active_generation, source_watermark, as_of
       FROM lifecycle_projection_state WHERE app_id = ?`,
    )
    .bind(ctx.appId)
    .first<Pick<ProjectionState, "status" | "active_generation" | "source_watermark" | "as_of">>();
  if (!state || state.active_generation === 0 || state.as_of === null) {
    return {
      as_of: null,
      data_freshness: {
        status: "unavailable",
        projection: state?.status ?? "none",
        lag_ms: null,
        generation: null,
        source_watermark: null,
      },
    };
  }
  const lag = Math.max(0, ctx.now - state.as_of);
  return {
    as_of: state.as_of,
    data_freshness: {
      status: lag > ctx.staleAfterMs ? "stale" : "fresh",
      projection: state.status,
      lag_ms: lag,
      generation: state.active_generation,
      source_watermark: state.source_watermark,
    },
  };
}

function respond(
  ctx: Ctx,
  fresh: Awaited<ReturnType<typeof freshness>>,
  body: Omit<Envelope, "app_id" | "as_of" | "data_freshness">,
): Response {
  return json({ app_id: ctx.appId, ...fresh, ...body } satisfies Envelope);
}

async function processes(ctx: Ctx): Promise<Response> {
  const p = ctx.params;
  onlyParams(p, ["process_key", "limit", "cursor"]);
  const processKey = slugParam(p, "process_key");
  const limit = limitParam(p);
  const scope = `processes ${ctx.appId} ${processKey}`;
  const after = decodeCursor(p, scope, ["string", "number"]) as [string, number] | null;
  const [fresh, rows] = await Promise.all([
    freshness(ctx),
    listProcesses(ctx.db, ctx.appId, { processKey, limit: limit + 1, after }),
  ]);
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return respond(ctx, fresh, {
    cohort: { process_key: processKey },
    sample_count: items.length,
    suppressed: false,
    data: items,
    page: {
      limit,
      next_cursor:
        rows.length > limit && last ? encodeCursor(scope, [last.process_key, last.version]) : null,
    },
  });
}

const CASE_PARAMS = [
  "process_key",
  "version",
  "status",
  "outcome",
  "stage",
  "parent",
  "started_after",
  "started_before",
  "limit",
  "cursor",
];

async function cases(ctx: Ctx): Promise<Response> {
  const p = ctx.params;
  onlyParams(p, CASE_PARAMS);
  const range = startedRange(p);
  const filters: CaseFilters = {
    processKey: slugParam(p, "process_key"),
    version: versionParam(p),
    status: statusParam(p),
    outcome: slugParam(p, "outcome"),
    stage: slugParam(p, "stage"),
    parent: idParam(p, "parent"),
    startedAfter: range.after,
    startedBefore: range.before,
  };
  if (filters.version !== null && filters.processKey === null) {
    throw new BadQuery("version requires process_key");
  }
  const limit = limitParam(p);
  const scope = `cases ${ctx.appId} ${JSON.stringify(filters)}`;
  const after = decodeCursor(p, scope, ["number", "string"]) as [number, string] | null;
  const [fresh, rows] = await Promise.all([
    freshness(ctx),
    listCases(ctx.db, ctx.appId, filters, { limit: limit + 1, after }),
  ]);
  const items: CaseSummary[] = rows.slice(0, limit);
  const last = items.at(-1);
  return respond(ctx, fresh, {
    cohort: {
      process_key: filters.processKey,
      version: filters.version,
      status: filters.status,
      outcome: filters.outcome,
      stage: filters.stage,
      parent: filters.parent,
      started_after: iso(range.after),
      started_before: iso(range.before),
    },
    sample_count: items.length,
    suppressed: false,
    data: items,
    page: {
      limit,
      next_cursor:
        rows.length > limit && last ? encodeCursor(scope, [last.started_at, last.case_id]) : null,
    },
  });
}

async function detail(ctx: Ctx, caseId: string): Promise<Response> {
  onlyParams(ctx.params, []);
  const [fresh, found] = await Promise.all([freshness(ctx), caseDetail(ctx.db, ctx.appId, caseId)]);
  // Same answer for a case in another app and one that never existed.
  if (!found) return fail(404, "Unknown case");
  return respond(ctx, fresh, {
    cohort: { case_id: caseId },
    sample_count: 1,
    suppressed: false,
    data: found,
  });
}

/** Aggregates need one process version (versions are not comparable) and a bounded window. */
async function summary(ctx: Ctx, kind: "stages" | "outcomes"): Promise<Response> {
  const p = ctx.params;
  onlyParams(p, ["process_key", "version", "status", "started_after", "started_before"]);
  const processKey = slugParam(p, "process_key");
  const version = versionParam(p);
  if (processKey === null || version === null) {
    throw new BadQuery("process_key and version are required");
  }
  const window = aggregateWindow(p, ctx.now);
  const cohort: Cohort = {
    processKey,
    version,
    status: statusParam(p),
    startedAfter: window.after,
    startedBefore: window.before,
  };
  const [fresh, result] = await Promise.all([
    freshness(ctx),
    kind === "stages"
      ? stageSummary(ctx.db, ctx.appId, cohort, ctx.minCohort)
      : outcomeSummary(ctx.db, ctx.appId, cohort, ctx.minCohort),
  ]);
  return respond(ctx, fresh, {
    cohort: {
      process_key: processKey,
      version,
      status: cohort.status,
      started_after: iso(window.after),
      started_before: iso(window.before),
      min_cohort: ctx.minCohort,
    },
    sample_count: result.sample_count,
    suppressed: result.suppressed,
    data: result.groups,
  });
}

function statusParam(params: URLSearchParams): "open" | "closed" | null {
  const value = params.get("status");
  if (value === null || value === "open" || value === "closed") return value;
  throw new BadQuery("status must be open or closed");
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
