import type { Interval, ReplayResult, StageState } from "@flightdeckhq/lifecycle";
import {
  type CaseSnapshotInput,
  MAX_INTERVALS,
  MAX_RELATIONS,
  OPAQUE_ID,
  SLUG,
} from "../lifecycle-serving/model";
import type { AdapterIssue, CaseFacts } from "./adapter";
import { type AdapterCode, CASE_OBJECT, PARENT_RELATION } from "./vocabulary";

/**
 * Maps one case's replay result to the serving read model's `CaseSnapshotInput`. Pure apart from
 * hashing ids. Facts the read model cannot represent are counted as diagnostics, never dropped
 * silently; nothing is inferred (no exits, outcomes or starts the evidence does not state).
 */

type Segment = CaseSnapshotInput["intervals"][number];
export type Mapped = { snapshot: CaseSnapshotInput | null; diagnostics: Map<string, number> };

const encoder = new TextEncoder();

/**
 * The read model's id for a producer case id. Ids that already fit the serving id shape are kept;
 * others (`deploy:web:1234`, over 64 chars) become `x-` plus 43 base64url chars of their SHA-256.
 */
export async function servingId(caseId: string): Promise<string> {
  if (OPAQUE_ID.test(caseId) && !caseId.startsWith("x-")) return caseId;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(caseId)));
  const b64 = btoa(String.fromCharCode(...digest))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `x-${b64}`;
}

export async function toSnapshot(
  result: ReplayResult,
  facts: CaseFacts,
  issues: readonly AdapterIssue[],
): Promise<Mapped> {
  const diagnostics = new Map<string, number>();
  const note = (code: string) => diagnostics.set(code, (diagnostics.get(code) ?? 0) + 1);
  for (const d of result.diagnostics) note(d.code);
  for (const issue of issues) note(issue.code);
  const report = (code: AdapterCode) => note(code);

  const state = result.cases.find((c) => c.id === facts.caseId);
  const effective = result.events;
  if (!state || !effective.length) {
    report("case_excluded");
    return { snapshot: null, diagnostics };
  }
  const closed = state.status === "terminated";
  const lastEventAt = Math.max(
    ...effective.map((e) => e.occurredAt),
    ...(facts.createdAt === null ? [] : [facts.createdAt]),
  );
  let startedAt = state.episodes.find((e) => e.start !== null)?.start ?? null;
  if (startedAt === null && facts.createdAt !== null) {
    report("start_from_created");
    startedAt = facts.createdAt;
  }
  if (startedAt === null) {
    report("no_case_start");
    startedAt = Math.min(...effective.map((e) => e.occurredAt));
  }
  const endedAt = closed ? (state.episodes.at(-1)?.end ?? null) : null;
  if (closed && (endedAt === null || endedAt < startedAt)) {
    report("case_excluded");
    return { snapshot: null, diagnostics };
  }

  // The outcome of the episode-ending evidence: an explicit case termination at the end time,
  // else a classified terminal stage entered then (its key is the outcome), else the class.
  let outcome: string | null = null;
  if (closed) {
    const terminate = effective.findLast(
      (e) =>
        e.type === "case.terminate" &&
        "caseId" in e &&
        e.caseId === facts.caseId &&
        e.occurredAt === endedAt,
    );
    const terminalStage = result.stageInstances.find(
      (s) =>
        s.caseId === facts.caseId && s.enteredAt === endedAt && facts.terminalStages.has(s.stageId),
    );
    outcome =
      (terminate && facts.outcomes.get(terminate.id)) ?? terminalStage?.stageId ?? state.terminal;
    if (outcome !== null && !SLUG.test(outcome)) {
      report("outcome_not_served");
      outcome = state.terminal;
    }
  }

  // Stage attempts in the order they were entered; each is split into state segments.
  const pauses = state.pauses;
  const exits = new Map(
    effective.flatMap((e) =>
      e.type === "stage.exit" && "stageInstanceId" in e ? [[e.stageInstanceId, e.id]] : [],
    ),
  );
  const attempts = result.stageInstances
    .filter((s) => s.caseId === facts.caseId)
    .sort(
      (a, b) =>
        (a.enteredAt ?? Number.MAX_SAFE_INTEGER) - (b.enteredAt ?? Number.MAX_SAFE_INTEGER) ||
        (a.id < b.id ? -1 : 1),
    );
  const intervals: Segment[] = [];
  let current: StageState | null = null;
  for (const stage of attempts) {
    if (stage.status === "skipped") {
      report("stage_skipped");
      continue;
    }
    if (stage.enteredAt === null) continue; // the engine reported the missing boundary
    if (facts.unclassifiedTerminalStages.has(stage.stageId)) report("terminal_stage_unclassified");
    if (closed && stage.exitedAt === null) {
      report("stage_open_at_case_end");
      continue;
    }
    if (stage.exitedAt === null && (!current || stage.enteredAt >= (current.enteredAt ?? 0))) {
      current = stage;
    }
    const exit = exits.get(stage.id);
    const reason = exit === undefined ? undefined : facts.exitReasons.get(exit);
    intervals.push(
      ...segments(stage, pauses, reason && SLUG.test(reason) ? reason : null, () =>
        report("interruption_boundary_unknown"),
      ),
    );
  }
  if (intervals.length > MAX_INTERVALS) {
    report("too_many_intervals");
    return { snapshot: null, diagnostics };
  }

  // Relations active at as_of: the parent, typed edges to other cases, and unserved objects.
  const active = (intervals: Interval[]) => {
    const last = intervals.at(-1);
    return last !== undefined && last.start !== null && last.end === null ? last.start : null;
  };
  const parents: { id: string; since: number }[] = [];
  const edges = new Map<string, { relation: string; to_case_id: string }>();
  for (const relation of result.relations) {
    const since = active(relation.intervals);
    if (since === null) continue;
    if (relation.to.type !== CASE_OBJECT) {
      report("object_relation_not_served");
      continue;
    }
    if (relation.to.id === facts.caseId) continue;
    const to = await servingId(relation.to.id);
    if (relation.kind === PARENT_RELATION && relation.from.type === CASE_OBJECT) {
      parents.push({ id: to, since });
    } else if (SLUG.test(relation.kind) && edges.size < MAX_RELATIONS) {
      edges.set(`${relation.kind} ${to}`, { relation: relation.kind, to_case_id: to });
    } else {
      report("object_relation_not_served");
    }
  }
  if (parents.length > 1) report("multiple_parents");
  const parent = parents.sort((a, b) => b.since - a.since || (a.id < b.id ? -1 : 1))[0];

  return {
    snapshot: {
      case_id: await servingId(facts.caseId),
      process_key: facts.processId,
      process_version: facts.processVersion,
      status: closed ? "closed" : "open",
      outcome,
      current_stage: closed ? null : (current?.stageId ?? null),
      parent_case_id: parent?.id ?? null,
      started_at: startedAt,
      ended_at: endedAt,
      last_event_at: lastEventAt,
      intervals,
      relations: [...edges.values()],
    },
    diagnostics,
  };
}

type Window = { start: number; end: number };

/**
 * Splits one stage attempt into consecutive `active` / `blocked` / `paused` segments. Pauses (the
 * stage's own and the case's) take precedence over blocks. Interruptions with an unknown start
 * cannot be placed in time and are reported instead.
 */
export function segments(
  stage: StageState,
  casePauses: readonly Interval[],
  exitOutcome: string | null,
  unknown: () => void,
): Segment[] {
  const start = stage.enteredAt;
  if (start === null) return [];
  const end = stage.exitedAt ?? Number.POSITIVE_INFINITY;
  const clip = (list: readonly Interval[]): Window[] =>
    list.flatMap((i) => {
      if (i.start === null) {
        unknown();
        return [];
      }
      const s = Math.max(i.start, start);
      const e = Math.min(i.end ?? Number.POSITIVE_INFINITY, end);
      return e > s ? [{ start: s, end: e }] : [];
    });
  const paused = clip([...stage.paused, ...casePauses]);
  const blocked = clip(stage.blocked);
  const points = [...new Set([start, ...[...paused, ...blocked].flatMap((w) => [w.start, w.end])])]
    .filter((p) => p >= start && p < end)
    .sort((a, b) => a - b);
  const covers = (list: Window[], at: number) => list.some((w) => w.start <= at && w.end > at);
  const result: Segment[] = [];
  points.forEach((from, i) => {
    const to = points[i + 1] ?? end;
    const state = covers(paused, from) ? "paused" : covers(blocked, from) ? "blocked" : "active";
    const previous = result.at(-1);
    if (previous && previous.state === state) previous.exited_at = finite(to);
    else result.push({ stage_key: stage.stageId, state, entered_at: from, exited_at: finite(to) });
  });
  // Entered and exited in the same millisecond: one zero-length attempt.
  if (!result.length) {
    result.push({ stage_key: stage.stageId, state: "active", entered_at: start, exited_at: start });
  }
  const last = result.at(-1) as Segment;
  last.outcome = stage.exitedAt === null ? null : exitOutcome;
  return result;
}

const finite = (n: number) => (Number.isFinite(n) ? n : null);
