import * as v from "valibot";

/** Private, read-only RPC contract. Identity is ONLY the signed assertion, never caller claims. */
export const WORKFLOW_KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const key = v.pipe(v.string(), v.regex(WORKFLOW_KEY));
const id = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/));
const ms = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const version = v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(1_000_000));
const page = {
  limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
  cursor: v.nullable(v.pipe(v.string(), v.maxLength(512))),
};
const aggregate = {
  workflowKey: key,
  version,
  from: ms,
  to: ms,
  groupBy: v.nullable(key),
  filters: v.record(key, key),
};
export const LifecycleReadRequest = v.variant("method", [
  v.strictObject({ method: v.literal("grantsFor") }),
  v.strictObject({
    method: v.literal("listWorkflowDefinitions"),
    workflowKey: v.nullable(key),
    ...page,
  }),
  v.strictObject({
    method: v.literal("getWorkflowDefinition"),
    workflowKey: key,
    version: v.nullable(version),
  }),
  v.strictObject({ method: v.literal("getCaseSummary"), caseId: id }),
  v.strictObject({ method: v.literal("getCaseTimeline"), caseId: id, ...page }),
  v.strictObject({ method: v.literal("getStageDwell"), ...aggregate }),
  v.strictObject({
    method: v.literal("getFunnel"),
    ...aggregate,
    stages: v.pipe(v.array(key), v.maxLength(12)),
  }),
  v.strictObject({
    method: v.literal("getVariantStats"),
    ...aggregate,
    limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(15)),
  }),
  v.strictObject({ method: v.literal("getFreshness") }),
]);
export type LifecycleReadRequest = v.InferOutput<typeof LifecycleReadRequest>;
export type LifecycleReadResult =
  | { ok: true; appId: string | null; value: unknown }
  | { ok: false; code: "unauthorized" | "forbidden" | "invalid_argument" | "source_unavailable" };
export interface LifecycleReadRpc {
  read(assertion: string, appId: string | null, request: unknown): Promise<LifecycleReadResult>;
}

export const ReadGrants = v.pipe(
  v.array(
    v.strictObject({
      appId: v.pipe(v.string(), v.regex(/^[\w-]{3,64}$/)),
      role: v.picklist(["reader", "analyst", "owner", "admin"]),
      expiresAt: v.nullable(ms),
    }),
  ),
  v.maxLength(256),
);
const fresh = {
  status: v.picklist(["fresh", "stale", "unavailable"]),
  // No event-time completeness guarantee is derivable from an ingestion sequence.
  watermark: v.nullable(ms),
  lag_ms: v.nullable(ms),
};
export const ReadMeta = v.strictObject({
  as_of: ms,
  freshness: v.strictObject(fresh),
  source_version: v.pipe(v.string(), v.maxLength(64)),
  projection: v.strictObject({
    source_watermark: ms,
    generation: ms,
    status: v.picklist(["ready", "rebuilding", "failed", "empty"]),
    lag_ms: ms,
  }),
});
export const ReadDefinition = v.strictObject({
  workflow_key: key,
  version,
  label: v.pipe(v.string(), v.maxLength(80)),
  description: v.literal(""),
  stages: v.pipe(
    v.array(
      v.strictObject({
        key,
        label: v.pipe(v.string(), v.maxLength(80)),
        order: ms,
        terminal: v.boolean(),
      }),
    ),
    v.minLength(1),
    v.maxLength(64),
  ),
  // Serving snapshots do not retain declared outcome values or categorical dimensions.
  outcomes: v.pipe(v.array(key), v.maxLength(0)),
  dimensions: v.pipe(v.array(v.never()), v.maxLength(0)),
  published_at: ms,
});
export const ReadCase = v.strictObject({
  case_id: id,
  workflow_key: key,
  version,
  status: v.picklist(["open", "closed"]),
  outcome: v.nullable(key),
  current_stage: v.nullable(key),
  started_at: ms,
  ended_at: v.nullable(ms),
  last_event_at: ms,
  dimensions: v.record(key, key),
});
export const ReadTimeline = v.strictObject({
  stage_key: key,
  attempt: version,
  state: v.picklist(["active", "completed"]),
  entered_at: ms,
  exited_at: v.nullable(ms),
});
export const ReadDwell = v.strictObject({
  stage_key: key,
  group: v.nullable(key),
  n: ms,
  open_n: ms,
  p50_ms: v.nullable(ms),
  p90_ms: v.nullable(ms),
  mean_ms: v.nullable(ms),
  suppressed: v.boolean(),
});
export const ReadFreshness = v.strictObject({
  ...fresh,
  workflows: v.pipe(
    v.array(v.strictObject({ workflow_key: key, last_event_at: v.nullable(ms) })),
    v.maxLength(100),
  ),
});
export const readPage = <S extends v.GenericSchema>(schema: S) =>
  v.strictObject({
    items: v.pipe(v.array(schema), v.maxLength(100)),
    next_cursor: v.nullable(v.pipe(v.string(), v.maxLength(512))),
  });
export const readSourced = <S extends v.GenericSchema>(schema: S) =>
  v.strictObject({ data: schema, meta: ReadMeta });
