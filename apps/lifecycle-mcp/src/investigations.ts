import { LIMITS, resolveWindow } from "./bounds";
import {
  INVESTIGATION_LIMITS as BUDGET,
  type EvidenceEntry,
  type InvestigationBridge,
  type InvestigationEvidence,
  type InvestigationInput,
  investigationOutputs,
  sourceSnapshot,
} from "./investigation-contract";
import { ANALYSIS_GUIDES } from "./prompts";
import type { LifecycleReadSource, Sourced } from "./source";
import { executeReadTool, scopeFor, type ToolContext, ToolError } from "./tools";

const LIMITATIONS = [
  "Deterministic bounded read bridge only; no server-side reasoning, model invocation or causal analysis.",
  "Cohorts are explicit versions and start windows without filters; case-mix matching is not performed.",
  "No upstream event coverage, arrival/service rates, resource capacity, staffing forecast or outcome breakdown is available.",
  "No historical as_of query or atomic snapshot API is available; each source snapshot is preserved and checked.",
  "Evidence refs are content-addressed citations, not stored resources or retrievable tasks; retain the returned pack.",
  "The production read API remains unwired and fail closed. Synthetic results describe invented fixtures only.",
  "Read timeouts stop further scheduling; the source contract has no abort signal to cancel an already-started read.",
  "Parent/child dependencies and concurrent critical paths are unsupported until aggregate_child_rollup or get_case_relations is wired. Never sum stage or child medians to infer parent blockers.",
];
const REQUIRED = [
  "get_data_freshness",
  "get_stage_dwell",
  "get_funnel",
  "compare_workflow_variants",
] as const;
const METHODS = [
  "getFreshness",
  "getWorkflowDefinition",
  "getStageDwell",
  "getFunnel",
  "getVariantStats",
] as const;

/** Counts source-returned array elements, including nested rows. Reject, never truncate evidence. */
function rows(value: unknown): number {
  if (Array.isArray(value)) return value.length + value.reduce((sum, item) => sum + rows(item), 0);
  if (value && typeof value === "object")
    return Object.values(value).reduce<number>((sum, item) => sum + rows(item), 0);
  return 0;
}

/** Deadline bounds the whole call, including grant resolution. No retries or background tasks. */
export async function withInvestigationDeadline<T>(
  operation: (active: () => void) => Promise<T>,
  timeoutMs: number = BUDGET.timeoutMs,
): Promise<T> {
  let expired = false;
  const end = Date.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = () => {
    if (expired || Date.now() >= end)
      throw new ToolError("budget_exceeded", "Investigation time budget exceeded");
  };
  try {
    return await Promise.race([
      operation(active),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new ToolError("budget_exceeded", "Investigation time budget exceeded"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    expired = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Implements only the temporary MCP bridge contract. Replace with the package adapter once
 * published; do not copy its statistics, plans or domain reasoning into this module.
 */
export class BoundedReadInvestigationBridge implements InvestigationBridge {
  constructor(
    private readonly ctx: ToolContext,
    private readonly active: () => void,
  ) {}

  async plan(input: InvestigationInput) {
    await scopeFor(this.ctx, input.app_id, "process:read");
    this.active();
    if (input.dependency_scope === "child_dependencies") {
      throw new ToolError(
        "insufficient_evidence",
        "Child dependency graphs are unsupported until aggregate_child_rollup or get_case_relations is wired; stage/child medians cannot establish parent blockers or critical paths",
      );
    }
    const needsPair = [
      "explain_dwell_change",
      "compare_process_variants",
      "evaluate_intervention",
    ].includes(input.goal);
    if (needsPair && input.cohorts.length !== 2) {
      throw new ToolError(
        "invalid_argument",
        "This investigation goal requires two explicit cohorts",
      );
    }
    const windows = input.cohorts.map((c) => resolveWindow(c, this.ctx.now()));
    const [a, b] = input.cohorts;
    const [wa, wb] = windows;
    if (a && b && wa && wb) {
      const sameWindow = wa.from === wb.from && wa.to === wb.to;
      const disjoint = wa.to <= wb.from || wb.to <= wa.from;
      const equalDuration = wa.to - wa.from === wb.to - wb.from;
      if (input.goal === "compare_process_variants") {
        if (a.version === b.version || !sameWindow) {
          throw new ToolError(
            "invalid_argument",
            "Variant comparison requires different versions and the same window",
          );
        }
      } else if (a.version !== b.version || !disjoint || !equalDuration) {
        throw new ToolError(
          "invalid_argument",
          "Temporal cohorts require the same version and disjoint equal-duration windows",
        );
      }
    }
    return investigationOutputs.plan_investigation.parse({
      contract_version: "bounded-read-bridge@1",
      app_id: input.app_id,
      workflow_key: input.workflow_key,
      goal: input.goal,
      cohorts: input.cohorts.map((c, i) => {
        const w = resolveWindow(c, this.ctx.now());
        return {
          cohort_ref: `cohort-${i + 1}`,
          version: c.version,
          from: new Date(w.from).toISOString(),
          to: new Date(w.to).toISOString(),
        };
      }),
      required_tools: [...REQUIRED],
      limits: {
        max_cohorts: BUDGET.maxCohorts,
        max_source_reads: BUDGET.maxSourceReads,
        max_source_rows: BUDGET.maxSourceRows,
        timeout_ms: BUDGET.timeoutMs,
        max_result_chars: LIMITS.maxResultChars,
        min_cohort: this.ctx.minCohort,
      },
      data_queries_executed: 0,
      model_invoked: false,
      dependency_graph: "unsupported",
      guidance: ANALYSIS_GUIDES[input.goal],
      limitations: LIMITATIONS,
    });
  }

  async collect(input: InvestigationInput): Promise<InvestigationEvidence> {
    const plan = await this.plan(input);
    let readCount = 0;
    let rowCount = 0;
    const sourceReads: InvestigationEvidence["source_reads"] = [];
    const source = new Proxy(this.ctx.source, {
      get: (target, prop, receiver) => {
        if (prop === "kind") return target.kind;
        // executeReadTool is invoked only with fixed literal names below. A future accidental
        // case read or new method also fails here, before touching the source.
        if (!(METHODS as readonly PropertyKey[]).includes(prop)) {
          throw new ToolError("internal", "Unsupported investigation source read");
        }
        const method = prop as (typeof METHODS)[number];
        return async (...args: unknown[]) => {
          this.active();
          if (++readCount > BUDGET.maxSourceReads)
            throw new ToolError("budget_exceeded", "Investigation read budget exceeded");
          const fn = Reflect.get(target, method, receiver) as (
            ...a: unknown[]
          ) => Promise<Sourced<unknown>>;
          const result = await fn.apply(target, args);
          this.active();
          rowCount += rows(result.data);
          if (rowCount > BUDGET.maxSourceRows)
            throw new ToolError("budget_exceeded", "Investigation source row budget exceeded");
          const snapshot = sourceSnapshot.parse(result.meta);
          if (
            snapshot.as_of > this.ctx.now() ||
            (snapshot.freshness.watermark !== null && snapshot.freshness.watermark > snapshot.as_of)
          ) {
            throw new ToolError("source_unavailable", "Invalid source snapshot metadata");
          }
          sourceReads.push({ ref: `source-${readCount}`, method, snapshot });
          return result;
        };
      },
    }) as LifecycleReadSource;
    const ctx: ToolContext = { ...this.ctx, source };
    const freshness = await executeReadTool("get_data_freshness", ctx, { app_id: input.app_id });
    const entries: EvidenceEntry[] = [];
    const collectEntry = async (
      cohortRef: string,
      read: () => Promise<EvidenceEntry["evidence"]>,
    ) => {
      const start = sourceReads.length;
      const evidence = await read();
      entries.push({
        ref: `entry-${entries.length + 1}`,
        cohort_ref: cohortRef,
        query_id: await digest({
          app_id: input.app_id,
          tool: evidence.tool,
          query: evidence.result.provenance.query,
        }),
        source_refs: sourceReads.slice(start).map((r) => r.ref),
        evidence,
      });
    };
    for (const cohort of plan.cohorts) {
      const args = {
        app_id: input.app_id,
        workflow_key: input.workflow_key,
        version: cohort.version,
        from: cohort.from,
        to: cohort.to,
      };
      await collectEntry(cohort.cohort_ref, async () => ({
        tool: "get_stage_dwell",
        result: await executeReadTool("get_stage_dwell", ctx, args),
      }));
      await collectEntry(cohort.cohort_ref, async () => ({
        tool: "get_funnel",
        result: await executeReadTool("get_funnel", ctx, args),
      }));
      await collectEntry(cohort.cohort_ref, async () => ({
        tool: "compare_workflow_variants",
        result: await executeReadTool("compare_workflow_variants", ctx, {
          app_id: input.app_id,
          workflow_key: input.workflow_key,
          baseline_version: cohort.version,
          from: cohort.from,
          to: cohort.to,
          limit: 5,
        }),
      }));
    }
    this.active();
    const snapshots = sourceReads.map((read) => read.snapshot);
    const first = JSON.stringify(snapshots[0]);
    const consistent = snapshots.every((meta) => JSON.stringify(meta) === first);
    const fresh =
      freshness.data.status === "fresh" &&
      freshness.data.watermark === freshness.provenance.freshness.watermark &&
      snapshots.every((meta) => {
        const f = meta.freshness;
        return (
          f.status === "fresh" &&
          f.watermark !== null &&
          f.lag_ms !== null &&
          f.lag_ms <= BUDGET.maxWatermarkLagMs &&
          this.ctx.now() - f.watermark <= BUDGET.maxWatermarkLagMs
        );
      });
    const watermarks = snapshots.map((meta) => meta.freshness.watermark);
    const watermark = watermarks.every((w) => w !== null)
      ? Math.min(...(watermarks as number[]))
      : null;
    const covered = watermark !== null && plan.cohorts.every((c) => Date.parse(c.to) <= watermark);
    const samples = plan.cohorts.map((c) => {
      const item = entries.find(
        (entry) =>
          entry.cohort_ref === c.cohort_ref && entry.evidence.tool === "compare_workflow_variants",
      )?.evidence;
      const stats =
        item?.tool === "compare_workflow_variants" ? item.result.data.cohorts[0] : undefined;
      const n = stats && !stats.suppressed ? stats.total_n : null;
      const completed = stats && !stats.suppressed ? stats.completed_n : null;
      return {
        cohort_ref: c.cohort_ref,
        n,
        completed_n: completed,
        open_n: n !== null && completed !== null ? n - completed : null,
      };
    });
    const enough = plan.cohorts.every((c) => {
      const sample = samples.find((s) => s.cohort_ref === c.cohort_ref);
      const dwell = entries.find(
        (e) => e.cohort_ref === c.cohort_ref && e.evidence.tool === "get_stage_dwell",
      )?.evidence;
      return (
        sample?.n !== null &&
        (sample?.n ?? 0) >= ctx.minCohort &&
        dwell?.tool === "get_stage_dwell" &&
        dwell.result.data.stages.some(
          (s) => !s.suppressed && s.n >= ctx.minCohort && s.p50_ms !== null,
        )
      );
    });
    const suppressed = entries.some((entry) => entry.evidence.result.privacy?.any_suppressed);
    const warnings = [
      "Observational evidence only; no causal conclusions or matched-cohort claims are supported.",
      "Source event coverage and case-mix balance are unknown; completed dwell excludes open intervals and follow-up may differ.",
      "Completion is the only available outcome proxy; no hiring assessments, scores or individual data are collected.",
    ];
    if (ctx.source.kind === "synthetic")
      warnings.push("SYNTHETIC DATA: invented fixtures; production is not wired.");
    if (!consistent) warnings.push("Source snapshots differ; this pack is not an atomic snapshot.");
    if (!fresh) warnings.push("Stale or unavailable watermarks: evidence is not current.");
    if (!covered) warnings.push("The source watermark does not cover every cohort window.");
    if (!enough)
      warnings.push(
        "Insufficient released sample or dwell evidence; do not draw quantitative conclusions.",
      );
    if (suppressed)
      warnings.push(
        "Small cells, complementary cohorts or rare paths are withheld; do not reconstruct them.",
      );
    const payload = {
      contract_version: "bounded-read-bridge@1" as const,
      app_id: input.app_id,
      workflow_key: input.workflow_key,
      synthetic: ctx.source.kind === "synthetic",
      as_of: consistent && snapshots[0] ? new Date(snapshots[0].as_of).toISOString() : null,
      watermark: watermark === null ? null : new Date(watermark).toISOString(),
      plan,
      freshness,
      source_reads: sourceReads,
      entries,
      checks: {
        status:
          enough && consistent && fresh && covered
            ? ("bounded_evidence" as const)
            : ("insufficient_evidence" as const),
        snapshot_consistent: consistent,
        fresh,
        window_covered: covered,
        min_cohort: ctx.minCohort,
        any_suppressed: suppressed,
        samples,
        coverage: "upstream_event_coverage_unknown" as const,
        censoring: "completed_intervals_only_open_cases_right_censored" as const,
        matched_cohorts: "not_verified" as const,
        outcome_detail: "completion_only_no_outcome_breakdown" as const,
      },
      warnings,
      model_invoked: false as const,
      causal: false as const,
    };
    const id = await digest(payload);
    const ref = `urn:flightdeck:evidence:${id}`;
    const pack = investigationOutputs.collect_investigation_evidence.parse({
      ...payload,
      evidence_id: id,
      evidence_ref: ref,
      entries: entries.map((entry) => ({
        ...entry,
        ref: `${ref}#${entry.ref}`,
        source_refs: entry.source_refs.map((sourceRef) => `${ref}#${sourceRef}`),
      })),
      source_reads: sourceReads.map((read) => ({ ...read, ref: `${ref}#${read.ref}` })),
    });
    return freeze(pack);
  }
}

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `sha256:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Freeze the server object; callers receive a content-addressed copy, with no mutable store. */
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
