import * as v from "valibot";

/**
 * Shapes of the derived lifecycle snapshots a projector writes (migration 0020). These are the
 * serving read model's own contract, deliberately independent of the lifecycle event schema and
 * reducer: a projector adapts reducer output into these inputs.
 */

/** Opaque ids: projector-chosen tokens (e.g. keyed hashes), never names or emails. */
export const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Machine keys: process, stage, outcome, relation, reason and error codes. */
export const SLUG = /^[a-z][a-z0-9_.-]{0,63}$/;
/** Reducer build tags such as `lifecycle@1.2.0`. */
const VERSION_TAG = /^[a-z0-9][a-z0-9_.@+-]{0,63}$/;
/** Definition labels are product metadata; the narrow charset keeps out free-form notes. */
const LABEL = /^[\p{L}\p{N} _.,:()&/+-]{1,80}$/u;

export const MAX_STAGES = 64;
export const MAX_INTERVALS = 500;
export const MAX_RELATIONS = 100;

const Id = v.pipe(v.string(), v.regex(OPAQUE_ID));
const Slug = v.pipe(v.string(), v.regex(SLUG));
const Label = v.pipe(v.string(), v.regex(LABEL));
const Ms = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const Positive = v.pipe(v.number(), v.safeInteger(), v.minValue(1));

export const ProcessDefinitionInput = v.pipe(
  v.strictObject({
    process_key: Slug,
    version: Positive,
    label: Label,
    stages: v.pipe(
      v.array(v.strictObject({ key: Slug, label: Label, terminal: v.optional(v.boolean()) })),
      v.minLength(1),
      v.maxLength(MAX_STAGES),
    ),
  }),
  v.check((d) => new Set(d.stages.map((s) => s.key)).size === d.stages.length, "duplicate stage"),
);
export type ProcessDefinitionInput = v.InferOutput<typeof ProcessDefinitionInput>;

export const STATES = ["active", "paused", "blocked"] as const;
export type IntervalState = (typeof STATES)[number];

const Interval = v.pipe(
  v.strictObject({
    stage_key: Slug,
    state: v.picklist(STATES),
    entered_at: Ms,
    exited_at: v.nullable(Ms),
    outcome: v.optional(v.nullable(Slug)),
  }),
  v.check((i) => i.exited_at === null || i.exited_at >= i.entered_at, "interval ends early"),
);

export const CaseSnapshotInput = v.pipe(
  v.strictObject({
    case_id: Id,
    process_key: Slug,
    process_version: Positive,
    status: v.picklist(["open", "closed"]),
    outcome: v.optional(v.nullable(Slug)),
    current_stage: v.optional(v.nullable(Slug)),
    parent_case_id: v.optional(v.nullable(Id)),
    started_at: Ms,
    ended_at: v.optional(v.nullable(Ms)),
    last_event_at: Ms,
    intervals: v.pipe(v.array(Interval), v.maxLength(MAX_INTERVALS)),
    relations: v.optional(
      v.pipe(
        v.array(v.strictObject({ relation: Slug, to_case_id: Id })),
        v.maxLength(MAX_RELATIONS),
      ),
    ),
  }),
  v.check((c) => (c.status === "open") === (c.ended_at == null), "open iff ended_at is null"),
  v.check((c) => c.ended_at == null || c.ended_at >= c.started_at, "case ends before start"),
  v.check((c) => c.parent_case_id !== c.case_id, "case is its own parent"),
  v.check((c) => !c.relations?.some((r) => r.to_case_id === c.case_id), "self relation"),
  v.check(
    (c) => c.status === "open" || c.intervals.every((i) => i.exited_at !== null),
    "closed case has an open interval",
  ),
);
export type CaseSnapshotInput = v.InferOutput<typeof CaseSnapshotInput>;

/** Where a snapshot came from: required on every write and echoed by every read. */
export const Provenance = v.strictObject({
  generation: Positive,
  source_watermark: Ms,
  as_of: Ms,
  reducer_version: v.pipe(v.string(), v.regex(VERSION_TAG)),
});
export type Provenance = v.InferOutput<typeof Provenance>;

/** Throws a ValidationError naming only the failed path, never the offending value. */
export function parseInput<S extends v.GenericSchema>(schema: S, input: unknown): v.InferOutput<S> {
  const result = v.safeParse(schema, input);
  if (result.success) return result.output;
  const issue: v.BaseIssue<unknown> | undefined = result.issues[0];
  const path = issue?.path?.map((p) => String(p.key)).join(".") || "input";
  // Custom check messages are ours; built-in messages echo the received value, so skip them.
  const why = issue?.type === "check" ? issue.message : (issue?.expected ?? "invalid");
  throw new SnapshotRejected("invalid", `${path}: ${why}`);
}

export type RejectReason = "invalid" | "cycle" | "generation" | "unauthorized";

/** A write the read model refuses; `reason` is safe to log, `detail` carries no input values. */
export class SnapshotRejected extends Error {
  constructor(
    readonly reason: RejectReason,
    detail: string,
  ) {
    super(`${reason}: ${detail}`);
    this.name = "SnapshotRejected";
  }
}
