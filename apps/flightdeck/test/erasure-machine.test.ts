import { describe, expect, it } from "vitest";
import {
  MAX_ATTEMPTS,
  type MachineEvent,
  type MachineState,
  retryDelay,
  STAGES,
  type Stage,
  transition,
} from "../src/lifecycle-erasure/machine";

const NOW = 1_800_000_000_000;
const at = (stage: Stage, patch: Partial<MachineState> = {}): MachineState => ({
  stage,
  failedStage: stage === "failed" ? "basin_pending" : null,
  attempts: 0,
  nextAttemptAt: NOW,
  lastErrorCode: null,
  settleUntil: null,
  ...patch,
});

const EVENTS: MachineEvent[] = [
  { type: "local_verified" },
  { type: "local_residue" },
  { type: "settle_scheduled", settleUntil: NOW + 1 },
  { type: "logical_accepted" },
  { type: "cleanup_scheduled", notBefore: NOW },
  { type: "physical_accepted" },
  { type: "step_failed", code: "x", retryable: true },
  { type: "step_blocked", code: "executor_unconfigured", retryAfterMs: 1000 },
  { type: "reopened" },
];

/** The only (stage, event) pairs that may change a job's stage. */
const ALLOWED: Record<string, Stage> = {
  "requested/local_verified": "local_hidden",
  "local_hidden/settle_scheduled": "basin_pending",
  "basin_pending/logical_accepted": "basin_verified",
  "basin_verified/cleanup_scheduled": "files_cleanup_pending",
  "files_cleanup_pending/physical_accepted": "complete",
  "failed/reopened": "basin_pending",
};

describe("erasure state machine", () => {
  it("reaches complete only through every stage, in order", () => {
    let s = at("requested");
    const path: [MachineEvent, Stage][] = [
      [{ type: "local_verified" }, "local_hidden"],
      [{ type: "settle_scheduled", settleUntil: NOW + 900_000 }, "basin_pending"],
      [{ type: "logical_accepted" }, "basin_verified"],
      [{ type: "cleanup_scheduled", notBefore: NOW + 3_600_000 }, "files_cleanup_pending"],
      [{ type: "physical_accepted" }, "complete"],
    ];
    for (const [event, stage] of path) {
      const t = transition(s, event, NOW);
      expect(t.ok).toBe(true);
      if (t.ok) s = t.state;
      expect(s.stage).toBe(stage);
    }
  });

  it("changes stage only along the allowed edges; everything else is an invalid no-op", () => {
    for (const stage of STAGES) {
      for (const event of EVENTS) {
        const t = transition(at(stage), event, NOW);
        const key = `${stage}/${event.type}`;
        if (key in ALLOWED) {
          expect(t.ok && t.state.stage, key).toBe(ALLOWED[key]);
        } else if (t.ok) {
          // Retry/blocked/residue keep the stage (or fail it); they never advance it.
          expect(
            [
              "requested",
              "local_hidden",
              "basin_pending",
              "basin_verified",
              "files_cleanup_pending",
              "failed",
            ],
            key,
          ).toContain(t.state.stage);
          expect(t.state.stage === stage || t.state.stage === "failed", key).toBe(true);
        } else {
          expect(t.code).toBe("invalid_transition");
        }
      }
    }
  });

  it("complete is absorbing and only physical_accepted from files_cleanup_pending reaches it", () => {
    for (const stage of STAGES) {
      for (const event of EVENTS) {
        const t = transition(at(stage), event, NOW);
        if (t.ok && t.state.stage === "complete") {
          expect(`${stage}/${event.type}`).toBe("files_cleanup_pending/physical_accepted");
        }
        if (stage === "complete") expect(t.ok).toBe(false);
      }
    }
  });

  it("logical acceptance is not completion", () => {
    const t = transition(at("basin_pending"), { type: "logical_accepted" }, NOW);
    expect(t.ok && t.state.stage).toBe("basin_verified");
  });

  it("backs off exponentially, capped, and fails after the attempt budget", () => {
    expect(retryDelay(1)).toBe(60_000);
    expect(retryDelay(2)).toBe(120_000);
    expect(retryDelay(50)).toBe(6 * 3_600_000);
    let s = at("basin_pending");
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const t = transition(s, { type: "step_failed", code: "send_failed", retryable: true }, NOW);
      expect(t.ok && t.state.stage).toBe("basin_pending");
      if (t.ok) {
        expect(t.state.attempts).toBe(i);
        expect(t.state.nextAttemptAt).toBe(NOW + retryDelay(i));
        s = t.state;
      }
    }
    const last = transition(s, { type: "step_failed", code: "send_failed", retryable: true }, NOW);
    expect(last.ok && last.state).toMatchObject({ stage: "failed", failedStage: "basin_pending" });
  });

  it("fails at once on a non-retryable error, and reopen resumes the failed stage", () => {
    const failed = transition(
      at("files_cleanup_pending"),
      { type: "step_failed", code: "bad", retryable: false },
      NOW,
    );
    expect(failed.ok && failed.state).toMatchObject({
      stage: "failed",
      failedStage: "files_cleanup_pending",
    });
    if (!failed.ok) return;
    const reopened = transition(failed.state, { type: "reopened" }, NOW + 5);
    expect(reopened.ok && reopened.state).toMatchObject({
      stage: "files_cleanup_pending",
      failedStage: null,
      attempts: 0,
      nextAttemptAt: NOW + 5,
    });
  });

  it("a missing executor blocks without spending attempts", () => {
    const t = transition(
      at("basin_pending", { attempts: 3 }),
      { type: "step_blocked", code: "executor_unconfigured", retryAfterMs: 3_600_000 },
      NOW,
    );
    expect(t.ok && t.state).toMatchObject({
      stage: "basin_pending",
      attempts: 3,
      lastErrorCode: "executor_unconfigured",
      nextAttemptAt: NOW + 3_600_000,
    });
  });
});
