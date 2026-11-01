import type { AccessPrincipal } from "../access";
import { fail, json } from "../api/http";
import { projectionDiagnostics } from "../lifecycle-projection/diagnostics";
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
 * Read-only lifecycle serving API over the derived read model (migration 0020), routed from the
 * `/api/*` dispatcher with `authorizeLifecycleRead` (FLIG-18) as the authorizer. Without an
 * `authorize` option every request is denied, so the routes alone expose nothing.
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
  /^\/api\/apps\/([\w-]{3,64})\/lifecycle\/(processes|cases|cases\/([A-Za-z0-9_-]{1,64})|summaries\/stages|summaries\/outcomes|diagnostics)$/;

type Freshness = {
  /** `unavailable` until a projection has been committed for the app. */
  status: "fresh" | "stale" | "unavailable";
  projection: ProjectionState["status"] | "none";
  lag_ms: number | null;
  generation: number | null;
  source_watermark: number | null;
  /** Cases with accepted events not yet reflected (queued or retrying). */
  pending_cases: number;
};

/**
 * How small-cohort suppression applied to this response. Only aggregates suppress: case lists
 * and detail return individual (opaque) cases under `lifecycle:read` and say so explicitly.
 */
type Suppression = {
  policy: "min_cohort" | "not_applicable";
  /** Groups with fewer distinct cases than this are withheld; null when not applicable. */
  min_cohort: number | null;
  unit: "distinct_cases" | null;
  /** True when at least one group was withheld. How many, and their sizes, are never disclosed. */
  withheld: boolean;
  /**
   * What `sample_count` counts: cases in released groups only, rows returned, the one case, or
   * nothing (operator diagnostics, where `sample_count` is always 0).
   */
  sample_count_of: "released_groups" | "returned_rows" | "case" | "none";
};

const unsuppressed = (of: "returned_rows" | "case" | "none"): Suppression => ({
  policy: "not_applicable",
  min_cohort: null,
  unit: null,
  withheld: false,
  sample_count_of: of,
});

type Envelope = {
  app_id: string;
  as_of: number | null;
  data_freshness: Freshness;
  /** The filters that define the population, echoed after normalization. */
  cohort: Record<string, string | number | null>;
  sample_count: number;
  /** Shorthand for `suppression.withheld`. */
  suppressed: boolean;
  suppression: Suppression;
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
    if (endpoint === "diagnostics") return await diagnostics(ctx);
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
  const [state, queued] = await Promise.all([
    ctx.db
      .prepare(
        `SELECT status, active_generation, source_watermark, as_of
         FROM lifecycle_projection_state WHERE app_id = ?`,
      )
      .bind(ctx.appId)
      .first<
        Pick<ProjectionState, "status" | "active_generation" | "source_watermark" | "as_of">
      >(),
    ctx.db
      .prepare("SELECT count(*) AS n FROM lifecycle_projection_queue WHERE app_id = ?")
      .bind(ctx.appId)
      .first<{ n: number }>(),
  ]);
  const pending_cases = queued?.n ?? 0;
  if (!state || state.active_generation === 0 || state.as_of === null) {
    return {
      as_of: null,
      data_freshness: {
        status: "unavailable",
        projection: state?.status ?? "none",
        lag_ms: null,
        generation: null,
        source_watermark: null,
        pending_cases,
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
      pending_cases,
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
    suppression: unsuppressed("returned_rows"),
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
    suppression: unsuppressed("returned_rows"),
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
    suppression: unsuppressed("case"),
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
    },
    sample_count: result.sample_count,
    suppressed: result.suppressed,
    suppression: {
      policy: "min_cohort",
      min_cohort: ctx.minCohort,
      unit: "distinct_cases",
      withheld: result.suppressed,
      sample_count_of: "released_groups",
    },
    data: result.groups,
  });
}

/** Projection health for operators: counts and codes only, never ids or payloads. */
async function diagnostics(ctx: Ctx): Promise<Response> {
  onlyParams(ctx.params, []);
  const [fresh, report] = await Promise.all([
    freshness(ctx),
    projectionDiagnostics(ctx.db, ctx.appId),
  ]);
  return respond(ctx, fresh, {
    cohort: {},
    sample_count: 0,
    suppressed: false,
    suppression: unsuppressed("none"),
    data: report,
  });
}

function statusParam(params: URLSearchParams): "open" | "closed" | null {
  const value = params.get("status");
  if (value === null || value === "open" || value === "closed") return value;
  throw new BadQuery("status must be open or closed");
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
