import type {
  ComparisonRow,
  MetricRow,
  Query,
  QueryRegistry,
  Sample,
} from "@flightdeckhq/lifecycle-queries";
import { digestOf } from "./hash.js";
import { isToken, parseUtc } from "./plan.js";
import type { EvidenceMetadata, EvidenceRow, PlannedQuery } from "./types.js";

export class InvalidResultError extends Error {}
function ok(condition: unknown): asserts condition {
  if (!condition) throw new InvalidResultError("invalid result");
}
const count = (value: unknown): number | null => {
  if (value === null) return null;
  ok(typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
  return value;
};
const duration = (value: unknown): number | null => {
  if (value === null) return null;
  ok(typeof value === "number" && Number.isFinite(value) && value >= 0);
  return value;
};
const signed = (value: unknown): number | null => {
  if (value === null) return null;
  ok(typeof value === "number" && Number.isFinite(value));
  return value;
};

function sampleOf(value: unknown, minimum: number): Sample | null {
  if (value === null) return null;
  ok(value && typeof value === "object");
  const raw = value as Sample;
  ok(typeof raw.suppressed === "boolean" && raw.suppression && typeof raw.suppression === "object");
  ok(
    [raw.suppression.sample, raw.suppression.counts, raw.suppression.percentiles].every(
      (flag) => typeof flag === "boolean",
    ),
  );
  const sample: Sample = {
    sampleSize: count(raw.sampleSize),
    observedCases: count(raw.observedCases),
    censoredCases: count(raw.censoredCases),
    count: count(raw.count),
    p50Ms: duration(raw.p50Ms),
    p75Ms: duration(raw.p75Ms),
    p90Ms: duration(raw.p90Ms),
    suppressed: raw.suppressed,
    suppression: {
      sample: raw.suppression.sample === true,
      counts: raw.suppression.counts === true,
      percentiles: raw.suppression.percentiles === true,
    },
  };
  if (sample.observedCases !== null && sample.censoredCases !== null && sample.sampleSize !== null)
    ok(sample.observedCases + sample.censoredCases === sample.sampleSize);
  ok(sample.sampleSize === null || sample.sampleSize >= minimum);
  ok(sample.count === null || sample.count === sample.sampleSize);
  ok(
    sample.observedCases === null || sample.observedCases === 0 || sample.observedCases >= minimum,
  );
  ok(
    sample.censoredCases === null || sample.censoredCases === 0 || sample.censoredCases >= minimum,
  );
  ok(sample.suppressed === sample.suppression.sample);
  if (sample.suppression.sample) ok(sample.sampleSize === null && sample.count === null);
  if (sample.suppression.counts || sample.suppression.sample)
    ok(sample.observedCases === null && sample.censoredCases === null);
  if (sample.suppression.percentiles || sample.suppression.sample)
    ok(sample.p50Ms === null && sample.p75Ms === null && sample.p90Ms === null);
  if (sample.p50Ms !== null && sample.p75Ms !== null) ok(sample.p50Ms <= sample.p75Ms);
  if (sample.p75Ms !== null && sample.p90Ms !== null) ok(sample.p75Ms <= sample.p90Ms);
  return sample;
}

/** Expected grouping dimensions after the query layer's own rules (comparison adds caseMix). */
function dimensionsOf(query: Query): string[] {
  return [
    ...new Set(query.metric.kind === "comparison" ? ["caseMix", ...query.groupBy] : query.groupBy),
  ];
}

/**
 * Re-validates an adapter (or cached) result against the plan and trusted scope, then copies
 * only aggregate fields. Unknown fields, including anything that looks like a case record,
 * are dropped. Throws InvalidResultError on any mismatch.
 */
export function acceptResult(
  planned: PlannedQuery,
  value: unknown,
  registry: QueryRegistry,
  maxRows: number,
): { metadata: EvidenceMetadata; rows: EvidenceRow[]; digest: string } {
  const query = planned.query;
  ok(value && typeof value === "object");
  const result = value as { metric?: { kind?: unknown }; rows?: unknown; metadata?: unknown };
  ok(result.metric && digestOf(result.metric) === digestOf(query.metric));
  ok(result.metadata && typeof result.metadata === "object");
  const meta = result.metadata as Record<string, unknown> & {
    coverage?: Record<string, unknown>;
    suppression?: Record<string, unknown>;
    cohort?: { id?: unknown; caseMix?: unknown };
  };
  ok(meta.appId === registry.appId && meta.appId === query.appId);
  ok(meta.definitionId === query.definitionId && meta.metricVersion === query.metricVersion);
  ok(meta.asOf === query.asOf);
  const watermark = parseUtc(meta.watermark);
  ok(watermark !== null && watermark <= (parseUtc(query.asOf) as number));
  ok(
    Array.isArray(meta.definitionVersions) &&
      JSON.stringify([...meta.definitionVersions].sort()) ===
        JSON.stringify([...query.definitionVersions].sort()),
  );
  ok(meta.cohort && meta.cohort.id === query.cohort.id);
  ok(
    Array.isArray(meta.cohort.caseMix) &&
      JSON.stringify([...meta.cohort.caseMix].sort()) ===
        JSON.stringify([...query.cohort.caseMix].sort()),
  );
  ok(meta.coverage && typeof meta.coverage === "object");
  ok(meta.suppression && typeof meta.suppression === "object");
  const ratio = meta.coverage.ratio;
  ok(ratio === null || (typeof ratio === "number" && ratio >= 0 && ratio <= 1));
  ok(
    meta.approximation === "exact-nearest-rank-fixture" ||
      meta.approximation === "basin-approx-percentile",
  );
  ok(meta.suppression.minSampleSize === registry.minSampleSize);
  ok(typeof meta.truncated === "boolean");
  const metadata: EvidenceMetadata = {
    definitionVersions: [...query.definitionVersions],
    asOf: query.asOf,
    watermark: meta.watermark as string,
    sourceFreshness: {
      lagMs: (parseUtc(query.asOf) as number) - watermark,
      coversWindow: watermark >= (parseUtc(query.to) as number),
    },
    sampleSize: count(meta.sampleSize ?? null),
    coverage: {
      eligibleCases: count(meta.coverage.eligibleCases ?? null),
      coveredCases: count(meta.coverage.coveredCases ?? null),
      ratio: ratio as number | null,
    },
    suppression: {
      minSampleSize: count(meta.suppression.minSampleSize) ?? 0,
      suppressedRows: count(meta.suppression.suppressedRows) ?? 0,
    },
    cohort: { id: query.cohort.id, caseMix: [...query.cohort.caseMix] },
    approximation: meta.approximation as string,
    truncated: meta.truncated as boolean,
  };
  for (const n of [
    metadata.sampleSize,
    metadata.coverage.eligibleCases,
    metadata.coverage.coveredCases,
  ])
    ok(n === null || n === 0 || n >= registry.minSampleSize);
  const { eligibleCases, coveredCases } = metadata.coverage;
  if (eligibleCases !== null && coveredCases !== null) ok(coveredCases <= eligibleCases);
  if (ratio !== null)
    ok(
      eligibleCases !== null &&
        coveredCases !== null &&
        eligibleCases > 0 &&
        Math.abs((ratio as number) - coveredCases / eligibleCases) < 1e-12,
    );

  ok(Array.isArray(result.rows) && result.rows.length <= Math.min(maxRows, query.topN));
  const dimensions = dimensionsOf(query);
  const seen = new Set<string>();
  const rows = (result.rows as unknown[]).map((input) => {
    ok(input && typeof input === "object");
    const row = input as Partial<MetricRow & ComparisonRow>;
    ok(isToken(row.key));
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
    ok(allowedKeys.includes(row.key));
    ok(row.group && typeof row.group === "object");
    const group: Record<string, string> = {};
    ok(Object.keys(row.group).length === dimensions.length);
    for (const dimension of dimensions) {
      const groupValue = (row.group as Record<string, unknown>)[dimension];
      ok(isToken(groupValue));
      ok(
        registry.filterValues[dimension as keyof typeof registry.filterValues].includes(groupValue),
      );
      if (dimension === "caseMix") ok(query.cohort.caseMix.includes(groupValue));
      if (dimension === "definitionVersion") ok(query.definitionVersions.includes(groupValue));
      if (dimension === "cohortId") ok(groupValue === query.cohort.id);
      group[dimension] = groupValue;
    }
    const identity = JSON.stringify([row.key, dimensions.map((dimension) => group[dimension])]);
    ok(!seen.has(identity));
    seen.add(identity);
    if (query.metric.kind === "comparison") {
      ok(typeof row.comparable === "boolean");
      ok(row.reason === null || row.reason === "missing-stratum" || row.reason === "suppressed");
      const primary = sampleOf(row.primary ?? null, registry.minSampleSize);
      const reference = sampleOf(row.reference ?? null, registry.minSampleSize);
      const delta = signed(row.deltaP50Ms ?? null);
      if (delta !== null)
        ok(
          row.comparable &&
            primary?.p50Ms != null &&
            reference?.p50Ms != null &&
            delta === primary.p50Ms - reference.p50Ms,
        );
      if (row.comparable) ok(primary && reference && row.reason === null);
      else ok(delta === null);
      return {
        identity,
        key: row.key,
        group,
        sample: primary,
        reference,
        comparable: row.comparable,
        reason: row.reason,
        deltaP50Ms: delta,
      };
    }
    return {
      identity,
      key: row.key,
      group,
      sample: sampleOf(row, registry.minSampleSize),
      reference: null,
      comparable: null,
      reason: null,
      deltaP50Ms: null,
    };
  });
  // Adapter order is not part of the evidence contract; sort for deterministic refs.
  rows.sort((a, b) => (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
  const evidenceRows: EvidenceRow[] = rows.map(({ identity: _, ...row }, index) => ({
    ref: `q:${planned.id}#${index}`,
    ...row,
  }));
  const digest = digestOf({
    metadata,
    rows: evidenceRows.map(({ ref: _, ...row }) => row),
  });
  return { metadata, rows: evidenceRows, digest };
}
