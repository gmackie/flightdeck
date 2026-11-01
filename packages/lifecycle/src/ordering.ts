import { compareText } from "./events.js";
import type { Diagnostic, LifecycleEvent } from "./types.js";

export interface OrderingContext {
  scope(event: LifecycleEvent): string;
  reliableCase(scope: string): boolean;
  before(a: LifecycleEvent, b: LifecycleEvent): boolean;
}

/** Order independent case timelines separately. Causal fallback applies only to equal times. */
export function orderEvents(
  events: LifecycleEvent[],
  reliable: ReadonlySet<string>,
  context: OrderingContext,
  diagnostics: Diagnostic[],
): LifecycleEvent[] {
  const groups = new Map<string, LifecycleEvent[]>();
  for (const event of events) {
    const key = JSON.stringify([event.occurredAt, context.scope(event)]);
    const group = groups.get(key) ?? [];
    group.push(event);
    groups.set(key, group);
  }
  const output: LifecycleEvent[] = [];
  const last = new Map<string, number>();
  const sortedGroups = [...groups.values()].sort((a, b) => {
    const x = a[0];
    const y = b[0];
    return x && y
      ? x.occurredAt - y.occurredAt || compareText(context.scope(x), context.scope(y))
      : 0;
  });
  for (const group of sortedGroups) {
    group.sort((a, b) => compareText(a.id, b.id));
    const first = group[0];
    if (!first) continue;
    const scope = context.scope(first);
    const isReliable = (e: LifecycleEvent) =>
      context.reliableCase(scope) || reliable.has(e.source.id);
    const sequenceScope = (e: LifecycleEvent) =>
      JSON.stringify([scope, context.reliableCase(scope) ? null : e.source.id]);
    const comparable = (a: LifecycleEvent, b: LifecycleEvent) =>
      isReliable(a) &&
      isReliable(b) &&
      sequenceScope(a) === sequenceScope(b) &&
      a.source.sequence !== undefined &&
      b.source.sequence !== undefined;
    const edges = new Map<LifecycleEvent, Set<LifecycleEvent>>(group.map((e) => [e, new Set()]));
    const add = (a: LifecycleEvent, b: LifecycleEvent) => edges.get(a)?.add(b);
    for (const a of group)
      for (const b of group) {
        if (a === b) continue;
        if (comparable(a, b) && a.source.sequence !== b.source.sequence) {
          if ((a.source.sequence ?? 0) < (b.source.sequence ?? 0)) add(a, b);
          if (context.before(a, b) && (a.source.sequence ?? 0) > (b.source.sequence ?? 0)) {
            diagnostics.push({
              code: "sequence_time_conflict",
              subject: scope,
              eventId: b.id,
              message:
                "Reliable sequence contradicts an equal-time lifecycle prerequisite; evidence is inconsistent.",
            });
          }
        } else if (context.before(a, b)) add(a, b);
      }
    const pending = new Set(group);
    let ambiguous = false;
    while (pending.size) {
      const ready = [...pending]
        .filter((e) => ![...pending].some((p) => edges.get(p)?.has(e)))
        .sort((a, b) => compareText(a.id, b.id));
      if (!ready.length) {
        diagnostics.push({
          code: "ambiguous_order",
          subject: scope,
          message:
            "Equal-time prerequisites conflict; stable event ID fallback cannot establish causality.",
        });
        output.push(...[...pending].sort((a, b) => compareText(a.id, b.id)));
        break;
      }
      // Multiple independent ready actions commute; only conflicting actions need ambiguity evidence.
      if (ready.some((a, i) => ready.slice(i + 1).some((b) => !commute(a, b)))) ambiguous = true;
      const next = ready[0];
      if (!next) break;
      pending.delete(next);
      output.push(next);
    }
    if (ambiguous)
      diagnostics.push({
        code: "ambiguous_order",
        subject: scope,
        message:
          "Equal-time conflicting actions lack a reliable case sequence; event IDs are a deterministic noncausal fallback.",
      });
    for (const event of output.slice(-group.length)) {
      if (!isReliable(event) || event.source.sequence === undefined) continue;
      const key = sequenceScope(event);
      const previous = last.get(key);
      if (previous !== undefined && event.source.sequence <= previous)
        diagnostics.push({
          code: "sequence_time_conflict",
          subject: scope,
          eventId: event.id,
          message:
            "Reliable case sequence contradicts occurrence time or repeats; occurrence time takes precedence.",
        });
      last.set(key, Math.max(previous ?? -1, event.source.sequence));
    }
  }
  return output;
}

function commute(a: LifecycleEvent, b: LifecycleEvent): boolean {
  const relational = (e: LifecycleEvent) =>
    e.type.startsWith("relation.") || e.type.startsWith("child.");
  if (relational(a) !== relational(b)) return true;
  if ("stageInstanceId" in a && "stageInstanceId" in b)
    return a.stageInstanceId !== b.stageInstanceId;
  if (a.type === "relation.link" && b.type === "relation.link")
    return a.relation.id !== b.relation.id;
  if (
    (a.type === "child.link" || a.type === "child.unlink") &&
    (b.type === "child.link" || b.type === "child.unlink")
  )
    return a.childCaseId !== b.childCaseId;
  return false;
}
