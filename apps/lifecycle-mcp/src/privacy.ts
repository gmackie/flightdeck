import type {
  CaseSummary,
  DwellGroup,
  FunnelGroup,
  TimelineEntry,
  VariantStats,
  WorkflowDefinition,
} from "./source";

/**
 * Privacy rules applied to every answer, whatever the source already did:
 *
 * - Only fields this module copies reach a tool result, so free text (notes, comments, names,
 *   emails) a source might return is dropped, never redacted in place.
 * - Categorical values must be declared in the workflow definition; anything else is dropped.
 * - Aggregate groups with fewer than `k` distinct cases are withheld, with no count, and when
 *   exactly one group of a breakdown is withheld the next smallest is withheld too, so it cannot
 *   be recovered by subtracting the others from a total.
 */

export type SuppressionReason = "small_cohort" | "complementary" | "source";
type Withheld = { suppressed: true; reason: SuppressionReason };

const MAX_LABEL = 120;
const MAX_STAGES = 64;
const MAX_DIMENSIONS = 20;
const MAX_VALUES = 50;

/** Strips control characters and caps the length of definition-authored labels. */
function label(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(/\p{Cc}/gu, " ")
        .trim()
        .slice(0, MAX_LABEL)
    : "";
}

const isSlug = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
const duration = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

export type PublicDefinition = WorkflowDefinition;

export function projectDefinition(def: WorkflowDefinition): PublicDefinition {
  return {
    workflow_key: def.workflow_key,
    version: def.version,
    label: label(def.label),
    description: label(def.description),
    stages: def.stages
      .filter((stage) => isSlug(stage.key))
      .slice(0, MAX_STAGES)
      .map((stage) => ({
        key: stage.key,
        label: label(stage.label),
        order: stage.order,
        terminal: stage.terminal === true,
      })),
    outcomes: def.outcomes.filter(isSlug).slice(0, MAX_VALUES),
    dimensions: def.dimensions
      .filter((dim) => isSlug(dim.key))
      .slice(0, MAX_DIMENSIONS)
      .map((dim) => ({
        key: dim.key,
        label: label(dim.label),
        values: dim.values.filter(isSlug).slice(0, MAX_VALUES),
      })),
    published_at: def.published_at,
  };
}

const stageKeys = (def: PublicDefinition) => new Set(def.stages.map((stage) => stage.key));

export function projectCase(c: CaseSummary, def: PublicDefinition): CaseSummary {
  const stages = stageKeys(def);
  const dimensions: Record<string, string> = {};
  for (const dim of def.dimensions) {
    const value = c.dimensions?.[dim.key];
    if (typeof value === "string" && dim.values.includes(value)) dimensions[dim.key] = value;
  }
  return {
    case_id: c.case_id,
    workflow_key: c.workflow_key,
    version: c.version,
    status: c.status === "closed" ? "closed" : "open",
    outcome: c.outcome !== null && def.outcomes.includes(c.outcome) ? c.outcome : null,
    current_stage: c.current_stage !== null && stages.has(c.current_stage) ? c.current_stage : null,
    started_at: c.started_at,
    ended_at: isTime(c.ended_at) ? c.ended_at : null,
    last_event_at: c.last_event_at,
    dimensions,
  };
}

const STATES = new Set(["active", "completed", "skipped", "interrupted"]);

/** Entries for stages the definition does not declare are dropped. */
export function projectTimeline(entries: TimelineEntry[], def: PublicDefinition): TimelineEntry[] {
  const stages = stageKeys(def);
  return entries
    .filter((entry) => stages.has(entry.stage_key) && STATES.has(entry.state))
    .map((entry) => ({
      stage_key: entry.stage_key,
      attempt: count(entry.attempt) || 1,
      state: entry.state,
      entered_at: entry.entered_at,
      exited_at: isTime(entry.exited_at) ? entry.exited_at : null,
    }));
}

/** A breakdown cell that is either released with its values or withheld without any. */
type Cell<T> = ({ suppressed: false } & T) | Withheld;

/** Withholds small groups, then applies complementary suppression within the breakdown. */
function suppressBreakdown<T extends { n: number; sourceSuppressed: boolean }>(
  rows: T[],
  k: number,
  grouped: boolean,
): (T & { reason: SuppressionReason | null })[] {
  const out: (T & { reason: SuppressionReason | null })[] = rows.map((row) => {
    const reason = row.sourceSuppressed ? "source" : row.n > 0 && row.n < k ? "small_cohort" : null;
    return { ...row, reason };
  });
  if (!grouped) return out;
  const withheld = out.filter((row) => row.reason !== null);
  const released = out.filter((row) => row.reason === null && row.n > 0);
  if (withheld.length === 1 && released.length > 0) {
    const smallest = released.reduce((a, b) => (b.n < a.n ? b : a));
    smallest.reason = "complementary";
  }
  return out;
}

export type ReleasedDwell = { stage_key: string; group: string | null } & Cell<{
  n: number;
  /** null when between 1 and k-1 cases are open: too few to report. */
  open_n: number | null;
  p50_ms: number | null;
  p90_ms: number | null;
  mean_ms: number | null;
}>;

export function suppressDwell(
  groups: DwellGroup[],
  def: PublicDefinition,
  groupBy: string | null,
  k: number,
): ReleasedDwell[] {
  const allowedGroups = groupBy
    ? new Set(def.dimensions.find((dim) => dim.key === groupBy)?.values ?? [])
    : null;
  const out: ReleasedDwell[] = [];
  for (const stage of def.stages) {
    const rows = groups
      .filter((g) => g.stage_key === stage.key)
      .filter((g) => (allowedGroups ? g.group !== null && allowedGroups.has(g.group) : true))
      .map((g) => ({ ...g, n: count(g.n), sourceSuppressed: g.suppressed === true }));
    for (const row of suppressBreakdown(rows, k, groupBy !== null)) {
      const head = { stage_key: row.stage_key, group: groupBy ? row.group : null };
      if (row.reason) {
        out.push({ ...head, suppressed: true, reason: row.reason });
        continue;
      }
      const open = count(row.open_n);
      out.push({
        ...head,
        suppressed: false,
        n: row.n,
        open_n: open > 0 && open < k ? null : open,
        // Percentiles of fewer than k completed intervals would describe individual cases.
        p50_ms: row.n >= k ? duration(row.p50_ms) : null,
        p90_ms: row.n >= k ? duration(row.p90_ms) : null,
        mean_ms: row.n >= k ? duration(row.mean_ms) : null,
      });
    }
  }
  return out;
}

export type ReleasedFunnelStep = { stage_key: string } & Cell<{
  reached_n: number;
  /** reached_n / cohort_n. */
  reach_rate: number | null;
  /** reached_n / the previous step's reached_n, when both are released. */
  conversion_from_previous: number | null;
}>;

export type ReleasedFunnel = { group: string | null } & Cell<{
  cohort_n: number;
  steps: ReleasedFunnelStep[];
}>;

const ratio = (num: number, den: number) =>
  den > 0 ? Math.round((num / den) * 10_000) / 10_000 : null;

export function suppressFunnel(
  groups: FunnelGroup[],
  stages: string[],
  groupBy: string | null,
  allowedGroups: Set<string> | null,
  k: number,
): ReleasedFunnel[] {
  const rows = groups
    .filter((g) => (allowedGroups ? g.group !== null && allowedGroups.has(g.group) : true))
    .map((g) => ({ ...g, n: count(g.cohort_n), sourceSuppressed: g.suppressed === true }));
  return suppressBreakdown(rows, k, groupBy !== null).map((row) => {
    const group = groupBy ? row.group : null;
    if (row.reason) return { group, suppressed: true, reason: row.reason };
    let previous: number | null = null;
    const steps = stages.map((stageKey): ReleasedFunnelStep => {
      const reached = count(row.steps.find((step) => step.stage_key === stageKey)?.reached_n);
      // Also hide the complementary cases that did not reach this step.
      const missing = row.n - reached;
      if ((reached > 0 && reached < k) || (missing > 0 && missing < k)) {
        previous = null;
        return {
          stage_key: stageKey,
          suppressed: true,
          reason: reached > 0 && reached < k ? "small_cohort" : "complementary",
        };
      }
      const step: ReleasedFunnelStep = {
        stage_key: stageKey,
        suppressed: false,
        reached_n: reached,
        reach_rate: ratio(reached, row.n),
        conversion_from_previous: previous === null ? null : ratio(reached, previous),
      };
      previous = reached;
      return step;
    });
    return { group, suppressed: false, cohort_n: row.n, steps };
  });
}

export type ReleasedVariant = {
  path: string[];
  n: number;
  share: number | null;
  completed_n: number | null;
  median_cycle_ms: number | null;
};

export type ReleasedVariants =
  | {
      suppressed: false;
      total_n: number;
      completed_n: number | null;
      completion_rate: number | null;
      median_cycle_ms: number | null;
      variants: ReleasedVariant[];
      /** Paths followed by fewer than k cases, pooled so no rare path is shown. */
      other: { suppressed: false; n: number } | Withheld | null;
    }
  | Withheld;

export function suppressVariants(
  stats: VariantStats,
  def: PublicDefinition,
  k: number,
): ReleasedVariants {
  const total = count(stats.total_n);
  if (total < k) return { suppressed: true, reason: "small_cohort" };
  const stages = stageKeys(def);
  const completed = count(stats.completed_n);
  const releaseCompleted =
    (completed === 0 || completed >= k) && (total - completed === 0 || total - completed >= k);
  const released: ReleasedVariant[] = [];
  for (const row of stats.variants) {
    const n = count(row.n);
    const validPath = Array.isArray(row.path) && row.path.every((key) => stages.has(key));
    if (n < k || !validPath) continue;
    const done = count(row.completed_n);
    const releaseDone = (done === 0 || done >= k) && (n - done === 0 || n - done >= k);
    released.push({
      path: [...row.path],
      n,
      share: ratio(n, total),
      completed_n: releaseDone ? done : null,
      median_cycle_ms: done >= k ? duration(row.median_cycle_ms) : null,
    });
  }
  released.sort((a, b) => b.n - a.n);
  // Everything not released, including paths the source left out of its top list, is "other".
  // `other` is total minus the released rows, so a small `other` would be recoverable from the
  // total: pool the smallest released variants into it until it reaches k.
  let otherN = Math.max(0, total - released.reduce((sum, v) => sum + v.n, 0));
  while (otherN > 0 && otherN < k && released.length > 0) {
    otherN += released.pop()?.n ?? 0;
  }
  return {
    suppressed: false,
    total_n: total,
    completed_n: releaseCompleted ? completed : null,
    completion_rate: releaseCompleted ? ratio(completed, total) : null,
    median_cycle_ms: completed >= k ? duration(stats.median_cycle_ms) : null,
    variants: released,
    other:
      otherN === 0
        ? null
        : otherN >= k
          ? { suppressed: false, n: otherN }
          : { suppressed: true, reason: "small_cohort" },
  };
}
