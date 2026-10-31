import type {
  LifecycleEvent,
  ProcessDefinition,
  ReplayInput,
  StageInstanceInput,
} from "@flightdeckhq/lifecycle";
import type { LifecycleRecord, ProcessDefinitionV1 } from "@flightdeckhq/schema";
import {
  type AdapterCode,
  engineProcessId,
  INTERRUPTION,
  OUTCOME_DIMENSION,
  TERMINAL_REASONS,
} from "./vocabulary";

/**
 * The explicit adapter from stored wire events (`LifecycleRecord`, one case) to the replay
 * engine's input. Pure and deterministic: the same records in any order give the same input.
 * See vocabulary.ts for the rules; every record that cannot be applied yields an issue.
 */

export type AdapterIssue = { code: AdapterCode; eventId?: string };

/** What the snapshot mapper needs beyond the engine's own result. */
export type CaseFacts = {
  caseId: string;
  processId: string;
  processVersion: number;
  definition: ProcessDefinitionV1;
  /** Effective `case.created` time, used only when no `case.started` is observed. */
  createdAt: number | null;
  /** Served outcome code per engine `case.terminate` event id. */
  outcomes: ReadonlyMap<string, string>;
  /** `stage.exited` reason per engine `stage.exit` event id. */
  exitReasons: ReadonlyMap<string, string>;
};

export type AdaptedCase = { input: ReplayInput; facts: CaseFacts | null; issues: AdapterIssue[] };

type Draft = Record<string, unknown> & { id: string; type: string };
/** An engine envelope before branding; ids are cast once, when the input is assembled. */
type Envelope = { id: string; occurredAt: number; source: { id: string; sequence: number } };

const order = (a: LifecycleRecord, b: LifecycleRecord) =>
  a.occurred_at - b.occurred_at ||
  a.source_sequence - b.source_sequence ||
  (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0);

/** A relation's identity is its content, so a repeated assertion names the same relation. */
const relationId = (type: string, from: string, objectType: string, objectId: string) =>
  `${type}|${from}|${objectType}|${objectId}`;

/**
 * Adapts every stored record of one case. `definitions` maps `processId@version` to registered
 * definitions; `asOf` bounds the replay.
 */
export function adaptCase(
  caseId: string,
  records: readonly LifecycleRecord[],
  definitions: ReadonlyMap<string, ProcessDefinitionV1>,
  asOf: number,
): AdaptedCase {
  const issues: AdapterIssue[] = [];
  const empty: ReplayInput = { definitions: [], cases: [], stageInstances: [], events: [], asOf };
  const sorted = [...records].sort(order);
  // The case's process is the one its earliest lifecycle (non-correction) record names.
  const first = sorted.find((r) => r.type !== "event.corrected") ?? sorted[0];
  if (!first) return { input: empty, facts: null, issues };
  const key = engineProcessId(first.process_id, first.process_version);
  const definition = definitions.get(key);
  if (!definition) {
    for (const r of sorted) issues.push({ code: "unknown_process", eventId: r.event_id });
    return { input: empty, facts: null, issues };
  }
  const own = sorted.filter((r) => {
    if (engineProcessId(r.process_id, r.process_version) === key) return true;
    issues.push({ code: "process_mismatch", eventId: r.event_id });
    return false;
  });

  const byId = new Map<string, LifecycleRecord>();
  for (const r of own) if (!byId.has(r.event_id)) byId.set(r.event_id, r);
  const outcomes = new Map<string, string>();
  const exitReasons = new Map<string, string>();
  const stageInstances = new Map<string, StageInstanceInput>();
  const sources = new Set<string>();
  const asserted = new Set<string>();
  /** Engine ids of the relation links each record's `relations` produced, by position. */
  const derived = new Map<string, (string | null)[]>();
  const events: Draft[] = [];

  const envelope = (r: LifecycleRecord, id = r.event_id, occurredAt = r.occurred_at) => {
    const source = `${r.source ?? "_"}:${caseId}`;
    sources.add(source);
    return { id, occurredAt, source: { id: source, sequence: r.source_sequence } };
  };

  /** The engine events for one lifecycle (non-correction) record. */
  function transition(r: LifecycleRecord, env: Envelope): Draft[] {
    const id = env.id;
    const base = { ...env };
    const stage = r.stage_instance_id;
    switch (r.type) {
      case "case.created":
        return [];
      case "case.started":
        return [{ ...base, type: "case.start", caseId }];
      case "case.reopened":
        return [{ ...base, type: "case.reopen", caseId }];
      case "case.paused":
      case "case.resumed":
        return [
          {
            ...base,
            type: r.type === "case.paused" ? "case.pause" : "case.resume",
            caseId,
            interruptionId: INTERRUPTION.casePause,
          },
        ];
      case "case.completed":
        outcomes.set(id, servedOutcome(r, "completed"));
        return [{ ...base, type: "case.terminate", caseId, terminal: "completed" }];
      case "case.terminated": {
        const terminal = TERMINAL_REASONS.find((c) => c === r.reason);
        if (!terminal) {
          issues.push({ code: "missing_terminal_class", eventId: r.event_id });
          return [];
        }
        outcomes.set(id, servedOutcome(r, terminal));
        return [{ ...base, type: "case.terminate", caseId, terminal }];
      }
      case "stage.entered":
      case "stage.exited":
      case "stage.skipped":
      case "stage.blocked":
      case "stage.unblocked":
      case "stage.paused":
      case "stage.resumed": {
        if (!stage || !r.stage_id) return [];
        // A reused instance id with another stage is a catalog conflict the engine reports.
        const instance = { id: stage, caseId, stageId: r.stage_id } as StageInstanceInput;
        const known = stageInstances.get(`${stage}\n${r.stage_id}`);
        if (!known) stageInstances.set(`${stage}\n${r.stage_id}`, instance);
        if (r.type === "stage.exited" && r.reason) exitReasons.set(id, r.reason);
        const action = {
          "stage.entered": ["stage.enter"],
          "stage.exited": ["stage.exit"],
          "stage.skipped": ["stage.skip"],
          "stage.blocked": ["stage.block", INTERRUPTION.stageBlock],
          "stage.unblocked": ["stage.unblock", INTERRUPTION.stageBlock],
          "stage.paused": ["stage.pause", INTERRUPTION.stagePause],
          "stage.resumed": ["stage.resume", INTERRUPTION.stagePause],
        }[r.type];
        return [
          {
            ...base,
            type: action[0] as string,
            stageInstanceId: stage,
            ...(action[1] ? { interruptionId: action[1] } : {}),
          },
        ];
      }
      case "object.linked":
      case "object.unlinked": {
        if (!r.object_type || !r.object_id) return [];
        const from = stage ? { type: "stage", id: stage } : { type: "case", id: caseId };
        const rid = relationId("linked", `${from.type}:${from.id}`, r.object_type, r.object_id);
        return r.type === "object.linked"
          ? [
              {
                ...base,
                type: "relation.link",
                relation: {
                  id: rid,
                  kind: "linked",
                  from,
                  to: { type: r.object_type, id: r.object_id },
                },
              },
            ]
          : [{ ...base, type: "relation.unlink", relationId: rid }];
      }
      default:
        return [];
    }
  }

  /** Links for the record's `relations`; the first assertion of each relation wins. */
  function relationLinks(r: LifecycleRecord, env: Envelope, ids: (string | null)[]): Draft[] {
    return (r.relations ?? []).flatMap((rel, i) => {
      const id = ids[i];
      if (!id) return [];
      return [
        {
          ...env,
          id,
          type: "relation.link",
          relation: {
            id: relationId(rel.type, `case:${caseId}`, rel.object_type, rel.object_id),
            kind: rel.type,
            from: { type: "case", id: caseId },
            to: { type: rel.object_type, id: rel.object_id },
          },
        },
      ];
    });
  }

  // Pass 1: lifecycle records, in occurrence order so the first assertion of a relation wins.
  for (const r of own) {
    if (r.type === "event.corrected") continue;
    const env = envelope(r);
    events.push(...transition(r, env));
    const ids = (r.relations ?? []).map((rel, i) => {
      const rid = relationId(rel.type, `case:${caseId}`, rel.object_type, rel.object_id);
      if (asserted.has(rid)) return null;
      asserted.add(rid);
      return `${r.event_id}#r${i}`;
    });
    derived.set(r.event_id, ids);
    events.push(...relationLinks(r, env, ids));
  }

  // Pass 2: corrections supersede their target (and the links it produced) wherever they arrive.
  for (const c of own) {
    const correction = c.correction;
    if (c.type !== "event.corrected" || !correction || !c.corrects_event_id) continue;
    const target = byId.get(c.corrects_event_id);
    if (!target) {
      issues.push({ code: "correction_target_missing", eventId: c.event_id });
      continue;
    }
    if (target.type === "event.corrected") {
      issues.push({ code: "correction_chain_unsupported", eventId: c.event_id });
      continue;
    }
    const links = derived.get(target.event_id) ?? [];
    const env = envelope(c);
    if (correction.action === "retract") {
      const retract = (id: string, supersedes: string): Draft => ({
        ...env,
        id,
        type: "event.retract",
        supersedes,
      });
      events.push(retract(c.event_id, target.event_id));
      links.forEach((link, i) => {
        if (link) events.push(retract(`${c.event_id}#r${i}`, link));
      });
      continue;
    }
    // Amend: the target as it should have been, under the correction's id, in the target's order.
    const amended: LifecycleRecord = {
      ...target,
      occurred_at: correction.occurred_at ?? target.occurred_at,
      dimensions:
        correction.dimensions || target.dimensions
          ? { ...target.dimensions, ...correction.dimensions }
          : null,
    };
    const replacement = { ...envelope(target, c.event_id, amended.occurred_at) };
    for (const e of transition(amended, replacement)) {
      events.push({ ...e, supersedes: target.event_id });
    }
    const ids = links.map((link, i) => (link ? `${c.event_id}#r${i}` : null));
    for (const e of relationLinks(amended, replacement, ids)) {
      const i = Number(e.id.slice(e.id.lastIndexOf("#r") + 2));
      events.push({ ...e, supersedes: links[i] as string });
    }
  }

  const engineDefinition: ProcessDefinition = {
    id: key,
    label: definition.name,
    stages: definition.stages.map((s) => ({ id: s.stageId, label: s.name })),
  } as unknown as ProcessDefinition;
  return {
    input: {
      definitions: [engineDefinition],
      cases: [{ id: caseId, processId: key }] as unknown as ReplayInput["cases"],
      stageInstances: [...stageInstances.values()],
      events: events as unknown as LifecycleEvent[],
      asOf,
      reliableSources: [...sources].sort(),
    },
    facts: {
      caseId,
      processId: first.process_id,
      processVersion: first.process_version,
      definition,
      createdAt: createdAt(own),
      outcomes,
      exitReasons,
    },
    issues,
  };
}

/** The domain outcome code: the `outcome` dimension, else the reason, else the class. */
function servedOutcome(r: LifecycleRecord, fallback: string): string {
  const dimension = r.dimensions?.[OUTCOME_DIMENSION];
  if (typeof dimension === "string") return dimension;
  return r.reason ?? fallback;
}

/** Earliest `case.created` time after corrections (retracted ones ignored, amended ones moved). */
function createdAt(records: readonly LifecycleRecord[]): number | null {
  const times = new Map<string, number>();
  for (const r of records) if (r.type === "case.created") times.set(r.event_id, r.occurred_at);
  for (const r of records) {
    const target = r.corrects_event_id;
    if (r.type !== "event.corrected" || !target || !times.has(target)) continue;
    if (r.correction?.action === "retract") times.delete(target);
    else if (r.correction?.occurred_at !== undefined) times.set(target, r.correction.occurred_at);
  }
  return times.size ? Math.min(...times.values()) : null;
}
