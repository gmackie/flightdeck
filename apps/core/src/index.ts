import { WorkerEntrypoint } from "cloudflare:workers";
import { Schema } from "effect";
import { EventBatch, type CaptureRequest, type CaptureReceipt } from "@flightdeck/contracts";

interface Env {
  EVENTS: R2Bucket;
  /** Secret JSON object: { "source-id": { "token": "long-random-secret", "projectId": "id" } } */
  SOURCE_CREDENTIALS: string;
}
type SourceConfig = { token: string; projectId: string };
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
function error(message: string): never { throw new Error(message); }
async function tokenMatches(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [x,y] = await Promise.all([crypto.subtle.digest("SHA-256",encoder.encode(a)),crypto.subtle.digest("SHA-256",encoder.encode(b))]);
  const left = new Uint8Array(x), right = new Uint8Array(y);
  let diff = 0; for (let i=0;i<left.length;i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}
export default class AnalyticsCore extends WorkerEntrypoint<Env> {
  async captureBatch(request: CaptureRequest): Promise<CaptureReceipt> {
    const { context, events } = request;
    if (!context || !idPattern.test(context.sourceId) || !context.sourceToken) error("unauthorized_source");
    let sources: Record<string,SourceConfig>;
    try { sources = JSON.parse(this.env.SOURCE_CREDENTIALS) as Record<string,SourceConfig>; }
    catch { error("source_configuration_missing"); }
    const source = Object.hasOwn(sources,context.sourceId) ? sources[context.sourceId] : undefined;
    if (!source?.token || !source.projectId || !(await tokenMatches(context.sourceToken,source.token))) error("unauthorized_source");
    if (!Array.isArray(events) || events.length === 0 || events.length > 100) error("invalid_batch_size");
    const size = new TextEncoder().encode(JSON.stringify(events)).byteLength;
    if (size > 256_000) error("batch_too_large");
    const decoded = Schema.decodeUnknownSync(EventBatch)({events}).events;
    for (const e of decoded) {
      if (!idPattern.test(e.eventId) || !/^[a-z][a-z0-9_.-]{0,127}$/.test(e.eventName) || Number.isNaN(Date.parse(e.occurredAt))) error("invalid_event");
    }
    const batchId = crypto.randomUUID();
    // One object per event: stable key allows idempotent retries. R2 put is durable before ack.
    // Note: repeated event IDs overwrite their own canonical record; callers must not reuse IDs for different events.
    const eventIds: string[] = [];
    for (const e of decoded) {
      const day = e.occurredAt.slice(0,10);
      const key = `events/${encodeURIComponent(source.projectId)}/${day}/${encodeURIComponent(e.eventId)}.json`;
      const record = { ...e, projectId: source.projectId, sourceId: context.sourceId, environment: context.environment ?? "production", receivedAt: new Date().toISOString(), batchId };
      await this.env.EVENTS.put(key, JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
      eventIds.push(e.eventId);
    }
    return { batchId, accepted: eventIds.length, rejected: 0, durability: "r2_persisted", eventIds };
  }
}
