import { Schema } from "effect";
export const ObjectRef = Schema.Struct({ type: Schema.String, id: Schema.String, role: Schema.String });
export const AnalyticsEvent = Schema.Struct({ eventId: Schema.String, eventName: Schema.String, occurredAt: Schema.String, anonymousId: Schema.optionalKey(Schema.String), sessionId: Schema.optionalKey(Schema.String), interactionId: Schema.optionalKey(Schema.String), objects: Schema.Array(ObjectRef), properties: Schema.Record(Schema.String, Schema.Json) });
export const EventBatch = Schema.Struct({ events: Schema.Array(AnalyticsEvent) });
export type AnalyticsEvent = typeof AnalyticsEvent.Type;
