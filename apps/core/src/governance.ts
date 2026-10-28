/**
 * Source and payload governance. This layer is independent of the transport so
 * the same policy applies to direct Worker RPC and an eventual HTTP collector.
 */
import type { AnalyticsEvent, CaptureContext } from "@flightdeck/contracts";

export interface SourceGovernance {
  enabled?: boolean;
  /** Optional additional SHA-256 hashes during credential rotation. */
  rotatingSha256?: readonly string[];
  allowedEnvironments?: readonly string[];
  allowedKinds?: readonly string[];
  consentRequired?: boolean;
  maxBatchSize?: number;
  maxBatchBytes?: number;
}
export class PolicyError extends Error {
  constructor(readonly code: string) { super(code); this.name = "PolicyError"; }
}
const blockedKeys = /^(?:password|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie|credit[_-]?card|card[_-]?number|cvv|ssn|social[_-]?security|private[_-]?key)$/i;
const maxDepth = 5;
const maxString = 4096;
const maxKeys = 64;
const maxArray = 128;
const maxEventPropertiesBytes = 24 * 1024;

export function enforceSourcePolicy(source: SourceGovernance, context: CaptureContext): void {
  if (source.enabled === false) throw new PolicyError("source_disabled");
  if (source.consentRequired && context.consentGranted !== true)
    throw new PolicyError("consent_required");
  if (source.allowedEnvironments?.length && !source.allowedEnvironments.includes(context.environment ?? "production"))
    throw new PolicyError("environment_not_allowed");
}
function checkJson(value: unknown, depth: number): void {
  if (depth > maxDepth) throw new PolicyError("properties_too_deep");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > maxString) throw new PolicyError("property_value_too_long");
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PolicyError("invalid_property_value");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > maxArray) throw new PolicyError("property_array_too_large");
    for (const item of value) checkJson(item, depth + 1);
    return;
  }
  if (typeof value !== "object" || !value) throw new PolicyError("invalid_property_value");
  const values = Object.entries(value as Record<string, unknown>);
  if (values.length > maxKeys) throw new PolicyError("too_many_properties");
  for (const [key, entry] of values) {
    if (blockedKeys.test(key)) throw new PolicyError("sensitive_property_name");
    if (key.length > 128) throw new PolicyError("property_key_too_long");
    checkJson(entry, depth + 1);
  }
}
export function enforceEventPolicy(event: AnalyticsEvent, source: SourceGovernance): void {
  if (source.allowedKinds?.length && !source.allowedKinds.includes(event.kind ?? "product"))
    throw new PolicyError("event_kind_not_allowed");
  const properties = event.properties;
  checkJson(properties, 0);
  const size = new TextEncoder().encode(JSON.stringify(properties)).byteLength;
  if (size > maxEventPropertiesBytes) throw new PolicyError("event_properties_too_large");
  // No accidental query params, fragments or full URLs in the canonical route.
  if (typeof properties.route === "string" &&
    (properties.route.includes("?") || properties.route.includes("#") || /^https?:\/\//i.test(properties.route)))
    throw new PolicyError("unsafe_route");
}
export function enforceBatchPolicy(events: readonly AnalyticsEvent[], source: SourceGovernance): void {
  const ids = new Set<string>();
  for (const event of events) {
    if (ids.has(event.eventId)) throw new PolicyError("duplicate_event_id_in_batch");
    ids.add(event.eventId);
    enforceEventPolicy(event, source);
  }
}
export function allowedBatchSize(source: SourceGovernance): number {
  return Math.min(100, Math.max(1, source.maxBatchSize ?? 100));
}
export function allowedBatchBytes(source: SourceGovernance): number {
  return Math.min(256_000, Math.max(1024, source.maxBatchBytes ?? 256_000));
}
