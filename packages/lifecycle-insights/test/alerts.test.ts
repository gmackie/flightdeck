import { describe, expect, it } from "vitest";
import { AS_OF, DAY, syntheticContext, syntheticFixture } from "../src/fixtures.js";
import type { Alert, AlertEvaluation, Cell, Metric, Snapshot } from "../src/index.js";
import { acknowledgeAlert, alertKey, evaluateRule, validateSnapshot } from "../src/index.js";
import { copy, required } from "./helpers.js";

function setup() {
  const f = copy(syntheticFixture("release"));
  return { ...f, context: copy(syntheticContext) };
}
function alert(result: AlertEvaluation): Alert {
  expect(result.status).toBe("evaluated");
  if (result.status !== "evaluated" || !result.alert) throw new Error("expected alert");
  return result.alert;
}
function later(f: ReturnType<typeof setup>, delta = DAY / 2) {
  f.context.asOf += delta;
  f.snapshot.asOf += delta;
  f.snapshot.producedAt += delta;
  f.snapshot.watermark += delta;
  f.snapshot.id += "-next";
}
const blocked = (reason: string) => ({
  status: "blocked",
  reasons: expect.arrayContaining([reason]),
});

describe("all rule metrics", () => {
  it.each<readonly [Metric, number, number | undefined, number]>([
    ["p90-current-dwell", 3 * DAY, undefined, 4 * DAY],
    ["stuck-open-count", 5, 3 * DAY, 8],
    ["aged-backlog-count", 2, 7 * DAY, 4],
    ["rejection-share", 0.1, undefined, 0.15],
    ["cancellation-share", 0.05, undefined, 0.1],
    ["capacity-saturation", 0.8, undefined, 0.9],
    ["sla-breach-share", 0.1, 5 * DAY, 0.15],
  ])("evaluates %s", (metric, threshold, ageThresholdMs, value) => {
    const f = setup();
    f.rule = {
      ...f.rule,
      metric,
      threshold,
      ageThresholdMs,
      selection: { variant: "a", filters: { category: ["standard"] } },
    };
    const result = evaluateRule({ ...f, current: f.snapshot });
    expect(result).toMatchObject({ status: "evaluated", value, transition: "opened", emit: true });
    expect(alert(result)).toMatchObject({
      ownerRef: "process-ops",
      severity: "warning",
      drilldown: { asOf: AS_OF, watermark: AS_OF },
    });
  });
  it("uses relative throughput drop and an explicit equal-length baseline", () => {
    const f = setup();
    f.rule = {
      ...f.rule,
      metric: "throughput-drop",
      threshold: 0.4,
      baselineWindow: f.baseline.window,
    };
    for (const c of f.snapshot.cells) c.completed = 40;
    // No duration observations in the newly completed cohort; throughput only needs the count.
    for (const c of f.snapshot.cells) {
      c.outcomes = { total: 0, rejected: 0, cancelled: 0 };
      c.duration.n = c.cost.n = c.rework.n = 0;
      c.duration.sum = c.cost.sum = c.rework.sum = 0;
      c.duration.sumSquares = c.cost.sumSquares = c.rework.sumSquares = 0;
    }
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject({
      status: "evaluated",
      value: 0.5,
      transition: "opened",
    });
  });
  it("does not average cell p90 values", () => {
    const f = setup();
    f.rule.metric = "p90-current-dwell";
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(
      blocked("non-mergeable-quantile"),
    );
  });
  it("uses strict thresholds and fractions rather than percentage points", () => {
    const f = setup();
    f.rule.metric = "rejection-share";
    f.rule.threshold = 0.15;
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject({
      status: "evaluated",
      transition: "unchanged",
      value: 0.15,
      emit: false,
    });
    f.rule.threshold = 15;
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(blocked("invalid-rule"));
  });
  it.each([
    "rejection-share",
    "cancellation-share",
    "capacity-saturation",
    "sla-breach-share",
    "throughput-drop",
  ] as const)("blocks zero denominator for %s", (metric) => {
    const f = setup();
    f.rule.metric = metric;
    f.rule.ageThresholdMs = 5 * DAY;
    if (metric === "throughput-drop") f.rule.baselineWindow = f.baseline.window;
    for (const c of [...f.snapshot.cells, ...f.baseline.cells]) {
      c.outcomes = { total: 0, rejected: 0, cancelled: 0 };
      c.capacity.available = 0;
      c.slaBreach = { thresholdMs: 5 * DAY, count: 0, eligible: 0 };
      c.completed = 0;
      c.duration = c.cost = c.rework = { n: 0, sum: 0, sumSquares: 0 };
    }
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(blocked("zero-denominator"));
  });
  it("counts zero current throughput as a full drop", () => {
    const f = setup();
    f.rule.metric = "throughput-drop";
    f.rule.baselineWindow = f.baseline.window;
    for (const c of f.snapshot.cells) {
      c.completed = 0;
      c.outcomes = { total: 0, rejected: 0, cancelled: 0 };
      c.duration = c.cost = c.rework = { n: 0, sum: 0, sumSquares: 0 };
    }
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject({
      status: "evaluated",
      value: 1,
      emit: true,
    });
  });
  it("blocks threshold buckets with a different age definition", () => {
    const f = setup();
    f.rule.metric = "stuck-open-count";
    f.rule.ageThresholdMs = 5 * DAY;
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(
      blocked("threshold-definition-mismatch"),
    );
  });
});

describe("alert lifecycle and caller-owned state", () => {
  it("deduplicates exact replay, honors cooldown, updates, clears, and reopens without stale ack", () => {
    const f = setup();
    const first = alert(evaluateRule({ ...f, current: f.snapshot }));
    const acknowledged = acknowledgeAlert(first, "team-opaque", AS_OF);
    expect(evaluateRule({ ...f, current: f.snapshot, previous: acknowledged })).toMatchObject({
      transition: "unchanged",
      emit: false,
    });
    later(f);
    const cooled = evaluateRule({ ...f, current: f.snapshot, previous: acknowledged });
    expect(cooled).toMatchObject({
      transition: "cooldown",
      emit: false,
      alert: { acknowledged: { ownerRef: "team-opaque" } },
    });
    later(f);
    const updated = evaluateRule({ ...f, current: f.snapshot, previous: alert(cooled) });
    expect(updated).toMatchObject({ transition: "updated", emit: true });
    later(f, 1);
    for (const c of f.snapshot.cells) c.capacity.used = 20;
    const clear = evaluateRule({ ...f, current: f.snapshot, previous: alert(updated) });
    expect(clear).toMatchObject({
      transition: "cleared",
      emit: false,
      alert: { status: "cleared" },
    });
    later(f, 1);
    for (const c of f.snapshot.cells) c.capacity.used = 90;
    const reopened = evaluateRule({ ...f, current: f.snapshot, previous: alert(clear) });
    expect(reopened).toMatchObject({
      transition: "reopened",
      emit: false,
      alert: { occurrences: 2 },
    });
    expect(alert(reopened).acknowledged).toBeUndefined();
    expect(first.acknowledged).toBeUndefined();
  });
  it("does not clear existing alerts on suppressed or incomplete evidence", () => {
    const f = setup();
    const previous = alert(evaluateRule({ ...f, current: f.snapshot }));
    later(f);
    required(f.snapshot.cells[0]).suppressed = true;
    expect(evaluateRule({ ...f, current: f.snapshot, previous })).toMatchObject(
      blocked("suppressed-cohort"),
    );
    expect(previous.status).toBe("open");
  });
  it("rejects conflicting backfill at the same evaluation cutoff", () => {
    const f = setup();
    const previous = alert(evaluateRule({ ...f, current: f.snapshot }));
    f.snapshot.id = "backfilled";
    expect(evaluateRule({ ...f, current: f.snapshot, previous })).toMatchObject(
      blocked("conflicting-replay"),
    );
  });
  it("rejects previous rule versions, changed configuration, scope, and out of order state", () => {
    const f = setup();
    const previous = alert(evaluateRule({ ...f, current: f.snapshot }));
    expect(
      evaluateRule({ ...f, current: f.snapshot, previous: { ...previous, ruleVersion: 2 } }),
    ).toMatchObject(blocked("previous-alert-version-or-scope-mismatch"));
    f.rule.threshold = 0.8;
    expect(evaluateRule({ ...f, current: f.snapshot, previous })).toMatchObject(
      blocked("previous-alert-version-or-scope-mismatch"),
    );
    f.rule.threshold = 0.85;
    expect(
      evaluateRule({
        ...f,
        current: f.snapshot,
        previous: { ...previous, lastEvaluatedAt: AS_OF + 1 },
      }),
    ).toMatchObject(blocked("out-of-order-evaluation"));
  });
  it("keys are stable across window shifts and filter ordering but distinct by case scope", () => {
    const f = setup();
    const key = alertKey(f.rule);
    f.rule.window = { start: f.rule.window.start + DAY, end: f.rule.window.end + DAY };
    expect(alertKey(f.rule)).toBe(key);
    f.rule.selection.filters = { category: ["complex", "standard", "complex"] };
    const filtered = alertKey(f.rule);
    f.rule.selection.filters = { category: ["standard", "complex"] };
    expect(alertKey(f.rule)).toBe(filtered);
    f.rule.contract.scope = {
      ...f.rule.contract.scope,
      kind: "stage",
      stageOccurrenceId: "occurrence-2",
    };
    expect(alertKey(f.rule)).not.toBe(filtered);
  });
  it("validates acknowledgments", () => {
    const f = setup();
    const a = alert(evaluateRule({ ...f, current: f.snapshot }));
    expect(() => acknowledgeAlert(a, "", AS_OF)).toThrow();
    expect(() => acknowledgeAlert(a, "ops", AS_OF - 1)).toThrow();
    expect(() => acknowledgeAlert({ ...a, status: "cleared" }, "ops", AS_OF)).toThrow();
  });
});

describe("source, temporal, scope and privacy gates", () => {
  it.each<readonly [string, (s: Snapshot) => void, string]>([
    [
      "unpermitted source",
      (s) => {
        s.sourceId = "untrusted";
      },
      "source-not-permitted",
    ],
    [
      "version drift",
      (s) => {
        s.definitionVersion = "2";
      },
      "contract-drift",
    ],
    [
      "schema version mismatch",
      (s) => {
        (s as unknown as { contractVersion: number }).contractVersion = 2;
      },
      "invalid-snapshot-shape",
    ],
    [
      "source version drift",
      (s) => {
        s.sourceVersion = "2";
      },
      "contract-drift",
    ],
    [
      "calendar drift",
      (s) => {
        s.clock.calendar = "business-v2";
      },
      "contract-drift",
    ],
    [
      "time zone drift",
      (s) => {
        s.clock.timeZone = "UTC";
      },
      "contract-drift",
    ],
    [
      "wrong scope",
      (s) => {
        s.scope.populationId = "different";
      },
      "contract-drift",
    ],
    [
      "stage data as case data",
      (s) => {
        s.scope.kind = "stage";
        s.scope.stageOccurrenceId = "occurrence-2";
      },
      "contract-drift",
    ],
    [
      "wrong window",
      (s) => {
        s.window.start += DAY;
      },
      "wrong-window",
    ],
    [
      "incomplete event time",
      (s) => {
        s.watermark -= 1;
      },
      "incomplete-watermark",
    ],
    [
      "future watermark",
      (s) => {
        s.watermark += 1;
      },
      "invalid-cutoff",
    ],
    [
      "backfill cutoff",
      (s) => {
        s.asOf += 1;
      },
      "invalid-cutoff",
    ],
    [
      "ingestion basis",
      (s) => {
        (s as unknown as { basis: string }).basis = "ingestion-time";
      },
      "invalid-snapshot-shape",
    ],
    [
      "overlap unresolved",
      (s) => {
        s.overlappingIntervalsResolved = false;
      },
      "ambiguous-intervals",
    ],
    [
      "non-disjoint cells",
      (s) => {
        s.disjointCells = false;
      },
      "ambiguous-intervals",
    ],
    [
      "ambiguous reused stages",
      (s) => {
        s.stageMapping = { review: "occurrence-2", repeatedReview: "occurrence-2" };
      },
      "ambiguous-stage-mapping",
    ],
  ])("blocks %s", (_label, change, reason) => {
    const f = setup();
    change(f.snapshot);
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(blocked(reason));
  });
  it.each<readonly [string, (c: Cell) => void, string]>([
    [
      "suppression",
      (c) => {
        c.suppressed = true;
      },
      "suppressed-cohort",
    ],
    [
      "small cohort",
      (c) => {
        c.cohortSize = 99;
        c.completed = 79;
        for (const m of [c.duration, c.cost, c.rework]) m.n = 79;
        c.outcomes.total = 79;
      },
      "small-cohort",
    ],
    [
      "blocked dimension",
      (c) => {
        c.dimensions = { email: "not-allowed" };
      },
      "blocked-dimension",
    ],
    [
      "paused inclusion",
      (c) => {
        c.stuckOpen.eligible = 20;
      },
      "paused-stage-inclusion",
    ],
    [
      "bad counts",
      (c) => {
        c.outcomes.rejected = 100;
      },
      "invalid-counts",
    ],
    [
      "invalid variance",
      (c) => {
        c.cost.sumSquares = 1;
      },
      "invalid-moments",
    ],
    [
      "NaN",
      (c) => {
        c.capacity.used = Number.NaN;
      },
      "invalid-snapshot-shape",
    ],
    [
      "raw record field",
      (c) => {
        Object.assign(c, { person: "private" });
      },
      "invalid-snapshot-shape",
    ],
  ])("blocks %s", (_label, change, reason) => {
    const f = setup();
    if (reason === "small-cohort") f.rule.minimumCohort = 100;
    change(required(f.snapshot.cells[0]));
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(blocked(reason));
  });
  it("fails closed on blocked filters without returning data", () => {
    const f = setup();
    f.rule.selection.filters = { person: ["opaque"] };
    expect(evaluateRule({ ...f, current: f.snapshot })).toEqual(blocked("invalid-rule"));
  });
  it("checks minimum samples and policy floor", () => {
    const f = setup();
    f.rule.minimumSamples = 1000;
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(
      blocked("insufficient-samples"),
    );
    expect(
      validateSnapshot(f.snapshot, {
        ...f.context,
        policy: { ...f.context.policy, minimumCohort: 1 },
      }),
    ).toContain("invalid-policy-or-cutoff");
  });
  it("rejects duplicate cells", () => {
    const f = setup();
    f.snapshot.cells = [...f.snapshot.cells, required(f.snapshot.cells[0])];
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(
      blocked("duplicate-aggregate-cell"),
    );
  });
  it.each([
    "missing",
    "wrong-window",
    "wrong-version",
    "wrong-population",
    "unequal-window",
    "wrong-cohort",
    "mapping-drift",
    "suppressed",
    "small-baseline",
  ])("rejects %s baseline", (mode) => {
    const f = setup();
    f.rule.metric = "throughput-drop";
    f.rule.baselineWindow = { ...f.baseline.window };
    let reason = "missing-baseline";
    if (mode === "wrong-window") {
      f.baseline.window.start += 1;
      reason = "wrong-window";
    }
    if (mode === "wrong-version") {
      f.baseline.sourceVersion = "2";
      reason = "contract-drift";
    }
    if (mode === "wrong-population") {
      f.baseline.scope.populationId = "other";
      reason = "contract-drift";
    }
    if (mode === "unequal-window") {
      f.rule.baselineWindow.start += 1;
      reason = "invalid-rule";
    }
    if (mode === "wrong-cohort") {
      f.baseline.cells = f.baseline.cells.filter((c) => c.id !== "a-2");
      reason = "baseline-cohort-drift";
    }
    if (mode === "mapping-drift") {
      f.baseline.stageMapping = { ...f.baseline.stageMapping, start: "new" };
      reason = "stage-mapping-drift";
    }
    if (mode === "suppressed") {
      required(f.baseline.cells[0]).suppressed = true;
      reason = "suppressed-cohort";
    }
    if (mode === "small-baseline") {
      f.rule.minimumSamples = 200;
      reason = "insufficient-baseline-samples";
    }
    expect(
      evaluateRule({
        ...f,
        current: f.snapshot,
        baseline: mode === "missing" ? undefined : f.baseline,
      }),
    ).toMatchObject(blocked(reason));
  });
  it("has no IO or mutation and repeats deterministically", () => {
    const f = setup();
    const before = copy(f);
    const result = evaluateRule({ ...f, current: f.snapshot });
    expect(evaluateRule({ ...f, current: f.snapshot })).toEqual(result);
    expect(f).toEqual(before);
  });
  it("handles malformed snapshots as a validation result", () => {
    expect(validateSnapshot(null, syntheticContext)).toEqual(["invalid-snapshot-shape"]);
    expect(validateSnapshot({ rows: [] }, syntheticContext)).toEqual(["invalid-snapshot-shape"]);
  });
});
