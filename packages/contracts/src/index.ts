import { Schema } from "effect";

export const ObjectRef = Schema.Struct({ type: Schema.String, id: Schema.String, role: Schema.String });
export const AnalyticsEvent = Schema.Struct({
  eventId: Schema.String,
  eventName: Schema.String,
  occurredAt: Schema.String,
  anonymousId: Schema.optionalKey(Schema.String),
  actorId: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String),
  pageViewId: Schema.optionalKey(Schema.String),
  interactionId: Schema.optionalKey(Schema.String),
  traceId: Schema.optionalKey(Schema.String),
  objects: Schema.Array(ObjectRef),
  properties: Schema.Record(Schema.String, Schema.Json),
});
export const EventBatch = Schema.Struct({ events: Schema.Array(AnalyticsEvent) });
export type AnalyticsEvent = typeof AnalyticsEvent.Type;
export type EventBatch = typeof EventBatch.Type;
export type CaptureContext = { sourceId: string; sourceToken: string; environment?: string; requestId?: string };
export type CaptureRequest = { context: CaptureContext; events: readonly AnalyticsEvent[] };
export type CaptureReceipt = { batchId: string; accepted: number; rejected: number; durability: "r2_persisted"; eventIds: string[] };
export type AnalyticsBinding = { captureBatch(request: CaptureRequest): Promise<CaptureReceipt> };
