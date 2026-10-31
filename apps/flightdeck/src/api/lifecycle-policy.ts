import { type AuthorizedRead, isProcessRead } from "./authorization";

/** Release policy, not an ingestion schema. No free-text or identifier dimension. */
export const LIFECYCLE_POLICY = {
  version: 1,
  minimum_cohort: 5,
  count_bucket: 5,
  dimensions: {
    workflow: { classification: "aggregate", values: ["hiring", "incident", "deployment"] },
    phase: { classification: "aggregate", values: ["queued", "active", "completed", "cancelled"] },
    outcome: { classification: "aggregate", values: ["success", "failure", "unknown"] },
  },
} as const;

export type Dimension = keyof typeof LIFECYCLE_POLICY.dimensions;

/** Unknown fields are restricted by default, including hashed/pseudonymous IDs. */
export function classifyDimension(name: string): "aggregate" | "restricted" {
  return Object.hasOwn(LIFECYCLE_POLICY.dimensions, name) ? "aggregate" : "restricted";
}

export function parseProjection(names: readonly string[]): Dimension[] | null {
  if (!names.length || names.length > 3 || new Set(names).size !== names.length) return null;
  return names.every((name) => classifyDimension(name) === "aggregate")
    ? (names.slice() as Dimension[])
    : null;
}

/** Server-side aggregate adapter input. cohort_size MUST count distinct subjects, not events.
 * Callers must aggregate by exactly the selected dimensions before invoking this boundary.
 * This module never accepts raw lifecycle records, person data, or client-supplied counts.
 */
export type LifecycleAggregate = {
  app_id: string;
  dimensions: Record<string, unknown>;
  count: number;
  cohort_size: number;
};

/** Project only approved categorical values. Fail the whole release on scope/schema errors.
 * No suppressed-count metadata, marginals, or total is returned (subtraction leaks cohorts).
 * Bucket rounding is defense in depth, not differential privacy.
 */
export function projectLifecycleAggregates(
  scope: AuthorizedRead,
  selected: readonly string[],
  rows: readonly LifecycleAggregate[],
): { dimensions: Partial<Record<Dimension, string>>; count: number }[] {
  const dimensions = parseProjection(selected);
  if (!isProcessRead(scope)) throw new Error("Process read authorization required");
  if (!dimensions) throw new Error("Invalid projection");
  const seen = new Set<string>();
  const output: { dimensions: Partial<Record<Dimension, string>>; count: number }[] = [];
  for (const row of rows) {
    if (
      row.app_id !== scope.appId ||
      !Number.isSafeInteger(row.count) ||
      !Number.isSafeInteger(row.cohort_size) ||
      row.cohort_size < 0 ||
      row.count < row.cohort_size ||
      Object.keys(row.dimensions).length !== dimensions.length
    )
      throw new Error("Invalid aggregate");
    const projected: Partial<Record<Dimension, string>> = {};
    for (const name of dimensions) {
      const value = row.dimensions[name];
      const allowed: readonly string[] = LIFECYCLE_POLICY.dimensions[name].values;
      if (typeof value !== "string" || !allowed.includes(value))
        throw new Error("Invalid aggregate");
      projected[name] = value;
    }
    const key = JSON.stringify(projected);
    if (seen.has(key)) throw new Error("Duplicate aggregate");
    seen.add(key);
    if (row.cohort_size < LIFECYCLE_POLICY.minimum_cohort) continue;
    output.push({
      dimensions: projected,
      count: Math.floor(row.count / LIFECYCLE_POLICY.count_bucket) * LIFECYCLE_POLICY.count_bucket,
    });
  }
  return output;
}
