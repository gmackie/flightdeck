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
): { events: LifecycleEvent[]; supersededEventIds: EventId[] } {
  const groups = new Map<EventId, Map<string, LifecycleEvent>>();
  for (const event of input) {
    const group = groups.get(event.id) ?? new Map<string, LifecycleEvent>();
    group.set(canonical(event), event);
    groups.set(event.id, group);
  }
  const unique = new Map<EventId, LifecycleEvent>();
  for (const [key, group] of [...groups].sort(([a], [b]) => compareText(a, b))) {
    if (group.size > 1) {
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
      diagnostics.push({
        code: "invalid_sequence",
        subject: key,
        eventId: key,
        message: "Sequence must be a nonnegative safe integer; event excluded.",
      });
      continue;
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
    const group = successors.get(event.supersedes) ?? [];
    group.push(event);
    successors.set(event.supersedes, group);
  }
  for (const [target, group] of successors) {
    if (group.length < 2) continue;
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
  events.sort(
    (a, b) =>
      a.occurredAt - b.occurredAt ||
      compareText(a.source.id, b.source.id) ||
      (reliable.has(a.source.id)
        ? (a.source.sequence ?? Number.MAX_SAFE_INTEGER) -
          (b.source.sequence ?? Number.MAX_SAFE_INTEGER)
        : 0) ||
      compareText(a.id, b.id),
  );
  const last = new Map<string, LifecycleEvent>();
  const times = new Map<number, LifecycleEvent[]>();
  for (const event of events) {
    const group = times.get(event.occurredAt) ?? [];
    group.push(event);
    times.set(event.occurredAt, group);
    if (!reliable.has(event.source.id) || event.source.sequence === undefined) continue;
    const previous = last.get(event.source.id);
    if (
      previous?.source.sequence !== undefined &&
      event.source.sequence <= previous.source.sequence
    ) {
      diagnostics.push({
        code: "sequence_time_conflict",
        subject: event.source.id,
        eventId: event.id,
        message:
          "Reliable source sequence contradicts occurrence time or repeats; occurrence time takes precedence.",
      });
    }
    if (!previous || (previous.source.sequence ?? -1) < event.source.sequence)
      last.set(event.source.id, event);
  }
  for (const group of times.values()) {
    if (group.length < 2) continue;
    const first = group[0];
    if (!first) continue;
    const known = new Set(group.map((e) => e.source.sequence));
    if (
      group.every(
        (e) =>
          e.source.id === first.source.id &&
          reliable.has(e.source.id) &&
          e.source.sequence !== undefined,
      ) &&
      known.size === group.length
    )
      continue;
    diagnostics.push({
      code: "ambiguous_order",
      subject: String(first.occurredAt),
      message:
        "Equal occurrence times lack a common reliable sequence; source ID then event ID provide a deterministic, noncausal fallback.",
    });
  }
  return { events, supersededEventIds: [...superseded].sort(compareText) };
}
