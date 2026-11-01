/**
 * The erasure job state machine: pure (no I/O, no clock), so every transition is unit-testable
 * and the D1 store only persists what this decides.
 *
 *   requested -> local_hidden -> basin_pending -> basin_verified -> files_cleanup_pending -> complete
 *
 * `complete` is reachable only from `files_cleanup_pending` by `physical_accepted`, and
 * `basin_verified` only from `basin_pending` by `logical_accepted`. Any other (stage, event)
 * pair is `invalid_transition` and changes nothing, so a duplicate or out-of-order event is a
 * no-op rather than a skipped stage.
 */

export const STAGES = [
  "requested",
  "local_hidden",
  "basin_pending",
  "basin_verified",
  "files_cleanup_pending",
  "complete",
  "failed",
] as const;
export type Stage = (typeof STAGES)[number];
export type ActiveStage = Exclude<Stage, "complete" | "failed">;

export const MAX_ATTEMPTS = 8;
const MINUTE = 60_000;
const MAX_DELAY_MS = 6 * 60 * MINUTE;

/** Retry delay after the nth consecutive failure: 1 min doubling, capped at 6 h. */
export const retryDelay = (attempts: number) =>
  Math.min(MAX_DELAY_MS, MINUTE * 2 ** Math.min(Math.max(attempts - 1, 0), 20));

export type MachineState = {
  stage: Stage;
  /** Set only while `failed`: the stage to resume at when an operator reopens the job. */
  failedStage: ActiveStage | null;
  attempts: number;
  nextAttemptAt: number;
  lastErrorCode: string | null;
  settleUntil: number | null;
};

export type MachineEvent =
  | { type: "local_verified" }
  | { type: "local_residue" }
  | { type: "settle_scheduled"; settleUntil: number }
  | { type: "logical_accepted" }
  | { type: "cleanup_scheduled"; notBefore: number }
  | { type: "physical_accepted" }
  /** The step failed; `retryable: false` fails the job at once. */
  | { type: "step_failed"; code: string; retryable: boolean }
  /** Nothing is wrong, or an operator must fix it (no executor, runner still working): wait without spending an attempt. */
  | { type: "step_blocked"; code: string; retryAfterMs: number }
  | { type: "reopened" };

export type Transition =
  | { ok: true; state: MachineState; code: string }
  | { ok: false; code: "invalid_transition" };

export const initialState = (now: number): MachineState => ({
  stage: "requested",
  failedStage: null,
  attempts: 0,
  nextAttemptAt: now,
  lastErrorCode: null,
  settleUntil: null,
});

export const isActive = (stage: Stage): stage is ActiveStage =>
  stage !== "complete" && stage !== "failed";

export const isDue = (state: MachineState, now: number) =>
  isActive(state.stage) && state.nextAttemptAt <= now;

const clean = (state: MachineState, patch: Partial<MachineState>): MachineState => ({
  ...state,
  attempts: 0,
  lastErrorCode: null,
  ...patch,
});

/** What the next event is on success, per stage. */
const FORWARD: Partial<Record<Stage, { event: MachineEvent["type"]; to: Stage }>> = {
  requested: { event: "local_verified", to: "local_hidden" },
  basin_pending: { event: "logical_accepted", to: "basin_verified" },
  files_cleanup_pending: { event: "physical_accepted", to: "complete" },
};

export function transition(state: MachineState, event: MachineEvent, now: number): Transition {
  const invalid = { ok: false, code: "invalid_transition" } as const;
  const ok = (next: MachineState, code: string): Transition => ({ ok: true, state: next, code });
  const { stage } = state;

  if (event.type === "reopened") {
    if (stage !== "failed" || !state.failedStage) return invalid;
    return ok(
      clean(state, { stage: state.failedStage, failedStage: null, nextAttemptAt: now }),
      "reopened",
    );
  }
  if (!isActive(stage)) return invalid;

  switch (event.type) {
    case "local_verified":
    case "logical_accepted":
    case "physical_accepted": {
      const step = FORWARD[stage];
      if (!step || step.event !== event.type) return invalid;
      return ok(
        clean(state, { stage: step.to, nextAttemptAt: now }),
        event.type === "physical_accepted" ? "complete" : step.to,
      );
    }
    case "settle_scheduled":
      if (stage !== "local_hidden") return invalid;
      return ok(
        clean(state, {
          stage: "basin_pending",
          settleUntil: event.settleUntil,
          nextAttemptAt: event.settleUntil,
        }),
        "settle_scheduled",
      );
    case "cleanup_scheduled":
      if (stage !== "basin_verified") return invalid;
      return ok(
        clean(state, {
          stage: "files_cleanup_pending",
          nextAttemptAt: Math.max(now, event.notBefore),
        }),
        "cleanup_scheduled",
      );
    case "local_residue":
      if (stage !== "requested") return invalid;
      return fail(state, "local_residue", true, now);
    case "step_failed":
      return fail(state, event.code, event.retryable, now);
    case "step_blocked":
      return ok(
        { ...state, lastErrorCode: event.code, nextAttemptAt: now + event.retryAfterMs },
        event.code,
      );
  }
}

function fail(state: MachineState, code: string, retryable: boolean, now: number): Transition {
  const attempts = state.attempts + 1;
  if (!retryable || attempts >= MAX_ATTEMPTS) {
    return {
      ok: true,
      code,
      state: {
        ...state,
        stage: "failed",
        failedStage: state.stage as ActiveStage,
        attempts,
        lastErrorCode: code,
        nextAttemptAt: now,
      },
    };
  }
  return {
    ok: true,
    code,
    state: { ...state, attempts, lastErrorCode: code, nextAttemptAt: now + retryDelay(attempts) },
  };
}
