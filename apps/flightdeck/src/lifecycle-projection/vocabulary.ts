import { type TerminalClass, terminalClasses } from "@flightdeckhq/lifecycle";

/**
 * The canonical lifecycle vocabulary: how a wire event (`LifecycleEventV1`, @flightdeckhq/schema)
 * is read by the replay engine (@flightdeckhq/lifecycle) and served from the D1 read model.
 * Everything a producer must state explicitly is listed here; nothing is inferred from labels,
 * free text or missing events.
 *
 * - Ordering: `sourceSequence` orders events of one case from one `source`. Events at the same
 *   millisecond are ordered by it, never by event id.
 * - Case start: `case.started` opens an episode. `case.created` registers the case only; its time
 *   is used as the start of a case that has no `case.started` (reported as `start_from_created`).
 * - Case end: `case.completed` ends it as `completed`. `case.terminated` must carry `reason` set
 *   to one of `TERMINAL_REASONS`. The served outcome is the `outcome` dimension when present (a
 *   domain code such as `hired` or `rolled_back`), else the reason, else `completed`.
 * - Interruptions: at most one active pause per case, and one active block plus one active pause
 *   per stage instance. `*.resumed` / `stage.unblocked` close the active one.
 * - Stage attempts: every entry is a new `stageInstanceId`; re-entering a stage is a new attempt.
 *   `stage.exited` may carry `reason`, served as the stage interval's outcome.
 * - Relations: `{ type: "child_of", objectType: "case" }` names the parent case. Any other relation
 *   to `objectType: "case"` is a typed edge between cases. Relations to other object types are
 *   graph evidence the reducer tracks but the D1 read model does not serve (reported).
 * - Corrections: `retract` removes the target; `amend` replaces the target's time and/or
 *   dimensions. Corrections of corrections are not supported (reported, not applied).
 */

export const PARENT_RELATION = "child_of";
export const CASE_OBJECT = "case";
export const OUTCOME_DIMENSION = "outcome";

/** `case.terminated` reasons: every engine terminal class except `completed`. */
export const TERMINAL_REASONS = terminalClasses.filter(
  (c): c is Exclude<TerminalClass, "completed"> => c !== "completed",
);

/** Fixed interruption ids: the vocabulary allows one active interruption of each kind. */
export const INTERRUPTION = { casePause: "case.pause", stageBlock: "block", stagePause: "pause" };

/** The engine's process id for one wire process version. */
export const engineProcessId = (processId: string, version: number) => `${processId}@${version}`;

/**
 * Codes the adapter and snapshot mapper report, alongside the engine's own diagnostic codes.
 * Every input event that is not applied, and every fact the read model cannot serve, produces
 * one of these: nothing is dropped silently.
 */
export const ADAPTER_CODES = [
  "unknown_process",
  "process_mismatch",
  "definition_violation",
  "missing_terminal_class",
  "correction_target_missing",
  "correction_chain_unsupported",
  "start_from_created",
  "no_case_start",
  "case_excluded",
  "stage_skipped",
  "stage_open_at_case_end",
  "interruption_boundary_unknown",
  "multiple_parents",
  "object_relation_not_served",
  "outcome_not_served",
  "too_many_intervals",
  "terminal_stage_unclassified",
] as const;
export type AdapterCode = (typeof ADAPTER_CODES)[number];
