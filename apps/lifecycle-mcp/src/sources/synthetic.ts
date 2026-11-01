import type {
  AggregateQuery,
  AppFreshness,
  AppScope,
  CaseSummary,
  DwellGroup,
  FunnelGroup,
  Grant,
  LifecycleReadSource,
  Page,
  PageRequest,
  Principal,
  Sourced,
  SourceMeta,
  TimelineEntry,
  VariantStats,
  WorkflowDefinition,
} from "../source";
import {
  DELIVERY_APP,
  RECRUITING_APP,
  SYNTHETIC_ANCHOR,
  SYNTHETIC_WORKFLOWS,
  type SyntheticCase,
  syntheticCases,
} from "./synthetic-data";

/** What every authenticated caller may read in synthetic mode. `synthetic-restricted` is absent. */
export const DEFAULT_SYNTHETIC_GRANTS: Grant[] = [
  { appId: "synthetic-release", role: "analyst", expiresAt: null },
  { appId: "synthetic-support", role: "analyst", expiresAt: null },
  { appId: RECRUITING_APP, role: "analyst", expiresAt: null },
  { appId: DELIVERY_APP, role: "analyst", expiresAt: null },
];

const STALE_AFTER_MS = 15 * 60_000;

export type SyntheticOptions = {
  grants?: (principal: Principal) => Grant[] | Promise<Grant[]>;
  now?: () => number;
};

/** Serves the invented fixtures in `synthetic-data.ts`. Results are labelled synthetic upstream. */
export class SyntheticLifecycleSource implements LifecycleReadSource {
  readonly kind = "synthetic" as const;
  private readonly now: () => number;
  private readonly grants: NonNullable<SyntheticOptions["grants"]>;

  constructor(opts: SyntheticOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.grants = opts.grants ?? (() => DEFAULT_SYNTHETIC_GRANTS);
  }

  async grantsFor(principal: Principal): Promise<Grant[]> {
    return this.grants(principal);
  }

  private meta(): SourceMeta {
    const asOf = this.now();
    const lag = Math.max(0, asOf - SYNTHETIC_ANCHOR);
    return {
      as_of: asOf,
      freshness: {
        status: lag <= STALE_AFTER_MS ? "fresh" : "stale",
        watermark: SYNTHETIC_ANCHOR,
        lag_ms: lag,
      },
      source_version: "synthetic-fixtures@1",
    };
  }

  private sourced<T>(data: T): Sourced<T> {
    return { data, meta: this.meta() };
  }

  private definitions(appId: string): WorkflowDefinition[] {
    return SYNTHETIC_WORKFLOWS.filter((w) => w.appId === appId)
      .map((w) => w.definition)
      .sort((a, b) => a.workflow_key.localeCompare(b.workflow_key) || b.version - a.version);
  }

  async listWorkflowDefinitions(
    scope: AppScope,
    q: { workflowKey: string | null; page: PageRequest },
  ): Promise<Sourced<Page<WorkflowDefinition>>> {
    const all = this.definitions(scope.appId).filter(
      (d) => q.workflowKey === null || d.workflow_key === q.workflowKey,
    );
    return this.sourced(paginate(all, q.page));
  }

  async getWorkflowDefinition(
    scope: AppScope,
    workflowKey: string,
    version: number | null,
  ): Promise<Sourced<WorkflowDefinition | null>> {
    const found = this.definitions(scope.appId).find(
      (d) => d.workflow_key === workflowKey && (version === null || d.version === version),
    );
    return this.sourced(found ?? null);
  }

  private findCase(appId: string, caseId: string): SyntheticCase | undefined {
    return syntheticCases().find((c) => c.appId === appId && c.case_id === caseId);
  }

  async getCaseSummary(scope: AppScope, caseId: string): Promise<Sourced<CaseSummary | null>> {
    const found = this.findCase(scope.appId, caseId);
    if (!found) return this.sourced(null);
    const { appId: _app, intervals: _intervals, ...summary } = found;
    return this.sourced(summary);
  }

  async getCaseTimeline(
    scope: AppScope,
    caseId: string,
    page: PageRequest,
  ): Promise<Sourced<Page<TimelineEntry> | null>> {
    const found = this.findCase(scope.appId, caseId);
    if (!found) return this.sourced(null);
    const ordered = [...found.intervals].sort((a, b) => a.entered_at - b.entered_at);
    return this.sourced(paginate(ordered, page));
  }

  private cohort(appId: string, q: AggregateQuery): SyntheticCase[] {
    return syntheticCases().filter(
      (c) =>
        c.appId === appId &&
        c.workflow_key === q.workflowKey &&
        c.version === q.version &&
        c.started_at >= q.from &&
        c.started_at < q.to &&
        Object.entries(q.filters).every(([key, value]) => c.dimensions[key] === value),
    );
  }

  private groups(
    cases: SyntheticCase[],
    groupBy: string | null,
  ): Map<string | null, SyntheticCase[]> {
    const out = new Map<string | null, SyntheticCase[]>();
    for (const c of cases) {
      const key = groupBy === null ? null : (c.dimensions[groupBy] ?? null);
      if (groupBy !== null && key === null) continue;
      out.set(key, [...(out.get(key) ?? []), c]);
    }
    return out;
  }

  async getStageDwell(scope: AppScope, q: AggregateQuery): Promise<Sourced<DwellGroup[]>> {
    const def = this.definitions(scope.appId).find(
      (d) => d.workflow_key === q.workflowKey && d.version === q.version,
    );
    const rows: DwellGroup[] = [];
    for (const [group, cases] of this.groups(this.cohort(scope.appId, q), q.groupBy)) {
      for (const stage of def?.stages ?? []) {
        if (stage.terminal) continue;
        const durations: number[] = [];
        const done = new Set<string>();
        const open = new Set<string>();
        for (const c of cases) {
          for (const i of c.intervals) {
            if (i.stage_key !== stage.key) continue;
            if (i.exited_at === null) open.add(c.case_id);
            else {
              durations.push(i.exited_at - i.entered_at);
              done.add(c.case_id);
            }
          }
        }
        if (done.size === 0 && open.size === 0) continue;
        durations.sort((a, b) => a - b);
        rows.push({
          stage_key: stage.key,
          group,
          n: done.size,
          open_n: open.size,
          p50_ms: percentile(durations, 0.5),
          p90_ms: percentile(durations, 0.9),
          mean_ms: durations.length
            ? durations.reduce((a, b) => a + b, 0) / durations.length
            : null,
        });
      }
    }
    return this.sourced(rows);
  }

  async getFunnel(
    scope: AppScope,
    q: AggregateQuery & { stages: string[] },
  ): Promise<Sourced<FunnelGroup[]>> {
    const rows: FunnelGroup[] = [];
    for (const [group, cases] of this.groups(this.cohort(scope.appId, q), q.groupBy)) {
      rows.push({
        group,
        cohort_n: cases.length,
        steps: q.stages.map((stageKey) => ({
          stage_key: stageKey,
          reached_n: cases.filter((c) => c.intervals.some((i) => i.stage_key === stageKey)).length,
        })),
      });
    }
    return this.sourced(rows);
  }

  async getVariantStats(
    scope: AppScope,
    q: AggregateQuery & { limit: number },
  ): Promise<Sourced<VariantStats>> {
    const cases = this.cohort(scope.appId, q);
    const byPath = new Map<string, SyntheticCase[]>();
    for (const c of cases) {
      const path = c.intervals
        .filter((i) => i.state !== "skipped")
        .sort((a, b) => a.entered_at - b.entered_at)
        .map((i) => i.stage_key)
        .join(">");
      byPath.set(path, [...(byPath.get(path) ?? []), c]);
    }
    const variants = [...byPath.entries()]
      .map(([path, members]) => ({
        path: path ? path.split(">") : [],
        n: members.length,
        completed_n: members.filter((c) => c.status === "closed").length,
        median_cycle_ms: medianCycle(members),
      }))
      .sort((a, b) => b.n - a.n || a.path.join().localeCompare(b.path.join()))
      .slice(0, q.limit);
    return this.sourced({
      total_n: cases.length,
      completed_n: cases.filter((c) => c.status === "closed").length,
      median_cycle_ms: medianCycle(cases),
      variants,
    });
  }

  async getFreshness(scope: AppScope): Promise<Sourced<AppFreshness>> {
    const meta = this.meta();
    const keys = [...new Set(this.definitions(scope.appId).map((d) => d.workflow_key))];
    const workflows = keys.map((key) => {
      const last = syntheticCases()
        .filter((c) => c.appId === scope.appId && c.workflow_key === key)
        .reduce<number | null>((max, c) => Math.max(max ?? 0, c.last_event_at), null);
      return { workflow_key: key, last_event_at: last };
    });
    return { data: { ...meta.freshness, workflows }, meta };
  }
}

/** Offset pagination; the cursor is the next offset as a decimal string. */
function paginate<T>(items: T[], page: PageRequest): Page<T> {
  const offset = page.cursor === null ? 0 : Number(page.cursor);
  if (!Number.isInteger(offset) || offset < 0 || offset > items.length) {
    return { items: [], next_cursor: null };
  }
  const slice = items.slice(offset, offset + page.limit);
  const next = offset + slice.length;
  return { items: slice, next_cursor: next < items.length ? String(next) : null };
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
}

function medianCycle(cases: SyntheticCase[]): number | null {
  const cycles = cases
    .filter((c) => c.ended_at !== null)
    .map((c) => (c.ended_at as number) - c.started_at)
    .sort((a, b) => a - b);
  return percentile(cycles, 0.5);
}
