import type { OrderingContext } from "./ordering.js";
import { orderEvents } from "./ordering.js";
import type { Diagnostic, EventId, LifecycleEvent } from "./types.js";

export const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Canonical JSON for duplicate equality, independent of property insertion order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => compareText(a, b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function prepareEvents(
  input: readonly LifecycleEvent[],
  asOf: number,
  reliable: ReadonlySet<string>,
  diagnostics: Diagnostic[],
  ordering: OrderingContext,
): { events: LifecycleEvent[]; supersededEventIds: EventId[]; uncertainEventIds: EventId[] } {
  const uncertain = new Set<EventId>();
  const groups = new Map<EventId, Map<string, LifecycleEvent>>();
  for (const event of input) {
    const group = groups.get(event.id) ?? new Map<string, LifecycleEvent>();
    group.set(canonical(event), event);
    groups.set(event.id, group);
  }
  const unique = new Map<EventId, LifecycleEvent>();
  for (const [key, group] of [...groups].sort(([a], [b]) => compareText(a, b))) {
    if (group.size > 1) {
      uncertain.add(key);
      diagnostics.push({
        code: "duplicate_conflict",
        subject: key,
        message: "Conflicting payloads share an event ID; all copies excluded.",
      });
      continue;
    }
    const event = [...group.values()][0];
    if (!event) continue;
    if (!Number.isFinite(event.occurredAt)) {
      uncertain.add(key);
      diagnostics.push({
        code: "invalid_time",
        subject: key,
        eventId: key,
        message: "Occurrence must be finite Unix milliseconds; event excluded.",
      });
      continue;
    }
    if (
      event.source.sequence !== undefined &&
      (!Number.isSafeInteger(event.source.sequence) || event.source.sequence < 0)
    ) {
      if (reliable.has(event.source.id) || ordering.reliableCase(ordering.scope(event)))
        uncertain.add(key);
      diagnostics.push({
        code: "invalid_sequence",
        subject: key,
        eventId: key,
        message:
          "Sequence must be a nonnegative safe integer; untrusted metadata is ignored, authoritative sequence errors exclude the event.",
      });
      if (reliable.has(event.source.id) || ordering.reliableCase(ordering.scope(event))) continue;
    }
    unique.set(key, event);
  }
  // Validate the entire replacement graph before removing anything. No arrival-order winner.
  const successors = new Map<EventId, LifecycleEvent[]>();
  const invalid = new Set<EventId>();
  for (const event of unique.values()) {
    if (!event.supersedes) continue;
    const target = unique.get(event.supersedes);
    if (!target) {
      diagnostics.push({
        code: "missing_reference",
        subject: event.supersedes,
        eventId: event.id,
        message: "Correction target is missing or conflicted; correction excluded.",
      });
      invalid.add(event.id);
    }
    if (target && event.type !== "event.retract") {
      const payload = (e: LifecycleEvent) => {
        const {
          id: _id,
          occurredAt: _time,
          source: _source,
          supersedes: _supersedes,
          ...action
        } = e;
        return canonical(action);
      };
      if (payload(event) !== payload(target)) {
        invalid.add(event.id);
        uncertain.add(target.id);
        diagnostics.push({
          code: "invalid_transition",
          subject: event.id,
          eventId: event.id,
          message:
            "An amendment cannot change its target action or subject; retract and supply new evidence instead.",
        });
      }
    }
    const group = successors.get(event.supersedes) ?? [];
    group.push(event);
    successors.set(event.supersedes, group);
  }
  for (const [target, group] of successors) {
    if (group.length < 2) continue;
    uncertain.add(target);
    for (const event of group) invalid.add(event.id);
    diagnostics.push({
      code: "correction_conflict",
      subject: target,
      message:
        "Competing replacements excluded; original retained. Supply a single correction chain.",
    });
  }
  for (const event of unique.values()) {
    const path = new Set<EventId>();
    let current: LifecycleEvent | undefined = event;
    while (current?.supersedes) {
      if (path.has(current.id)) {
        for (const key of path) invalid.add(key);
        diagnostics.push({
          code: "cycle",
          subject: event.id,
          eventId: event.id,
          message: "Correction cycle (or dependent correction) excluded.",
        });
        break;
      }
      path.add(current.id);
      current = unique.get(current.supersedes);
    }
  }
  // A correction of an invalid correction is also invalid. Iterate to a fixed point.
  let changed = true;
  while (changed) {
    changed = false;
    for (const event of unique.values()) {
      if (event.supersedes && invalid.has(event.supersedes) && !invalid.has(event.id)) {
        invalid.add(event.id);
        changed = true;
      }
    }
  }
  const superseded = new Set<EventId>();
  for (const event of unique.values()) {
    if (event.supersedes && !invalid.has(event.id)) superseded.add(event.supersedes);
  }
  const events = [...unique.values()].filter(
    (e) =>
      !invalid.has(e.id) &&
      !superseded.has(e.id) &&
      e.type !== "event.retract" &&
      e.occurredAt <= asOf,
  );
  for (const key of invalid) uncertain.add(key);
  return {
    events: orderEvents(events, reliable, ordering, diagnostics),
    supersededEventIds: [...superseded].sort(compareText),
    uncertainEventIds: [...uncertain].sort(compareText),
  };
}
