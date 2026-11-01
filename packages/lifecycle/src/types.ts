declare const opaqueId: unique symbol;
/** Caller-owned, stable identifiers. No identity is derived from labels, position or timestamps. */
export type Id<K extends string> = string & { readonly [opaqueId]: K };
export type ProcessId = Id<"process">;
export type CaseId = Id<"case">;
export type StageId = Id<"stage">;
export type StageInstanceId = Id<"stage-instance">;
export type EventId = Id<"event">;
export type RelationId = Id<"relation">;

export function id<K extends string>(value: string): Id<K> {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("IDs must be nonempty opaque strings");
  }
  return value as Id<K>;
}

export type TerminalClass =
  | "completed"
  | "rejected"
  | "withdrawn"
  | "cancelled"
  | "failed"
  | "expired";
export const terminalClasses: readonly TerminalClass[] = [
  "completed",
  "rejected",
  "withdrawn",
  "cancelled",
  "failed",
  "expired",
];
export type Attributes = Readonly<Record<string, string | number | boolean | null>>;
export interface StageDefinition {
  readonly id: StageId;
  readonly label?: string;
  /** Entering this explicitly classified terminal stage terminates the case at entry time. */
  readonly terminal?: TerminalClass;
}
export interface ProcessDefinition {
  readonly id: ProcessId;
  readonly label?: string;
  readonly stages: readonly StageDefinition[];
  /** With edges, entry requires the latest branch predecessor in the current case episode.
   * Constrained definitions require initialStages. Self edges permit retries; cycles are valid. */
  readonly transitions?: readonly { readonly from: StageId; readonly to: StageId }[];
  readonly initialStages?: readonly StageId[];
}
export interface CaseInput {
  /** Set false for a known partial extraction, even if no missing boundary can be detected. */
  readonly historyComplete?: boolean;
  readonly id: CaseId;
  readonly processId: ProcessId;
  readonly attributes?: Attributes;
}
export interface StageInstanceInput {
  readonly historyComplete?: boolean;
  readonly id: StageInstanceId;
  readonly caseId: CaseId;
  readonly stageId: StageId;
  /** Independent transition frontier within the case. Defaults to one serial branch. */
  readonly branchId?: string;
}
export interface ObjectRef {
  readonly type: string;
  readonly id: string;
}
export interface RelationInput {
  readonly id: RelationId;
  readonly kind: string;
  readonly from: ObjectRef;
  readonly to: ObjectRef;
}
export interface EventEnvelope {
  readonly id: EventId;
  /** Finite Unix milliseconds. Receipt time must never be substituted for occurrence time. */
  readonly occurredAt: number;
  readonly source: { readonly id: string; readonly sequence?: number; readonly producer?: string };
  /** Replacement uses its own authoritative occurrence time; this is not receipt order. */
  readonly supersedes?: EventId;
}
type CaseAction = { readonly caseId: CaseId } & (
  | { readonly type: "case.start" | "case.reopen" }
  | { readonly type: "case.pause" | "case.resume"; readonly interruptionId: string }
  | { readonly type: "case.terminate"; readonly terminal: TerminalClass }
);
type StageAction = { readonly stageInstanceId: StageInstanceId } & (
  | { readonly type: "stage.enter" | "stage.exit" | "stage.skip" }
  | {
      readonly type: "stage.block" | "stage.unblock" | "stage.pause" | "stage.resume";
      readonly interruptionId: string;
    }
);
export type LifecycleEvent = EventEnvelope &
  (
    | CaseAction
    | StageAction
    | { readonly type: "relation.link"; readonly relation: RelationInput }
    | { readonly type: "relation.unlink"; readonly relationId: RelationId }
    | {
        readonly type: "child.link" | "child.unlink";
        readonly caseId: CaseId;
        readonly childCaseId: CaseId;
      }
    | { readonly type: "event.retract"; readonly supersedes: EventId }
  );
/** All inputs are immutable. Replay is from the complete supplied log, never a mutable snapshot. */
export interface ReplayInput {
  readonly definitions: readonly ProcessDefinition[];
  readonly cases: readonly CaseInput[];
  readonly stageInstances: readonly StageInstanceInput[];
  readonly events: readonly LifecycleEvent[];
  readonly asOf: number;
  /** Sequence is trusted only for these source IDs, and only to order equal occurrence times. */
  readonly reliableSources?: readonly string[];
  /** Authoritative per-case sequences span producer/source names, as in Workstream A. */
  readonly reliableCases?: readonly CaseId[];
}
export type DiagnosticCode =
  | "unsupported_event"
  | "duplicate_conflict"
  | "invalid_time"
  | "invalid_sequence"
  | "sequence_time_conflict"
  | "ambiguous_order"
  | "missing_reference"
  | "invalid_definition"
  | "invalid_transition"
  | "missing_boundary"
  | "cycle"
  | "correction_conflict";
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly subject: string;
  readonly eventId?: EventId;
  readonly message: string;
}
/** Null is an unknown boundary. An open interval has end=null and a known start. */
export interface Interval {
  start: number | null;
  end: number | null;
}
export interface CaseState extends CaseInput {
  status: "unknown" | "open" | "paused" | "terminated";
  terminal: TerminalClass | null;
  episodes: Interval[];
  pauses: Interval[];
  timingComplete: boolean;
}
export interface StageState extends StageInstanceInput {
  status: "unknown" | "open" | "closed" | "skipped";
  episodeIndex: number | null;
  enteredAt: number | null;
  exitedAt: number | null;
  blocked: Interval[];
  paused: Interval[];
  timingComplete: boolean;
}
export interface RelationState extends RelationInput {
  intervals: Interval[];
}
export interface ChildState {
  caseId: CaseId;
  childCaseId: CaseId;
  intervals: Interval[];
}
export interface StageVisit {
  caseId: CaseId;
  stageId: StageId;
  stageInstanceId: StageInstanceId;
  occurredAt: number;
  eventId: EventId;
}
export interface ReplayResult {
  asOf: number;
  cases: CaseState[];
  stageInstances: StageState[];
  relations: RelationState[];
  children: ChildState[];
  visits: StageVisit[];
  /** Effective events, after deduplication and supersession, at/before asOf. */
  events: LifecycleEvent[];
  supersededEventIds: EventId[];
  uncertainEventIds: EventId[];
  diagnostics: Diagnostic[];
}
