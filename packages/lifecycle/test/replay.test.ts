import { describe, expect, it } from "vitest";
import { caseMetrics, id, replay, stageMetrics, terminalClasses } from "../src/index.js";
import {
  caseId,
  enter,
  event,
  exit,
  first,
  fixture,
  hiring,
  incident,
  instance,
  processId,
  rollout,
  second,
  start,
  terminate,
} from "./fixtures.js";

const codes = (data: ReturnType<typeof replay>) => data.diagnostics.map((d) => d.code);

describe("deterministic full-log replay", () => {
  it.each([hiring, rollout, incident])(
    "replays domain fixtures, shuffled and duplicated, without mutating input",
    (make) => {
      const input = make();
      const before = JSON.stringify(input);
      const expected = replay(input);
      for (let offset = 0; offset < input.events.length; offset++) {
        const shuffled = [
          ...input.events.slice(offset),
          ...input.events.slice(0, offset),
        ].reverse();
        expect(replay({ ...input, events: [...shuffled, ...shuffled] })).toEqual(expected);
      }
      expect(JSON.stringify(input)).toBe(before);
      expect(replay(input)).toEqual(expected);
      expect(expected.diagnostics).toEqual([]);
    },
  );

  it("inserts a late exit and reconstructs state rather than incrementing metrics", () => {
    const input = fixture([start(), enter(), terminate()]);
    expect(stageMetrics(replay(input), instance).wallClockMs).toBeNull();
    const complete = replay({ ...input, events: [...input.events, exit(40)] });
    expect(stageMetrics(complete, instance).wallClockMs).toBe(30);
    expect(complete.stageInstances[0]?.status).toBe("closed");
  });

  it("uses reliable sequence for equal times and reports chronological contradictions", () => {
    const input = fixture([
      event("z", 0, { type: "case.start", caseId }, 1),
      event("a", 0, { type: "stage.enter", stageInstanceId: instance }, 2),
      event("exit", 50, { type: "stage.exit", stageInstanceId: instance }, 0),
    ]);
    const result = replay({ ...input, reliableSources: ["fixture"] });
    expect(result.events.map((e) => e.id)).toEqual(["z", "a", "exit"]);
    expect(codes(result)).toContain("sequence_time_conflict");
    expect(codes(result)).not.toContain("ambiguous_order");
    expect(stageMetrics(result, instance).wallClockMs).toBe(50);
  });

  it("uses lifecycle prerequisites for equal timestamps, independent of arrival order", () => {
    const input = fixture([start(), enter(0)]);
    const result = replay(input);
    expect(codes(result)).not.toContain("ambiguous_order");
    expect(replay({ ...input, events: [...input.events].reverse() })).toEqual(result);
  });

  it("excludes conflicting duplicate IDs instead of choosing an arrival-order winner", () => {
    const input = fixture([start(), enter(), { ...enter(), occurredAt: 20 }]);
    const result = replay(input);
    expect(codes(result)).toContain("duplicate_conflict");
    expect(stageMetrics(result, instance).wallClockMs).toBeNull();
  });

  it("ignores invalid event times and sequences; validates asOf", () => {
    const input = fixture([
      start(),
      enter(Number.NaN),
      { ...exit(), source: { id: "bad", sequence: -1 } },
    ]);
    expect(codes(replay(input))).toEqual(
      expect.arrayContaining(["invalid_time", "invalid_sequence"]),
    );
    expect(() => replay({ ...input, asOf: Infinity })).toThrow();
  });

  it("only replays occurrence times at/before asOf", () => {
    const result = replay({ ...fixture([start(), enter(), exit(60)]), asOf: 30 });
    expect(result.stageInstances[0]?.status).toBe("open");
    expect(stageMetrics(result, instance).wallClockMs).toBe(20);
  });
});

describe("corrections and superseded events", () => {
  it("replaces the old occurrence and chains corrections, including late insertion", () => {
    const old = exit(70);
    const replacement = event("corrected", 40, {
      type: "stage.exit",
      stageInstanceId: instance,
      supersedes: old.id,
    });
    const latest = event("corrected-again", 45, {
      type: "stage.exit",
      stageInstanceId: instance,
      supersedes: replacement.id,
    });
    const input = fixture([start(), enter(), old, terminate(), replacement, latest]);
    const result = replay(input);
    expect(stageMetrics(result, instance).wallClockMs).toBe(35);
    expect(result.supersededEventIds).toEqual([replacement.id, old.id].sort());
    expect(result.events.map((e) => e.id)).not.toContain(old.id);
    expect(replay({ ...input, events: [...input.events].reverse() })).toEqual(result);
  });

  it("retracts an event without inferring a replacement", () => {
    const old = exit();
    const result = replay(
      fixture([
        start(),
        enter(),
        old,
        event("retracted", 80, { type: "event.retract", supersedes: old.id }),
      ]),
    );
    expect(result.stageInstances[0]?.status).toBe("open");
    expect(result.events.map((e) => e.id)).not.toContain(old.id);
  });

  it("reports missing correction targets, competing replacements and cycles", () => {
    const old = exit();
    const input = fixture([
      start(),
      enter(),
      old,
      event("c1", 30, { type: "stage.exit", stageInstanceId: instance, supersedes: old.id }),
      event("c2", 40, { type: "stage.exit", stageInstanceId: instance, supersedes: old.id }),
      event("missing", 1, { type: "event.retract", supersedes: id<"event">("absent") }),
      event("cycle1", 2, { type: "event.retract", supersedes: id<"event">("cycle2") }),
      event("cycle2", 3, { type: "event.retract", supersedes: id<"event">("cycle1") }),
    ]);
    const result = replay(input);
    expect(codes(result)).toEqual(
      expect.arrayContaining(["correction_conflict", "missing_reference", "cycle"]),
    );
    expect(stageMetrics(result, instance).wallClockMs).toBe(40);
  });
});

describe("lifecycle consistency", () => {
  it.each(terminalClasses)("keeps explicit %s terminal outcome", (terminal) => {
    const result = replay(
      fixture([start(), event("terminal", 90, { type: "case.terminate", caseId, terminal })]),
    );
    expect(result.cases[0]?.terminal).toBe(terminal);
    expect(caseMetrics(result, caseId).openDurationMs).toBe(90);
  });

  it("never derives terminal outcomes from stage exits, skips, or absent events", () => {
    const result = replay(fixture([start(), enter(), exit()]));
    expect(result.cases[0]?.status).toBe("open");
    expect(result.cases[0]?.terminal).toBeNull();
    expect(stageMetrics(replay(fixture()), instance).wallClockMs).toBeNull();
    const skipped = replay(
      fixture([start(), event("skip", 20, { type: "stage.skip", stageInstanceId: instance })]),
    );
    expect(skipped.stageInstances[0]?.status).toBe("skipped");
    expect(stageMetrics(skipped, instance).wallClockMs).toBeNull();
  });

  it("treats exit-before-entry as unknown instead of a negative duration", () => {
    const result = replay(fixture([start(), exit(5), enter(10)]));
    expect(codes(result)).toContain("missing_boundary");
    expect(codes(result)).toContain("invalid_transition");
    expect(stageMetrics(result, instance).wallClockMs).toBeNull();
  });

  it("retains termination without a start, with unknown duration", () => {
    const result = replay(fixture([terminate()]));
    expect(result.cases[0]?.terminal).toBe("completed");
    expect(caseMetrics(result, caseId).spanMs).toBeNull();
  });

  it("supports reopen episodes without charging the closed gap as open duration", () => {
    const result = replay(
      fixture([
        start(),
        terminate(20),
        event("reopen", 50, { type: "case.reopen", caseId }),
        event("final", 80, { type: "case.terminate", caseId, terminal: "cancelled" }),
      ]),
    );
    expect(caseMetrics(result, caseId)).toMatchObject({
      spanMs: 80,
      openDurationMs: 50,
      openCensored: false,
    });
    expect(result.cases[0]?.terminal).toBe("cancelled");
  });

  it("does not resurrect unclosed stage instances after reopening", () => {
    const result = replay(
      fixture([
        start(),
        enter(),
        terminate(20),
        event("reopen", 50, { type: "case.reopen", caseId }),
      ]),
    );
    expect(stageMetrics(result, instance).wallClockMs).toBeNull();
    expect(codes(result)).toContain("missing_boundary");
  });

  it("diagnoses invalid reopen, stage re-entry and terminated case entry", () => {
    const result = replay(
      fixture([
        start(),
        event("reopen", 5, { type: "case.reopen", caseId }),
        enter(),
        exit(),
        event("repeat", 55, { type: "stage.enter", stageInstanceId: instance }),
      ]),
    );
    expect(codes(result).filter((c) => c === "invalid_transition")).toHaveLength(2);
    const closed = replay(fixture([start(), terminate(5), enter()]));
    expect(codes(closed)).toContain("invalid_transition");
  });

  it("checks explicit predecessor rules and allows intentional retry cycles in definitions", () => {
    const data = hiring();
    const definitions = [
      {
        id: processId,
        stages: [{ id: first }, { id: second }],
        initialStages: [first],
        transitions: [
          { from: first, to: first },
          { from: first, to: second },
        ],
      },
    ];
    expect(replay({ ...data, definitions }).diagnostics).toEqual([]);
    const invalid = replay({
      ...fixture([start(), enter()]),
      definitions: [
        {
          ...definitions[0],
          id: processId,
          stages: [{ id: first }, { id: second }],
          initialStages: [second],
        },
      ],
    });
    expect(codes(invalid)).toContain("invalid_transition");
  });

  it("diagnoses invalid definitions and missing catalog references", () => {
    const data = fixture([start(), enter()]);
    const result = replay({
      ...data,
      definitions: [{ id: processId, stages: [{ id: first }, { id: first }] }],
    });
    expect(codes(result)).toEqual(
      expect.arrayContaining(["invalid_definition", "missing_reference"]),
    );
    expect(result.cases).toEqual([]);
  });

  it("validates opaque IDs without deriving identity from labels", () => {
    expect(() => id<"case">(" ")).toThrow();
    expect(id<"case">("__proto__")).toBe("__proto__");
  });
});

it("is idempotent even for conflicting child events and invalid correction cycles", () => {
  const data = rollout();
  const bad = event("conflict", 40, {
    type: "child.link",
    caseId,
    childCaseId: id<"case">("service-a"),
  });
  const input = { ...data, events: [...data.events, bad, { ...bad, occurredAt: 50 }] };
  const expected = replay(input);
  expect(replay({ ...input, events: [...input.events, ...input.events].reverse() })).toEqual(
    expected,
  );
  expect(caseMetrics(expected, caseId).childOverlapMs).toBeNull();
  const cycle = fixture([
    start(),
    enter(),
    exit(),
    event("cycle-a", 20, {
      type: "stage.block",
      stageInstanceId: instance,
      interruptionId: "wait",
      supersedes: id<"event">("cycle-b"),
    }),
    event("cycle-b", 30, {
      type: "stage.block",
      stageInstanceId: instance,
      interruptionId: "wait",
      supersedes: id<"event">("cycle-a"),
    }),
  ]);
  expect(stageMetrics(replay(cycle), instance).unavailableMs).toBeNull();
});
