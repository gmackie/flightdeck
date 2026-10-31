import { canonical, compareText } from "./events.js";
import type {
  Attributes,
  CaseId,
  CaseState,
  Interval,
  ObjectRef,
  ProcessId,
  ReplayResult,
  StageId,
  StageInstanceId,
  TerminalClass,
} from "./types.js";
import { terminalClasses } from "./types.js";

type Range = { start: number; end: number };
function ranges(intervals: readonly Interval[], asOf: number): Range[] | null {
  if (!Number.isFinite(asOf)) throw new TypeError("asOf must be finite");
  const result: Range[] = [];
  for (const interval of intervals) {
    const end = interval.end ?? asOf;
    if (
      interval.start === null ||
      !Number.isFinite(interval.start) ||
      !Number.isFinite(end) ||
      end < interval.start ||
      interval.start > asOf
    )
      return null;
    result.push({ start: interval.start, end: Math.min(end, asOf) });
  }
  return result;
}
function merge(items: readonly Range[]): Range[] {
  const result: Range[] = [];
  for (const item of [...items].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1);
    if (previous && item.start <= previous.end) previous.end = Math.max(previous.end, item.end);
    else result.push({ ...item });
  }
  return result;
}
function intersect(a: readonly Range[], b: readonly Range[]): Range[] {
  const result: Range[] = [];
  for (const x of a)
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) result.push({ start, end });
    }
  return merge(result);
}
const duration = (items: readonly Range[]): number =>
  merge(items).reduce((n, r) => n + r.end - r.start, 0);
/** Milliseconds in the union. Null means an invalid or unknown boundary, not zero. */
export function unionDuration(intervals: readonly Interval[], asOf: number): number | null {
  const resolved = ranges(intervals, asOf);
  return resolved === null ? null : duration(resolved);
}

export interface StageMetrics {
  stageInstanceId: StageInstanceId;
  /** Observed entry -> explicit exit, or asOf for an open, nonterminated case. */
  wallClockMs: number | null;
  blockedMs: number | null;
  /** Includes explicit case pauses intersecting this stage instance. */
  pausedMs: number | null;
  unavailableMs: number | null;
  /** Wall clock minus union(blocked, paused). Never a measure of labor. */
  availableElapsedMs: number | null;
  activeAgeMs: number | null;
  openCensored: boolean;
}
export function stageMetrics(result: ReplayResult, stageInstanceId: StageInstanceId): StageMetrics {
  const stage = result.stageInstances.find((s) => s.id === stageInstanceId);
  if (!stage) throw new RangeError(`Unknown stage instance: ${stageInstanceId}`);
  const owner = result.cases.find((c) => c.id === stage.caseId);
  const crossedTermination = owner?.episodes.some(
    (e) => e.end !== null && e.end >= (stage.enteredAt ?? Infinity),
  );
  const openCensored =
    stage.status === "open" &&
    !crossedTermination &&
    (owner?.status === "open" || owner?.status === "paused");
  const output: StageMetrics = {
    stageInstanceId,
    wallClockMs: null,
    blockedMs: null,
    pausedMs: null,
    unavailableMs: null,
    availableElapsedMs: null,
    activeAgeMs: null,
    openCensored,
  };
  if (
    stage.enteredAt === null ||
    stage.status === "skipped" ||
    stage.status === "unknown" ||
    (stage.status === "open" && owner?.status === "terminated")
  )
    return output;
  if (stage.status === "open" && crossedTermination) return output;
  const end = stage.exitedAt ?? result.asOf;
  if (end < stage.enteredAt) return output;
  const bounds = [{ start: stage.enteredAt, end }];
  output.wallClockMs = end - stage.enteredAt;
  if (!stage.timingComplete) return output;
  const blocked = ranges(stage.blocked, result.asOf);
  const paused =
    owner?.timingComplete && owner.status !== "unknown"
      ? ranges([...stage.paused, ...owner.pauses], result.asOf)
      : null;
  output.blockedMs = blocked === null ? null : duration(intersect(blocked, bounds));
  output.pausedMs = paused === null ? null : duration(intersect(paused, bounds));
  if (blocked !== null && paused !== null && stage.timingComplete && owner?.timingComplete) {
    output.unavailableMs = duration(intersect([...blocked, ...paused], bounds));
    output.availableElapsedMs = output.wallClockMs - output.unavailableMs;
    if (openCensored) output.activeAgeMs = output.availableElapsedMs;
  }
  return output;
}

export interface CaseMetrics {
  caseId: CaseId;
  openCensored: boolean;
  /** First explicit start to latest explicit end/asOf, including gaps between reopen episodes. */
  spanMs: number | null;
  /** Union of explicitly open episodes, excluding gaps between termination and reopen. */
  openDurationMs: number | null;
  pausedMs: number | null;
  availableElapsedMs: number | null;
  /** Union of child episodes intersected with link windows and explicit parent episodes. */
  childOverlapMs: number | null;
  /** Time with at least two distinct children open within that parent. */
  parallelChildMs: number | null;
}
export function caseMetrics(result: ReplayResult, caseId: CaseId): CaseMetrics {
  const owner = result.cases.find((c) => c.id === caseId);
  if (!owner) throw new RangeError(`Unknown case: ${caseId}`);
  const output: CaseMetrics = {
    caseId,
    openCensored: owner.status === "open" || owner.status === "paused",
    spanMs: null,
    openDurationMs: null,
    pausedMs: null,
    availableElapsedMs: null,
    childOverlapMs: null,
    parallelChildMs: null,
  };
  const episodes = ranges(owner.episodes, result.asOf);
  if (!episodes?.length || !owner.timingComplete) return output;
  const starts = episodes.map((e) => e.start);
  const ends = episodes.map((e) => e.end);
  output.spanMs = Math.max(...ends) - Math.min(...starts);
  output.openDurationMs = duration(episodes);
  const pauses = ranges(owner.pauses, result.asOf);
  if (pauses !== null) {
    output.pausedMs = duration(intersect(pauses, episodes));
    output.availableElapsedMs = output.openDurationMs - output.pausedMs;
  }
  const childRanges: Range[] = [];
  const points: { time: number; delta: number }[] = [];
  for (const edge of result.children.filter((c) => c.caseId === owner.id)) {
    const child = result.cases.find((c) => c.id === edge.childCaseId);
    const childEpisodes = child && ranges(child.episodes, result.asOf);
    const links = ranges(edge.intervals, result.asOf);
    if (!child?.timingComplete || !childEpisodes?.length || links === null) return output;
    const covered = intersect(intersect(childEpisodes, links), episodes);
    childRanges.push(...covered);
    for (const interval of covered)
      points.push({ time: interval.start, delta: 1 }, { time: interval.end, delta: -1 });
  }
  output.childOverlapMs = duration(childRanges);
  output.parallelChildMs = 0;
  let count = 0;
  let previous: number | undefined;
  for (const point of points.sort((a, b) => a.time - b.time || a.delta - b.delta)) {
    if (count >= 2 && previous !== undefined) output.parallelChildMs += point.time - previous;
    count += point.delta;
    previous = point.time;
  }
  return output;
}

/** Linear interpolation at (n - 1) * q. Empty/unknown samples stay unknown. */
export function percentile(samples: readonly number[], q: number): number | null {
  if (!Number.isFinite(q) || q < 0 || q > 1) throw new RangeError("q must be in [0, 1]");
  if (samples.some((n) => !Number.isFinite(n) || n < 0))
    throw new RangeError("Samples must be finite nonnegative durations");
  const sorted = [...samples].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = sorted[Math.floor(position)];
  const upper = sorted[Math.ceil(position)];
  return lower === undefined || upper === undefined
    ? null
    : lower + (upper - lower) * (position % 1);
}
export function ratio(numerator: number, denominator: number): number | null {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator < 0 ||
    denominator < 0
  ) {
    throw new RangeError("Ratio counts must be finite and nonnegative");
  }
  return denominator === 0 ? null : numerator / denominator;
}
export interface CohortFilter {
  processId?: ProcessId;
  /** First explicit case start in [startedFrom, startedBefore). Unknown starts excluded. */
  startedFrom?: number;
  startedBefore?: number;
  attributes?: Attributes;
  terminal?: readonly TerminalClass[];
  status?: CaseState["status"];
  /** Currently linked object via an explicit endpoint with type='case' and id=case ID. */
  relatedObject?: ObjectRef;
}
export function selectCases(result: ReplayResult, filter: CohortFilter = {}): CaseState[] {
  if (
    (filter.startedFrom !== undefined && !Number.isFinite(filter.startedFrom)) ||
    (filter.startedBefore !== undefined && !Number.isFinite(filter.startedBefore))
  ) {
    throw new TypeError("Cohort boundaries must be finite Unix milliseconds");
  }
  return result.cases.filter((c) => {
    const start = c.episodes[0]?.start;
    if (filter.processId !== undefined && c.processId !== filter.processId) return false;
    if (filter.status !== undefined && c.status !== filter.status) return false;
    if (filter.terminal && (c.terminal === null || !filter.terminal.includes(c.terminal)))
      return false;
    if (filter.startedFrom !== undefined && (start == null || start < filter.startedFrom))
      return false;
    if (filter.startedBefore !== undefined && (start == null || start >= filter.startedBefore))
      return false;
    if (
      filter.attributes &&
      Object.entries(filter.attributes).some(([k, v]) => c.attributes?.[k] !== v)
    )
      return false;
    if (filter.relatedObject) {
      const target = canonical(filter.relatedObject);
      return result.relations.some(
        (r) =>
          r.intervals.at(-1)?.end === null &&
          ((r.from.type === "case" && r.from.id === c.id && canonical(r.to) === target) ||
            (r.to.type === "case" && r.to.id === c.id && canonical(r.from) === target)),
      );
    }
    return true;
  });
}
export interface FunnelStep {
  stageId: StageId;
  reached: number;
  converted: number;
  openCensored: number;
  unknown: number;
  denominator: number;
  conversion: number | null;
}
function caseIncomplete(result: ReplayResult, owner: CaseState): boolean {
  return (
    owner.status === "unknown" ||
    !owner.timingComplete ||
    result.stageInstances.some(
      (s) => s.caseId === owner.id && (!s.timingComplete || s.status === "unknown"),
    )
  );
}
/** Case-level nondecreasing-time entry subsequences; equal-time entries are unordered. */
export function funnel(
  result: ReplayResult,
  stageIds: readonly StageId[],
  options: { cohort?: CohortFilter; denominator?: "all-reached" | "closed-only" } = {},
): FunnelStep[] {
  const selected = selectCases(result, options.cohort);
  const prefixes = selected.map((c) => {
    let index = 0;
    const byTime = new Map<number, Map<StageId, number>>();
    for (const visit of result.visits.filter((v) => v.caseId === c.id)) {
      const group = byTime.get(visit.occurredAt) ?? new Map<StageId, number>();
      group.set(visit.stageId, (group.get(visit.stageId) ?? 0) + 1);
      byTime.set(visit.occurredAt, group);
    }
    for (const group of byTime.values()) {
      let wanted = stageIds[index];
      while (wanted !== undefined && (group.get(wanted) ?? 0) > 0) {
        group.set(wanted, (group.get(wanted) ?? 0) - 1);
        index += 1;
        wanted = stageIds[index];
      }
    }
    return { c, length: index };
  });
  return stageIds.map((stageId, index) => {
    const reached = prefixes.filter((p) => p.length > index);
    const converted = reached.filter((p) => p.length > index + 1).length;
    const openCensored = reached.filter(
      (p) => p.c.status === "open" || p.c.status === "paused",
    ).length;
    const unknown = reached.filter((p) => caseIncomplete(result, p.c)).length;
    const eligible =
      options.denominator === "closed-only"
        ? reached.filter((p) => p.c.status === "terminated")
        : reached;
    const numerator = eligible.filter((p) => p.length > index + 1).length;
    return {
      stageId,
      reached: reached.length,
      converted,
      openCensored,
      unknown,
      denominator: eligible.length,
      conversion: index === stageIds.length - 1 ? null : ratio(numerator, eligible.length),
    };
  });
}

export interface Distribution {
  samples: number;
  p50: number | null;
  p90: number | null;
}
const distribution = (samples: number[]): Distribution => ({
  samples: samples.length,
  p50: percentile(samples, 0.5),
  p90: percentile(samples, 0.9),
});
export interface ProcessVariant {
  key: string;
  count: number;
  share: number | null;
  openCensored: number;
}
/** Equal-time entries form an unordered group; repeated attempts remain repeated groups/entries. */
export function variants(
  result: ReplayResult,
  cohort?: CohortFilter,
): { variants: ProcessVariant[]; unknownCases: number } {
  const selected = selectCases(result, cohort);
  const groups = new Map<string, ProcessVariant>();
  let unknownCases = 0;
  for (const owner of selected) {
    if (caseIncomplete(result, owner)) {
      unknownCases += 1;
      continue;
    }
    const byTime = new Map<number, string[]>();
    for (const visit of result.visits.filter((v) => v.caseId === owner.id)) {
      const group = byTime.get(visit.occurredAt) ?? [];
      group.push(visit.stageId);
      byTime.set(visit.occurredAt, group);
    }
    const key = canonical([
      owner.processId,
      [...byTime.values()].map((g) => g.sort(compareText)),
      owner.terminal ?? owner.status,
    ]);
    const variant = groups.get(key) ?? { key, count: 0, share: null, openCensored: 0 };
    variant.count += 1;
    if (owner.status === "open" || owner.status === "paused") variant.openCensored += 1;
    groups.set(key, variant);
  }
  return {
    variants: [...groups.values()]
      .map((v) => ({ ...v, share: ratio(v.count, selected.length - unknownCases) }))
      .sort((a, b) => b.count - a.count || compareText(a.key, b.key)),
    unknownCases,
  };
}
export function summarize(result: ReplayResult, cohort?: CohortFilter) {
  const selected = selectCases(result, cohort);
  const ids = new Set(selected.map((c) => c.id));
  const terminal = Object.fromEntries(
    terminalClasses.map((t) => [t, selected.filter((c) => c.terminal === t).length]),
  ) as Record<TerminalClass, number>;
  const closed = selected.filter((c) => c.status === "terminated");
  const stageIds = [
    ...new Set(result.stageInstances.filter((s) => ids.has(s.caseId)).map((s) => s.stageId)),
  ].sort(compareText);
  return {
    cases: selected.length,
    openCensored: selected.filter((c) => c.status === "open" || c.status === "paused").length,
    unknown: selected.filter((c) => caseIncomplete(result, c)).length,
    terminal,
    completionRatio: ratio(terminal.completed, closed.length),
    closedCaseDuration: distribution(
      closed
        .map((c) => caseMetrics(result, c.id).openDurationMs)
        .filter((n): n is number => n !== null),
    ),
    stages: stageIds.map((stageId) => {
      const instances = result.stageInstances.filter(
        (s) => s.stageId === stageId && ids.has(s.caseId),
      );
      const samples = instances
        .filter((s) => s.status === "closed")
        .map((s) => stageMetrics(result, s.id))
        .filter((m) => m.wallClockMs !== null);
      return {
        stageId,
        closedDwell: distribution(samples.map((m) => m.wallClockMs as number)),
        openCensored: instances.filter((s) => stageMetrics(result, s.id).openCensored).length,
        skipped: instances.filter((s) => s.status === "skipped").length,
        unknown: instances.filter(
          (s) => stageMetrics(result, s.id).wallClockMs === null && s.status !== "skipped",
        ).length,
      };
    }),
    ...variants(result, cohort),
  };
}
