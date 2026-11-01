import { replay } from "@flightdeckhq/lifecycle";
import type { LifecycleRecord, ProcessDefinitionV1 } from "@flightdeckhq/schema";
import { describe, expect, it } from "vitest";
import { adaptCase } from "../src/lifecycle-projection/adapter";
import { segments, servingId, toSnapshot } from "../src/lifecycle-projection/snapshot";

/** Pure adapter + mapper tests: wire records for one case -> engine -> served snapshot. */

const T = Date.UTC(2026, 5, 1, 9);
const MIN = 60_000;
const DEPLOY: ProcessDefinitionV1 = {
  schemaVersion: 1,
  processId: "deploy",
  version: 1,
  name: "Deploy",
  caseType: "deploy",
  stages: [
    { stageId: "build", name: "Build" },
    { stageId: "canary", name: "Canary" },
    { stageId: "completed", name: "Shipped", terminal: true },
    { stageId: "done", name: "Done", terminal: true },
  ],
  dimensions: [{ key: "outcome", values: ["shipped", "rolled_back"] }],
  relations: [
    { type: "child_of", objectType: "case" },
    { type: "blocks", objectType: "case" },
    { type: "built_from", objectType: "commit" },
  ],
};
const DEFINITIONS = new Map([["deploy@1", DEPLOY]]);

let seq = 0;
/** A stored record; `id` defaults so that event ids sort OPPOSITE to sequence order. */
function rec(type: LifecycleRecord["type"], over: Partial<LifecycleRecord> = {}): LifecycleRecord {
  seq += 1;
  return {
    event_id: `evt_${String(1000 - seq).padStart(4, "0")}`,
    app_id: "app_adapter",
    schema_version: 1,
    process_id: "deploy",
    process_version: 1,
    type,
    case_id: "deploy:web:42",
    stage_id: null,
    stage_instance_id: null,
    occurred_at: T,
    received_at: T,
    source: "deploy-bot",
    source_sequence: seq,
    reason: null,
    object_type: null,
    object_id: null,
    relations: null,
    dimensions: null,
    corrects_event_id: null,
    correction: null,
    channel: "binding",
    ...over,
  };
}
const stage = (type: LifecycleRecord["type"], stageId: string, instance: string, over = {}) =>
  rec(type, { stage_id: stageId, stage_instance_id: instance, ...over });

async function project(records: LifecycleRecord[], asOf = T + 60 * MIN) {
  const adapted = adaptCase("deploy:web:42", records, DEFINITIONS, asOf);
  if (!adapted.facts) throw new Error("not adapted");
  const result = replay(adapted.input);
  return { ...(await toSnapshot(result, adapted.facts, adapted.issues)), result, adapted };
}

describe("same-millisecond ordering uses the per-case sequence, never event ids", () => {
  it("case start, stage enter, stage exit, next enter and terminate at one instant", async () => {
    seq = 0;
    const records = [
      rec("case.started"),
      stage("stage.entered", "build", "si_build"),
      stage("stage.exited", "build", "si_build", { reason: "passed" }),
      stage("stage.entered", "canary", "si_canary"),
      stage("stage.exited", "canary", "si_canary"),
      rec("case.completed", { dimensions: { outcome: "shipped" } }),
    ];
    // Event ids sort in exactly the reverse order; delivery order is shuffled too.
    const { snapshot, diagnostics } = await project([...records].reverse());
    expect(snapshot).toMatchObject({
      status: "closed",
      outcome: "shipped",
      started_at: T,
      ended_at: T,
    });
    expect(snapshot?.intervals.map((i) => [i.stage_key, i.exited_at, i.outcome ?? null])).toEqual([
      ["build", T, "passed"],
      ["canary", T, null],
    ]);
    expect([...diagnostics.keys()]).not.toContain("invalid_transition");
    expect([...diagnostics.keys()]).not.toContain("ambiguous_order");
  });

  it("orders a same-instant pause, resume, pause only by the producer's sequence", async () => {
    seq = 0;
    const at = T + MIN;
    const { result, diagnostics } = await project([
      rec("case.started"),
      rec("case.paused", { occurred_at: at }),
      rec("case.resumed", { occurred_at: at }),
      rec("case.paused", { occurred_at: at }),
    ]);
    expect(result.cases[0]?.status).toBe("paused");
    expect(diagnostics.get("ambiguous_order")).toBeUndefined();
    expect(diagnostics.get("invalid_transition")).toBeUndefined();
  });
});

describe("terminal stages", () => {
  it("closes the case when a classified terminal stage is entered, outcome = stage", async () => {
    seq = 0;
    const { snapshot } = await project([
      rec("case.started"),
      stage("stage.entered", "build", "si_b", { occurred_at: T }),
      stage("stage.exited", "build", "si_b", { occurred_at: T + 5 * MIN }),
      stage("stage.entered", "completed", "si_c", { occurred_at: T + 5 * MIN }),
    ]);
    expect(snapshot).toMatchObject({
      status: "closed",
      outcome: "completed",
      ended_at: T + 5 * MIN,
      current_stage: null,
    });
    expect(snapshot?.intervals.at(-1)).toMatchObject({
      stage_key: "completed",
      entered_at: T + 5 * MIN,
      exited_at: T + 5 * MIN,
    });
  });

  it("reports an unclassified terminal stage instead of inferring an outcome", async () => {
    seq = 0;
    const { snapshot, diagnostics } = await project([
      rec("case.started"),
      stage("stage.entered", "done", "si_d", { occurred_at: T + MIN }),
    ]);
    expect(snapshot?.status).toBe("open");
    expect(diagnostics.get("terminal_stage_unclassified")).toBe(1);
  });
});

describe("terminal outcomes", () => {
  it("needs an explicit terminal class on case.terminated", async () => {
    seq = 0;
    const { snapshot, diagnostics } = await project([
      rec("case.started"),
      rec("case.terminated", { reason: "oops", occurred_at: T + MIN }),
    ]);
    expect(snapshot?.status).toBe("open");
    expect(diagnostics.get("missing_terminal_class")).toBe(1);
    seq = 0;
    const ok = await project([
      rec("case.started"),
      rec("case.terminated", {
        reason: "failed",
        occurred_at: T + MIN,
        dimensions: { outcome: "rolled_back" },
      }),
    ]);
    expect(ok.snapshot).toMatchObject({ status: "closed", outcome: "rolled_back" });
  });
});

describe("corrections", () => {
  it("retract removes the target; amend moves it; unknown targets are reported", async () => {
    seq = 0;
    const start = rec("case.started");
    const exitWrong = stage("stage.exited", "build", "si_b", { occurred_at: T + 90 * MIN });
    const enter = stage("stage.entered", "build", "si_b", { occurred_at: T + MIN });
    const complete = rec("case.completed", { occurred_at: T + 10 * MIN });
    const retract = rec("event.corrected", {
      corrects_event_id: complete.event_id,
      correction: { action: "retract" },
    });
    const amend = rec("event.corrected", {
      corrects_event_id: exitWrong.event_id,
      correction: { action: "amend", occurred_at: T + 9 * MIN },
    });
    const dangling = rec("event.corrected", {
      corrects_event_id: "evt_never_seen",
      correction: { action: "retract" },
    });
    const { snapshot, diagnostics } = await project(
      [dangling, amend, retract, complete, exitWrong, enter, start],
      T + 120 * MIN,
    );
    expect(snapshot?.status).toBe("open");
    expect(snapshot?.intervals).toEqual([
      {
        stage_key: "build",
        state: "active",
        entered_at: T + MIN,
        exited_at: T + 9 * MIN,
        outcome: null,
      },
    ]);
    expect(diagnostics.get("correction_target_missing")).toBe(1);
  });

  it("excludes both copies of a reused event id and reports the conflict", async () => {
    seq = 0;
    const start = rec("case.started");
    const enter = stage("stage.entered", "build", "si_b", { occurred_at: T + MIN });
    const conflicting = { ...enter, occurred_at: T + 2 * MIN };
    const { snapshot, diagnostics } = await project([start, enter, conflicting]);
    expect(snapshot?.intervals).toEqual([]);
    expect(diagnostics.get("duplicate_conflict")).toBe(1);
  });
});

describe("relations", () => {
  it("serves the parent and case edges; object relations are counted, not served", async () => {
    seq = 0;
    const { snapshot, diagnostics } = await project([
      rec("case.started", {
        relations: [
          { type: "child_of", object_type: "case", object_id: "release:2026-06" },
          { type: "blocks", object_type: "case", object_id: "deploy_api_7" },
          { type: "built_from", object_type: "commit", object_id: "c0ffee" },
        ],
      }),
      // Repeating a relation is an assertion of the same relation, not a second link.
      stage("stage.entered", "build", "si_b", {
        occurred_at: T + MIN,
        relations: [{ type: "blocks", object_type: "case", object_id: "deploy_api_7" }],
      }),
    ]);
    expect(snapshot?.parent_case_id).toBe(await servingId("release:2026-06"));
    expect(snapshot?.relations).toEqual([{ relation: "blocks", to_case_id: "deploy_api_7" }]);
    expect(diagnostics.get("object_relation_not_served")).toBe(1);
    expect(diagnostics.get("invalid_transition")).toBeUndefined();
  });

  it("maps producer ids that do not fit the serving id shape to stable opaque ids", async () => {
    expect(await servingId("deploy_api_7")).toBe("deploy_api_7");
    const hashed = await servingId("deploy:web:42");
    expect(hashed).toMatch(/^x-[A-Za-z0-9_-]{43}$/);
    expect(await servingId("deploy:web:42")).toBe(hashed);
  });
});

describe("stage segmentation", () => {
  it("splits an attempt into active, blocked and paused segments; pauses win", () => {
    const at = (m: number) => T + m * MIN;
    const result = segments(
      {
        id: "si" as never,
        caseId: "c" as never,
        stageId: "build" as never,
        status: "closed",
        episodeIndex: 0,
        enteredAt: at(0),
        exitedAt: at(60),
        blocked: [{ start: at(10), end: at(30) }],
        paused: [],
        timingComplete: true,
      },
      [{ start: at(20), end: at(40) }],
      "passed",
      () => {
        throw new Error("no unknown boundaries here");
      },
    );
    expect(result.map((s) => [s.state, s.entered_at - T, (s.exited_at ?? 0) - T])).toEqual([
      ["active", 0, 10 * MIN],
      ["blocked", 10 * MIN, 20 * MIN],
      ["paused", 20 * MIN, 40 * MIN],
      ["active", 40 * MIN, 60 * MIN],
    ]);
    expect(result.at(-1)?.outcome).toBe("passed");
  });
});
