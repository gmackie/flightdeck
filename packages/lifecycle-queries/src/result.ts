import type {
  AggregateRow,
  ComparisonRow,
  Evidence,
  Metric,
  MetricRow,
  Query,
  QueryRegistry,
  Result,
  Sample,
} from "./types.js";
import { groups, invariant, utc } from "./validate.js";

function count(value: unknown): asserts value is number {
  invariant(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "Invalid aggregate count",
  );
}
function visible(value: number, minimum: number) {
  return value === 0 || value >= minimum ? value : null;
}
function sample(row: AggregateRow, query: Query, minimum: number): Sample {
  const suppressed = row.sampleSize < minimum;
  const countsSuppressed =
    suppressed ||
    visible(row.observedCases, minimum) === null ||
    visible(row.censoredCases, minimum) === null;
  const percentileN = query.metric.kind === "current-open-age" ? row.sampleSize : row.observedCases;
  const percentilesSuppressed =
    ["stage-dwell", "comparison", "current-open-age"].includes(query.metric.kind) &&
    percentileN < minimum;
  return {
    suppression: {
      sample: suppressed,
      counts: countsSuppressed,
      percentiles: percentilesSuppressed,
    },
    sampleSize: suppressed ? null : row.sampleSize,
    observedCases: countsSuppressed ? null : visible(row.observedCases, minimum),
    censoredCases: countsSuppressed ? null : visible(row.censoredCases, minimum),
    count: suppressed ? null : row.count,
    p50Ms: suppressed || percentileN < minimum ? null : row.p50Ms,
    p75Ms: suppressed || percentileN < minimum ? null : row.p75Ms,
    p90Ms: suppressed || percentileN < minimum ? null : row.p90Ms,
    suppressed,
  };
}
export function finish<M extends Metric>(
  query: Query<M>,
  registry: QueryRegistry,
  raw: readonly AggregateRow[],
  evidence: Evidence,
  approximation: Result<M>["metadata"]["approximation"],
): Result<M> {
  utc(evidence.watermark);
  invariant(utc(evidence.watermark) <= utc(query.asOf), "Watermark exceeds asOf");
  count(evidence.coveredCases);
  if (evidence.eligibleCases !== null) {
    count(evidence.eligibleCases);
    invariant(evidence.eligibleCases >= evidence.coveredCases, "Invalid coverage");
  }
  const dimensions = groups(query);
  const buckets = new Map<
    string,
    { key: string; group: AggregateRow["group"]; arms: Map<string, AggregateRow>; size: number }
  >();
  for (const row of raw) {
    invariant(typeof row.key === "string" && row.key.length <= 128, "Invalid aggregate key");
    const metric = query.metric;
    const allowedKeys =
      metric.kind === "outcomes"
        ? registry.filterValues.outcome
        : metric.kind === "variant-counts"
          ? registry.filterValues.variantId
          : metric.kind === "funnel"
            ? metric.checkpoints
            : metric.kind === "stage-dwell" || metric.kind === "comparison"
              ? [metric.stageId]
              : [metric.kind];
    invariant(allowedKeys.includes(row.key), "Unexpected metric key");
    invariant(
      row.arm === "primary" || (query.metric.kind === "comparison" && row.arm === "reference"),
      "Invalid aggregate arm",
    );
    invariant(
      Object.keys(row.group).length === dimensions.length &&
        dimensions.every((dimension) => typeof row.group[dimension] === "string"),
      "Invalid aggregate dimensions",
    );
    for (const dimension of dimensions)
      invariant(
        registry.filterValues[dimension].includes(row.group[dimension] ?? ""),
        "Unregistered aggregate dimension",
      );
    for (const value of [row.sampleSize, row.observedCases, row.censoredCases, row.count])
      count(value);
    invariant(
      row.sampleSize > 0 &&
        row.observedCases + row.censoredCases === row.sampleSize &&
        row.count === row.sampleSize &&
        row.sampleSize <= evidence.coveredCases,
      "Inconsistent aggregate counts",
    );
    for (const value of [row.p50Ms, row.p75Ms, row.p90Ms])
      invariant(
        value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0),
        "Invalid percentile",
      );
    invariant(
      (row.p50Ms === null && row.p75Ms === null && row.p90Ms === null) ||
        (row.p50Ms !== null &&
          row.p75Ms !== null &&
          row.p90Ms !== null &&
          row.p50Ms <= row.p75Ms &&
          row.p75Ms <= row.p90Ms),
      "Invalid percentile ordering",
    );
    const id = JSON.stringify([row.key, dimensions.map((dimension) => row.group[dimension])]);
    const bucket = buckets.get(id) ?? {
      key: row.key,
      group: row.group,
      arms: new Map<string, AggregateRow>(),
      size: 0,
    };
    invariant(!bucket.arms.has(row.arm), "Duplicate aggregate row");
    bucket.arms.set(row.arm, row);
    bucket.size += row.sampleSize;
    buckets.set(id, bucket);
  }
  const ordered = [...buckets.entries()].sort(
    ([idA, a], [idB, b]) => b.size - a.size || (idA < idB ? -1 : idA > idB ? 1 : 0),
  );
  const minimum = registry.minSampleSize;
  const rows: (MetricRow | ComparisonRow)[] = ordered.slice(0, query.topN).map(([, bucket]) => {
    const primaryRow = bucket.arms.get("primary"),
      referenceRow = bucket.arms.get("reference");
    if (query.metric.kind !== "comparison") {
      invariant(primaryRow, "Missing primary aggregate");
      return { key: bucket.key, group: bucket.group, ...sample(primaryRow, query, minimum) };
    }
    const primary = primaryRow ? sample(primaryRow, query, minimum) : null;
    const reference = referenceRow ? sample(referenceRow, query, minimum) : null;
    const reason =
      !primary || !reference
        ? "missing-stratum"
        : primary.p50Ms === null || reference.p50Ms === null
          ? "suppressed"
          : null;
    return {
      key: bucket.key,
      group: bucket.group,
      primary,
      reference,
      comparable: reason === null,
      reason,
      deltaP50Ms:
        reason === null && primary?.p50Ms !== null && reference?.p50Ms !== null
          ? (primary?.p50Ms ?? 0) - (reference?.p50Ms ?? 0)
          : null,
    };
  });
  const suppressedRows = rows.filter((row) =>
    "suppressed" in row
      ? Object.values(row.suppression).some(Boolean)
      : [row.primary, row.reference].some(
          (sample) => sample && Object.values(sample.suppression).some(Boolean),
        ),
  ).length;
  return {
    metric: query.metric,
    rows: rows as Result<M>["rows"],
    metadata: {
      appId: query.appId,
      definitionId: query.definitionId,
      definitionVersions: [...query.definitionVersions],
      metricVersion: query.metricVersion,
      asOf: query.asOf,
      watermark: evidence.watermark,
      sampleSize: visible(evidence.coveredCases, minimum),
      coverage: {
        eligibleCases:
          evidence.eligibleCases === null ? null : visible(evidence.eligibleCases, minimum),
        coveredCases: visible(evidence.coveredCases, minimum),
        ratio:
          evidence.eligibleCases === null ||
          evidence.eligibleCases < minimum ||
          evidence.coveredCases < minimum
            ? null
            : evidence.coveredCases / evidence.eligibleCases,
      },
      suppression: { minSampleSize: minimum, suppressedRows },
      cohort: query.cohort,
      approximation,
      truncated: ordered.length > query.topN,
    },
  };
}
