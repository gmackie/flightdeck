import {
  checkAgainstDefinition,
  LIFECYCLE_SCHEMA_VERSION,
  LifecycleBatch,
  type LifecycleChannel,
  LifecycleEventV1,
  type LifecycleIngestResult,
  type LifecycleRecord,
  type ProcessDefinitionV1,
  prohibitedKeys,
} from "@flightdeckhq/schema";
import * as v from "valibot";

/** An event may claim at most this much clock skew into the future. Past events are kept as is. */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;
/** Largest serialized event; the schema's own bounds keep real events far below it. */
export const MAX_LIFECYCLE_EVENT_BYTES = 8 * 1024;
/** Issues reported per rejected batch, and the longest message each carries. */
const MAX_ISSUES = 20;
const MAX_MESSAGE = 160;

export type LifecycleIssueCode =
  | "invalid_envelope"
  | "unsupported_schema_version"
  | "prohibited_key"
  | "event_too_large"
  | "invalid_event"
  | "future_occurred_at"
  | "duplicate_event_id"
  | "unknown_process"
  | "nonconforming_event"
  | "invalid_definition"
  | "definition_conflict";

/** `index` is the event's position in the batch, or null for envelope issues. Never echoes values. */
export type LifecycleIssue = { index: number | null; code: LifecycleIssueCode; message: string };

/**
 * Retrying the same batch fails the same way: fix or quarantine the events. The exceptions are
 * `future_occurred_at` (producer clock skew), which succeeds once Flightdeck's clock catches up,
 * and `unknown_process`, which succeeds once the producer registers the process version.
 */
export class LifecycleRejected extends Error {
  constructor(readonly issues: LifecycleIssue[]) {
    const first = issues[0];
    const at = first?.index == null ? "" : ` at events[${first.index}]`;
    super(`lifecycle rejected (${first?.code})${at}: ${first?.message}`);
    this.name = "LifecycleRejected";
  }
}

/** Operator-fixable (stream not bound): keep the events and retry later. */
export class LifecycleUnavailable extends Error {
  constructor(reason: string) {
    super(`lifecycle unavailable: ${reason}`);
    this.name = "LifecycleUnavailable";
  }
}

/** The app or credential lacks `lifecycle.write`. Operator-fixable, so also not permanent. */
export class LifecycleForbidden extends Error {
  constructor() {
    super("lifecycle forbidden: lifecycle.write is not granted");
    this.name = "LifecycleForbidden";
  }
}

export interface LifecycleDeps {
  now(): number;
  /** The commit point: once this resolves the whole batch is accepted. */
  send(rows: LifecycleRecord[]): Promise<void>;
  /** Registered definitions among `processId@version` keys for the app. */
  definitions(keys: string[]): Promise<Map<string, ProcessDefinitionV1>>;
}

const encoder = new TextEncoder();

/**
 * Validates and stores a lifecycle batch for `appId`, which the caller took from a credential.
 * All or nothing: one bad event rejects the batch, so a producer's checkpoint never skips one.
 * Delivery is at least once; readers dedupe on `(app_id, event_id)`.
 */
export async function ingestLifecycle(
  appId: string,
  input: unknown,
  channel: LifecycleChannel,
  deps: LifecycleDeps,
): Promise<LifecycleIngestResult> {
  const envelope = v.safeParse(LifecycleBatch, input);
  if (!envelope.success) {
    const message = describe(envelope.issues[0]);
    throw new LifecycleRejected([{ index: null, code: "invalid_envelope", message }]);
  }
  const receivedAt = deps.now();
  const issues: LifecycleIssue[] = [];
  const events: { index: number; event: LifecycleEventV1 }[] = [];
  const seen = new Set<string>();
  envelope.output.events.forEach((raw, index) => {
    const result = checkEvent(raw, receivedAt);
    if ("code" in result) {
      issues.push({ index, ...result });
      return;
    }
    if (seen.has(result.eventId)) {
      issues.push({ index, code: "duplicate_event_id", message: "eventId repeats in the batch" });
      return;
    }
    seen.add(result.eventId);
    events.push({ index, event: result });
  });
  if (issues.length) throw new LifecycleRejected(issues.slice(0, MAX_ISSUES));

  // Every event must conform to its registered process version (stages, dimensions, objects).
  const key = (e: LifecycleEventV1) => `${e.processId}@${e.processVersion}`;
  const definitions = await deps.definitions(events.map(({ event }) => key(event)));
  for (const { index, event } of events) {
    const definition = definitions.get(key(event));
    if (!definition) {
      const message = `process ${key(event)} is not registered`;
      issues.push({ index, code: "unknown_process", message });
      continue;
    }
    const problem = checkAgainstDefinition(event, definition)[0];
    if (problem) issues.push({ index, code: "nonconforming_event", message: safeText(problem) });
  }
  if (issues.length) throw new LifecycleRejected(issues.slice(0, MAX_ISSUES));

  const rows = events.map(({ event }) => toRecord(appId, event, receivedAt, channel));
  await deps.send(rows);
  return { accepted: rows.length };
}

function checkEvent(
  raw: unknown,
  receivedAt: number,
): LifecycleEventV1 | { code: LifecycleIssueCode; message: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { code: "invalid_event", message: "expected an object" };
  }
  // Size first, so the key scan below is bounded. RPC structured clone can carry BigInt and
  // cycles, which JSON cannot: those are permanent rejections, not retryable crashes.
  let size: number;
  try {
    size = encoder.encode(JSON.stringify(raw)).byteLength;
  } catch {
    return { code: "invalid_event", message: "not JSON-serializable" };
  }
  if (size > MAX_LIFECYCLE_EVENT_BYTES) {
    return { code: "event_too_large", message: `over ${MAX_LIFECYCLE_EVENT_BYTES} bytes` };
  }
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  if (version !== LIFECYCLE_SCHEMA_VERSION) {
    return {
      code: "unsupported_schema_version",
      message: `schemaVersion must be ${LIFECYCLE_SCHEMA_VERSION}`,
    };
  }
  const prohibited = prohibitedKeys(raw);
  if (prohibited.length) {
    return { code: "prohibited_key", message: `key names personal data: ${safe(prohibited[0])}` };
  }
  const parsed = v.safeParse(LifecycleEventV1, raw);
  if (!parsed.success) return { code: "invalid_event", message: describe(parsed.issues[0]) };
  const event = parsed.output;
  const latest = receivedAt + MAX_FUTURE_SKEW_MS;
  const amended = event.type === "event.corrected" ? event.correction.occurredAt : undefined;
  // Rejected, never clamped: a clamped time would be stored as if it were true.
  if (event.occurredAt > latest || (amended !== undefined && amended > latest)) {
    return { code: "future_occurred_at", message: "occurredAt is ahead of the server clock" };
  }
  return event;
}

/** A path and an issue message with any echoed input value removed. */
function describe(issue: v.BaseIssue<unknown> | undefined): string {
  if (!issue) return "invalid";
  const path = v.getDotPath(issue);
  // valibot appends the input (`... but received 3.25`, `Invalid integer: Received 3.25`).
  const message = issue.message.replace(/(:| but)? [Rr]eceived .*$/s, "").slice(0, MAX_MESSAGE);
  return path ? `${safe(path)}: ${message}` : message;
}

/** Keys and paths may come from the producer: keep them short and printable. */
const safe = (text: string | undefined) => (text ?? "").replace(/[^\w.[\]-]/g, "?").slice(0, 64);
/** Definition problems name keys (stages, dimensions, types), never values. */
const safeText = (text: string) => text.replace(/[^\w .@[\]-]/g, "?").slice(0, MAX_MESSAGE);

function toRecord(
  appId: string,
  e: LifecycleEventV1,
  receivedAt: number,
  channel: LifecycleChannel,
): LifecycleRecord {
  const stage = "stageId" in e ? e : undefined;
  const object = "object" in e ? e.object : undefined;
  const correction = e.type === "event.corrected" ? e.correction : undefined;
  return {
    event_id: e.eventId,
    app_id: appId,
    schema_version: e.schemaVersion,
    process_id: e.processId,
    process_version: e.processVersion,
    type: e.type,
    case_id: e.caseId,
    stage_id: stage?.stageId ?? null,
    stage_instance_id: stage?.stageInstanceId ?? null,
    occurred_at: e.occurredAt,
    received_at: receivedAt,
    source: e.source ?? null,
    source_sequence: e.sourceSequence,
    reason: e.reason ?? null,
    object_type: object?.type ?? null,
    object_id: object?.objectId ?? null,
    relations: e.relations?.length
      ? e.relations.map((r) => ({ type: r.type, object_type: r.objectType, object_id: r.objectId }))
      : null,
    dimensions: e.dimensions && Object.keys(e.dimensions).length ? e.dimensions : null,
    corrects_event_id: correction?.targetEventId ?? null,
    correction: correction
      ? {
          action: correction.action,
          ...(correction.occurredAt !== undefined ? { occurred_at: correction.occurredAt } : {}),
          ...(correction.dimensions ? { dimensions: correction.dimensions } : {}),
        }
      : null,
    channel,
  };
}
