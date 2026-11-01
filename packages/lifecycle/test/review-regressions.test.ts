import { describe, expect, it } from "vitest";
import { caseMetrics, id, replay, stageMetrics, summarize } from "../src/index.js";
import {
  caseId,
  enter,
  event,
  exit,
  first,
  fixture,
  instance,
  processId,
  second,
  start,
  terminate,
} from "./fixtures.js";

const b = id<"stage-instance">("attempt-b");
function sequential() {
  const input = fixture();
  return {
    ...input,
    definitions: [
      {
        id: processId,
        stages: [{ id: first }, { id: second }],
        initialStages: [first],
        transitions: [{ from: first, to: second }],
      },
    ],
    stageInstances: [...input.stageInstances, { id: b, caseId, stageId: second }],
  };
}

describe("P1 equal-time causal boundaries", () => {
  it.each([false, true])(
    "does not let event IDs discard same-time boundaries (reverse=%s)",
    (reverse) => {
      const input = sequential();
      const events = [
        { ...start(0), id: id<"event">("z-start") },
        { ...enter(0), id: id<"event">("a-enter") },
        { ...exit(10), id: id<"event">("z-exit-a") },
        { ...enter(10, b), id: id<"event">("a-enter-b") },
        { ...exit(20, b), id: id<"event">("z-final-exit") },
        { ...terminate(20), id: id<"event">("a-terminate") },
      ];
      const result = replay({ ...input, events: reverse ? events.reverse() : events });
      expect(result.visits.map((v) => v.stageId)).toEqual([first, second]);
      expect(result.stageInstances.every((s) => s.timingComplete)).toBe(true);
      expect(summarize(result)).toMatchObject({ unknown: 0, openCensored: 0 });
      expect(stageMetrics(result, b).wallClockMs).toBe(10);
    },
  );
});

describe("P2 missing correction evidence and distributions", () => {
  it("does not age a stage or case confidently when a replacement target is missing", () => {
    const result = replay(
      fixture([
        start(),
        enter(),
        event("replacement", 40, {
          type: "stage.exit",
          stageInstanceId: instance,
          supersedes: id<"event">("lost"),
        }),
      ]),
    );
    expect(result.stageInstances[0]?.timingComplete).toBe(false);
    expect(stageMetrics(result, instance)).toMatchObject({
      activeAgeMs: null,
      openCensored: false,
    });
    expect(caseMetrics(result, caseId)).toMatchObject({
      openDurationMs: null,
      openCensored: false,
    });
    expect(summarize(result)).toMatchObject({ unknown: 1, openCensored: 0 });
  });

  it("excludes incomplete stages and their cases from closed duration distributions", () => {
    const original = exit(70);
    const result = replay(
      fixture([
        start(),
        enter(),
        original,
        terminate(),
        event("c1", 20, { type: "stage.exit", stageInstanceId: instance, supersedes: original.id }),
        event("c2", 30, { type: "stage.exit", stageInstanceId: instance, supersedes: original.id }),
      ]),
    );
    expect(summarize(result)).toMatchObject({
      unknown: 1,
      closedCaseDuration: { samples: 0, p50: null },
    });
    expect(summarize(result).stages[0]).toMatchObject({
      unknown: 1,
      closedDwell: { samples: 0, p50: null },
    });
  });
});

it("closes raw stage interruptions at explicit exit", () => {
  const result = replay(
    fixture([
      start(),
      enter(),
      event("block", 20, {
        type: "stage.block",
        stageInstanceId: instance,
        interruptionId: "wait",
      }),
      exit(40),
    ]),
  );
  expect(result.stageInstances[0]?.blocked).toEqual([{ start: 20, end: 40 }]);
});

it("does not generate cross-case ordering noise at the same timestamp", () => {
  const other = id<"case">("other");
  const result = replay({
    ...fixture([start(0), start(0, other)]),
    stageInstances: [],
    cases: [
      { id: caseId, processId },
      { id: other, processId },
    ],
  });
  expect(result.diagnostics).toEqual([]);
});

it("bounds raw stage pauses and blocks at case termination, without inventing a stage exit", () => {
  const result = replay(
    fixture([
      start(),
      enter(),
      event("block", 20, {
        type: "stage.block",
        stageInstanceId: instance,
        interruptionId: "wait",
      }),
      event("pause", 25, {
        type: "stage.pause",
        stageInstanceId: instance,
        interruptionId: "window",
      }),
      terminate(40),
    ]),
  );
  expect(result.stageInstances[0]).toMatchObject({
    exitedAt: null,
    blocked: [{ start: 20, end: 40 }],
    paused: [{ start: 25, end: 40 }],
  });
});

it("restricts transitions to latest predecessor within a branch and episode", () => {
  const third = id<"stage">("third");
  const c = id<"stage-instance">("attempt-c");
  const again = id<"stage-instance">("attempt-b-again");
  const input = sequential();
  const result = replay({
    ...input,
    definitions: [
      {
        id: processId,
        stages: [{ id: first }, { id: second }, { id: third }],
        initialStages: [first],
        transitions: [
          { from: first, to: second },
          { from: second, to: third },
          { from: third, to: first },
        ],
      },
    ],
    stageInstances: [
      ...input.stageInstances,
      { id: c, caseId, stageId: third },
      { id: again, caseId, stageId: second },
    ],
    events: [
      start(),
      enter(1),
      exit(2),
      enter(3, b),
      exit(4, b),
      enter(5, c),
      exit(6, c),
      enter(7, again),
    ],
  });
  expect(result.visits.map((v) => v.stageId)).toEqual([first, second, third]);
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "invalid_transition", eventId: `enter:${again}` }),
  );
  const reopened = replay({
    ...input,
    events: [
      start(),
      enter(1),
      exit(2),
      terminate(3),
      event("reopen", 4, { type: "case.reopen", caseId }),
      enter(5, b),
    ],
  });
  expect(reopened.stageInstances.find((s) => s.id === b)?.status).toBe("unknown");
});

it("supports explicit parallel branch frontiers without borrowing exits", () => {
  const third = id<"stage">("third");
  const fourth = id<"stage">("fourth");
  const c = id<"stage-instance">("attempt-c");
  const d = id<"stage-instance">("attempt-d");
  const data = sequential();
  const result = replay({
    ...data,
    definitions: [
      {
        id: processId,
        stages: [{ id: first }, { id: second }, { id: third }, { id: fourth }],
        initialStages: [first, third],
        transitions: [
          { from: first, to: second },
          { from: third, to: fourth },
        ],
      },
    ],
    stageInstances: [
      { id: instance, caseId, stageId: first, branchId: "left" },
      { id: b, caseId, stageId: second, branchId: "left" },
      { id: c, caseId, stageId: third, branchId: "right" },
      { id: d, caseId, stageId: fourth, branchId: "right" },
    ],
    events: [
      start(),
      enter(1),
      enter(2, c),
      exit(3),
      exit(4, c),
      enter(5, b),
      enter(6, d),
      exit(7, b),
      exit(8, d),
    ],
  });
  expect(result.diagnostics).toEqual([]);
  expect(result.visits.map((v) => v.stageId)).toEqual([first, third, second, fourth]);
});

it("rejects constrained definitions without initial stages and enforces standalone initialStages", () => {
  const input = sequential();
  expect(
    replay({
      ...input,
      definitions: input.definitions.map((d) => ({ ...d, initialStages: undefined })),
    }).diagnostics,
  ).toContainEqual(expect.objectContaining({ code: "invalid_definition" }));
  const result = replay({
    ...input,
    definitions: input.definitions.map((d) => ({ ...d, transitions: [] })),
    events: [start(), enter(1, b)],
  });
  expect(result.visits).toEqual([]);
});

it("rejects subject-changing amendments and retains uncertain original evidence", () => {
  const input = sequential();
  const old = exit(20);
  const result = replay({
    ...input,
    events: [
      start(),
      enter(),
      old,
      event("mutated", 30, { type: "stage.exit", stageInstanceId: b, supersedes: old.id }),
    ],
  });
  expect(result.events.map((e) => e.id)).toContain(old.id);
  expect(result.events.map((e) => e.id)).not.toContain("mutated");
  expect(result.uncertainEventIds).toEqual(expect.arrayContaining([old.id, "mutated"]));
  expect(result.stageInstances.find((s) => s.id === instance)?.timingComplete).toBe(false);
});

it("supports hierarchy cohorts across case totals, funnels and distributions", async () => {
  const { selectCases, funnel } = await import("../src/index.js");
  const child = id<"case">("child");
  const childAttempt = id<"stage-instance">("child-attempt");
  const data = fixture();
  const input = {
    ...data,
    cases: [...data.cases, { id: child, processId }],
    stageInstances: [...data.stageInstances, { id: childAttempt, caseId: child, stageId: first }],
    events: [
      start(),
      start(1, child),
      enter(2),
      enter(3, childAttempt),
      exit(4),
      exit(5, childAttempt),
      event("link", 1, { type: "child.link" as const, caseId, childCaseId: child }),
      event("end-parent", 10, {
        type: "case.terminate" as const,
        caseId,
        terminal: "rejected" as const,
      }),
      terminate(20, child),
      event("unlink", 30, { type: "child.unlink" as const, caseId, childCaseId: child }),
    ],
  };
  const result = replay(input);
  expect(summarize(result)).toMatchObject({ cases: 2, completionRatio: 0.5 });
  expect(summarize(result, { hierarchy: "roots" })).toMatchObject({ cases: 1, completionRatio: 0 });
  expect(selectCases(result, { hierarchy: "children" }).map((c) => c.id)).toEqual([child]);
  expect(funnel(result, [first], { cohort: { hierarchy: "roots" } })[0]?.reached).toBe(1);
});

it("supports reliable case-wide sequences across differently named producers", () => {
  const events = [
    { ...start(0), id: id<"event">("z"), source: { id: "z-producer", sequence: 1 } },
    { ...enter(0), id: id<"event">("a"), source: { id: "a-producer", sequence: 2 } },
    { ...exit(20), source: { id: "z-producer", sequence: 3 } },
  ];
  const result = replay({ ...fixture(events), reliableCases: [caseId] });
  expect(result.events.map((e) => e.source.sequence)).toEqual([1, 2, 3]);
  expect(result.diagnostics).toEqual([]);
  const contradicting = replay({
    ...fixture(
      events.map((e) =>
        e.type === "stage.exit" ? { ...e, source: { id: "z-producer", sequence: 0 } } : e,
      ),
    ),
    reliableCases: [caseId],
  });
  expect(contradicting.diagnostics.some((d) => d.code === "sequence_time_conflict")).toBe(true);
});

it("sanitizes diagnostic IDs/text at the presentation boundary", async () => {
  const { sanitizeDiagnostics } = await import("../src/index.js");
  const raw = [
    {
      code: "missing_reference" as const,
      subject: "person@example.com\nforged-log",
      eventId: id<"event">("<script>"),
      message: "secret",
    },
  ];
  const safe = JSON.stringify(sanitizeDiagnostics(raw));
  for (const unsafe of ["person@", "forged-log", "<script>", "secret"])
    expect(safe).not.toContain(unsafe);
  expect(raw[0]?.message).toBe("secret");
});

it("does not discard chronological evidence for invalid untrusted sequence metadata", () => {
  const result = replay(
    fixture([start(), { ...enter(), source: { id: "untrusted", sequence: -1 } }, exit()]),
  );
  expect(result.stageInstances[0]?.status).toBe("closed");
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "invalid_sequence" }));
});

it("orders predecessor exit before a terminal marker even in an unrestricted process", () => {
  const data = fixture();
  const result = replay({
    ...data,
    definitions: [
      { id: processId, stages: [{ id: first }, { id: second, terminal: "completed" }] },
    ],
    stageInstances: [...data.stageInstances, { id: b, caseId, stageId: second }],
    events: [
      start(),
      enter(1),
      { ...exit(20), id: id<"event">("z-exit") },
      { ...enter(20, b), id: id<"event">("a-terminal") },
    ],
  });
  expect(result.diagnostics).toEqual([]);
  expect(summarize(result)).toMatchObject({ completionRatio: 1, unknown: 0 });
});

it("retains valid zero-duration enter/exit/termination, without an ambiguity warning", () => {
  const result = replay(
    fixture([
      { ...start(0), id: id<"event">("z") },
      { ...enter(0), id: id<"event">("c") },
      { ...exit(0), id: id<"event">("b") },
      { ...terminate(0), id: id<"event">("a") },
    ]),
  );
  expect(result.diagnostics).toEqual([]);
  expect(stageMetrics(result, instance).wallClockMs).toBe(0);
  expect(caseMetrics(result, caseId).openDurationMs).toBe(0);
});

it("marks a case with a missing case-correction target as unknown, not open-aged", () => {
  const result = replay({
    ...fixture([
      start(),
      event("corrected-case-end", 30, {
        type: "case.terminate",
        caseId,
        terminal: "completed",
        supersedes: id<"event">("missing"),
      }),
    ]),
    stageInstances: [],
  });
  expect(caseMetrics(result, caseId)).toMatchObject({ openDurationMs: null, openCensored: false });
  expect(summarize(result)).toMatchObject({ unknown: 1, openCensored: 0 });
});

it("excludes incomplete evidence from funnel and completion denominators", async () => {
  const { funnel } = await import("../src/index.js");
  const result = replay({
    ...fixture([start(), enter(), exit(), terminate()]),
    cases: [{ id: caseId, processId, historyComplete: false }],
  });
  expect(funnel(result, [first, second])[0]).toMatchObject({
    reached: 1,
    unknown: 1,
    denominator: 0,
    conversion: null,
  });
  expect(summarize(result)).toMatchObject({
    terminal: { completed: 1 },
    completionRatio: null,
    completionDenominator: 0,
    completionUnknown: 1,
  });
});

it("keeps all same-time boundaries valid under every pair of lexicographic ID orders", () => {
  for (let mask = 0; mask < 8; mask++) {
    const input = sequential();
    const events = [start(0), enter(0), exit(10), enter(10, b), exit(20, b), terminate(20)].map(
      (e, i) => ({
        ...e,
        id: id<"event">(
          `${Math.floor(i / 2)}:${mask & (1 << Math.floor(i / 2)) ? 1 - (i % 2) : i % 2}`,
        ),
      }),
    );
    const result = replay({ ...input, events: events.reverse() });
    expect(result.diagnostics).toEqual([]);
    expect(result.visits.map((v) => v.stageId)).toEqual([first, second]);
    expect(summarize(result).unknown).toBe(0);
  }
});
