import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { Authorizer } from "./authorize";
import { BoundsError, decodeCursor, encodeCursor, LIMITS, resolveWindow } from "./bounds";
import { CASE_CAVEATS, METRICS, type MetricId, OBSERVATIONAL_CAVEATS } from "./glossary";
import {
  type PublicDefinition,
  projectCase,
  projectDefinition,
  projectTimeline,
  type ReleasedDwell,
  suppressDwell,
  suppressFunnel,
  suppressVariants,
} from "./privacy";
import { type inputs, outputs, type ToolName } from "./schemas";
import {
  type AppScope,
  type Capability,
  type LifecycleReadSource,
  type SourceMeta,
  SourceUnavailableError,
} from "./source";

export const SERVER_VERSION = "0.1.0";

export type ToolContext = {
  source: LifecycleReadSource;
  authorizer: Authorizer;
  minCohort: number;
  now: () => number;
};

type ErrorCode =
  | "forbidden"
  | "not_found"
  | "invalid_argument"
  | "source_unavailable"
  | "result_too_large"
  | "internal";

/** A tool failure with a fixed, safe message: never an upstream error text or an input value. */
export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

type Args<K extends ToolName> = z.infer<(typeof inputs)[K]>;
type Out<K extends ToolName> = z.infer<(typeof outputs)[K]>;
type Handler<K extends ToolName> = (ctx: ToolContext, args: Args<K>) => Promise<Out<K>>;
type Envelope = Out<"describe_metric">;

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const SYNTHETIC_CAVEAT =
  "SYNTHETIC DATA: invented fixtures for testing and demos, not real operational data.";

const FORBIDDEN = "Not authorized for this app, or the app does not exist";

export const definitionUri = (appId: string, workflowKey: string) =>
  `lifecycle://apps/${appId}/workflows/${workflowKey}/definition`;

async function scopeFor(ctx: ToolContext, appId: string, capability: Capability) {
  const scope = await ctx.authorizer.authorize(appId, capability);
  if ("code" in scope) {
    throw scope.code === "forbidden"
      ? new ToolError("forbidden", FORBIDDEN)
      : new ToolError("source_unavailable", "Grants could not be loaded; access is denied");
  }
  return scope;
}

/** Runs a source call, mapping every failure to a fixed message. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof SourceUnavailableError) {
      throw new ToolError("source_unavailable", "The lifecycle read source is unavailable");
    }
    throw new ToolError("internal", "The lifecycle read source failed");
  }
}

function provenance(
  ctx: ToolContext,
  meta: SourceMeta | null,
  tool: ToolName,
  query: Record<string, unknown>,
): Envelope["provenance"] {
  const now = ctx.now();
  if (!meta) {
    return {
      source: "server",
      synthetic: false,
      source_version: `lifecycle-mcp@${SERVER_VERSION}`,
      as_of: iso(now),
      generated_at: iso(now),
      freshness: { status: "fresh", watermark: null, lag_ms: null },
      tool,
      query,
    };
  }
  return {
    source: ctx.source.kind,
    synthetic: ctx.source.kind === "synthetic",
    source_version: String(meta.source_version).slice(0, 64),
    as_of: iso(meta.as_of),
    generated_at: iso(now),
    freshness: {
      status: meta.freshness.status,
      watermark: isoOrNull(meta.freshness.watermark),
      lag_ms: meta.freshness.lag_ms,
    },
    tool,
    query,
  };
}

function interpretation(
  ctx: ToolContext,
  kind: Envelope["interpretation"]["kind"],
  caveats: readonly string[],
): Envelope["interpretation"] {
  const synthetic = ctx.source.kind === "synthetic" && kind !== "reference";
  return {
    kind,
    causal: false,
    caveats: synthetic ? [SYNTHETIC_CAVEAT, ...caveats] : [...caveats],
  };
}

const EMPTY_DEFINITION: PublicDefinition = {
  workflow_key: "",
  version: 0,
  label: "",
  description: "",
  stages: [],
  outcomes: [],
  dimensions: [],
  published_at: 0,
};

async function definitionFor(
  ctx: ToolContext,
  scope: AppScope,
  workflowKey: string,
  version: number | null,
): Promise<PublicDefinition> {
  const res = await call(() => ctx.source.getWorkflowDefinition(scope, workflowKey, version));
  if (!res.data || res.data.workflow_key !== workflowKey) {
    throw new ToolError("not_found", "Unknown workflow or version");
  }
  return projectDefinition(res.data);
}

type CohortArgs = {
  from?: string | undefined;
  to?: string | undefined;
  group_by?: string | undefined;
  filters?: { dimension: string; value: string }[] | undefined;
};

/** Validates grouping and filters against the definition's declared dimensions. */
function cohortQuery(ctx: ToolContext, defs: PublicDefinition[], args: CohortArgs) {
  const { from, to } = resolveWindow(args, ctx.now());
  const declared = (key: string) =>
    defs.every((def) => def.dimensions.some((dim) => dim.key === key));
  const groupBy = args.group_by ?? null;
  if (groupBy !== null && !declared(groupBy)) {
    throw new ToolError("invalid_argument", "group_by must be a dimension the workflow declares");
  }
  const filters: Record<string, string> = {};
  for (const { dimension, value } of args.filters ?? []) {
    const ok = defs.every((def) =>
      def.dimensions.some((dim) => dim.key === dimension && dim.values.includes(value)),
    );
    if (!ok || dimension in filters) {
      throw new ToolError(
        "invalid_argument",
        "filters must use declared dimensions and values, each dimension at most once",
      );
    }
    filters[dimension] = value;
  }
  return { from, to, groupBy, filters };
}

const describeQuery = (
  workflowKey: string,
  version: number,
  q: { from: number; to: number; groupBy?: string | null; filters: Record<string, string> },
) => ({
  workflow_key: workflowKey,
  version,
  from: iso(q.from),
  to: iso(q.to),
  group_by: q.groupBy ?? null,
  filters: q.filters,
});

const anySuppressed = (rows: { suppressed: boolean }[]) => rows.some((row) => row.suppressed);

const handlers: { [K in ToolName]: Handler<K> } = {
  async list_workflow_definitions(ctx, args) {
    const scope = await scopeFor(ctx, args.app_id, "lifecycle:read");
    const limit = args.limit ?? LIMITS.defaultPageSize;
    const query = { workflow_key: args.workflow_key ?? null, limit };
    const binding = { tool: "list_workflow_definitions", appId: args.app_id, query };
    const { page, sourceCursor } = await decodeCursor(args.cursor, binding);
    const res = await call(() =>
      ctx.source.listWorkflowDefinitions(scope, {
        workflowKey: args.workflow_key ?? null,
        page: { limit, cursor: sourceCursor },
      }),
    );
    const definitions = res.data.items
      .slice(0, limit)
      .filter((def) => SLUG.test(def.workflow_key))
      .map(projectDefinition)
      .map((def) => ({
        ...def,
        published_at: iso(def.published_at),
        resource_uri: definitionUri(args.app_id, def.workflow_key),
      }));
    return {
      app_id: args.app_id,
      data: { definitions },
      page: { next_cursor: await encodeCursor(binding, page, res.data.next_cursor), page, limit },
      provenance: provenance(ctx, res.meta, "list_workflow_definitions", query),
      interpretation: interpretation(ctx, "definition", [
        "Definitions describe the intended stages; observed cases may skip or repeat stages.",
      ]),
    };
  },

  async get_case_summary(ctx, args) {
    const scope = await scopeFor(ctx, args.app_id, "lifecycle:read");
    const res = await call(() => ctx.source.getCaseSummary(scope, args.case_id));
    if (!res.data || res.data.case_id !== args.case_id) {
      throw new ToolError("not_found", "Unknown case");
    }
    const found = res.data;
    const def = await definitionFor(ctx, scope, found.workflow_key, found.version).catch(
      (error: unknown) => {
        if (error instanceof ToolError && error.code === "not_found") return EMPTY_DEFINITION;
        throw error;
      },
    );
    const c = projectCase(found, def);
    const end = c.ended_at ?? res.meta.freshness.watermark ?? res.meta.as_of;
    return {
      app_id: args.app_id,
      data: {
        case: {
          ...c,
          started_at: iso(c.started_at),
          ended_at: isoOrNull(c.ended_at),
          last_event_at: iso(c.last_event_at),
          elapsed_ms: end >= c.started_at ? end - c.started_at : null,
        },
      },
      provenance: provenance(ctx, res.meta, "get_case_summary", { case_id: args.case_id }),
      interpretation: interpretation(ctx, "case_record", CASE_CAVEATS),
    };
  },

  async get_case_timeline(ctx, args) {
    const scope = await scopeFor(ctx, args.app_id, "lifecycle:read");
    const limit = args.limit ?? LIMITS.defaultTimelinePage;
    const query = { case_id: args.case_id, limit };
    const binding = { tool: "get_case_timeline", appId: args.app_id, query };
    const { page, sourceCursor } = await decodeCursor(args.cursor, binding);
    const summary = await call(() => ctx.source.getCaseSummary(scope, args.case_id));
    if (!summary.data) throw new ToolError("not_found", "Unknown case");
    const { workflow_key, version } = summary.data;
    const def = await definitionFor(ctx, scope, workflow_key, version);
    const res = await call(() =>
      ctx.source.getCaseTimeline(scope, args.case_id, { limit, cursor: sourceCursor }),
    );
    if (!res.data) throw new ToolError("not_found", "Unknown case");
    const entries = projectTimeline(res.data.items.slice(0, limit), def).map((entry) => ({
      ...entry,
      entered_at: iso(entry.entered_at),
      exited_at: isoOrNull(entry.exited_at),
      dwell_ms: entry.exited_at === null ? null : Math.max(0, entry.exited_at - entry.entered_at),
    }));
    return {
      app_id: args.app_id,
      data: { case_id: args.case_id, entries },
      page: { next_cursor: await encodeCursor(binding, page, res.data.next_cursor), page, limit },
      provenance: provenance(ctx, res.meta, "get_case_timeline", query),
      interpretation: interpretation(ctx, "case_record", CASE_CAVEATS),
    };
  },

  async get_stage_dwell(ctx, args) {
    const scope = await scopeFor(ctx, args.app_id, "process:read");
    const def = await definitionFor(ctx, scope, args.workflow_key, args.version ?? null);
    const q = cohortQuery(ctx, [def], args);
    const res = await call(() =>
      ctx.source.getStageDwell(scope, {
        workflowKey: def.workflow_key,
        version: def.version,
        ...q,
      }),
    );
    const stages = suppressDwell(res.data, def, q.groupBy, ctx.minCohort);
    return {
      app_id: args.app_id,
      data: {
        workflow_key: def.workflow_key,
        version: def.version,
        window: { from: iso(q.from), to: iso(q.to) },
        group_by: q.groupBy,
        stages,
      },
      privacy: { min_cohort: ctx.minCohort, any_suppressed: anySuppressed(stages) },
      provenance: provenance(
        ctx,
        res.meta,
        "get_stage_dwell",
        describeQuery(def.workflow_key, def.version, q),
      ),
      interpretation: interpretation(ctx, "observed_process_pattern", [
        ...OBSERVATIONAL_CAVEATS,
        ...METRICS.stage_dwell.caveats,
      ]),
    };
  },

  async get_funnel(ctx, args) {
    const scope = await scopeFor(ctx, args.app_id, "process:read");
    const def = await definitionFor(ctx, scope, args.workflow_key, args.version ?? null);
    const known = new Set(def.stages.map((stage) => stage.key));
    const stages =
      args.stages ??
      [...def.stages]
        .sort((a, b) => a.order - b.order)
        .map((stage) => stage.key)
        .slice(0, LIMITS.maxFunnelStages);
    if (!stages.every((key) => known.has(key)) || new Set(stages).size !== stages.length) {
      throw new ToolError("invalid_argument", "stages must be distinct stage keys of the workflow");
    }
    const q = cohortQuery(ctx, [def], args);
    const res = await call(() =>
      ctx.source.getFunnel(scope, {
        workflowKey: def.workflow_key,
        version: def.version,
        ...q,
        stages,
      }),
    );
    const allowed = q.groupBy
      ? new Set(def.dimensions.find((dim) => dim.key === q.groupBy)?.values ?? [])
      : null;
    const groups = suppressFunnel(res.data, stages, q.groupBy, allowed, ctx.minCohort);
    const steps = groups.flatMap((g) => (g.suppressed ? [] : g.steps));
    return {
      app_id: args.app_id,
      data: {
        workflow_key: def.workflow_key,
        version: def.version,
        window: { from: iso(q.from), to: iso(q.to) },
        group_by: q.groupBy,
        stages,
        groups,
      },
      privacy: {
        min_cohort: ctx.minCohort,
        any_suppressed: anySuppressed(groups) || anySuppressed(steps),
      },
      provenance: provenance(ctx, res.meta, "get_funnel", {
        ...describeQuery(def.workflow_key, def.version, q),
        stages,
      }),
      interpretation: interpretation(ctx, "observed_process_pattern", [
        ...OBSERVATIONAL_CAVEATS,
        ...METRICS.funnel_reach_rate.caveats,
      ]),
    };
  },

  async compare_workflow_variants(ctx, args) {
    const scope = await scopeFor(ctx, args.app_id, "process:read");
    const baseline = await definitionFor(
      ctx,
      scope,
      args.workflow_key,
      args.baseline_version ?? null,
    );
    const candidate =
      args.candidate_version === undefined
        ? null
        : await definitionFor(ctx, scope, args.workflow_key, args.candidate_version);
    if (candidate && candidate.version === baseline.version) {
      throw new ToolError(
        "invalid_argument",
        "candidate_version must differ from baseline_version",
      );
    }
    const defs = candidate ? [baseline, candidate] : [baseline];
    const q = cohortQuery(ctx, defs, { ...args, group_by: undefined });
    const limit = args.limit ?? 10;
    let meta: SourceMeta | null = null;
    const cohorts: Out<"compare_workflow_variants">["data"]["cohorts"] = [];
    for (const def of defs) {
      const res = await call(() =>
        ctx.source.getVariantStats(scope, {
          workflowKey: def.workflow_key,
          version: def.version,
          ...q,
          limit,
        }),
      );
      meta ??= res.meta;
      const released = suppressVariants(res.data, def, ctx.minCohort);
      if (released.suppressed) {
        cohorts.push({ version: def.version, ...released });
        continue;
      }
      const dominant = released.variants[0]?.median_cycle_ms ?? null;
      cohorts.push({
        version: def.version,
        ...released,
        variants: released.variants.map((variant) => ({
          ...variant,
          cycle_delta_vs_dominant_ms:
            dominant !== null && variant.median_cycle_ms !== null
              ? variant.median_cycle_ms - dominant
              : null,
        })),
      });
    }
    let comparison: Out<"compare_workflow_variants">["data"]["comparison"] = null;
    if (candidate) {
      const [base, cand] = cohorts;
      const reasons = [
        "Each version's cases differ in timing and case mix; differences are not caused by the version alone.",
      ];
      let deltas = null;
      if (!base || !cand || base.suppressed || cand.suppressed) {
        reasons.push("A cohort is below the minimum cohort size.");
      } else {
        const sameStages =
          baseline.stages.map((stage) => stage.key).join() ===
          candidate.stages.map((stage) => stage.key).join();
        if (!sameStages) {
          reasons.push("The versions define different stages; compare end-to-end metrics only.");
        }
        deltas = {
          median_cycle_ms:
            base.median_cycle_ms !== null && cand.median_cycle_ms !== null
              ? cand.median_cycle_ms - base.median_cycle_ms
              : null,
          completion_rate:
            base.completion_rate !== null && cand.completion_rate !== null
              ? Math.round((cand.completion_rate - base.completion_rate) * 10_000) / 10_000
              : null,
        };
      }
      comparison = {
        baseline_version: baseline.version,
        candidate_version: candidate.version,
        comparable:
          deltas !== null && (deltas.median_cycle_ms !== null || deltas.completion_rate !== null),
        reasons,
        deltas,
      };
    }
    const query = {
      workflow_key: baseline.workflow_key,
      versions: defs.map((def) => def.version),
      from: iso(q.from),
      to: iso(q.to),
      filters: q.filters,
      limit,
    };
    return {
      app_id: args.app_id,
      data: {
        workflow_key: baseline.workflow_key,
        window: { from: iso(q.from), to: iso(q.to) },
        cohorts,
        comparison,
      },
      privacy: {
        min_cohort: ctx.minCohort,
        // Pooled rare paths count as withheld detail too.
        any_suppressed: cohorts.some((c) => c.suppressed || c.other !== null),
      },
      provenance: provenance(ctx, meta, "compare_workflow_variants", query),
      interpretation: interpretation(ctx, "observed_process_pattern", [
        ...OBSERVATIONAL_CAVEATS,
        ...METRICS.variant_share.caveats,
        ...METRICS.cycle_time.caveats,
      ]),
    };
  },

  async list_bottlenecks(ctx, args) {
    const scope = await scopeFor(ctx, args.app_id, "process:read");
    const def = await definitionFor(ctx, scope, args.workflow_key, args.version ?? null);
    const q = cohortQuery(ctx, [def], { ...args, group_by: undefined });
    const res = await call(() =>
      ctx.source.getStageDwell(scope, {
        workflowKey: def.workflow_key,
        version: def.version,
        ...q,
      }),
    );
    const rows = suppressDwell(res.data, def, null, ctx.minCohort);
    const bottlenecks = rankBottlenecks(rows, def).slice(0, args.limit ?? 5);
    return {
      app_id: args.app_id,
      data: {
        workflow_key: def.workflow_key,
        version: def.version,
        window: { from: iso(q.from), to: iso(q.to) },
        bottlenecks,
      },
      privacy: { min_cohort: ctx.minCohort, any_suppressed: anySuppressed(rows) },
      provenance: provenance(
        ctx,
        res.meta,
        "list_bottlenecks",
        describeQuery(def.workflow_key, def.version, q),
      ),
      interpretation: interpretation(ctx, "observed_process_pattern", [
        ...OBSERVATIONAL_CAVEATS,
        ...METRICS.bottleneck_signal.caveats,
      ]),
    };
  },

  async describe_metric(ctx, args) {
    const metric = METRICS[args.metric];
    return {
      app_id: null,
      data: { metric: { ...metric, caveats: [...metric.caveats], used_by: [...metric.used_by] } },
      provenance: provenance(ctx, null, "describe_metric", { metric: args.metric }),
      interpretation: interpretation(ctx, "reference", []),
    };
  },

  async get_data_freshness(ctx, args) {
    const scope = await scopeFor(ctx, args.app_id, "lifecycle:read");
    const res = await call(() => ctx.source.getFreshness(scope));
    return {
      app_id: args.app_id,
      data: {
        status: res.data.status,
        watermark: isoOrNull(res.data.watermark),
        lag_ms: res.data.lag_ms,
        workflows: res.data.workflows
          .filter((w) => SLUG.test(w.workflow_key))
          .slice(0, LIMITS.maxPageSize)
          .map((w) => ({
            workflow_key: w.workflow_key,
            last_event_at: isoOrNull(w.last_event_at),
          })),
      },
      provenance: provenance(ctx, res.meta, "get_data_freshness", {}),
      interpretation: interpretation(ctx, "freshness", METRICS.data_freshness.caveats),
    };
  },
  async get_data_quality(ctx, args) {
    const scope = await scopeFor(ctx, args.app_id, "process:read");
    const def = await definitionFor(ctx, scope, args.workflow_key, args.version ?? null);
    const q = cohortQuery(ctx, [def], { ...args, group_by: undefined });
    const res = await call(() =>
      ctx.source.getDataQuality(scope, {
        workflowKey: def.workflow_key,
        version: def.version,
        ...q,
      }),
    );
    const k = ctx.minCohort;
    const release = (n: unknown) => {
      const value = typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
      return value === 0 || value >= k ? value : null;
    };
    const cohortN = release(res.data.cohort_n);
    const check = (name: string, n: unknown, warnAbove: number, note: string) => {
      const released = cohortN === null ? null : release(n);
      const share = released !== null && cohortN ? round4(released / cohortN) : null;
      return {
        check: name,
        n: released,
        share,
        severity: share !== null && share > warnAbove ? ("warning" as const) : ("info" as const),
        note,
      };
    };
    const freshness = res.meta.freshness.status;
    const checks = [
      check(
        "open_cases_censored",
        res.data.open_n,
        0.2,
        "Cases still open at the watermark. Dwell, cycle time and outcomes exclude or understate them.",
      ),
      check(
        "stage_reentries",
        res.data.reentry_n,
        0.3,
        "Cases that re-entered a stage (rework or loops). Each attempt counts as its own interval.",
      ),
      check(
        "skipped_stages",
        res.data.skipped_n,
        0.1,
        "Cases that skipped a stage; reach is not monotone.",
      ),
      check(
        "undeclared_stages",
        res.data.undeclared_stage_n,
        0,
        "Cases with intervals in stages the definition does not declare; those intervals are dropped.",
      ),
      ...def.dimensions.map((dim) =>
        check(
          `missing_dimension:${dim.key}`,
          res.data.missing_dimension_n?.[dim.key] ?? 0,
          0.05,
          `Cases without a declared ${dim.key} value; breakdowns by ${dim.key} omit them.`,
        ),
      ),
      {
        check: "data_freshness",
        n: null,
        share: null,
        severity: freshness === "fresh" ? ("info" as const) : ("warning" as const),
        note: `The read model is ${freshness}; see provenance.freshness.`,
      },
    ];
    return {
      app_id: args.app_id,
      data: {
        workflow_key: def.workflow_key,
        version: def.version,
        window: { from: iso(q.from), to: iso(q.to) },
        cohort_n: cohortN,
        checks,
      },
      privacy: {
        min_cohort: k,
        any_suppressed:
          cohortN === null || checks.some((c) => c.n === null && c.check !== "data_freshness"),
      },
      provenance: provenance(
        ctx,
        res.meta,
        "get_data_quality",
        describeQuery(def.workflow_key, def.version, q),
      ),
      interpretation: interpretation(ctx, "observed_process_pattern", [
        "Data-quality checks describe the recorded data, not the process itself.",
      ]),
    };
  },

  async compare_case_mix(ctx, args) {
    const scope = await scopeFor(ctx, args.app_id, "process:read");
    const cohorts: {
      role: "baseline" | "candidate";
      def: PublicDefinition;
      q: ReturnType<typeof cohortQuery>;
    }[] = [];
    for (const role of ["baseline", "candidate"] as const) {
      const spec = args[role];
      const def = await definitionFor(ctx, scope, args.workflow_key, spec.version ?? null);
      cohorts.push({ role, def, q: cohortQuery(ctx, [def], spec) });
    }
    const declared = (key: string) =>
      cohorts.every((c) => c.def.dimensions.some((dim) => dim.key === key));
    const dims =
      args.dimensions ??
      cohorts[0]?.def.dimensions
        .map((dim) => dim.key)
        .filter(declared)
        .slice(0, 5) ??
      [];
    if (!dims.every(declared) || new Set(dims).size !== dims.length) {
      throw new ToolError(
        "invalid_argument",
        "dimensions must be distinct dimensions both cohorts declare",
      );
    }
    let meta: SourceMeta | null = null;
    const mixes: Awaited<ReturnType<typeof caseMix>>[] = [];
    for (const c of cohorts) {
      const mix = await caseMix(ctx, scope, c.def, c.q, dims);
      meta ??= mix.meta;
      mixes.push(mix);
    }
    const [base, cand] = mixes;
    const dimensions = dims.map((key) => {
      const values = cohorts[0]?.def.dimensions.find((dim) => dim.key === key)?.values ?? [];
      const rows = values.map((value) => {
        const b = base?.shares.get(key)?.get(value) ?? null;
        const c = cand?.shares.get(key)?.get(value) ?? null;
        return {
          value,
          baseline_share: b,
          candidate_share: c,
          delta: b !== null && c !== null ? round4(c - b) : null,
        };
      });
      const deltas = rows.flatMap((row) => (row.delta === null ? [] : [Math.abs(row.delta)]));
      const max = deltas.length ? Math.max(...deltas) : null;
      return {
        dimension: key,
        values: rows,
        max_abs_delta: max,
        balanced: max === null ? null : max < CASE_MIX_TOLERANCE,
      };
    });
    const refs = cohorts.map((c, i) => ({
      role: c.role,
      version: c.def.version,
      window: { from: iso(c.q.from), to: iso(c.q.to) },
      n: mixes[i]?.n ?? null,
    }));
    return {
      app_id: args.app_id,
      data: { workflow_key: args.workflow_key, cohorts: refs, dimensions },
      privacy: {
        min_cohort: ctx.minCohort,
        any_suppressed:
          refs.some((r) => r.n === null) ||
          dimensions.some((d) =>
            d.values.some((v) => v.baseline_share === null || v.candidate_share === null),
          ),
      },
      provenance: provenance(ctx, meta, "compare_case_mix", {
        workflow_key: args.workflow_key,
        cohorts: refs.map((r) => ({ role: r.role, version: r.version, ...r.window })),
        dimensions: dims,
      }),
      interpretation: interpretation(ctx, "observed_process_pattern", [
        `Dimensions whose shares differ by ${CASE_MIX_TOLERANCE} or more are flagged as not balanced; stratify or filter before comparing outcomes.`,
        "Balanced declared dimensions do not rule out undeclared confounders.",
      ]),
    };
  },

  async build_evidence_pack(ctx, args) {
    return evidencePack(ctx, args);
  },
};

type Bottleneck = Out<"list_bottlenecks">["data"]["bottlenecks"][number];

/** Scores released, non-terminal stages; see the bottleneck_signal metric for the formula. */
function rankBottlenecks(rows: ReleasedDwell[], def: PublicDefinition): Bottleneck[] {
  const terminal = new Set(def.stages.filter((stage) => stage.terminal).map((stage) => stage.key));
  const released = rows.flatMap((row) =>
    !row.suppressed && row.p50_ms !== null && row.p50_ms > 0 && !terminal.has(row.stage_key)
      ? [{ ...row, p50_ms: row.p50_ms }]
      : [],
  );
  const totalP50 = released.reduce((sum, row) => sum + row.p50_ms, 0);
  const totalOpen = released.reduce((sum, row) => sum + (row.open_n ?? 0), 0);
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  return released
    .map((row) => {
      const share = row.p50_ms / totalP50;
      const tail = row.p90_ms === null ? null : row.p90_ms / row.p50_ms;
      const openShare = row.open_n === null || totalOpen === 0 ? null : row.open_n / totalOpen;
      const score =
        0.6 * share +
        0.25 * (tail === null ? 0 : Math.min(1, Math.max(0, (tail - 1) / 4))) +
        0.15 * (openShare ?? 0);
      return {
        rank: 0,
        stage_key: row.stage_key,
        score: round(score),
        signals: {
          share_of_median_path: round(share),
          tail_ratio: tail === null ? null : round(tail),
          share_of_open_work: openShare === null ? null : round(openShare),
        },
        observed: { n: row.n, open_n: row.open_n, p50_ms: row.p50_ms, p90_ms: row.p90_ms },
        evidence: "observed_association" as const,
      };
    })
    .sort((a, b) => b.score - a.score || a.stage_key.localeCompare(b.stage_key))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;

/** Share differences at or above this flag a dimension as not balanced between cohorts. */
const CASE_MIX_TOLERANCE = 0.1;

/** Released shares of each declared value, from per-group cohort sizes (suppression applied). */
async function caseMix(
  ctx: ToolContext,
  scope: AppScope,
  def: PublicDefinition,
  q: { from: number; to: number },
  dims: string[],
) {
  const first = [...def.stages].sort((a, b) => a.order - b.order)[0]?.key;
  if (!first) throw new ToolError("not_found", "The workflow declares no stages");
  const query = { workflowKey: def.workflow_key, version: def.version, from: q.from, to: q.to };
  const total = await call(() =>
    ctx.source.getFunnel(scope, { ...query, groupBy: null, filters: {}, stages: [first] }),
  );
  const [overall] = suppressFunnel(total.data, [first], null, null, ctx.minCohort);
  const n = overall && !overall.suppressed ? overall.cohort_n : null;
  const shares = new Map<string, Map<string, number | null>>();
  for (const dim of dims) {
    const allowed = new Set(def.dimensions.find((d) => d.key === dim)?.values ?? []);
    const res = await call(() =>
      ctx.source.getFunnel(scope, { ...query, groupBy: dim, filters: {}, stages: [first] }),
    );
    const groups = suppressFunnel(res.data, [first], dim, allowed, ctx.minCohort);
    const byValue = new Map<string, number | null>();
    for (const value of allowed) {
      const group = groups.find((g) => g.group === value);
      // A value with no cases has share 0; a withheld group's share stays unknown.
      byValue.set(
        value,
        n === null || !n ? null : !group ? 0 : group.suppressed ? null : round4(group.cohort_n / n),
      );
    }
    shares.set(dim, byValue);
  }
  return { n, shares, meta: total.meta };
}

type PackArgs = Args<"build_evidence_pack">;
type Pack = Out<"build_evidence_pack">["data"];
type Evidence = Pack["evidence"][number];

const PACK_METRICS: Record<PackArgs["question"], MetricId[]> = {
  bottleneck: [
    "bottleneck_signal",
    "stage_dwell",
    "open_in_stage",
    "funnel_reach_rate",
    "data_freshness",
    "small_cohort_suppression",
  ],
  health: [
    "stage_dwell",
    "open_in_stage",
    "funnel_reach_rate",
    "step_conversion",
    "bottleneck_signal",
    "data_freshness",
    "small_cohort_suppression",
  ],
  dwell_change: ["stage_dwell", "open_in_stage", "data_freshness", "small_cohort_suppression"],
  intervention: [
    "stage_dwell",
    "funnel_reach_rate",
    "step_conversion",
    "data_freshness",
    "small_cohort_suppression",
  ],
  variants: [
    "variant_share",
    "cycle_time",
    "completion_rate",
    "data_freshness",
    "small_cohort_suppression",
  ],
};

const UNSUPPORTED: Record<PackArgs["question"], string[]> = {
  bottleneck: [
    "That the top-ranked stage causes the overall delay, or that shortening it would shorten the process by the same amount.",
    "Who or which team is responsible: the data has no actors and must not be used to assess individuals.",
  ],
  health: [
    "That the process is healthy or unhealthy in absolute terms: no target or benchmark is part of the data.",
    "Who or which team is responsible: the data has no actors and must not be used to assess individuals.",
  ],
  dwell_change: [
    "That any single change caused the dwell difference between the cohorts.",
    "That the difference will persist: the cohorts are observational samples of two periods.",
  ],
  intervention: [
    "That the intervention caused the before/after difference: there is no randomization or control group.",
    "That the effect size is the intervention's effect, rather than case mix, seasonality or concurrent changes.",
  ],
  variants: [
    "That a path variant or version causes faster or slower cycle times: cases choose or are routed to paths for reasons not in the data.",
    "That cases on a rare path (pooled as other) behave like any listed variant.",
  ],
};

const STATIC_CONFOUNDERS = [
  "Seasonality and workload: cohorts from different periods can differ in volume and urgency.",
  "Concurrent changes: tooling, staffing or policy changes in the same windows are not in the data.",
  "Data completeness: late or corrected events after the watermark can still change these numbers.",
];

const ANALYSIS_INSTRUCTIONS = `Interpret this pack yourself; the server performs no analysis beyond the aggregates shown.
Cite evidence by id with its sample_n, as_of and watermark. Report withheld (suppressed) values as withheld and never estimate them.
Before comparing cohorts, check case mix and data quality; name every confounder and censoring issue that could explain a difference.
Describe findings as observed associations. For each claim in unsupported_claims, say explicitly that the evidence does not support it.
End with the additional measurements that would strengthen or refute the observation.`;

/** Composes existing tools into one bounded, provenance-stamped evidence pack. */
async function evidencePack(ctx: ToolContext, args: PackArgs): Promise<Out<"build_evidence_pack">> {
  const { app_id, workflow_key, question } = args;
  const paired =
    question === "dwell_change" || question === "intervention" || question === "variants";
  if (paired && !args.candidate) {
    throw new ToolError(
      "invalid_argument",
      "This question compares two cohorts: give baseline and candidate",
    );
  }
  if (!paired && args.candidate) {
    throw new ToolError("invalid_argument", "This question uses one cohort: give only baseline");
  }
  // Fail fast with one uniform denial before composing anything.
  await scopeFor(ctx, app_id, "process:read");
  const base = { app_id, workflow_key, ...(args.baseline ?? {}) };
  const cand = args.candidate ? { app_id, workflow_key, ...args.candidate } : null;

  const evidence: Evidence[] = [];
  // Each composed result is re-validated against the tool's own strict output schema.
  const add = async <K extends ToolName>(
    role: Evidence["role"],
    tool: K,
    kind: Evidence["kind"],
    args: Args<K>,
  ) => {
    const out = outputs[tool].parse(await (handlers[tool] as Handler<K>)(ctx, args)) as Envelope & {
      data: Record<string, unknown>;
      privacy?: { any_suppressed: boolean };
    };
    const id = `e${evidence.length + 1}`;
    evidence.push({
      id,
      role,
      tool,
      kind,
      sample_n: sampleSize(tool, out.data),
      any_suppressed: out.privacy?.any_suppressed ?? false,
      as_of: out.provenance.as_of,
      watermark: out.provenance.freshness.watermark,
      data: out.data,
    });
    return { id, data: out.data };
  };

  await add("context", "get_data_freshness", "freshness", { app_id });
  const dqBase = await add("baseline", "get_data_quality", "data_quality", base);
  const dqCand = cand ? await add("candidate", "get_data_quality", "data_quality", cand) : null;
  const derived: Pack["derived"] = [];

  if (question === "bottleneck" || question === "health") {
    await add("baseline", "list_bottlenecks", "observed_process_pattern", base);
    await add("baseline", "get_stage_dwell", "observed_process_pattern", base);
    await add("baseline", "get_funnel", "observed_process_pattern", base);
  } else if (cand && (question === "dwell_change" || question === "intervention")) {
    const b = await add("baseline", "get_stage_dwell", "observed_process_pattern", base);
    const c = await add("candidate", "get_stage_dwell", "observed_process_pattern", cand);
    derived.push(...dwellDeltas(b, c));
    if (question === "intervention") {
      const fb = await add("baseline", "get_funnel", "observed_process_pattern", base);
      const fc = await add("candidate", "get_funnel", "observed_process_pattern", cand);
      derived.push(...reachDeltas(fb, fc, derived.length));
    }
  } else if (cand) {
    await add("comparison", "compare_workflow_variants", "observed_process_pattern", {
      app_id,
      workflow_key,
      baseline_version: base.version,
      candidate_version: cand.version,
      from: base.from,
      to: base.to,
    });
  }

  let mix: { data: Record<string, unknown> } | null = null;
  if (cand) {
    mix = await add("comparison", "compare_case_mix", "case_mix", {
      app_id,
      workflow_key,
      baseline: args.baseline ?? {},
      candidate: args.candidate ?? {},
    });
  }

  const cohorts: Pack["scope"]["cohorts"] = [dqBase, dqCand].flatMap((dq, i) =>
    dq
      ? [
          {
            role: i === 0 ? ("baseline" as const) : ("candidate" as const),
            version: Number(dq.data.version),
            window: dq.data.window as { from: string; to: string },
            n: (dq.data.cohort_n as number | null) ?? null,
          },
        ]
      : [],
  );

  const confounders = [...STATIC_CONFOUNDERS];
  for (const dim of (mix?.data.dimensions as
    | { dimension: string; balanced: boolean | null; max_abs_delta: number | null }[]
    | undefined) ?? []) {
    if (dim.balanced === false) {
      confounders.unshift(
        `Case mix: ${dim.dimension} shares differ by up to ${dim.max_abs_delta} between cohorts; stratify by ${dim.dimension} (group_by or filters) before attributing a difference.`,
      );
    }
  }
  if (cohorts.length === 2 && cohorts[0]?.version !== cohorts[1]?.version) {
    confounders.push(
      "Definition change: the cohorts use different workflow versions; compare end-to-end metrics only.",
    );
  }

  const censoring = [
    "Dwell percentiles use completed intervals only; long-running open cases are not yet counted.",
  ];
  for (const dq of [dqBase, dqCand]) {
    const open = (dq?.data.checks as { check: string; share: number | null }[] | undefined)?.find(
      (c) => c.check === "open_cases_censored",
    );
    if (open?.share) {
      censoring.push(
        `${dq?.id}: ${Math.round(open.share * 1000) / 10}% of the cohort was still open at the watermark, so durations are biased low and outcomes incomplete.`,
      );
    }
  }

  return {
    app_id,
    data: {
      pack_version: "lifecycle-evidence-pack@1",
      question,
      scope: { app_id, workflow_key, cohorts },
      evidence,
      derived,
      metric_definitions: PACK_METRICS[question].map((id) => ({
        ...METRICS[id],
        caveats: [...METRICS[id].caveats],
        used_by: [...METRICS[id].used_by],
      })),
      confounders_to_check: confounders,
      censoring,
      unsupported_claims: [
        ...UNSUPPORTED[question],
        "Anything about withheld (suppressed) groups.",
      ],
      analysis_instructions: ANALYSIS_INSTRUCTIONS,
    },
    privacy: { min_cohort: ctx.minCohort, any_suppressed: evidence.some((e) => e.any_suppressed) },
    provenance: provenance(ctx, null, "build_evidence_pack", {
      question,
      workflow_key,
      evidence: evidence.map((e) => `${e.id}:${e.tool}:${e.role}`),
    }),
    interpretation: interpretation(ctx, "observed_process_pattern", OBSERVATIONAL_CAVEATS),
  };
}

function sampleSize(tool: ToolName, data: Record<string, unknown>): number | null {
  const released = (rows: unknown, field: string) =>
    Array.isArray(rows)
      ? rows.reduce<number | null>((max, row) => {
          const value = (row as Record<string, unknown>)[field];
          return typeof value === "number" ? Math.max(max ?? 0, value) : max;
        }, null)
      : null;
  switch (tool) {
    case "get_data_quality":
      return (data.cohort_n as number | null) ?? null;
    case "get_stage_dwell":
      return released(data.stages, "n");
    case "get_funnel":
      return released(data.groups, "cohort_n");
    case "list_bottlenecks":
      return released(
        (data.bottlenecks as { observed: unknown }[] | undefined)?.map((b) => b.observed),
        "n",
      );
    case "compare_workflow_variants":
    case "compare_case_mix": {
      const cohorts = data.cohorts as Record<string, unknown>[] | undefined;
      const field = tool === "compare_case_mix" ? "n" : "total_n";
      const sizes = (cohorts ?? [])
        .map((c) => c[field])
        .filter((n): n is number => typeof n === "number");
      return sizes.length ? sizes.reduce((a, b) => a + b, 0) : null;
    }
    default:
      return null;
  }
}

type DwellRows = {
  stage_key: string;
  suppressed: boolean;
  p50_ms?: number | null;
  p90_ms?: number | null;
}[];

function dwellDeltas(
  b: { id: string; data: Record<string, unknown> },
  c: { id: string; data: Record<string, unknown> },
) {
  const out: Pack["derived"] = [];
  const before = new Map((b.data.stages as DwellRows).map((row) => [row.stage_key, row]));
  for (const after of c.data.stages as DwellRows) {
    const prior = before.get(after.stage_key);
    if (!prior || prior.suppressed || after.suppressed) continue;
    for (const field of ["p50_ms", "p90_ms"] as const) {
      const x = prior[field];
      const y = after[field];
      out.push({
        id: `d${out.length + 1}`,
        from: [b.id, c.id],
        metric: `stage_dwell_${field.replace("_ms", "")}_delta`,
        stage_key: after.stage_key,
        value: typeof x === "number" && typeof y === "number" ? y - x : null,
        unit: "milliseconds",
      });
    }
  }
  return out;
}

type FunnelGroups = {
  suppressed: boolean;
  steps?: { stage_key: string; suppressed: boolean; reach_rate?: number | null }[];
}[];

function reachDeltas(
  b: { id: string; data: Record<string, unknown> },
  c: { id: string; data: Record<string, unknown> },
  offset: number,
) {
  const steps = (data: Record<string, unknown>) => {
    const [group] = data.groups as FunnelGroups;
    return group && !group.suppressed ? (group.steps ?? []) : [];
  };
  const before = new Map(steps(b.data).map((step) => [step.stage_key, step]));
  return steps(c.data).flatMap((after, i) => {
    const prior = before.get(after.stage_key);
    if (!prior || prior.suppressed || after.suppressed) return [];
    const x = prior.reach_rate;
    const y = after.reach_rate;
    return [
      {
        id: `d${offset + i + 1}`,
        from: [b.id, c.id],
        metric: "funnel_reach_rate_delta",
        stage_key: after.stage_key,
        value: typeof x === "number" && typeof y === "number" ? round4(y - x) : null,
        unit: "ratio",
      },
    ];
  });
}

/** Runs one tool and shapes the MCP result; failures become `isError` results with a code. */
export async function runTool<K extends ToolName>(
  name: K,
  ctx: ToolContext,
  args: Args<K>,
): Promise<CallToolResult> {
  try {
    const structured = await (handlers[name] as Handler<K>)(ctx, args);
    const text = JSON.stringify(structured);
    if (text.length > LIMITS.maxResultChars) {
      throw new ToolError(
        "result_too_large",
        "The result exceeds the output budget; narrow the date range, filters or limit",
      );
    }
    return {
      content: [{ type: "text", text }],
      structuredContent: structured as Record<string, unknown>,
    };
  } catch (error) {
    const failure =
      error instanceof ToolError
        ? error
        : error instanceof BoundsError
          ? new ToolError("invalid_argument", error.message)
          : new ToolError("internal", "Internal error");
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: { code: failure.code, message: failure.message } }),
        },
      ],
    };
  }
}
