import { describe, expect, it } from "vitest";
import { syntheticContext, syntheticFixture } from "../src/fixtures.js";
import type { Cell, Comparison, ComparisonMetric, Snapshot } from "../src/index.js";
import { compareVariants } from "../src/index.js";
import { copy, required } from "./helpers.js";

function setup() {
  const f = syntheticFixture("hiring");
  return {
    spec: copy(f.comparison),
    left: copy(f.snapshot),
    right: copy(f.snapshot),
    context: copy(syntheticContext),
  };
}
function compared(r: Comparison) {
  expect(r.status).toBe("compared");
  if (r.status !== "compared") throw new Error("expected comparison");
  return r;
}
const blocked = (reason: string) => ({
  status: "blocked",
  reasons: expect.arrayContaining([reason]),
});
function stats(c: Cell, n: number, mean: number) {
  c.cohortSize = c.completed = n;
  c.censored = c.paused = 0;
  c.currentDwell = { n: 0, p90Ms: null };
  c.stuckOpen = { thresholdMs: 1, count: 0, eligible: 0 };
  c.agedBacklog = { thresholdMs: 1, count: 0, eligible: 0 };
  c.slaBreach = { thresholdMs: 1, count: 0, eligible: n };
  c.outcomes = { total: n, rejected: 0, cancelled: 0 };
  c.duration = c.cost = c.rework = { n, sum: n * mean, sumSquares: n * mean * mean + n - 1 };
}

describe("synthetic non-domain-specific comparisons", () => {
  it.each(["hiring", "release", "incidents"] as const)(
    "compares %s using the same API",
    (domain) => {
      const f = syntheticFixture(domain);
      const r = compared(
        compareVariants({
          spec: f.comparison,
          left: f.snapshot,
          right: f.snapshot,
          context: syntheticContext,
        }),
      );
      expect(r.interpretation).toBe("descriptive-only");
      expect(r.differences.map((d) => d.metric)).toEqual([
        "duration",
        "cost",
        "rework",
        "rejection-share",
        "cancellation-share",
      ]);
      expect(r.coverage).toEqual({ left: 1, right: 1, matchedStrata: 2 });
      expect(r.differences[0]?.observedDifference).toBe(0);
      expect(r.differences[0]?.confidenceInterval?.[0]).toBeLessThan(0);
      expect(r.differences[0]?.warnings).toContain("heterogeneous-strata");
      expect(r.warnings).toEqual(
        expect.arrayContaining([
          "censored-completed-only",
          "paused-time-excluded",
          "observational-no-causal-claims",
        ]),
      );
    },
  );
  it("uses pooled cohort weights with independently checkable mean difference and interval", () => {
    const f = setup();
    f.spec.metrics = ["cost"];
    for (const c of f.left.cells) stats(c, 100, c.variant === "a" ? 10 : 20);
    f.right = copy(f.left);
    const d = required(compared(compareVariants(f)).differences[0]);
    expect(d.leftMean).toBe(10);
    expect(d.rightMean).toBe(20);
    expect(d.observedDifference).toBe(10);
    // Two equally weighted strata, variance=1 on each side, n=100.
    expect(d.confidenceInterval?.[0]).toBeCloseTo(10 - 1.96 * 0.1, 10);
    expect(d.confidenceInterval?.[1]).toBeCloseTo(10 + 1.96 * 0.1, 10);
  });
  it("flags Simpson's paradox instead of ranking variants", () => {
    const f = setup();
    f.spec.metrics = ["duration"];
    for (const c of f.left.cells) {
      const complex = c.dimensions.category === "complex";
      const a = c.variant === "a";
      stats(c, complex === a ? 900 : 100, (complex ? 20 : 2) + (a ? 0 : 1));
    }
    f.right = copy(f.left);
    const d = required(compared(compareVariants(f)).differences[0]);
    expect(d.observedDifference).toBeCloseTo(1);
    expect(d.crudeDifference).toBeLessThan(0);
    expect(d.warnings).toContain("simpsons-paradox-concern");
  });
  it("reports small n and withholds a normal confidence interval", () => {
    const f = setup();
    f.spec.metrics = ["duration"];
    for (const c of f.left.cells) stats(c, 15, 2);
    f.right = copy(f.left);
    const d = required(compared(compareVariants(f)).differences[0]);
    expect(d.confidenceInterval).toBeNull();
    expect(d.warnings).toContain("small-n-no-confidence-interval");
  });
  it("withholds intervals for rare binary outcomes", () => {
    const f = setup();
    for (const c of f.right.cells) c.outcomes.rejected = 0;
    const d = compared(compareVariants(f)).differences.find((d) => d.metric === "rejection-share");
    expect(d?.confidenceInterval).toBeNull();
    expect(d?.warnings).toContain("rare-outcome-no-confidence-interval");
  });
  it("filters before matching without treating an empty selection as zero", () => {
    const f = setup();
    f.spec.left.filters = f.spec.right.filters = { category: ["standard"] };
    expect(compared(compareVariants(f)).coverage.matchedStrata).toBe(1);
    f.spec.left.variant = "missing";
    expect(compareVariants(f)).toMatchObject(blocked("empty-cohort"));
  });
  it("requires explicit accounting for every allowlisted dimension", () => {
    const f = setup();
    f.spec.controls = ["category"];
    expect(compareVariants(f)).toMatchObject(blocked("unaccounted-or-blocked-controls"));
    f.spec.uncontrolled = ["region", "level"];
    expect(compared(compareVariants(f)).warnings).toContain("uncontrolled-dimensions");
    f.spec.controls = ["person"];
    expect(compareVariants(f)).toMatchObject(blocked("unaccounted-or-blocked-controls"));
  });
  it("flags unequal censoring", () => {
    const f = setup();
    for (const c of f.right.cells) {
      c.censored = c.paused = 0;
      c.currentDwell = { n: 0, p90Ms: null };
      c.stuckOpen.count = c.stuckOpen.eligible = c.agedBacklog.count = c.agedBacklog.eligible = 0;
    }
    expect(compared(compareVariants(f)).warnings).toContain("unequal-censoring");
  });
});

describe("comparison gates", () => {
  it.each<readonly [string, (s: Snapshot) => void, string]>([
    [
      "suppressed cohort",
      (s) => {
        required(s.cells.find((c) => c.variant === "b")).suppressed = true;
      },
      "suppressed-cohort",
    ],
    [
      "low sample cohort",
      (s) => {
        stats(required(s.cells.find((c) => c.variant === "b")), 10, 2);
      },
      "small-cohort",
    ],
    [
      "missing matching control",
      (s) => {
        s.cells = s.cells.filter(
          (c) => !(c.variant === "b" && c.dimensions.category === "complex"),
        );
      },
      "insufficient-coverage",
    ],
    [
      "definition drift",
      (s) => {
        s.definitionVersion = "2";
      },
      "contract-drift",
    ],
    [
      "source drift",
      (s) => {
        s.sourceVersion = "2";
      },
      "contract-drift",
    ],
    [
      "wrong source",
      (s) => {
        s.sourceId = "unknown";
      },
      "source-not-permitted",
    ],
    [
      "wrong baseline period",
      (s) => {
        s.window.start -= 1;
      },
      "wrong-window",
    ],
    [
      "mapping drift",
      (s) => {
        s.stageMapping = { ...s.stageMapping, review: "new-review" };
      },
      "stage-mapping-drift",
    ],
    [
      "reused mapping",
      (s) => {
        s.stageMapping = { start: "occurrence-1", end: "occurrence-1" };
      },
      "ambiguous-stage-mapping",
    ],
    [
      "mixed scope",
      (s) => {
        s.scope = { ...s.scope, kind: "stage", stageOccurrenceId: "occurrence-2" };
      },
      "contract-drift",
    ],
    [
      "overlap",
      (s) => {
        s.overlappingIntervalsResolved = false;
      },
      "ambiguous-intervals",
    ],
    [
      "watermark behind",
      (s) => {
        s.watermark -= 1;
      },
      "incomplete-watermark",
    ],
    [
      "backfill as of drift",
      (s) => {
        s.asOf += 1;
      },
      "invalid-cutoff",
    ],
  ])("blocks %s without returning numeric data", (_label, mutate, reason) => {
    const f = setup();
    if (reason === "small-cohort") f.spec.minimumCohort = 15;
    mutate(f.right);
    const result = compareVariants(f);
    expect(result).toMatchObject(blocked(reason));
    expect(Object.keys(result).sort()).toEqual(["reasons", "status"]);
  });
  it("does not leak a suppressed cohort by filtering or dropping its cell", () => {
    const f = setup();
    required(f.right.cells.find((c) => c.variant === "b")).suppressed = true;
    f.spec.minimumCoverage = 0.1;
    expect(compareVariants(f)).toMatchObject(blocked("suppressed-cohort"));
  });
  it("reports explicitly permitted incomplete coverage", () => {
    const f = setup();
    f.right.cells = f.right.cells.filter(
      (c) => !(c.variant === "b" && c.dimensions.category === "complex"),
    );
    f.spec.minimumCoverage = 0.5;
    const result = compared(compareVariants(f));
    expect(result.coverage).toEqual({ left: 0.5, right: 1, matchedStrata: 1 });
    expect(result.warnings).toContain("incomplete-coverage");
  });
  it.each<ComparisonMetric>([
    "duration",
    "cost",
    "rework",
    "rejection-share",
    "cancellation-share",
  ])("blocks zero denominator for %s", (metric) => {
    const f = setup();
    f.spec.metrics = [metric];
    for (const c of f.right.cells) {
      if (metric.endsWith("share")) c.outcomes = { total: 0, rejected: 0, cancelled: 0 };
      else c[metric as "duration" | "cost" | "rework"] = { n: 0, sum: 0, sumSquares: 0 };
    }
    expect(compareVariants(f)).toMatchObject(blocked("zero-denominator"));
  });
  it("requires minimum samples in each stratum", () => {
    const f = setup();
    f.spec.minimumSamples = 90;
    expect(compareVariants(f)).toMatchObject(blocked("insufficient-stratum-samples"));
  });
  it("rejects mismatched filters, blocked values, and duplicate controls", () => {
    const f = setup();
    f.spec.left.filters = { category: ["complex"] };
    expect(compareVariants(f)).toMatchObject(blocked("incompatible-cohort-filters"));
    f.spec.left.filters = { person: ["opaque"] };
    expect(compareVariants(f)).toMatchObject(blocked("invalid-comparison-or-filter"));
    f.spec.left.filters = {};
    f.spec.controls = ["category", "category", "region", "level"];
    expect(compareVariants(f)).toMatchObject(blocked("unaccounted-or-blocked-controls"));
  });
  it("does not compare a variant with itself", () => {
    const f = setup();
    f.spec.right.variant = "a";
    expect(compareVariants(f)).toMatchObject(blocked("incompatible-cohort-filters"));
  });
  it("is pure and invariant to input cell ordering", () => {
    const f = setup();
    const original = copy(f);
    const result = compareVariants(f);
    expect(f).toEqual(original);
    f.left.cells = [...f.left.cells].reverse();
    f.right.cells = [...f.right.cells].reverse();
    expect(compareVariants(f)).toEqual(result);
  });
});
