import { isLifecycleReadKey } from "@flightdeckhq/schema";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import type { Authorizer } from "./authorize";
import { BoundsError, decodeCursor, encodeCursor, LIMITS, resolveWindow } from "./bounds";
import { CASE_CAVEATS, METRICS, OBSERVATIONAL_CAVEATS } from "./glossary";
import type { InvestigationEngineConfig } from "./investigation-engine-adapter";
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
import type { inputs, outputs, ToolName } from "./schemas";
import {
  type AppScope,
  type Capability,
  type LifecycleReadSource,
  SourceForbiddenError,
  type SourceMeta,
  SourceUnavailableError,
} from "./source";

export const SERVER_VERSION = "0.1.0";

export type ToolContext = {
  investigationEngine?: InvestigationEngineConfig;
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
  | "budget_exceeded"
  | "insufficient_evidence"
  | "unsupported"
  | "engine_unavailable"
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

const SYNTHETIC_CAVEAT =
  "SYNTHETIC DATA: invented fixtures for testing and demos, not real operational data.";

const FORBIDDEN = "Not authorized for this app, or the app does not exist";

export const definitionUri = (appId: string, workflowKey: string) =>
  `lifecycle://apps/${encodeURIComponent(appId)}/workflows/${encodeURIComponent(workflowKey)}/definition`;

export async function scopeFor(ctx: ToolContext, appId: string, capability: Capability) {
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
    if (error instanceof ToolError) throw error;
    if (error instanceof SourceForbiddenError) throw new ToolError("forbidden", FORBIDDEN);
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
    ...(meta.projection ? { projection: meta.projection } : {}),
    ...(ctx.source.kind === "lifecycle-read-api"
      ? { event_time_completeness: "unknown" as const }
      : {}),
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
  const completeness =
    ctx.source.kind === "lifecycle-read-api" && kind !== "reference"
      ? [
          "Event-time completeness is unknown. A fresh status means only a recent projection; producer delivery and event coverage are unverified.",
        ]
      : [];
  return {
    kind,
    causal: false,
    caveats: synthetic ? [SYNTHETIC_CAVEAT, ...caveats] : [...completeness, ...caveats],
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
  if (
    !res.data ||
    res.data.workflow_key !== workflowKey ||
    (version !== null && res.data.version !== version)
  ) {
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
      .filter((def) => isLifecycleReadKey(def.workflow_key))
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
        any_suppressed: cohorts.some(
          (c) =>
            c.suppressed ||
            c.other !== null ||
            c.completed_n === null ||
            c.variants.some((v) => v.completed_n === null),
        ),
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
          .filter((w) => isLifecycleReadKey(w.workflow_key))
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

/** Runs one tool and shapes the MCP result; failures become `isError` results with a code. */
export async function runTool<K extends ToolName>(
  name: K,
  ctx: ToolContext,
  args: Args<K>,
): Promise<CallToolResult> {
  return formatToolResult(() => (handlers[name] as Handler<K>)(ctx, args));
}

export async function formatToolResult(
  operation: () => Promise<object>,
  summary?: string,
): Promise<CallToolResult> {
  try {
    const structured = await operation();
    const text = JSON.stringify(structured);
    if (text.length + (summary?.length ?? 0) > LIMITS.maxResultChars) {
      throw new ToolError(
        "result_too_large",
        "The result exceeds the output budget; narrow the date range, filters or limit",
      );
    }
    return {
      content: [{ type: "text", text: summary ?? text }],
      structuredContent: structured as Record<string, unknown>,
    };
  } catch (error) {
    const failure =
      error instanceof ToolError
        ? error
        : error instanceof SourceUnavailableError
          ? new ToolError("source_unavailable", "The lifecycle read source is unavailable")
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

/** Typed in-process bridge to the existing read handlers, not arbitrary MCP tool dispatch. */
export async function executeReadTool<K extends ToolName>(
  name: K,
  ctx: ToolContext,
  args: Args<K>,
): Promise<Out<K>> {
  return (handlers[name] as Handler<K>)(ctx, args);
}
