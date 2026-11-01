import { describe, expect, it } from "vitest";
import {
  caseMetrics,
  funnel,
  id,
  percentile,
  ratio,
  replay,
  selectCases,
  stageMetrics,
  summarize,
  unionDuration,
  variants,
} from "../src/index.js";
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

describe("interval and elapsed time metrics", () => {
  it("keeps blocked/paused separate while unioning all overlap as unavailable", () => {
    const result = replay(incident());
    expect(stageMetrics(result, instance)).toEqual({
      stageInstanceId: instance,
      wallClockMs: 50,
      blockedMs: 25,
      pausedMs: 20,
      unavailableMs: 30,
      availableElapsedMs: 20,
      activeAgeMs: null,
      openCensored: false,
    });
  });

  it("computes open active age explicitly as-of, including still-open interruptions", () => {
    const input = fixture([
      start(),
      enter(),
      event("block", 20, {
        type: "stage.block",
        stageInstanceId: instance,
        interruptionId: "wait",
      }),
    ]);
    expect(stageMetrics(replay({ ...input, asOf: 50 }), instance)).toMatchObject({
      wallClockMs: 40,
      blockedMs: 30,
      unavailableMs: 30,
      availableElapsedMs: 10,
      activeAgeMs: 10,
      openCensored: true,
    });
    expect(stageMetrics(replay(input), instance).activeAgeMs).toBe(10);
  });

  it("intersects case pauses with stage pauses and blocks, without double counting", () => {
    const input = incident();
    const result = replay({
      ...input,
      events: [
        ...input.events,
        event("case-pause", 15, { type: "case.pause", caseId, interruptionId: "window" }),
        event("case-resume", 35, { type: "case.resume", caseId, interruptionId: "window" }),
      ],
    });
    expect(caseMetrics(result, caseId)).toMatchObject({
      openDurationMs: 80,
      pausedMs: 20,
      availableElapsedMs: 60,
    });
    expect(stageMetrics(result, instance)).toMatchObject({
      blockedMs: 25,
      pausedMs: 35,
      unavailableMs: 35,
      availableElapsedMs: 15,
    });
  });

  it("unions independent case pauses and ends them at explicit termination", () => {
    const result = replay(
      fixture([
        start(),
        event("p1", 10, { type: "case.pause", caseId, interruptionId: "a" }),
        event("p2", 20, { type: "case.pause", caseId, interruptionId: "b" }),
        event("r1", 30, { type: "case.resume", caseId, interruptionId: "a" }),
        terminate(50),
        event("reopen", 60, { type: "case.reopen", caseId }),
      ]),
    );
    expect(result.cases[0]?.status).toBe("open");
    expect(caseMetrics(result, caseId)).toMatchObject({
      openDurationMs: 90,
      pausedMs: 40,
      availableElapsedMs: 50,
    });
  });

  it("does not call a missing unblock start zero, or claim known available time", () => {
    const result = replay(
      fixture([
        start(),
        enter(),
        event("unblock", 30, {
          type: "stage.unblock",
          stageInstanceId: instance,
          interruptionId: "missing",
        }),
        exit(),
      ]),
    );
    expect(stageMetrics(result, instance)).toMatchObject({
      wallClockMs: 40,
      blockedMs: null,
      availableElapsedMs: null,
      unavailableMs: null,
    });
    expect(result.diagnostics.some((d) => d.code === "missing_boundary")).toBe(true);
  });

  it("does not infer zero case pause time when case start is missing", () => {
    const result = replay(fixture([enter(), exit()]));
    expect(stageMetrics(result, instance)).toMatchObject({
      wallClockMs: 40,
      pausedMs: null,
      unavailableMs: null,
      availableElapsedMs: null,
    });
    expect(caseMetrics(result, caseId).openDurationMs).toBeNull();
  });

  it("computes explicit parent duration, child union and simultaneous child time", () => {
    const result = replay(rollout());
    expect(caseMetrics(result, caseId)).toMatchObject({
      spanMs: 90,
      openDurationMs: 90,
      childOverlapMs: 70,
      parallelChildMs: 50,
    });
    expect(result.diagnostics).toEqual([]);
  });

  it("clips child overlap to link windows and explicit parent boundaries", () => {
    const input = rollout();
    const a = id<"case">("service-a");
    const result = replay({
      ...input,
      events: [
        ...input.events,
        event("unlink", 40, { type: "child.unlink", caseId, childCaseId: a }),
        event("relink", 50, { type: "child.link", caseId, childCaseId: a }),
      ],
    });
    expect(caseMetrics(result, caseId)).toMatchObject({
      openDurationMs: 90,
      childOverlapMs: 70,
      parallelChildMs: 40,
    });
  });

  it("never derives parent start/end from children; incomplete child overlap is unknown", () => {
    const input = rollout();
    const missingParent = replay({
      ...input,
      events: input.events.filter((e) => e.id !== `start:${caseId}`),
    });
    expect(caseMetrics(missingParent, caseId)).toMatchObject({
      spanMs: null,
      openDurationMs: null,
      childOverlapMs: null,
    });
    const missingChild = replay({
      ...input,
      events: input.events.filter((e) => e.id !== "start:service-a"),
    });
    expect(caseMetrics(missingChild, caseId)).toMatchObject({
      openDurationMs: 90,
      childOverlapMs: null,
      parallelChildMs: null,
    });
  });

  it("handles interval overlap, adjacency, zero boundaries and incomplete/negative intervals", () => {
    expect(
      unionDuration(
        [
          { start: 0, end: 20 },
          { start: 5, end: 30 },
          { start: 30, end: 40 },
          { start: 10, end: 15 },
        ],
        100,
      ),
    ).toBe(40);
    expect(unionDuration([{ start: 0, end: null }], 10)).toBe(10);
    expect(unionDuration([{ start: null, end: 10 }], 10)).toBeNull();
    expect(unionDuration([{ start: 20, end: 10 }], 100)).toBeNull();
    expect(unionDuration([{ start: 50, end: null }], 10)).toBeNull();
    expect(unionDuration([], 10)).toBe(0);
  });

  it("matches a simple discrete-time oracle for overlapping interval unions", () => {
    for (let seed = 0; seed < 40; seed++) {
      const intervals = Array.from({ length: 10 }, (_, n) => {
        const start = (seed * 7 + n * 13) % 50;
        return { start, end: start + ((seed + n * 3) % 20) };
      });
      const oracle = Array.from({ length: 100 }, (_, t) =>
        intervals.some((i) => i.start <= t && t < i.end),
      ).filter(Boolean).length;
      expect(unionDuration(intervals, 100)).toBe(oracle);
    }
  });
});

describe("aggregate definitions, cohorts and denominators", () => {
  it("uses interpolated p50/p90 and reports no samples as unknown", () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0.9)).toBe(37);
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([], 0.5)).toBeNull();
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(2, 4)).toBe(0.5);
    expect(() => percentile([-1], 0.5)).toThrow();
    expect(() => percentile([NaN], 0.5)).toThrow();
    expect(() => percentile([1], 2)).toThrow();
  });

  function cohortFixture() {
    const data = hiring();
    const open = id<"case">("open-case");
    const cancelled = id<"case">("cancelled-case");
    const openStage = id<"stage-instance">("open-attempt");
    const cancelledStage = id<"stage-instance">("cancelled-attempt");
    return replay({
      ...data,
      cases: [
        ...data.cases,
        { id: open, processId, attributes: { region: "west" } },
        { id: cancelled, processId, attributes: { region: "east" } },
      ],
      stageInstances: [
        ...data.stageInstances,
        { id: openStage, caseId: open, stageId: first },
        { id: cancelledStage, caseId: cancelled, stageId: first },
      ],
      events: [
        ...data.events,
        start(1, open),
        enter(11, openStage),
        start(2, cancelled),
        enter(12, cancelledStage),
        exit(22, cancelledStage),
        event("cancel", 32, { type: "case.terminate", caseId: cancelled, terminal: "cancelled" }),
      ],
    });
  }

  it("returns terminal counts/ratios, closed-only distributions and open censor counts", () => {
    const summary = summarize(cohortFixture());
    expect(summary).toMatchObject({
      cases: 3,
      openCensored: 1,
      unknown: 0,
      completionRatio: 0.5,
      terminal: { completed: 1, cancelled: 1, rejected: 0, failed: 0 },
      closedCaseDuration: { samples: 2, p50: 50, p90: 66 },
    });
    expect(summary.stages.find((s) => s.stageId === first)).toMatchObject({
      closedDwell: { samples: 3, p50: 10, p90: 14 },
      openCensored: 1,
    });
  });

  it("counts each case once in funnels despite retry attempts; exposes denominator policy", () => {
    const result = cohortFixture();
    expect(funnel(result, [first, second])[0]).toMatchObject({
      reached: 3,
      converted: 1,
      denominator: 3,
      conversion: 1 / 3,
      openCensored: 1,
    });
    expect(funnel(result, [first, second], { denominator: "closed-only" })[0]).toMatchObject({
      reached: 3,
      converted: 1,
      denominator: 2,
      conversion: 0.5,
      openCensored: 1,
    });
    expect(funnel(result, [first, second])[1]?.conversion).toBeNull();
    expect(funnel(replay(fixture()), [first])[0]?.conversion).toBeNull();
  });

  it("filters first-start cohorts, process, attributes, status, terminal and linked object", () => {
    const result = cohortFixture();
    expect(selectCases(result, { attributes: { region: "east" } })).toHaveLength(2);
    expect(selectCases(result, { startedFrom: 1, startedBefore: 2 })).toHaveLength(1);
    expect(selectCases(result, { processId, status: "open" })).toHaveLength(1);
    expect(selectCases(result, { terminal: ["cancelled"] })).toHaveLength(1);
    expect(
      selectCases(result, { relatedObject: { type: "person", id: "person-opaque" } }).map(
        (c) => c.id,
      ),
    ).toEqual([caseId]);
    expect(selectCases(replay(fixture()), { startedFrom: 0 })).toEqual([]);
  });

  it("keeps retries in variants, terminal classes distinct, and reports unknown cases separately", () => {
    const result = cohortFixture();
    const summary = variants(result);
    expect(summary.variants).toHaveLength(3);
    expect(summary.unknownCases).toBe(0);
    const completed = summary.variants.find((v) => v.key.includes("completed"));
    expect(completed?.key.match(/opaque:stage:first/g)).toHaveLength(2);
    expect(completed?.share).toBe(1 / 3);
    expect(variants(replay(fixture())).unknownCases).toBe(1);
  });

  it("groups simultaneous parallel entries without inventing a causal order", () => {
    const other = id<"stage-instance">("parallel");
    const input = fixture([start(), enter(), enter(10, other)]);
    const result = replay({
      ...input,
      stageInstances: [...input.stageInstances, { id: other, caseId, stageId: second }],
    });
    const key = variants(result).variants[0]?.key;
    expect(JSON.parse(key ?? "[]")[1]).toEqual([[first, second]]);
  });
});

describe("uncertain evidence", () => {
  it("does not turn excluded conflicting interruption events into zero unavailable time", () => {
    const block = event("block", 20, {
      type: "stage.block",
      stageInstanceId: instance,
      interruptionId: "wait",
    });
    const result = replay(fixture([start(), enter(), exit(), block, { ...block, occurredAt: 30 }]));
    expect(stageMetrics(result, instance)).toMatchObject({
      wallClockMs: 40,
      blockedMs: null,
      unavailableMs: null,
    });
    expect(variants(result).unknownCases).toBe(1);
  });

  it("keeps unmatched child unlink overlap unknown, while retaining explicit parent duration", () => {
    const data = rollout();
    const result = replay({
      ...data,
      events: data.events
        .filter((e) => e.id !== "child-a")
        .concat(
          event("unlink", 40, {
            type: "child.unlink",
            caseId,
            childCaseId: id<"case">("service-a"),
          }),
        ),
    });
    expect(caseMetrics(result, caseId)).toMatchObject({ openDurationMs: 90, childOverlapMs: null });
  });

  it("gives equal-time funnel entries no arbitrary event-ID precedence", () => {
    const other = id<"stage-instance">("parallel-b");
    const data = fixture([
      start(),
      { ...enter(), id: id<"event">("z") },
      { ...enter(10, other), id: id<"event">("a") },
    ]);
    const result = replay({
      ...data,
      stageInstances: [...data.stageInstances, { id: other, caseId, stageId: second }],
    });
    expect(result.visits.map((v) => v.stageId)).toEqual([second, first]);
    expect(funnel(result, [first, second])[0]?.conversion).toBe(1);
  });
});

describe("known partial extracts", () => {
  it("keeps known missing case and instance evidence unknown even without structural gaps", () => {
    const data = fixture([start(), enter(), exit(), terminate()]);
    const partialCase = replay({
      ...data,
      cases: data.cases.map((c) => ({ ...c, historyComplete: false })),
    });
    expect(caseMetrics(partialCase, caseId).openDurationMs).toBeNull();
    expect(stageMetrics(partialCase, instance).pausedMs).toBeNull();
    expect(summarize(partialCase)).toMatchObject({
      unknown: 1,
      closedCaseDuration: { samples: 0, p50: null, p90: null },
    });
    const partialStage = replay({
      ...data,
      stageInstances: data.stageInstances.map((s) => ({ ...s, historyComplete: false })),
    });
    expect(stageMetrics(partialStage, instance)).toMatchObject({
      wallClockMs: 40,
      blockedMs: null,
      unavailableMs: null,
    });
    expect(variants(partialStage).unknownCases).toBe(1);
  });

  it("distinguishes unknown exit in a terminated case from an open censored observation", () => {
    const result = replay(fixture([start(), enter(), terminate()]));
    expect(stageMetrics(result, instance)).toMatchObject({
      openCensored: false,
      wallClockMs: null,
    });
    expect(summarize(result).stages[0]).toMatchObject({ openCensored: 0, unknown: 1 });
  });

  it("preserves explicit zero durations, without using zero for skipped/unknown stages", () => {
    const result = replay(fixture([start(), enter(10), exit(10)]));
    expect(stageMetrics(result, instance).wallClockMs).toBe(0);
    expect(stageMetrics(replay(fixture()), instance).wallClockMs).toBeNull();
  });
});
