import { finish } from "./result.js";
import { buildBasinSql, type SqlPlan } from "./sql.js";
import type {
  AggregateRow,
  Evidence,
  Metric,
  Query,
  QueryAdapter,
  QueryRegistry,
  Result,
} from "./types.js";
import { invariant } from "./validate.js";

/** Implement against a read-only Basin credential with time/scan/response byte limits.
 * Decode SQL snake_case columns to AggregateRow, reject partial/failed results, and provide
 * coverage evidence for this exact query and snapshot. No external client is bundled here.
 */
export type BasinExecutor = (
  plan: SqlPlan,
  query: Query,
) => Promise<{ rows: readonly AggregateRow[]; evidence: Evidence }>;
export function createBasinAdapter(
  registry: QueryRegistry,
  execute: BasinExecutor,
  table?: string,
): QueryAdapter {
  // Freeze a private copy: later registry/request mutations cannot change an in-flight plan.
  const policy = structuredClone(registry);
  return {
    async query<M extends Metric>(input: Query<M>): Promise<Result<M>> {
      const query = structuredClone(input);
      const plan = buildBasinSql(query, policy, table);
      const response = await execute(plan, structuredClone(query));
      invariant(
        Array.isArray(response.rows) && response.rows.length <= plan.maxRows,
        "Executor exceeded row limit",
      );
      return finish(query, policy, response.rows, response.evidence, "basin-approx-percentile");
    },
  };
}
