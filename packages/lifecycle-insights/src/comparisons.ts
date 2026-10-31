import { drilldown } from "./alerts.js";
import type {
  Cell,
  Comparison,
  ComparisonMetric,
  ComparisonSpec,
  Difference,
  EvaluationContext,
  Moments,
  Snapshot,
} from "./types.js";
import {
  canonical,
  checkSnapshot,
  normalizedFilter,
  selectCells,
  validContract,
  validPolicy,
  validSelection,
  validWindow,
} from "./validation.js";

interface Sample {
  n: number;
  mean: number;
  variance: number;
}
interface Stratum {
  left: readonly Cell[];
  right: readonly Cell[];
  weight: number;
}
const sum = (cells: readonly Cell[], f: (c: Cell) => number) => cells.reduce((n, c) => n + f(c), 0);
const size = (cells: readonly Cell[]) => sum(cells, (c) => c.cohortSize);
function sample(cells: readonly Cell[], metric: ComparisonMetric): Sample {
  if (metric === "rejection-share" || metric === "cancellation-share") {
    const n = sum(cells, (c) => c.outcomes.total);
    const successes = sum(cells, (c) =>
      metric === "rejection-share" ? c.outcomes.rejected : c.outcomes.cancelled,
    );
    const mean = successes / n;
    return { n, mean, variance: n > 1 ? (mean * (1 - mean) * n) / (n - 1) : 0 };
  }
  const m = cells.reduce<Moments>(
    (a, c) => ({
      n: a.n + c[metric].n,
      sum: a.sum + c[metric].sum,
      sumSquares: a.sumSquares + c[metric].sumSquares,
    }),
    { n: 0, sum: 0, sumSquares: 0 },
  );
  return {
    n: m.n,
    mean: m.sum / m.n,
    variance: m.n > 1 ? Math.max(0, (m.sumSquares - m.sum * (m.sum / m.n)) / (m.n - 1)) : 0,
  };
}
function group(cells: readonly Cell[], controls: readonly string[]): Map<string, Cell[]> {
  const groups = new Map<string, Cell[]>();
  for (const cell of cells) {
    const key = canonical([...controls].sort().map((k) => [k, cell.dimensions[k]]));
    const existing = groups.get(key);
    if (existing) existing.push(cell);
    else groups.set(key, [cell]);
  }
  return groups;
}
const metricNames = new Set([
  "duration",
  "cost",
  "rework",
  "rejection-share",
  "cancellation-share",
]);

/** Descriptive standardization over matched cells; never a causal estimate or ranking. */
export function compareVariants(input: {
  spec: ComparisonSpec;
  left: Snapshot;
  right: Snapshot;
  context: EvaluationContext;
}): Comparison {
  const { spec: s, left, right, context } = input;
  const blocked = (...reasons: string[]): Comparison => ({ status: "blocked", reasons });
  if (
    !validPolicy(context.policy) ||
    !validContract(s.contract) ||
    !validWindow(s.window) ||
    !validSelection(s.left, context.policy) ||
    !validSelection(s.right, context.policy)
  )
    return blocked("invalid-comparison-or-filter");
  if (
    s.left.variant === s.right.variant ||
    canonical(normalizedFilter(s.left.filters)) !== canonical(normalizedFilter(s.right.filters))
  )
    return blocked("incompatible-cohort-filters");
  if (
    !Array.isArray(s.controls) ||
    !Array.isArray(s.uncontrolled) ||
    new Set([...s.controls, ...s.uncontrolled]).size !==
      s.controls.length + s.uncontrolled.length ||
    canonical([...s.controls, ...s.uncontrolled].sort()) !==
      canonical(Object.keys(context.policy.dimensions).sort())
  )
    return blocked("unaccounted-or-blocked-controls");
  if (
    !Number.isSafeInteger(s.minimumSamples) ||
    s.minimumSamples < 2 ||
    !Number.isSafeInteger(s.minimumCohort) ||
    s.minimumCohort < 2 ||
    !Number.isFinite(s.minimumCoverage) ||
    s.minimumCoverage <= 0 ||
    s.minimumCoverage > 1 ||
    !Array.isArray(s.metrics) ||
    !s.metrics.length ||
    new Set(s.metrics).size !== s.metrics.length ||
    s.metrics.some((m) => !metricNames.has(m))
  )
    return blocked("invalid-comparison-limits");
  const errors = [
    ...checkSnapshot(left, s.contract, s.window, context),
    ...checkSnapshot(right, s.contract, s.window, context),
  ];
  if (errors.length) return blocked(...new Set(errors));
  if (canonical(left.stageMapping) !== canonical(right.stageMapping))
    return blocked("stage-mapping-drift");
  const minimum = Math.max(s.minimumCohort, context.policy.minimumCohort);
  const l = selectCells(left, s.left, minimum);
  const r = selectCells(right, s.right, minimum);
  if (l.reasons.length || r.reasons.length)
    return blocked(...new Set([...l.reasons, ...r.reasons]));
  const lg = group(l.cells, s.controls);
  const rg = group(r.cells, s.controls);
  const matched: Stratum[] = [];
  for (const [key, lc] of [...lg].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const rc = rg.get(key);
    if (rc) matched.push({ left: lc, right: rc, weight: size(lc) + size(rc) });
  }
  const leftMatched = matched.flatMap((m) => m.left);
  const rightMatched = matched.flatMap((m) => m.right);
  const coverage = {
    left: size(leftMatched) / size(l.cells),
    right: size(rightMatched) / size(r.cells),
    matchedStrata: matched.length,
  };
  if (!matched.length || coverage.left < s.minimumCoverage || coverage.right < s.minimumCoverage)
    return blocked("insufficient-coverage");
  const warnings = ["observational-no-causal-claims", "unmeasured-confounding-possible"];
  if (s.uncontrolled.length) warnings.push("uncontrolled-dimensions");
  if (coverage.left < 1 || coverage.right < 1) warnings.push("incomplete-coverage");
  const leftCensorRate = sum(l.cells, (c) => c.censored) / size(l.cells);
  const rightCensorRate = sum(r.cells, (c) => c.censored) / size(r.cells);
  if (leftCensorRate || rightCensorRate) warnings.push("censored-completed-only");
  if (Math.abs(leftCensorRate - rightCensorRate) > 0.1) warnings.push("unequal-censoring");
  if (sum([...l.cells, ...r.cells], (c) => c.paused)) warnings.push("paused-time-excluded");
  const totalWeight = matched.reduce((n, m) => n + m.weight, 0);
  if (!Number.isSafeInteger(totalWeight)) return blocked("numeric-overflow");
  const differences: Difference[] = [];
  for (const metric of s.metrics) {
    let leftMean = 0;
    let rightMean = 0;
    let variance = 0;
    let ciEligible = true;
    const metricWarnings: string[] = [];
    const stratumDifferences: number[] = [];
    for (const stratum of matched) {
      const a = sample(stratum.left, metric);
      const b = sample(stratum.right, metric);
      if (!a.n || !b.n) return blocked("zero-denominator");
      if (a.n < Math.max(s.minimumSamples, minimum) || b.n < Math.max(s.minimumSamples, minimum))
        return blocked("insufficient-stratum-samples");
      if (a.n < 30 || b.n < 30) ciEligible = false;
      const leftCompleted = sum(stratum.left, (c) => c.completed);
      const rightCompleted = sum(stratum.right, (c) => c.completed);
      const leftCoverage = a.n / leftCompleted;
      const rightCoverage = b.n / rightCompleted;
      if (leftCoverage < s.minimumCoverage || rightCoverage < s.minimumCoverage)
        return blocked("insufficient-metric-coverage");
      if (leftCoverage < 1 || rightCoverage < 1) metricWarnings.push("incomplete-metric-coverage");
      const w = stratum.weight / totalWeight;
      leftMean += w * a.mean;
      rightMean += w * b.mean;
      variance += w * w * (a.variance / a.n + b.variance / b.n);
      stratumDifferences.push(b.mean - a.mean);
    }
    const a = sample(leftMatched, metric);
    const b = sample(rightMatched, metric);
    const crudeDifference = b.mean - a.mean;
    const observedDifference = rightMean - leftMean;
    if (
      ![leftMean, rightMean, variance, crudeDifference, observedDifference].every(Number.isFinite)
    )
      return blocked("numeric-overflow");
    const reverses = (x: number, y: number) => x !== 0 && y !== 0 && Math.sign(x) !== Math.sign(y);
    if (
      reverses(crudeDifference, observedDifference) ||
      (stratumDifferences.length > 1 &&
        stratumDifferences.every((d) => reverses(d, crudeDifference)))
    )
      metricWarnings.push("simpsons-paradox-concern");
    if (stratumDifferences.some((d) => d > 0) && stratumDifferences.some((d) => d < 0))
      metricWarnings.push("heterogeneous-strata");
    if (!ciEligible) metricWarnings.push("small-n-no-confidence-interval");
    if (s.metrics.length > 1) metricWarnings.push("multiple-comparisons-unadjusted");
    // A normal interval for rare binary outcomes is misleading even with a large denominator.
    if (
      metric.endsWith("share") &&
      matched.some((m) =>
        [sample(m.left, metric), sample(m.right, metric)].some(
          (v) => v.n * v.mean < 5 || v.n * (1 - v.mean) < 5,
        ),
      )
    ) {
      ciEligible = false;
      metricWarnings.push("rare-outcome-no-confidence-interval");
    }
    const margin = 1.96 * Math.sqrt(variance);
    differences.push({
      metric,
      leftMean,
      rightMean,
      observedDifference,
      crudeDifference,
      confidenceInterval: ciEligible
        ? [observedDifference - margin, observedDifference + margin]
        : null,
      warnings: [...new Set(metricWarnings)],
    });
  }
  return {
    status: "compared",
    interpretation: "descriptive-only",
    differences,
    warnings,
    coverage,
    drilldowns: [drilldown(left, { selection: s.left }), drilldown(right, { selection: s.right })],
  };
}
