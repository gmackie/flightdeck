import * as v from "valibot";

/**
 * Object-centric lifecycle events: a case (an application, a deploy, an incident) moves through
 * the stages of a versioned process. These contracts are strict: unknown fields, unknown schema
 * versions and personal-data keys fail closed instead of being stored.
 */
export const LIFECYCLE_SCHEMA_VERSION = 1;
export const MAX_LIFECYCLE_BATCH = 100;
export const MAX_LIFECYCLE_DIMENSIONS = 16;
export const MAX_LIFECYCLE_RELATIONS = 16;
export const MAX_PROCESS_STAGES = 64;
export const MAX_DIMENSION_VALUES = 64;
/** 2000-01-01T00:00:00Z. Earlier values are almost always epoch seconds sent as milliseconds. */
export const MIN_OCCURRED_AT = 946_684_800_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

/** Low-cardinality machine names: process, stage, object type, relation type, reason, source. */
const Key = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9_.-]{0,63}$/, "expected a lowercase key"));
/** Opaque producer ids (case, stage instance, linked object). No `@`, spaces or free text. */
const ObjectId = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "expected an opaque id"),
);
/** Same rule as `ClientEvent.eventId`: the stable dedup key. */
const EventId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{8,64}$/, "expected an 8-64 char id"));
const DimensionValue = v.union([
  v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/, "expected a short code")),
  v.boolean(),
]);
const EpochMs = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(MIN_OCCURRED_AT),
  v.maxValue(MAX_DATE_MS),
);

// Key segments that name personal or secret data. Keys are split on `_`, `.`, `-` and camelCase,
// and adjacent segments are also joined, so `api_key`, `firstName` and `e-mail` all match.
const SENSITIVE_SEGMENTS = new Set([
  "email",
  "mail",
  "phone",
  "mobile",
  "ssn",
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "credential",
  "credentials",
  "cookie",
  "address",
  "street",
  "postcode",
  "zip",
  "zipcode",
  "name",
  "firstname",
  "lastname",
  "fullname",
  "surname",
  "dob",
  "birthday",
  "birthdate",
  "salary",
  "compensation",
  "ip",
  "ipaddress",
  "creditcard",
  "cardnumber",
  "iban",
  "passport",
  "nationalid",
  "taxid",
]);

// Matched anywhere in the key with separators removed, so `useremail` and `phonenumber` match.
const SENSITIVE_SUBSTRINGS = [
  "email",
  "phone",
  "password",
  "passwd",
  "secret",
  "token",
  "address",
  "apikey",
  "privatekey",
  "username",
  "firstname",
  "lastname",
  "fullname",
  "surname",
  "birth",
  "credential",
  "passport",
  "creditcard",
  "cardnumber",
];

/**
 * True when `key` names personal or secret data and must never be stored. A best-effort
 * denylist: it catches common spellings, not every possible one, and cannot judge values.
 */
export function isSensitiveKey(key: string): boolean {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] as string;
    if (SENSITIVE_SEGMENTS.has(part)) return true;
    const next = parts[i + 1];
    if (next && SENSITIVE_SEGMENTS.has(part + next)) return true;
  }
  const compact = parts.join("");
  return SENSITIVE_SUBSTRINGS.some((term) => compact.includes(term));
}

/** Every object key in `value` (depth-bounded) that `isSensitiveKey` flags. */
export function prohibitedKeys(value: unknown, depth = 0): string[] {
  if (depth > 4 || typeof value !== "object" || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => prohibitedKeys(item, depth + 1));
  return Object.entries(value).flatMap(([k, item]) => [
    ...(isSensitiveKey(k) ? [k] : []),
    ...prohibitedKeys(item, depth + 1),
  ]);
}

const Dimensions = v.pipe(
  v.record(Key, DimensionValue),
  v.check(
    (d) => Object.keys(d).length <= MAX_LIFECYCLE_DIMENSIONS,
    `at most ${MAX_LIFECYCLE_DIMENSIONS} dimensions`,
  ),
  v.check((d) => !Object.keys(d).some(isSensitiveKey), "dimension key names personal data"),
);
export type LifecycleDimensions = v.InferOutput<typeof Dimensions>;

const ObjectRef = v.strictObject({ type: Key, objectId: ObjectId });
export type LifecycleObjectRef = v.InferOutput<typeof ObjectRef>;

const Relation = v.strictObject({ type: Key, objectType: Key, objectId: ObjectId });
export type LifecycleRelation = v.InferOutput<typeof Relation>;

const Relations = v.pipe(
  v.array(Relation),
  v.maxLength(MAX_LIFECYCLE_RELATIONS),
  v.check(
    (rs) => new Set(rs.map((r) => `${r.type}\n${r.objectType}\n${r.objectId}`)).size === rs.length,
    "duplicate relation",
  ),
);

export const CASE_TRANSITIONS = [
  "case.created",
  "case.started",
  "case.paused",
  "case.resumed",
  "case.completed",
  "case.terminated",
  "case.reopened",
] as const;
export const STAGE_TRANSITIONS = [
  "stage.entered",
  "stage.blocked",
  "stage.unblocked",
  "stage.paused",
  "stage.resumed",
  "stage.exited",
  "stage.skipped",
] as const;
export const OBJECT_TRANSITIONS = ["object.linked", "object.unlinked"] as const;
export const CORRECTION_TRANSITIONS = ["event.corrected"] as const;
export const LIFECYCLE_TRANSITIONS = [
  ...CASE_TRANSITIONS,
  ...STAGE_TRANSITIONS,
  ...OBJECT_TRANSITIONS,
  ...CORRECTION_TRANSITIONS,
] as const;
export type LifecycleTransition = (typeof LIFECYCLE_TRANSITIONS)[number];

/** Fields every lifecycle event carries. */
const base = {
  schemaVersion: v.literal(LIFECYCLE_SCHEMA_VERSION),
  /** Stable producer-minted id: a retry must resend the same id. Dedup key with the app id. */
  eventId: EventId,
  processId: Key,
  processVersion: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000)),
  caseId: ObjectId,
  /** When it happened in the source system. Kept as sent, however old; never clamped. */
  occurredAt: EpochMs,
  /** Producer-assigned order within a case (e.g. an outbox row id); breaks `occurredAt` ties. */
  sourceSequence: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(Number.MAX_SAFE_INTEGER),
  ),
  /** The producing system, e.g. `greenhouse` or `deploy-bot`. */
  source: v.optional(Key),
  /** Low-cardinality reason code, e.g. `awaiting_approval` on `stage.blocked`. */
  reason: v.optional(Key),
  relations: v.optional(Relations),
  dimensions: v.optional(Dimensions),
};

const stage = { stageId: Key, stageInstanceId: ObjectId };

const CaseEvent = v.strictObject({ ...base, type: v.picklist(CASE_TRANSITIONS) });
const StageEvent = v.strictObject({ ...base, type: v.picklist(STAGE_TRANSITIONS), ...stage });
const ObjectEvent = v.strictObject({
  ...base,
  type: v.picklist(OBJECT_TRANSITIONS),
  object: ObjectRef,
  /** Optional: link the object to one stage instance rather than the whole case. */
  stageId: v.optional(Key),
  stageInstanceId: v.optional(ObjectId),
});

const Correction = v.pipe(
  v.strictObject({
    targetEventId: EventId,
    /** `retract`: the target never happened. `amend`: replace its `occurredAt`/`dimensions`. */
    action: v.picklist(["retract", "amend"]),
    occurredAt: v.optional(EpochMs),
    dimensions: v.optional(Dimensions),
  }),
  v.check(
    (c) =>
      c.action === "retract"
        ? c.occurredAt === undefined && c.dimensions === undefined
        : c.occurredAt !== undefined || c.dimensions !== undefined,
    "amend needs occurredAt or dimensions; retract takes neither",
  ),
);
export type LifecycleCorrection = v.InferOutput<typeof Correction>;

const CorrectionEvent = v.strictObject({
  ...base,
  type: v.picklist(CORRECTION_TRANSITIONS),
  correction: Correction,
});

/**
 * One lifecycle transition, discriminated by `type`, so issues come from the matching shape.
 * Validate with `v.safeParse(LifecycleEventV1, input)`.
 */
export const LifecycleEventV1 = v.pipe(
  v.variant("type", [CaseEvent, StageEvent, ObjectEvent, CorrectionEvent]),
  v.check(
    (e) =>
      e.type !== "object.linked" && e.type !== "object.unlinked"
        ? true
        : (e.stageId === undefined) === (e.stageInstanceId === undefined),
    "stageId and stageInstanceId go together",
  ),
  v.check(
    (e) => e.type !== "event.corrected" || e.correction.targetEventId !== e.eventId,
    "an event cannot correct itself",
  ),
);
export type LifecycleEventV1 = v.InferOutput<typeof LifecycleEventV1>;
export type LifecycleEventInput = v.InferInput<typeof LifecycleEventV1>;

/** The batch envelope. Nothing else is accepted: the app comes from the credential. */
export const LifecycleBatch = v.strictObject({
  events: v.pipe(v.array(v.unknown()), v.minLength(1), v.maxLength(MAX_LIFECYCLE_BATCH)),
});

const StageDefinition = v.strictObject({
  stageId: Key,
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  /** Entering a terminal stage ends the case's active time in this process. */
  terminal: v.optional(v.boolean()),
});

const DimensionDefinition = v.pipe(
  v.strictObject({
    key: Key,
    values: v.pipe(v.array(DimensionValue), v.minLength(1), v.maxLength(MAX_DIMENSION_VALUES)),
  }),
  v.check((d) => !isSensitiveKey(d.key), "dimension key names personal data"),
  v.check((d) => new Set(d.values).size === d.values.length, "duplicate dimension value"),
);

const unique = <T>(items: T[], key: (item: T) => string) =>
  new Set(items.map(key)).size === items.length;

/**
 * A versioned process: its stages, the dimensions events may carry (with every allowed value,
 * which keeps them low-cardinality) and the object types cases may link to. Publish a new
 * `version` for any change; events name the version they were produced under.
 */
export const ProcessDefinitionV1 = v.pipe(
  v.strictObject({
    schemaVersion: v.literal(LIFECYCLE_SCHEMA_VERSION),
    processId: Key,
    version: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000)),
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    /** What one case is, e.g. `job_application`, `deploy`, `incident`. */
    caseType: Key,
    stages: v.pipe(v.array(StageDefinition), v.minLength(1), v.maxLength(MAX_PROCESS_STAGES)),
    dimensions: v.optional(
      v.pipe(v.array(DimensionDefinition), v.maxLength(MAX_LIFECYCLE_DIMENSIONS)),
    ),
    /** Allowed `(type, objectType)` pairs for relations and linked objects. */
    relations: v.optional(
      v.pipe(
        v.array(v.strictObject({ type: Key, objectType: Key })),
        v.maxLength(MAX_LIFECYCLE_RELATIONS),
      ),
    ),
  }),
  v.check((p) => unique(p.stages, (s) => s.stageId), "duplicate stageId"),
  v.check((p) => unique(p.dimensions ?? [], (d) => d.key), "duplicate dimension key"),
  v.check(
    (p) => unique(p.relations ?? [], (r) => `${r.type}\n${r.objectType}`),
    "duplicate relation type",
  ),
);
export type ProcessDefinitionV1 = v.InferOutput<typeof ProcessDefinitionV1>;

/**
 * Checks a parsed event against its process definition: stage, dimension keys and values,
 * relation and linked-object types. Returns problems (empty when the event conforms).
 * Producers should run this before enqueueing; ingestion enforces only the structural schema.
 */
export function checkAgainstDefinition(
  event: LifecycleEventV1,
  definition: ProcessDefinitionV1,
): string[] {
  const problems: string[] = [];
  if (event.processId !== definition.processId || event.processVersion !== definition.version) {
    return [`event is for ${event.processId}@${event.processVersion}`];
  }
  if ("stageId" in event && event.stageId !== undefined) {
    if (!definition.stages.some((s) => s.stageId === event.stageId)) {
      problems.push(`unknown stage ${event.stageId}`);
    }
  }
  const allowed = new Map((definition.dimensions ?? []).map((d) => [d.key, d.values]));
  const dimensionSets = [event.dimensions];
  if ("correction" in event) dimensionSets.push(event.correction.dimensions);
  for (const [key, value] of dimensionSets.flatMap((d) => Object.entries(d ?? {}))) {
    const values = allowed.get(key);
    if (!values) problems.push(`unknown dimension ${key}`);
    else if (!values.includes(value)) problems.push(`value not allowed for dimension ${key}`);
  }
  const pairs = new Set((definition.relations ?? []).map((r) => `${r.type}\n${r.objectType}`));
  for (const r of event.relations ?? []) {
    if (!pairs.has(`${r.type}\n${r.objectType}`)) {
      problems.push(`relation ${r.type} to ${r.objectType} not allowed`);
    }
  }
  if (
    "object" in event &&
    !(definition.relations ?? []).some((r) => r.objectType === event.object.type)
  ) {
    problems.push(`object type ${event.object.type} not allowed`);
  }
  return problems;
}

/** A relation as stored: a typed list of structs in the stream, not JSON. */
export type LifecycleRelationRecord = { type: string; object_type: string; object_id: string };

/** A correction as stored; its target is the row's `corrects_event_id`. */
export type LifecycleCorrectionRecord = {
  action: LifecycleCorrection["action"];
  occurred_at?: number;
  dimensions?: LifecycleDimensions;
};

/** Ingestion channel recorded on each row. */
export type LifecycleChannel = "binding" | "http";

/**
 * One row of the Iceberg `lifecycle_events` table. Corrections are rows too: readers apply
 * `event.corrected` rows to their targets rather than rewriting history.
 */
export type LifecycleRecord = {
  event_id: string;
  app_id: string;
  schema_version: number;
  process_id: string;
  process_version: number;
  type: LifecycleTransition;
  case_id: string;
  stage_id: string | null;
  stage_instance_id: string | null;
  occurred_at: number;
  received_at: number;
  source: string | null;
  source_sequence: number;
  reason: string | null;
  object_type: string | null;
  object_id: string | null;
  relations: LifecycleRelationRecord[] | null;
  dimensions: LifecycleDimensions | null;
  corrects_event_id: string | null;
  correction: LifecycleCorrectionRecord | null;
  channel: LifecycleChannel;
};

export type LifecycleIngestResult = { accepted: number };

/**
 * Lifecycle methods on `env.FLIGHTDECK`. Server-only: Flightdeck must have granted the bound
 * app `lifecycle.write`. A batch is accepted or rejected whole; errors whose message starts
 * with `lifecycle rejected` are permanent (fix or quarantine the events) except
 * `lifecycle rejected (future_occurred_at)`; others are retryable.
 */
export interface LifecycleRpc {
  trackLifecycle(event: unknown): Promise<LifecycleIngestResult>;
  ingestLifecycleBatch(batch: unknown): Promise<LifecycleIngestResult>;
}
