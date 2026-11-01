import { canonical, compareText, prepareEvents } from "./events.js";
import type {
  CaseState,
  ChildState,
  Diagnostic,
  DiagnosticCode,
  Interval,
  LifecycleEvent,
  RelationState,
  ReplayInput,
  ReplayResult,
  StageState,
} from "./types.js";
import { terminalClasses } from "./types.js";

/** Pure full-log replay. To insert late events, replay the old log plus the new events. */
export function replay(input: ReplayInput): ReplayResult {
  if (!Number.isFinite(input.asOf)) throw new TypeError("asOf must be finite Unix milliseconds");
  const diagnostics: Diagnostic[] = [];
  const report = (
    code: DiagnosticCode,
    subject: string,
    message: string,
    event?: LifecycleEvent,
  ) => {
    diagnostics.push({ code, subject, message, ...(event ? { eventId: event.id } : {}) });
  };
  function catalog<T extends { readonly id: string }>(items: readonly T[]): Map<string, T> {
    const result = new Map<string, T>();
    const conflicts = new Set<string>();
    for (const item of items) {
      const previous = result.get(item.id);
      if (previous && canonical(previous) !== canonical(item)) conflicts.add(item.id);
      result.set(item.id, item);
    }
    for (const key of conflicts) {
      result.delete(key);
      report("invalid_definition", key, "Conflicting catalog entries excluded.");
    }
    return result;
  }
  const definitions = catalog(input.definitions);
  for (const [key, definition] of definitions) {
    const stageIds = new Set(definition.stages.map((s) => s.id));
    if (
      stageIds.size !== definition.stages.length ||
      definition.initialStages?.some((s) => !stageIds.has(s)) ||
      (definition.initialStages !== undefined &&
        (definition.initialStages.length === 0 ||
          new Set(definition.initialStages).size !== definition.initialStages.length)) ||
      (Boolean(definition.transitions?.length) && !definition.initialStages?.length) ||
      definition.stages.some(
        (s) => s.terminal !== undefined && !terminalClasses.includes(s.terminal),
      ) ||
      definition.transitions?.some((t) => !stageIds.has(t.from) || !stageIds.has(t.to)) ||
      (definition.transitions !== undefined &&
        new Set(definition.transitions.map((t) => canonical([t.from, t.to]))).size !==
          definition.transitions.length)
    ) {
      definitions.delete(key);
      report(
        "invalid_definition",
        key,
        "Stage IDs and initial IDs must be unique, references must exist, constrained processes need initial stages, and terminal stages need an explicit terminal class.",
      );
    }
  }
  const cases = new Map<string, CaseState>();
  for (const item of catalog(input.cases).values()) {
    if (!definitions.has(item.processId)) {
      report("missing_reference", item.id, "Case process definition is missing; case excluded.");
      continue;
    }
    cases.set(item.id, {
      ...item,
      status: "unknown",
      terminal: null,
      episodes: [],
      pauses: [],
      timingComplete: item.historyComplete !== false,
    });
  }
  const stages = new Map<string, StageState>();
  for (const item of catalog(input.stageInstances).values()) {
    const owner = cases.get(item.caseId);
    if (!owner || !definitions.get(owner.processId)?.stages.some((s) => s.id === item.stageId)) {
      report(
        "missing_reference",
        item.id,
        "Stage instance case or stage definition is missing; instance excluded.",
      );
      continue;
    }
    stages.set(item.id, {
      ...item,
      status: "unknown",
      episodeIndex: null,
      enteredAt: null,
      exitedAt: null,
      blocked: [],
      paused: [],
      timingComplete: item.historyComplete !== false,
    });
  }
  const relations = new Map<string, RelationState>();
  const children = new Map<string, ChildState>();
  const visits: ReplayResult["visits"] = [];
  const activeInterruptions = new Map<string, Interval>();
  function interrupt(
    event: LifecycleEvent,
    owner: CaseState | StageState,
    list: Interval[],
    kind: string,
    interruptionId: string,
    opening: boolean,
  ) {
    const key = canonical([kind, owner.id, interruptionId]);
    const active = activeInterruptions.get(key);
    if (!interruptionId || (opening && active)) {
      owner.timingComplete = false;
      report("invalid_transition", owner.id, "Empty or already active interruption ID.", event);
    } else if (opening) {
      const interval = { start: event.occurredAt, end: null };
      list.push(interval);
      activeInterruptions.set(key, interval);
    } else if (active) {
      active.end = event.occurredAt;
      activeInterruptions.delete(key);
    } else {
      list.push({ start: null, end: event.occurredAt });
      owner.timingComplete = false;
      report(
        "missing_boundary",
        owner.id,
        "Interruption end has no observed start; unavailable duration is unknown.",
        event,
      );
    }
  }
  const reliableCases = new Set<string>(input.reliableCases);
  const relationScope = (relation: RelationState | import("./types.js").RelationInput) => {
    for (const endpoint of [relation.from, relation.to]) {
      if (endpoint.type === "case") return endpoint.id;
      if (endpoint.type === "stage-instance") {
        const owner = stages.get(endpoint.id)?.caseId;
        if (owner) return owner;
      }
    }
    return relation.id;
  };
  const eventCase = (event: LifecycleEvent): string => {
    if ("stageInstanceId" in event)
      return stages.get(event.stageInstanceId)?.caseId ?? event.stageInstanceId;
    if ("caseId" in event) return event.caseId;
    if (event.type === "relation.link") return relationScope(event.relation);
    if (event.type === "relation.unlink") {
      // Conflicting input links must not let arrival order choose a case/sequence scope.
      const scopes = input.events
        .filter((e) => e.type === "relation.link" && e.relation.id === event.relationId)
        .map((e) => (e.type === "relation.link" ? relationScope(e.relation) : ""))
        .sort(compareText);
      return scopes[0] ?? event.relationId;
    }
    return event.id;
  };
  const prepared = prepareEvents(
    input.events,
    input.asOf,
    new Set(input.reliableSources),
    diagnostics,
    {
      scope: eventCase,
      reliableCase: (scope) => reliableCases.has(scope),
      before: (a, b) => {
        if (a.type === "relation.link" && b.type === "relation.unlink")
          return a.relation.id === b.relationId;
        if (a.type === "child.link" && b.type === "child.unlink")
          return a.childCaseId === b.childCaseId;
        if (a.type === "case.pause" && b.type === "case.resume")
          return a.interruptionId === b.interruptionId;
        if (a.type === "case.start" || a.type === "case.reopen")
          return (
            b.type.startsWith("stage.") ||
            b.type === "case.pause" ||
            b.type === "case.resume" ||
            b.type === "case.terminate"
          );
        if (b.type === "case.terminate")
          return a.type.startsWith("stage.") || a.type === "case.pause" || a.type === "case.resume";
        if ("stageInstanceId" in a && "stageInstanceId" in b) {
          if (a.stageInstanceId === b.stageInstanceId) {
            if (a.type === "stage.enter")
              return b.type !== "stage.enter" && b.type !== "stage.skip";
            if (b.type === "stage.exit") return a.type !== "stage.exit" && a.type !== "stage.skip";
            if (
              "interruptionId" in a &&
              "interruptionId" in b &&
              a.interruptionId === b.interruptionId
            )
              return (
                (a.type === "stage.block" && b.type === "stage.unblock") ||
                (a.type === "stage.pause" && b.type === "stage.resume")
              );
          } else if (a.type === "stage.exit" && b.type === "stage.enter") {
            const from = stages.get(a.stageInstanceId);
            const to = stages.get(b.stageInstanceId);
            const definition = to && definitions.get(cases.get(to.caseId)?.processId ?? "");
            return Boolean(
              from &&
                to &&
                (from.branchId ?? "") === (to.branchId ?? "") &&
                (definition?.transitions?.some(
                  (t) => t.from === from.stageId && t.to === to.stageId,
                ) ||
                  definition?.stages.some((s) => s.id === to.stageId && s.terminal !== undefined)),
            );
          }
        }
        return false;
      },
    },
  );
  function closeInterruptions(lists: Interval[][], time: number) {
    for (const [key, interval] of activeInterruptions) {
      if (lists.some((list) => list.includes(interval))) {
        interval.end = time;
        activeInterruptions.delete(key);
      }
    }
  }
  function terminateCase(
    owner: CaseState,
    time: number,
    terminal: CaseState["terminal"],
    event: LifecycleEvent,
  ) {
    const episode = owner.episodes.at(-1);
    if (episode) episode.end = time;
    else {
      owner.episodes.push({ start: null, end: time });
      owner.timingComplete = false;
      report("missing_boundary", owner.id, "Termination has no observed case start.", event);
    }
    owner.status = "terminated";
    owner.terminal = terminal;
    const stageLists = [...stages.values()]
      .filter((s) => s.caseId === owner.id)
      .flatMap((s) => [s.blocked, s.paused]);
    closeInterruptions([owner.pauses, ...stageLists], time);
  }
  // Latest closed predecessor is scoped to a branch and explicit case episode.
  const frontiers = new Map<string, StageState>();
  const frontierKey = (stage: StageState, owner: CaseState) =>
    canonical([owner.id, owner.episodes.length, stage.branchId ?? ""]);
  const supported = new Set([
    "case.start",
    "case.pause",
    "case.resume",
    "case.terminate",
    "case.reopen",
    "stage.enter",
    "stage.exit",
    "stage.skip",
    "stage.block",
    "stage.unblock",
    "stage.pause",
    "stage.resume",
    "relation.link",
    "relation.unlink",
    "child.link",
    "child.unlink",
  ]);
  for (const event of prepared.events) {
    if (!supported.has(event.type)) {
      report(
        "unsupported_event",
        event.id,
        "Unknown engine action; canonical wire names require explicit normalization.",
        event,
      );
      continue;
    }
    const time = event.occurredAt;
    if (event.type.startsWith("case.") && "caseId" in event) {
      const owner = cases.get(event.caseId);
      if (!owner) {
        report("missing_reference", event.caseId, "Unknown case.", event);
        continue;
      }
      const invalid = (message: string) => {
        owner.timingComplete = false;
        report("invalid_transition", owner.id, message, event);
      };
      switch (event.type) {
        case "case.start":
          if (owner.status !== "unknown" || owner.episodes.length)
            invalid("Case already started; use reopen after termination.");
          else {
            owner.status = "open";
            owner.episodes.push({ start: time, end: null });
          }
          break;
        case "case.reopen":
          if (owner.status !== "terminated")
            invalid("Reopen requires an explicit prior termination.");
          else {
            owner.status = "open";
            owner.terminal = null;
            owner.episodes.push({ start: time, end: null });
          }
          break;
        case "case.terminate": {
          if (!terminalClasses.includes(event.terminal)) {
            invalid("Unknown terminal class.");
            break;
          }
          if (owner.status === "terminated") {
            if (owner.episodes.at(-1)?.end !== time || owner.terminal !== event.terminal)
              invalid("Case already terminated or terminal class conflicts.");
            break;
          }
          terminateCase(owner, time, event.terminal, event);
          break;
        }
        case "case.pause":
        case "case.resume":
          if (owner.status !== "open" && owner.status !== "paused") {
            invalid("Case interruption requires an open case.");
            break;
          }
          interrupt(
            event,
            owner,
            owner.pauses,
            "case.pause",
            event.interruptionId,
            event.type === "case.pause",
          );
          owner.status = owner.pauses.some((p) => p.start !== null && p.end === null)
            ? "paused"
            : "open";
          break;
      }
      continue;
    }
    if ("stageInstanceId" in event) {
      const stage = stages.get(event.stageInstanceId);
      const owner = stage && cases.get(stage.caseId);
      if (!stage || !owner) {
        report("missing_reference", event.stageInstanceId, "Unknown stage instance.", event);
        continue;
      }
      const invalid = (message: string) => {
        stage.timingComplete = false;
        report("invalid_transition", stage.id, message, event);
      };
      if (event.type === "stage.enter" || event.type === "stage.skip") {
        if (stage.status !== "unknown") {
          invalid("Instance already observed; retry/re-entry requires a new instance ID.");
          continue;
        }
        if (owner.status === "terminated") {
          invalid("Stage cannot enter or skip in a terminated case; reopen first.");
          continue;
        }
        if (event.type === "stage.skip") {
          stage.status = "skipped";
          continue;
        }
        if (owner.status === "unknown") {
          stage.timingComplete = false;
          report(
            "missing_boundary",
            stage.id,
            "Stage entry lacks an observed open case; case history is incomplete.",
            event,
          );
        }
        const definition = definitions.get(owner.processId);
        if (
          definition?.transitions?.length &&
          [...stages.values()].some(
            (s) =>
              s.caseId === owner.id &&
              s.status === "open" &&
              s.episodeIndex === owner.episodes.length - 1 &&
              (s.branchId ?? "") === (stage.branchId ?? ""),
          )
        ) {
          invalid(
            "A constrained serial branch already has an open attempt; use distinct branch IDs for parallel paths.",
          );
          continue;
        }
        const prior = frontiers.get(frontierKey(stage, owner));
        const allowed = prior
          ? !definition?.transitions?.length ||
            definition.transitions.some((t) => t.to === stage.stageId && t.from === prior.stageId)
          : !definition?.initialStages || definition.initialStages.includes(stage.stageId);
        if (!allowed) {
          invalid(
            "Latest predecessor in this branch and case episode does not permit entry (or initial stage is not allowed).",
          );
          continue;
        }
        stage.status = "open";
        stage.enteredAt = time;
        stage.episodeIndex = owner.episodes.length - 1;
        visits.push({
          caseId: stage.caseId,
          stageId: stage.stageId,
          stageInstanceId: stage.id,
          occurredAt: time,
          eventId: event.id,
        });
        const terminal = definition?.stages.find((s) => s.id === stage.stageId)?.terminal;
        if (terminal !== undefined) {
          // The terminal marker has no continuing dwell: its entry explicitly ends this episode.
          stage.status = "closed";
          stage.exitedAt = time;
          terminateCase(owner, time, terminal, event);
        }
      } else if (event.type === "stage.exit") {
        if (stage.status === "closed" || stage.status === "skipped") {
          const terminal = definitions
            .get(owner.processId)
            ?.stages.find((s) => s.id === stage.stageId)?.terminal;
          if (terminal !== undefined && stage.enteredAt === time && stage.exitedAt === time)
            continue;
          invalid("Stage already closed or skipped.");
          continue;
        }
        if (stage.enteredAt !== null && stage.episodeIndex !== owner.episodes.length - 1) {
          invalid(
            "Stage exit belongs to a prior case episode; it cannot advance the reopened branch.",
          );
        }
        if (owner.status === "terminated") {
          stage.timingComplete = false;
          report(
            "invalid_transition",
            stage.id,
            "Stage exit occurs after case termination; explicit dwell is retained but availability is unknown.",
            event,
          );
        }
        if (stage.enteredAt === null) {
          stage.timingComplete = false;
          report(
            "missing_boundary",
            stage.id,
            "Exit precedes or lacks entry; dwell is unknown, never negative.",
            event,
          );
        }
        stage.status = "closed";
        stage.exitedAt = time;
        closeInterruptions([stage.blocked, stage.paused], time);
        if (stage.enteredAt !== null && stage.episodeIndex === owner.episodes.length - 1)
          frontiers.set(frontierKey(stage, owner), stage);
      } else if ("interruptionId" in event) {
        if (stage.status !== "open") {
          invalid("Stage interruption requires an observed entry and no exit.");
          continue;
        }
        const blocked = event.type === "stage.block" || event.type === "stage.unblock";
        interrupt(
          event,
          stage,
          blocked ? stage.blocked : stage.paused,
          blocked ? "stage.block" : "stage.pause",
          event.interruptionId,
          event.type === "stage.block" || event.type === "stage.pause",
        );
      }
      continue;
    }
    if (event.type === "relation.link") {
      const old = relations.get(event.relation.id);
      const { intervals: _intervals, ...identity } = old ?? { intervals: [] };
      if (
        old &&
        (canonical(identity) !== canonical(event.relation) || old.intervals.at(-1)?.end === null)
      ) {
        report(
          "invalid_transition",
          event.relation.id,
          "Relation identity changed or relation is already linked.",
          event,
        );
        continue;
      }
      const relation: RelationState = old ?? { ...event.relation, intervals: [] };
      relation.intervals.push({ start: time, end: null });
      relations.set(relation.id, relation);
    } else if (event.type === "relation.unlink") {
      const interval = relations.get(event.relationId)?.intervals.at(-1);
      if (!interval || interval.end !== null)
        report("missing_boundary", event.relationId, "Unlink has no active relation link.", event);
      else interval.end = time;
    } else if (event.type === "child.link" || event.type === "child.unlink") {
      if (!cases.has(event.caseId) || !cases.has(event.childCaseId)) {
        report("missing_reference", event.childCaseId, "Parent or child case is missing.", event);
        continue;
      }
      const key = canonical([event.caseId, event.childCaseId]);
      const child = children.get(key) ?? {
        caseId: event.caseId,
        childCaseId: event.childCaseId,
        intervals: [],
      };
      const active = child.intervals.at(-1);
      if (event.type === "child.unlink") {
        if (!active || active.end !== null) {
          child.intervals.push({ start: null, end: time });
          children.set(key, child);
          report("missing_boundary", key, "Child unlink has no active link.", event);
        } else active.end = time;
      } else if (active?.end === null) {
        report("invalid_transition", key, "Child already linked.", event);
      } else {
        const pending = [event.childCaseId];
        const seen = new Set<string>();
        while (pending.length) {
          const current = pending.pop();
          if (!current || seen.has(current)) continue;
          seen.add(current);
          for (const edge of children.values()) {
            if (edge.caseId === current && edge.intervals.at(-1)?.end === null)
              pending.push(edge.childCaseId);
          }
        }
        if (seen.has(event.caseId))
          report(
            "cycle",
            key,
            "Child link would create an active case hierarchy cycle; excluded.",
            event,
          );
        else {
          child.intervals.push({ start: time, end: null });
          children.set(key, child);
        }
      }
    }
  }
  // Excluded corrupt evidence must not make an interruption disappear into a fabricated zero.
  const uncertainIds = new Set(prepared.uncertainEventIds);
  for (const d of diagnostics) {
    if (d.code === "unsupported_event" && d.eventId) uncertainIds.add(d.eventId);
  }
  for (const event of input.events) {
    if (!uncertainIds.has(event.id)) continue;
    if ("stageInstanceId" in event) {
      const stage = stages.get(event.stageInstanceId);
      if (stage) {
        stage.timingComplete = false;
        const owner = cases.get(stage.caseId);
        if (owner) owner.timingComplete = false;
      }
    } else if ("caseId" in event && event.type.startsWith("case.")) {
      const owner = cases.get(event.caseId);
      if (owner) owner.timingComplete = false;
    } else if (event.type === "child.link" || event.type === "child.unlink") {
      const key = canonical([event.caseId, event.childCaseId]);
      const child = children.get(key) ?? {
        caseId: event.caseId,
        childCaseId: event.childCaseId,
        intervals: [],
      };
      if (!child.intervals.some((i) => i.start === null && i.end === input.asOf)) {
        child.intervals.push({ start: null, end: input.asOf });
      }
      children.set(key, child);
    }
  }
  for (const owner of cases.values()) {
    if (owner.status === "unknown")
      report("missing_boundary", owner.id, "No explicit case start or termination is observed.");
  }
  for (const stage of stages.values()) {
    const owner = cases.get(stage.caseId);
    if (stage.status === "unknown")
      report("missing_boundary", stage.id, "No stage entry, exit or skip is observed.");
    if (
      stage.status === "open" &&
      owner?.episodes.some((e) => e.end !== null && e.end >= (stage.enteredAt ?? Infinity))
    ) {
      stage.timingComplete = false;
      report(
        "missing_boundary",
        stage.id,
        "Case episode terminated without this stage's exit; no exit or outcome inferred.",
      );
    }
  }
  const byId = <T extends { id: string }>(items: Iterable<T>): T[] =>
    [...items].sort((a, b) => compareText(a.id, b.id));
  return {
    asOf: input.asOf,
    cases: byId(cases.values()),
    stageInstances: byId(stages.values()),
    relations: byId(relations.values()),
    children: [...children.values()].sort((a, b) =>
      compareText(canonical([a.caseId, a.childCaseId]), canonical([b.caseId, b.childCaseId])),
    ),
    visits,
    ...prepared,
    diagnostics: diagnostics.sort((a, b) => compareText(canonical(a), canonical(b))),
  };
}
