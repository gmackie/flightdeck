import type {
  LifecycleNode,
  LifecycleStage,
  LifecycleState,
  WorkflowPortfolio,
  WorkflowSnapshot,
} from "./model";

/**
 * Wire types for the read-only lifecycle API (`/api/apps/:app/lifecycle/*`) and the pure mapping
 * from its responses into the dashboard's `WorkflowSnapshot`. Ids are opaque tokens; labels come
 * from the process definition plus a short id, never invented names.
 */

export type DataFreshness = {
  /** `unavailable` until a projection has been committed for the app. */
  status: "fresh" | "stale" | "unavailable";
  projection: string;
  lag_ms: number | null;
  generation: number | null;
  source_watermark: number | null;
  pending_cases?: number;
};

export type LifecycleEnvelope<T> = {
  app_id: string;
  as_of: number | null;
  data_freshness: DataFreshness;
  sample_count: number;
  suppressed: boolean;
  data: T;
  page?: { limit: number; next_cursor: string | null };
};

export type ProcessDefinition = {
  process_key: string;
  version: number;
  label: string;
  stages: { key: string; label: string; terminal: boolean }[];
  as_of: number;
};

export type CaseSummary = {
  case_id: string;
  process_key: string;
  process_version: number;
  status: "open" | "closed";
  outcome: string | null;
  current_stage: string | null;
  parent_case_id: string | null;
  started_at: number;
  ended_at: number | null;
  last_event_at: number;
};

export type StageInterval = {
  stage_key: string;
  state: string;
  entered_at: number;
  exited_at: number | null;
  outcome: string | null;
};

/** Only the detail fields the dashboard reads; parent/children/relations are not rendered yet. */
export type CaseDetail = CaseSummary & { intervals: StageInterval[] };

export type OutcomeGroup = {
  status: "open" | "closed";
  outcome: string | null;
  case_count: number;
  duration_ms: { mean: number | null; p50: number | null; p90: number | null };
};

type Guard<T> = (value: unknown) => value is T;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isNum = (value: unknown): value is number => typeof value === "number";
const isNumOrNull = (value: unknown) => value === null || isNum(value);
const isStrOrNull = (value: unknown) => value === null || typeof value === "string";
const listOf =
  <T>(item: Guard<T>): Guard<T[]> =>
  (value): value is T[] =>
    Array.isArray(value) && value.every(item);

function isFreshness(value: unknown): value is DataFreshness {
  if (!isRecord(value)) return false;
  return (
    (value.status === "fresh" || value.status === "stale" || value.status === "unavailable") &&
    typeof value.projection === "string" &&
    isNumOrNull(value.lag_ms) &&
    isNumOrNull(value.generation) &&
    isNumOrNull(value.source_watermark) &&
    (value.pending_cases === undefined || isNum(value.pending_cases))
  );
}

/** Checks the shared response envelope, then `data` with `data`. */
export const isEnvelope =
  <T>(data: Guard<T>): Guard<LifecycleEnvelope<T>> =>
  (value): value is LifecycleEnvelope<T> =>
    isRecord(value) &&
    typeof value.app_id === "string" &&
    isNumOrNull(value.as_of) &&
    isFreshness(value.data_freshness) &&
    typeof value.suppressed === "boolean" &&
    data(value.data);

export const isProcessDefinition: Guard<ProcessDefinition> = (value): value is ProcessDefinition =>
  isRecord(value) &&
  typeof value.process_key === "string" &&
  isNum(value.version) &&
  typeof value.label === "string" &&
  Array.isArray(value.stages) &&
  value.stages.every(
    (stage) => isRecord(stage) && typeof stage.key === "string" && typeof stage.label === "string",
  );

export const isCaseSummary: Guard<CaseSummary> = (value): value is CaseSummary =>
  isRecord(value) &&
  typeof value.case_id === "string" &&
  typeof value.process_key === "string" &&
  (value.status === "open" || value.status === "closed") &&
  isStrOrNull(value.outcome) &&
  isStrOrNull(value.current_stage) &&
  isStrOrNull(value.parent_case_id) &&
  isNum(value.started_at) &&
  isNumOrNull(value.ended_at);

const isInterval: Guard<StageInterval> = (value): value is StageInterval =>
  isRecord(value) &&
  typeof value.stage_key === "string" &&
  typeof value.state === "string" &&
  isNum(value.entered_at) &&
  isNumOrNull(value.exited_at);

export const isCaseDetail: Guard<CaseDetail> = (value): value is CaseDetail =>
  isCaseSummary(value) && listOf(isInterval)((value as Record<string, unknown>).intervals);

export const isOutcomeGroup: Guard<OutcomeGroup> = (value): value is OutcomeGroup =>
  isRecord(value) &&
  (value.status === "open" || value.status === "closed") &&
  isStrOrNull(value.outcome) &&
  isNum(value.case_count) &&
  isRecord(value.duration_ms);

export const isProcessList = isEnvelope(listOf(isProcessDefinition));
export const isCaseList = isEnvelope(listOf(isCaseSummary));
export const isCaseDetailEnvelope = isEnvelope(isCaseDetail);
export const isOutcomeList = isEnvelope(listOf(isOutcomeGroup));

/** Stable portfolio id for one process version; versions are not comparable, so never merged. */
export const processId = (process: Pick<ProcessDefinition, "process_key" | "version">) =>
  `${process.process_key}@v${process.version}`;

/** The tail of an opaque id: enough to tell rows apart without pretending it is a name. */
export function shortId(id: string): string {
  return id.length <= 10 ? id : `…${id.slice(-8)}`;
}

/** Terminal state for a closed case's outcome; anything unrecognised reads as completed. */
export function outcomeState(outcome: string | null): LifecycleState {
  const value = outcome?.toLowerCase() ?? "";
  if (value === "rejected" || value === "reject") return "rejected";
  if (value === "withdrawn") return "withdrawn";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  return "completed";
}

/** An open interval's state: blocked work is waiting on something outside the stage. */
function intervalState(state: string): LifecycleState {
  if (state === "blocked") return "waiting";
  if (state === "paused") return "paused";
  return "active";
}

/** Consecutive segments of the same stage form one visit (one stage instance). */
type Visit = { stageKey: string; segments: StageInterval[] };

function visits(intervals: readonly StageInterval[]): Visit[] {
  const out: Visit[] = [];
  for (const interval of intervals) {
    const last = out.at(-1);
    if (last?.stageKey === interval.stage_key) last.segments.push(interval);
    else out.push({ stageKey: interval.stage_key, segments: [interval] });
  }
  return out;
}

/**
 * One stage per definition stage, in order, from that stage's latest visit. Stage keys the
 * definition does not know are appended rather than dropped. Timestamps are copied as-is so
 * `diagnoseWorkflowSnapshot` can surface bad ones.
 */
export function caseStages(process: ProcessDefinition, detail: CaseDetail): LifecycleStage[] {
  const all = visits(detail.intervals);
  const finalVisit = all.at(-1);
  const keys = process.stages.map((stage) => stage.key);
  for (const visit of all) if (!keys.includes(visit.stageKey)) keys.push(visit.stageKey);
  return keys.map((key) => {
    const label = process.stages.find((stage) => stage.key === key)?.label ?? key;
    const own = all.filter((visit) => visit.stageKey === key);
    const visit = own.at(-1);
    if (!visit) return { id: key, label, state: "future", owner: "—" };
    const first = visit.segments[0] as StageInterval;
    const last = visit.segments.at(-1) as StageInterval;
    const isFinal = visit === finalVisit;
    const state: LifecycleState =
      detail.status === "closed" && isFinal
        ? outcomeState(detail.outcome)
        : last.exited_at === null
          ? intervalState(last.state)
          : "completed";
    const reasons = [
      own.length > 1 ? `Entered ${own.length} times; showing the latest visit` : null,
      detail.status === "closed" && isFinal ? `Case outcome: ${detail.outcome ?? "none"}` : null,
      last.exited_at === null && last.state === "blocked" ? "Blocked" : null,
    ].filter(Boolean);
    return {
      id: key,
      label,
      state,
      owner: "—",
      enteredAt: first.entered_at,
      ...(last.exited_at === null ? {} : { exitedAt: last.exited_at }),
      ...(reasons.length ? { reason: reasons.join(" · ") } : {}),
    };
  });
}

/** A case's own state: closed cases from their outcome, open ones from their open segment. */
export function caseState(detail: CaseDetail): LifecycleState {
  if (detail.status === "closed") return outcomeState(detail.outcome);
  const open = detail.intervals.findLast((interval) => interval.exited_at === null);
  return open ? intervalState(open.state) : "active";
}

export function caseNode(process: ProcessDefinition, detail: CaseDetail): LifecycleNode {
  return {
    id: detail.case_id,
    label: `${process.label} · ${shortId(detail.case_id)}`,
    kind: process.label,
    owner: "—",
    state: caseState(detail),
    outcome: detail.status === "closed" ? (detail.outcome ?? "none recorded") : undefined,
    createdAt: detail.started_at,
    ...(detail.ended_at === null ? {} : { endedAt: detail.ended_at }),
    stages: caseStages(process, detail),
  };
}

export type LiveProcessCases = { process: ProcessDefinition; cases: readonly CaseDetail[] };

/**
 * One portfolio per process version. Cases nest under their parent when the parent was fetched
 * too (in any process); otherwise, or when parent links form a cycle, they are roots.
 */
export function buildPortfolios(groups: readonly LiveProcessCases[]): WorkflowPortfolio[] {
  const byId = new Map<string, { node: LifecycleNode; parent: string | null; home: string }>();
  for (const { process, cases } of groups) {
    for (const detail of cases) {
      byId.set(detail.case_id, {
        node: caseNode(process, detail),
        parent: detail.parent_case_id,
        home: processId(process),
      });
    }
  }
  const nestedParent = (id: string): string | null => {
    const parent = byId.get(id)?.parent ?? null;
    if (parent === null || !byId.has(parent)) return null;
    const seen = new Set([id]);
    for (let at: string | null = parent; at !== null; at = byId.get(at)?.parent ?? null) {
      if (seen.has(at)) return null;
      seen.add(at);
      if (!byId.has(at)) break;
    }
    return parent;
  };
  const children = new Map<string, string[]>();
  const roots = new Map<string, string[]>();
  for (const [id, entry] of byId) {
    const parent = nestedParent(id);
    const bucket = parent === null ? roots : children;
    const key = parent ?? entry.home;
    bucket.set(key, [...(bucket.get(key) ?? []), id]);
  }
  const build = (id: string): LifecycleNode => {
    const entry = byId.get(id) as { node: LifecycleNode };
    const kids = (children.get(id) ?? []).map(build);
    return kids.length ? { ...entry.node, children: kids } : entry.node;
  };
  return groups.map(({ process, cases }) => ({
    id: processId(process),
    label: `${process.label} · v${process.version}`,
    description: `${cases.length} most recent cases · process ${process.process_key}`,
    roots: (roots.get(processId(process)) ?? []).map(build),
  }));
}

/** The live view model; `asOf` is the newest projection time any response reported. */
export function liveSnapshot(groups: readonly LiveProcessCases[], asOf: number): WorkflowSnapshot {
  return {
    asOf,
    source: { label: "Lifecycle read model", synthetic: false },
    portfolios: buildPortfolios(groups),
  };
}
