import { Schema } from "effect";

/** Wire-level contracts shared by Cloudflare RPC and application SDKs. */
export const ObjectRef = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  role: Schema.String,
});
export const AnalyticsEvent = Schema.Struct({
  eventId: Schema.String,
  eventName: Schema.String,
  occurredAt: Schema.String,
  kind: Schema.optionalKey(Schema.Literals(["product", "rum", "error", "exposure", "agent"])),
  anonymousId: Schema.optionalKey(Schema.String),
  actorId: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String),
  pageViewId: Schema.optionalKey(Schema.String),
  interactionId: Schema.optionalKey(Schema.String),
  traceId: Schema.optionalKey(Schema.String),
  deploymentId: Schema.optionalKey(Schema.String),
  objects: Schema.Array(ObjectRef),
  properties: Schema.Record(Schema.String, Schema.Json),
});
export const EventBatch = Schema.Struct({ events: Schema.Array(AnalyticsEvent) });
export type AnalyticsEvent = typeof AnalyticsEvent.Type;
export type EventBatch = typeof EventBatch.Type;
export type EventKind = NonNullable<AnalyticsEvent["kind"]>;
export type ObjectReference = typeof ObjectRef.Type;

/** This context belongs to the authenticated application Worker/DO, never the browser. */
export type CaptureContext = {
  sourceId: string;
  sourceToken: string;
  environment?: string;
  requestId?: string;
  /** Asserted by an authenticated application, never from browser input. */
  consentGranted?: boolean;
};
export type CaptureRequest = { context: CaptureContext; events: readonly AnalyticsEvent[] };
export type Durability = "stream_ingested" | "r2_persisted";
export type CaptureReceipt = {
  batchId: string;
  accepted: number;
  rejected: number;
  durability: Durability;
  eventIds: string[];
};
export interface AnalyticsBinding {
  captureBatch(request: CaptureRequest): Promise<CaptureReceipt>;
}
