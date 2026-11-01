/** Dashboard-only read model. Future API adapters map into this; no ingest/schema dependency. */
export const LIFECYCLE_STATES = [
  "completed",
  "active",
  "waiting",
  "paused",
  "deferred",
  "rejected",
  "cancelled",
  "withdrawn",
  "future",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const STATE_LABELS: Record<LifecycleState, string> = {
  completed: "Completed",
  active: "Active",
  waiting: "Waiting",
  paused: "Paused",
  deferred: "Deferred",
  rejected: "Rejected",
  cancelled: "Cancelled",
  withdrawn: "Withdrawn",
  future: "Future",
};
export const STATE_MARKS: Record<LifecycleState, string> = {
  completed: "✓",
  active: "●",
  waiting: "◷",
  paused: "Ⅱ",
  deferred: "↷",
  rejected: "×",
  cancelled: "⊘",
  withdrawn: "↩",
  future: "·",
};

export interface LifecycleStage {
  id: string;
  label: string;
  state: LifecycleState;
  owner: string;
  reason?: string;
  enteredAt?: number;
  exitedAt?: number;
}

export interface LifecycleNode {
  id: string;
  label: string;
  kind: string;
  owner: string;
  state: LifecycleState;
  createdAt: number;
  endedAt?: number;
  /** Explicit parent stages; never inferred from child outcomes. */
  stages: readonly LifecycleStage[];
  children?: readonly LifecycleNode[];
  relationship?: string;
  /** Raw outcome recorded by the source system, when it has one. */
  outcome?: string;
}

export interface WorkflowPortfolio {
  id: string;
  label: string;
  description: string;
  roots: readonly LifecycleNode[];
}

export interface WorkflowSnapshot {
  asOf: number;
  source: { label: string; synthetic: boolean };
  portfolios: readonly WorkflowPortfolio[];
}

export function duration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Invalid integration timestamps remain unavailable, never silently clamped to zero. */
export function stageTimeProblem(stage: LifecycleStage, asOf: number): string | undefined {
  if (!Number.isFinite(asOf)) return "Snapshot timestamp is invalid";
  if (stage.enteredAt === undefined) {
    if (stage.exitedAt !== undefined) return "Exit timestamp has no entry";
    if (stage.state !== "future") return "Entered stage is missing its entry timestamp";
    return undefined;
  }
  if (stage.state === "future") return "Future stage has recorded timestamps";
  if (!Number.isFinite(stage.enteredAt)) return "Entry timestamp is invalid";
  if (stage.enteredAt > asOf) return "Entry is after the snapshot";
  if (stage.exitedAt !== undefined) {
    if (!Number.isFinite(stage.exitedAt)) return "Exit timestamp is invalid";
    if (stage.exitedAt < stage.enteredAt) return "Exit is before entry";
    if (stage.exitedAt > asOf) return "Exit is after the snapshot";
  } else if (["completed", "rejected", "cancelled", "withdrawn"].includes(stage.state))
    return "Terminal stage is missing its exit timestamp";
  return undefined;
}

export function stageDwell(stage: LifecycleStage, asOf: number): number | undefined {
  if (stage.enteredAt === undefined || stageTimeProblem(stage, asOf)) return undefined;
  return (stage.exitedAt ?? asOf) - stage.enteredAt;
}

export function stageAge(stage: LifecycleStage, asOf: number): number | undefined {
  if (stage.enteredAt === undefined || stageTimeProblem(stage, asOf)) return undefined;
  return asOf - stage.enteredAt;
}

export function flattenNodes(roots: readonly LifecycleNode[]): LifecycleNode[] {
  return roots.flatMap((node) => [node, ...flattenNodes(node.children ?? [])]);
}

/** Nearest-rank percentile over a caller-selected, validated cohort. */
export function percentile(values: readonly number[], quantile: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

export function summarizePortfolio(roots: readonly LifecycleNode[], asOf: number) {
  const nodes = flattenNodes(roots);
  const counts = Object.fromEntries(LIFECYCLE_STATES.map((state) => [state, 0])) as Record<
    LifecycleState,
    number
  >;
  const completedDwells: number[] = [];
  const openAges: number[] = [];
  let invalidStages = 0;
  for (const node of nodes) {
    counts[node.state] += 1;
    for (const stage of node.stages) {
      const dwell = stageDwell(stage, asOf);
      if (stageTimeProblem(stage, asOf)) invalidStages += 1;
      if (dwell === undefined) continue;
      if (stage.state === "completed" && stage.exitedAt !== undefined) completedDwells.push(dwell);
      else if (stage.exitedAt === undefined) openAges.push(dwell);
    }
  }
  return {
    total: nodes.length,
    counts,
    completedDwell: {
      p50: percentile(completedDwells, 0.5),
      p90: percentile(completedDwells, 0.9),
      count: completedDwells.length,
    },
    openStageAge: {
      p50: percentile(openAges, 0.5),
      p90: percentile(openAges, 0.9),
      count: openAges.length,
    },
    invalidStages,
  };
}

/** Search retains ancestor context without changing any lifecycle's own stages/state. */
export function filterHierarchy(
  roots: readonly LifecycleNode[],
  query: string,
): readonly LifecycleNode[] {
  const term = query.trim().toLowerCase();
  if (!term) return roots;
  return roots.flatMap((node) => {
    if (
      `${node.label} ${node.kind} ${node.owner} ${STATE_LABELS[node.state]} ${node.outcome ?? ""}`
        .toLowerCase()
        .includes(term)
    )
      return [node];
    const children = filterHierarchy(node.children ?? [], term);
    return children.length ? [{ ...node, children }] : [];
  });
}
