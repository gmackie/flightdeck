import {
  type Cohort,
  DIMENSIONS,
  type Dimension,
  type Query,
  type QueryRegistry,
} from "./types.js";

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function utc(value: unknown): number {
  invariant(
    typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value),
    "Expected canonical UTC timestamp",
  );
  const time = Date.parse(value);
  invariant(
    Number.isFinite(time) && new Date(time).toISOString() === value,
    "Invalid UTC timestamp",
  );
  return time;
}
export function token(value: unknown): asserts value is string {
  invariant(
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value),
    "Invalid registered identifier",
  );
}
function unique(values: readonly unknown[], min: number, max: number) {
  invariant(
    Array.isArray(values) &&
      values.length >= min &&
      values.length <= max &&
      new Set(values).size === values.length,
    "Invalid or duplicate list entries",
  );
}
function registered(value: string, allowed: readonly string[]) {
  token(value);
  invariant(allowed.includes(value), `Unregistered value: ${value}`);
}
function cohort(value: Cohort, registry: QueryRegistry) {
  invariant(value && typeof value === "object", "Missing explicit cohort");
  registered(value.id, registry.filterValues.cohortId);
  unique(value.caseMix, 1, 20);
  for (const mix of value.caseMix) registered(mix, registry.filterValues.caseMix);
}
export function validateRegistry(registry: QueryRegistry) {
  token(registry.appId);
  token(registry.definitionId);
  invariant(registry.metricVersion === "lifecycle.v1", "Unsupported metric version");
  utc(registry.availableFrom);
  invariant(
    Number.isInteger(registry.maxWindowDays) &&
      registry.maxWindowDays >= 1 &&
      registry.maxWindowDays <= 366,
    "Invalid window policy",
  );
  invariant(
    Number.isInteger(registry.minSampleSize) &&
      registry.minSampleSize >= 2 &&
      registry.minSampleSize <= 1000,
    "Invalid suppression policy",
  );
  for (const field of DIMENSIONS) {
    unique(registry.filterValues[field], 1, 1000);
    for (const value of registry.filterValues[field]) token(value);
  }
  invariant(Object.keys(registry.versions).length > 0, "Missing version mappings");
  for (const [version, mapping] of Object.entries(registry.versions)) {
    registered(version, registry.filterValues.definitionVersion);
    token(mapping.comparisonKey);
    for (const map of [mapping.stages, mapping.checkpoints, mapping.variants]) {
      const entries = Object.entries(map);
      invariant(
        new Set(entries.map(([, value]) => value)).size === entries.length,
        "Ambiguous version mapping",
      );
      for (const [physical, canonical] of entries) {
        token(physical);
        token(canonical);
      }
    }
    for (const variant of Object.values(mapping.variants))
      registered(variant, registry.filterValues.variantId);
  }
}
/** Validate again at every public adapter boundary; TypeScript types are not a trust boundary. */
export function validateQuery(query: Query, registry: QueryRegistry): void {
  validateRegistry(registry);
  invariant(query && typeof query === "object", "Missing query");
  invariant(
    query.appId === registry.appId && query.definitionId === registry.definitionId,
    "Query scope does not match registry",
  );
  invariant(query.metricVersion === registry.metricVersion, "Unsupported metric version");
  const from = utc(query.from),
    to = utc(query.to),
    asOf = utc(query.asOf);
  invariant(
    from >= utc(registry.availableFrom) &&
      from < to &&
      to <= asOf &&
      to - from <= registry.maxWindowDays * 86400000,
    "Invalid bounded query window",
  );
  unique(query.definitionVersions, 1, 10);
  const keys = new Set<string>();
  for (const version of query.definitionVersions) {
    token(version);
    invariant(Object.hasOwn(registry.versions, version), "Unregistered definition version");
    keys.add(registry.versions[version]?.comparisonKey ?? "");
  }
  invariant(keys.size === 1, "Non-comparable definition versions");
  cohort(query.cohort, registry);
  unique(query.groupBy, 0, 2);
  for (const dimension of query.groupBy)
    invariant(DIMENSIONS.includes(dimension), "Unregistered groupBy");
  invariant(Array.isArray(query.filters) && query.filters.length <= 5, "Invalid filters");
  unique(
    query.filters.map((filter) => filter.field),
    0,
    5,
  );
  for (const filter of query.filters) {
    invariant(DIMENSIONS.includes(filter.field), "Unregistered filter");
    unique(filter.values, 1, 20);
    for (const value of filter.values)
      registered(value, registry.filterValues[filter.field as Dimension]);
  }
  invariant(Number.isInteger(query.topN) && query.topN >= 1 && query.topN <= 100, "Invalid topN");
  invariant(query.metric && typeof query.metric === "object", "Missing metric");
  const metric = query.metric;
  invariant(
    [
      "stage-dwell",
      "current-open-age",
      "outcomes",
      "funnel",
      "variant-counts",
      "case-counts",
      "comparison",
    ].includes(metric.kind),
    "Unknown metric",
  );
  if (metric.kind === "stage-dwell" || metric.kind === "comparison") {
    token(metric.stageId);
    for (const version of query.definitionVersions)
      invariant(
        Object.values(registry.versions[version]?.stages ?? {}).includes(metric.stageId),
        "Unmapped stage",
      );
  }
  if (metric.kind === "funnel") {
    unique(metric.checkpoints, 1, 12);
    for (const checkpoint of metric.checkpoints) {
      token(checkpoint);
      for (const version of query.definitionVersions)
        invariant(
          Object.values(registry.versions[version]?.checkpoints ?? {}).includes(checkpoint),
          "Unmapped checkpoint",
        );
    }
  }
  if (metric.kind === "comparison") {
    cohort(metric.reference, registry);
    invariant(metric.reference.id !== query.cohort.id, "Comparison requires distinct cohorts");
    invariant(
      !query.filters.some((filter) => filter.field === "cohortId"),
      "Comparison cannot filter away a cohort",
    );
    invariant(!query.groupBy.includes("cohortId"), "Comparison cannot group by cohortId");
  }
}
export function groups(query: Query): Dimension[] {
  return [
    ...new Set<Dimension>(
      query.metric.kind === "comparison" ? ["caseMix", ...query.groupBy] : query.groupBy,
    ),
  ];
}
