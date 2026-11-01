import { describe, expect, it } from "vitest";
import { AS_OF, DAY, syntheticContext, syntheticFixture } from "../src/fixtures.js";
import { compareVariants, evaluateRule, validateSnapshot } from "../src/index.js";
import { copy, required } from "./helpers.js";

function setup() {
  return { ...syntheticFixture("incidents"), context: copy(syntheticContext) };
}
const blocked = (reason: string) => ({
  status: "blocked",
  reasons: expect.arrayContaining([reason]),
});

describe("normalization, coverage, and privacy boundaries", () => {
  it.each(["cost", "capacity"] as const)("blocks %s unit drift", (unit) => {
    const f = setup();
    f.snapshot.units[unit] = "different-unit";
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(blocked("contract-drift"));
    expect(
      compareVariants({
        spec: f.comparison,
        left: f.baseline,
        right: f.snapshot,
        context: f.context,
      }),
    ).toMatchObject(blocked("contract-drift"));
  });
  it("uses IANA timezone validation and explicit cutoff, without reading Date.now", () => {
    const f = setup();
    f.rule.contract.clock.timeZone = "invalid-zone";
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(blocked("invalid-rule"));
    f.rule.contract.clock.timeZone = "America/Detroit";
    expect(
      evaluateRule({ ...f, current: f.snapshot, context: { ...f.context, asOf: Number.NaN } }),
    ).toMatchObject(blocked("invalid-policy-or-cutoff"));
    f.snapshot.producedAt = AS_OF + DAY;
    // Later production is permitted only under the explicit historical-knowledge attestation.
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject({ status: "evaluated" });
  });
  it("rejects processing before knowledge cutoff and incomplete future event windows", () => {
    const f = setup();
    f.snapshot.producedAt -= 1;
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(blocked("invalid-cutoff"));
    f.snapshot.producedAt = AS_OF;
    f.snapshot.window.end += 1;
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(blocked("invalid-cutoff"));
  });
  it("blocks single-observation moments inside a large cohort", () => {
    const f = setup();
    const c = required(f.snapshot.cells[0]);
    c.cost = { n: 1, sum: 30, sumSquares: 900 };
    expect(validateSnapshot(f.snapshot, f.context)).toContain("small-measurement-cohort");
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(
      blocked("small-measurement-cohort"),
    );
  });
  it("allows an empty suppressed placeholder without returning the hidden cells or values", () => {
    const f = setup();
    const c = required(f.snapshot.cells[0]);
    c.suppressed = true;
    c.cohortSize = c.completed = c.censored = c.paused = 0;
    c.currentDwell = { n: 0, p90Ms: null };
    c.stuckOpen.count =
      c.stuckOpen.eligible =
      c.agedBacklog.count =
      c.agedBacklog.eligible =
      c.slaBreach.count =
      c.slaBreach.eligible =
        0;
    c.duration = c.cost = c.rework = { n: 0, sum: 0, sumSquares: 0 };
    c.outcomes = { total: 0, rejected: 0, cancelled: 0 };
    c.capacity = { used: 0, available: 0 };
    expect(validateSnapshot(f.snapshot, f.context)).toEqual([]);
    expect(evaluateRule({ ...f, current: f.snapshot })).toEqual({
      status: "blocked",
      reasons: ["suppressed-cohort"],
    });
  });
  it("does not use or expose an unselected suppressed cell", () => {
    const f = setup();
    required(f.snapshot.cells.find((c) => c.variant === "b")).suppressed = true;
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject({
      status: "evaluated",
      value: 0.9,
    });
  });
  it("blocks low metric coverage separately from cohort matching coverage", () => {
    const f = setup();
    f.comparison.metrics = ["cost"];
    for (const c of f.snapshot.cells) c.cost = { n: 40, sum: 400, sumSquares: 4039 };
    const compare = () =>
      compareVariants({
        spec: f.comparison,
        left: f.snapshot,
        right: f.snapshot,
        context: f.context,
      });
    expect(compare()).toMatchObject(blocked("insufficient-metric-coverage"));
    f.comparison.minimumCoverage = 0.5;
    const result = compare();
    expect(result.status).toBe("compared");
    if (result.status === "compared")
      expect(result.differences[0]?.warnings).toContain("incomplete-metric-coverage");
  });
  it("does not lower sample privacy floors with a smaller rule minimum", () => {
    const f = setup();
    f.rule.minimumSamples = 1;
    required(f.snapshot.cells[0]).currentDwell = { n: 1, p90Ms: 10 * DAY };
    f.rule.metric = "p90-current-dwell";
    f.rule.selection.filters = { category: ["standard"] };
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(
      blocked("small-measurement-cohort"),
    );
  });
  it("accepts saturation above 100% with consistent units", () => {
    const f = setup();
    for (const c of f.snapshot.cells) c.capacity.used = 150;
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject({
      status: "evaluated",
      value: 1.5,
      emit: true,
    });
  });
  it("blocks numeric overflow rather than emitting infinite alert values", () => {
    const f = setup();
    for (const c of f.snapshot.cells) c.capacity.used = 1e308;
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(blocked("numeric-overflow"));
  });
  it("excludes paused intervals from current dwell sample counts", () => {
    const f = setup();
    required(f.snapshot.cells[0]).currentDwell.n = 20;
    expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(blocked("invalid-counts"));
  });
  it("requires stage occurrence presence and rejects case snapshots carrying a stage ID", () => {
    const f = setup();
    f.snapshot.scope = { ...f.snapshot.scope, kind: "stage", stageOccurrenceId: "missing" };
    expect(validateSnapshot(f.snapshot, f.context)).toContain("ambiguous-stage-mapping");
    f.snapshot.scope.kind = "case";
    expect(validateSnapshot(f.snapshot, f.context)).toContain("invalid-contract");
  });
  it("rejects unknown fields at every snapshot level and bad outcome counts", () => {
    const f = setup();
    Object.assign(f.snapshot, { rows: [] });
    expect(validateSnapshot(f.snapshot, f.context)).toEqual(["invalid-snapshot-shape"]);
    const g = setup();
    required(g.snapshot.cells[0]).outcomes.cancelled = 80;
    expect(validateSnapshot(g.snapshot, g.context)).toContain("invalid-counts");
  });
  it.each([0, -1, 1.01, Number.NaN])(
    "rejects invalid comparison coverage %s",
    (minimumCoverage) => {
      const f = setup();
      f.comparison.minimumCoverage = minimumCoverage;
      expect(
        compareVariants({
          spec: f.comparison,
          left: f.snapshot,
          right: f.snapshot,
          context: f.context,
        }),
      ).toMatchObject(blocked("invalid-comparison-limits"));
    },
  );
});

it("does not confuse a completed-window watermark with point-in-time completeness", () => {
  const f = setup();
  f.snapshot.asOf += DAY;
  f.snapshot.producedAt += DAY;
  f.context.asOf += DAY;
  expect(evaluateRule({ ...f, current: f.snapshot })).toMatchObject(
    blocked("incomplete-point-in-time-watermark"),
  );
});
it("retains the baseline reference and rejects conflicting baseline replay", () => {
  const f = setup();
  f.rule.metric = "throughput-drop";
  f.rule.threshold = 0.5;
  f.rule.baselineWindow = f.baseline.window;
  for (const c of f.snapshot.cells) {
    c.completed = 0;
    c.outcomes = { total: 0, rejected: 0, cancelled: 0 };
    c.duration = c.cost = c.rework = { n: 0, sum: 0, sumSquares: 0 };
  }
  const first = evaluateRule({ ...f, current: f.snapshot });
  expect(first.status).toBe("evaluated");
  if (first.status !== "evaluated" || !first.alert) throw new Error("expected alert");
  expect(first.alert.baselineDrilldown?.snapshotId).toBe(f.baseline.id);
  f.baseline.id += "-revision-2";
  expect(evaluateRule({ ...f, current: f.snapshot, previous: first.alert })).toMatchObject(
    blocked("conflicting-replay"),
  );
});
