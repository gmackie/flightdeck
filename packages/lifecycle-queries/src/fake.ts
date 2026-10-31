import { finish } from "./result.js";
import type {
  AggregateRow,
  FactBase,
  LifecycleFact,
  Metric,
  Query,
  QueryAdapter,
  QueryRegistry,
  Result,
} from "./types.js";
import { groups, invariant, utc, validateQuery, validateRegistry } from "./validate.js";

function time(value: string | null): number | null {
  return value === null ? null : utc(value);
}
function sameBase(a: FactBase, b: FactBase) {
  return [
    "appId",
    "definitionId",
    "definitionVersion",
    "caseId",
    "revision",
    "recordedAt",
    "cohortId",
    "caseMix",
    "variantId",
    "caseStartedAt",
    "caseEndedAt",
    "outcome",
  ].every((key) => a[key as keyof FactBase] === b[key as keyof FactBase]);
}
function percentile(values: number[], p: number) {
  return values.length ? (values[Math.ceil(values.length * p) - 1] ?? null) : null;
}
interface Bucket {
  row: AggregateRow;
  values: number[];
}
/** Fixture serving adapter, not an event reducer. Requires complete, atomic revision snapshots. */
export function createFakeAdapter(
  input: readonly LifecycleFact[],
  registry: QueryRegistry,
  watermark: string,
): QueryAdapter {
  validateRegistry(registry);
  utc(watermark);
  const policy = structuredClone(registry),
    facts = structuredClone(input);
  const revisions = new Map<string, LifecycleFact[]>();
  const identities = new Map<string, string>();
  for (const fact of facts) {
    invariant(
      typeof fact.factId === "string" &&
        fact.factId.length > 0 &&
        typeof fact.caseId === "string" &&
        fact.caseId.length > 0,
      "Missing fact/case identity",
    );
    invariant(Number.isSafeInteger(fact.revision) && fact.revision >= 1, "Invalid revision");
    utc(fact.recordedAt);
    invariant(utc(fact.recordedAt) <= utc(watermark), "Fact beyond source watermark");
    for (const value of [fact.caseStartedAt, fact.caseEndedAt]) time(value);
    invariant(
      ["open", "completed", "cancelled", "failed"].includes(fact.outcome),
      "Invalid fact outcome",
    );
    invariant(["case", "interval", "checkpoint"].includes(fact.kind), "Invalid fact kind");
    if (fact.kind === "interval") {
      time(fact.enteredAt);
      time(fact.exitedAt);
    }
    if (fact.kind === "checkpoint") {
      time(fact.reachedAt);
      invariant(
        Number.isSafeInteger(fact.sequence) && fact.sequence >= 0,
        "Invalid checkpoint sequence",
      );
    }
    const scope = JSON.stringify([fact.appId, fact.definitionId, fact.caseId]);
    const immutable = JSON.stringify([fact.caseStartedAt]);
    invariant(
      !identities.has(scope) || identities.get(scope) === immutable,
      "Correction changed immutable cohort start",
    );
    identities.set(scope, immutable);
    const id = JSON.stringify([scope, fact.revision]);
    const snapshot = revisions.get(id) ?? [];
    const duplicate = snapshot.find((other) => other.factId === fact.factId);
    if (duplicate) {
      invariant(
        sameBase(duplicate, fact) &&
          duplicate.kind === fact.kind &&
          JSON.stringify(Object.entries(duplicate).sort()) ===
            JSON.stringify(Object.entries(fact).sort()),
        "Conflicting duplicate fact ID",
      );
      continue;
    }
    invariant(!snapshot[0] || sameBase(snapshot[0], fact), "Inconsistent revision snapshot");
    snapshot.push(fact);
    revisions.set(id, snapshot);
  }
  for (const snapshot of revisions.values()) {
    invariant(
      snapshot.filter((fact) => fact.kind === "case").length === 1,
      "Snapshot requires exactly one case fact",
    );
    const checkpoints = snapshot
      .filter((fact) => fact.kind === "checkpoint")
      .map((fact) => fact.checkpointId);
    invariant(new Set(checkpoints).size === checkpoints.length, "Duplicate checkpoint in revision");
  }
  return {
    async query<M extends Metric>(inputQuery: Query<M>): Promise<Result<M>> {
      const query = structuredClone(inputQuery);
      validateQuery(query, policy);
      const asOf = utc(query.asOf),
        from = utc(query.from),
        to = utc(query.to);
      const latest = new Map<string, LifecycleFact[]>();
      for (const snapshot of revisions.values()) {
        const fact = snapshot[0];
        if (
          !fact ||
          fact.appId !== query.appId ||
          fact.definitionId !== query.definitionId ||
          utc(fact.recordedAt) > asOf
        )
          continue;
        const prior = latest.get(fact.caseId)?.[0];
        if (!prior || prior.revision < fact.revision) latest.set(fact.caseId, snapshot);
      }
      const buckets = new Map<string, Bucket>();
      let eligibleCases = 0,
        coveredCases = 0;
      const dimensions = groups(query);
      const metric = query.metric;
      for (const snapshot of latest.values()) {
        const c = snapshot.find((fact) => fact.kind === "case");
        if (!c || !query.definitionVersions.includes(c.definitionVersion)) continue;
        const version = policy.versions[c.definitionVersion];
        if (!version) continue;
        const variantId = Object.hasOwn(version.variants, c.variantId)
          ? version.variants[c.variantId]
          : undefined;
        const values = {
          caseMix: c.caseMix,
          cohortId: c.cohortId,
          definitionVersion: c.definitionVersion,
          variantId: variantId ?? "",
          outcome: c.outcome,
        };
        const arm =
          c.cohortId === query.cohort.id && query.cohort.caseMix.includes(c.caseMix)
            ? "primary"
            : metric.kind === "comparison" &&
                c.cohortId === metric.reference.id &&
                metric.reference.caseMix.includes(c.caseMix)
              ? "reference"
              : null;
        if (!arm || !query.filters.every((filter) => filter.values.includes(values[filter.field])))
          continue;
        const start = time(c.caseStartedAt),
          end = time(c.caseEndedAt);
        // Null starts cannot be assigned to a bounded cohort; do not guess a partition.
        if (start === null || start < from || start >= to) continue;
        eligibleCases++;
        if (
          !variantId ||
          (c.outcome === "open" ? end !== null : end === null || end < start || end > asOf)
        )
          continue;
        coveredCases++;
        const group = Object.fromEntries(
          dimensions.map((dimension) => [dimension, values[dimension]]),
        );
        function add(key: string, censored: boolean, duration: number | null) {
          const id = JSON.stringify([key, dimensions.map((dimension) => group[dimension]), arm]);
          const bucket: Bucket = buckets.get(id) ?? {
            row: {
              key,
              group,
              arm: arm as "primary" | "reference",
              sampleSize: 0,
              observedCases: 0,
              censoredCases: 0,
              count: 0,
              p50Ms: null,
              p75Ms: null,
              p90Ms: null,
            },
            values: [],
          };
          bucket.row.sampleSize++;
          bucket.row.count++;
          if (censored) bucket.row.censoredCases++;
          else bucket.row.observedCases++;
          if (duration !== null) bucket.values.push(duration);
          buckets.set(id, bucket);
        }
        if (metric.kind === "stage-dwell" || metric.kind === "comparison") {
          const intervals = snapshot.filter(
            (fact) =>
              fact.kind === "interval" &&
              Object.hasOwn(version.stages, fact.stageId) &&
              version.stages[fact.stageId] === metric.stageId,
          );
          let duration = 0,
            visits = 0,
            censored = false,
            invalid = false;
          for (const interval of intervals) {
            if (interval.kind !== "interval") continue;
            const entered = time(interval.enteredAt),
              exited = time(interval.exitedAt);
            if (
              entered === null ||
              entered < start ||
              entered > asOf ||
              (exited !== null && (exited < entered || exited > asOf)) ||
              (end !== null && (exited === null || exited > end))
            ) {
              invalid = true;
              continue;
            }
            visits++;
            if (exited === null) censored = true;
            else duration += exited - entered;
          }
          if (visits && !invalid) add(metric.stageId, censored, censored ? null : duration);
        } else if (metric.kind === "funnel") {
          let priorSequence = -1,
            priorTime = start;
          for (const checkpoint of metric.checkpoints) {
            const fact = snapshot.find(
              (fact) =>
                fact.kind === "checkpoint" &&
                Object.hasOwn(version.checkpoints, fact.checkpointId) &&
                version.checkpoints[fact.checkpointId] === checkpoint,
            );
            if (fact?.kind !== "checkpoint") break;
            const reached = time(fact.reachedAt);
            if (
              reached === null ||
              reached < priorTime ||
              reached > (end ?? asOf) ||
              fact.sequence <= priorSequence
            )
              break;
            add(checkpoint, c.outcome === "open", null);
            priorSequence = fact.sequence;
            priorTime = reached;
          }
        } else if (metric.kind === "current-open-age") {
          if (c.outcome === "open") add(metric.kind, true, asOf - start);
        } else {
          add(
            metric.kind === "outcomes"
              ? c.outcome
              : metric.kind === "variant-counts"
                ? variantId
                : metric.kind,
            c.outcome === "open",
            null,
          );
        }
      }
      const rows = [...buckets.values()].map(({ row, values }) => {
        values.sort((a, b) => a - b);
        return {
          ...row,
          p50Ms: percentile(values, 0.5),
          p75Ms: percentile(values, 0.75),
          p90Ms: percentile(values, 0.9),
        };
      });
      return finish(
        query,
        policy,
        rows,
        { watermark: utc(watermark) < asOf ? watermark : query.asOf, eligibleCases, coveredCases },
        "exact-nearest-rank-fixture",
      );
    },
  };
}
