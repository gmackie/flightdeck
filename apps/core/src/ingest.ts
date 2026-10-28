import { Schema } from "effect";
import { EventBatch, type CaptureReceipt, type CaptureRequest, type AnalyticsEvent } from "@flightdeck/contracts";
import { allowedBatchBytes, allowedBatchSize, enforceBatchPolicy, enforceSourcePolicy, type SourceGovernance } from "./governance";

const encoder = new TextEncoder();
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const eventNamePattern = /^[a-z][a-z0-9_.-]{0,127}$/;
const MAX_EVENTS = 100;
const MAX_BYTES = 256_000;
const MAX_AGE_MS = 90 * 86_400_000;
const MAX_FUTURE_MS = 5 * 60_000;

export type SourceConfig = SourceGovernance & {
  sha256: string;
  projectId: string;
  allowedEvents: string[];
  allowedProperties: Record<string, string[]>;
  /** Explicit authorization for architecture manifest registration. */
  graphEnabled?: boolean;
};
export type SinkRecord = {
  event_id: string; event_name: string; event_kind: string;
  project_id: string; source_id: string; environment: string;
  occurred_at: string; received_at: string; actor_id: string;
  anonymous_id: string; session_id: string; page_view_id: string;
  interaction_id: string; trace_id: string; deployment_id: string;
  objects_json: string; properties_json: string; batch_id: string;
};
export interface EventSink {
  durability: CaptureReceipt["durability"];
  write(records: readonly SinkRecord[]): Promise<void>;
}
export class IngestError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = "IngestError"; }
}
function allowed(name: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => pattern === name ||
    (pattern.endsWith(".*") && name.startsWith(pattern.slice(0,-1))));
}
function allowedKeys(eventName: string, source: SourceConfig): string[] {
  const list = Object.entries(source.allowedProperties ?? {});
  return list.filter(([pattern]) => allowed(eventName, [pattern])).flatMap(([,keys]) => keys);
}
export async function sha256(input: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(input)));
  return Array.from(digest, x=>x.toString(16).padStart(2,"0")).join("");
}
function equalHex(a: string, b: string): boolean {
  if (a.length !== 64 || b.length !== 64 || !/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  let mismatch = 0;
  for(let i=0;i<64;i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
export async function authenticate(
  context: CaptureRequest["context"],
  registry: Record<string,SourceConfig>
): Promise<SourceConfig> {
  if (!context || !identifier.test(context.sourceId) || !context.sourceToken || context.sourceToken.length < 32)
    throw new IngestError("unauthorized_source");
  if (!Object.prototype.hasOwnProperty.call(registry,context.sourceId))
    throw new IngestError("unauthorized_source");
  const source = registry[context.sourceId];
  const actual = await sha256(context.sourceToken);
  if (!source?.projectId || !identifier.test(source.projectId)) throw new IngestError("unauthorized_source");
  const digests = [source.sha256, ...(source.rotatingSha256 ?? [])];
  // Evaluate each candidate to avoid disclosing which credential is active.
  let valid = false;
  for (const digest of digests) {
    if (typeof digest === "string" && equalHex(digest, actual)) valid = true;
  }
  if (!valid) throw new IngestError("unauthorized_source");
  enforceSourcePolicy(source, context);
  return source;
}
export function validateBatch(input: unknown, source: SourceConfig, now = Date.now()): readonly AnalyticsEvent[] {
  if (!input || typeof input !== "object" || !Array.isArray((input as {events?:unknown}).events))
    throw new IngestError("invalid_batch");
  const rawEvents = (input as {events: unknown[]}).events;
  if (rawEvents.length === 0 || rawEvents.length > Math.min(MAX_EVENTS, allowedBatchSize(source)))
    throw new IngestError("invalid_batch_size");
  if (encoder.encode(JSON.stringify(input)).byteLength > Math.min(MAX_BYTES, allowedBatchBytes(source)))
    throw new IngestError("batch_too_large");
  let events: readonly AnalyticsEvent[];
  try { events = Schema.decodeUnknownSync(EventBatch)(input).events; }
  catch { throw new IngestError("invalid_schema"); }
  for (const event of events) {
    if (!identifier.test(event.eventId) || !eventNamePattern.test(event.eventName))
      throw new IngestError("invalid_event_identifier");
    if (!Array.isArray(source.allowedEvents) || !allowed(event.eventName,source.allowedEvents))
      throw new IngestError("event_not_allowed");
    const time = Date.parse(event.occurredAt);
    if (!Number.isFinite(time) || time < now-MAX_AGE_MS || time > now+MAX_FUTURE_MS)
      throw new IngestError("invalid_timestamp");
    if (event.objects.length > 16) throw new IngestError("too_many_objects");
    for (const obj of event.objects) {
      if (!identifier.test(obj.id) || !identifier.test(obj.type) || !identifier.test(obj.role))
        throw new IngestError("invalid_object");
    }
    if (event.actorId && !identifier.test(event.actorId)) throw new IngestError("invalid_actor");
    const keys = allowedKeys(event.eventName,source);
    for(const key of Object.keys(event.properties)){
      if (!keys.includes(key)) throw new IngestError("property_not_allowed");
    }
  }
  enforceBatchPolicy(events, source);
  return events;
}
function asString(value: string | undefined): string { return value ?? ""; }
export function toRecords(
  events: readonly AnalyticsEvent[], source: SourceConfig, context: CaptureRequest["context"], batchId: string, now: string
): SinkRecord[] {
  return events.map(e=>({
    event_id: e.eventId, event_name: e.eventName, event_kind: e.kind ?? "product",
    project_id: source.projectId, source_id: context.sourceId, environment: context.environment ?? "production",
    occurred_at: new Date(e.occurredAt).toISOString(), received_at: now,
    actor_id: asString(e.actorId), anonymous_id: asString(e.anonymousId),
    session_id: asString(e.sessionId), page_view_id: asString(e.pageViewId),
    interaction_id: asString(e.interactionId), trace_id: asString(e.traceId),
    deployment_id: asString(e.deploymentId),
    objects_json: JSON.stringify(e.objects), properties_json: JSON.stringify(e.properties), batch_id: batchId,
  }));
}
export async function ingestBatch(
  request: CaptureRequest, registry: Record<string,SourceConfig>, sink: EventSink, now = Date.now()
): Promise<CaptureReceipt> {
  const source = await authenticate(request?.context,registry);
  const events = validateBatch({events: request.events},source,now);
  const batchId = crypto.randomUUID();
  const records = toRecords(events,source,request.context,batchId,new Date(now).toISOString());
  await sink.write(records);
  return { batchId, accepted:records.length, rejected:0, durability:sink.durability, eventIds:records.map(x=>x.event_id) };
}
