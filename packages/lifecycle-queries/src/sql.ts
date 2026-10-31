import type { Dimension, Query, QueryRegistry } from "./types.js";
import { groups, invariant, utc, validateQuery } from "./validate.js";

const COLUMNS: Record<Dimension, string> = {
  caseMix: "case_mix",
  cohortId: "cohort_id",
  definitionVersion: "definition_version",
  variantId: "variant_id",
  outcome: "outcome",
};
export interface SqlPlan {
  readonly sql: string;
  readonly readOnly: true;
  readonly dialect: "basin-datafusion-candidate";
  readonly maxRows: number;
  readonly columns: readonly [
    "key",
    "arm",
    "sample_size",
    "observed_cases",
    "censored_cases",
    "count",
    "p50_ms",
    "p75_ms",
    "p90_ms",
  ];
  readonly groupColumns: readonly Dimension[];
}
// Query values are deliberately restricted to registered tokens; this is not a general SQL escaper.
function literal(value: string) {
  return `'${value}'`;
}
function list(values: readonly string[]) {
  return values.map(literal).join(", ");
}
function tableName(table: string) {
  invariant(
    typeof table === "string" && /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*){0,2}$/.test(table),
    "Invalid table identifier",
  );
  return table
    .split(".")
    .map((part) => `"${part}"`)
    .join(".");
}
function mapping(
  query: Query,
  registry: QueryRegistry,
  field: "stages" | "checkpoints" | "variants",
  column: string,
) {
  const branches = query.definitionVersions.flatMap((version) =>
    Object.entries(registry.versions[version]?.[field] ?? {}).map(
      ([physical, canonical]) =>
        `WHEN definition_version = ${literal(version)} AND ${column} = ${literal(physical)} THEN ${literal(canonical)}`,
    ),
  );
  return branches.length ? `CASE ${branches.join(" ")} ELSE NULL END` : "CAST(NULL AS VARCHAR)";
}
/** Generates only SELECT/CTEs over a caller-configured normalized Iceberg facts table.
 * The caller must validate the candidate dialect against its Basin deployment before enabling it.
 */
export function buildBasinSql(
  query: Query,
  registry: QueryRegistry,
  table = "lifecycle_facts",
): SqlPlan {
  validateQuery(query, registry);
  const tableSql = tableName(table);
  const dimensions = groups(query);
  const dimensionSelect = dimensions
    .map((dimension) => `, ${COLUMNS[dimension]} AS "${dimension}"`)
    .join("");
  const dimensionGroup = dimensions.map((dimension) => `, "${dimension}"`).join("");
  const from = utc(query.from),
    to = utc(query.to),
    asOf = utc(query.asOf);
  const arms = [
    { arm: "primary", cohort: query.cohort },
    ...(query.metric.kind === "comparison"
      ? [{ arm: "reference", cohort: query.metric.reference }]
      : []),
  ];
  const selected = arms
    .map(
      ({ arm, cohort }) => `SELECT *, '${arm}' AS arm FROM mapped
    WHERE cohort_id = ${literal(cohort.id)} AND case_mix IN (${list(cohort.caseMix)})
    ${query.filters.map((filter) => `AND ${COLUMNS[filter.field]} IN (${list(filter.values)})`).join("\n    ")}`,
    )
    .join("\nUNION ALL\n");
  const metric = query.metric;
  let observations: string;
  if (metric.kind === "stage-dwell" || metric.kind === "comparison") {
    observations = `SELECT c.*, ${literal(metric.stageId)} AS key,
      SUM(CASE WHEN i.exited_at_ms IS NOT NULL THEN i.exited_at_ms - i.entered_at_ms ELSE 0 END) AS duration_ms,
      MAX(CASE WHEN i.exited_at_ms IS NULL THEN 1 ELSE 0 END) AS censored,
      1 AS value_count
    FROM cases c JOIN selected i ON c.case_id = i.case_id AND c.arm = i.arm AND c.revision = i.revision
    WHERE i.fact_kind = 'interval' AND i.stage_id = ${literal(metric.stageId)}
    GROUP BY ${["case_id", "revision", "arm", "case_started_at_ms", "case_ended_at_ms", ...Object.values(COLUMNS)].map((column) => `c.${column}`).join(", ")}
    HAVING MIN(CASE WHEN i.entered_at_ms >= c.case_started_at_ms AND i.entered_at_ms <= ${asOf}
      AND (i.exited_at_ms IS NULL OR (i.exited_at_ms >= i.entered_at_ms AND i.exited_at_ms <= ${asOf}))
      AND (c.case_ended_at_ms IS NULL OR (i.exited_at_ms IS NOT NULL AND i.exited_at_ms <= c.case_ended_at_ms))
      THEN 1 ELSE 0 END) = 1`;
  } else if (metric.kind === "funnel") {
    const joins = metric.checkpoints
      .map(
        (
          checkpoint,
          index,
        ) => `LEFT JOIN selected p${index} ON p${index}.case_id = c.case_id AND p${index}.revision = c.revision AND p${index}.arm = c.arm
      AND p${index}.fact_kind = 'checkpoint' AND p${index}.checkpoint_id = ${literal(checkpoint)}
      AND p${index}.reached_at_ms >= c.case_started_at_ms AND p${index}.reached_at_ms <= COALESCE(c.case_ended_at_ms, ${asOf})`,
      )
      .join("\n");
    const funnel = metric.checkpoints.map((checkpoint, index) => {
      const ordered = Array.from(
        { length: index + 1 },
        (_, n) =>
          `p${n}.reached_at_ms IS NOT NULL${n > 0 ? ` AND p${n}.sequence_no > p${n - 1}.sequence_no AND p${n}.reached_at_ms >= p${n - 1}.reached_at_ms` : ""}`,
      ).join(" AND ");
      return `SELECT c.*, ${literal(checkpoint)} AS key, CAST(NULL AS DOUBLE) AS duration_ms,
      CASE WHEN c.outcome = 'open' THEN 1 ELSE 0 END AS censored, 1 AS value_count
      FROM cases c ${joins} WHERE ${ordered}`;
    });
    observations = funnel.join("\nUNION ALL\n");
  } else {
    const key =
      metric.kind === "outcomes"
        ? "outcome"
        : metric.kind === "variant-counts"
          ? "variant_id"
          : literal(metric.kind);
    observations = `SELECT *, ${key} AS key,
      ${metric.kind === "current-open-age" ? `${asOf} - case_started_at_ms` : "CAST(NULL AS DOUBLE)"} AS duration_ms,
      CASE WHEN outcome = 'open' THEN 1 ELSE 0 END AS censored, 1 AS value_count
      FROM cases ${metric.kind === "current-open-age" ? "WHERE outcome = 'open'" : ""}`;
  }
  // Dwell percentiles exclude right censored durations; current age describes censored cases.
  const duration =
    metric.kind === "current-open-age"
      ? "duration_ms"
      : "CASE WHEN censored = 0 THEN duration_ms ELSE NULL END";
  const maxRows = metric.kind === "comparison" ? (query.topN + 1) * 2 : query.topN + 1;
  const sql = `WITH partitioned AS (
  SELECT *, DENSE_RANK() OVER (PARTITION BY case_id ORDER BY revision DESC) AS revision_rank,
    ROW_NUMBER() OVER (PARTITION BY case_id, revision, fact_id ORDER BY recorded_at_ms DESC) AS duplicate_rank
  FROM ${tableSql}
  WHERE app_id = ${literal(query.appId)} AND definition_id = ${literal(query.definitionId)}
    AND cohort_day >= ${literal(query.from.slice(0, 10))} AND cohort_day <= ${literal(query.to.slice(0, 10))}
    AND case_started_at_ms >= ${from} AND case_started_at_ms < ${to}
    AND recorded_at_ms <= ${asOf}
), latest AS (
  SELECT * FROM partitioned WHERE revision_rank = 1 AND duplicate_rank = 1
    AND definition_version IN (${list(query.definitionVersions)})
), mapped AS (
  SELECT fact_id, case_id, revision, fact_kind, case_started_at_ms, case_ended_at_ms,
    cohort_id, case_mix, definition_version, outcome, entered_at_ms, exited_at_ms, reached_at_ms, sequence_no,
    ${mapping(query, registry, "stages", "stage_id")} AS stage_id,
    ${mapping(query, registry, "checkpoints", "checkpoint_id")} AS checkpoint_id,
    ${mapping(query, registry, "variants", "variant_id")} AS variant_id
  FROM latest
), selected AS (
  ${selected}
), cases AS (
  SELECT case_id, revision, arm, case_started_at_ms, case_ended_at_ms, ${Object.values(COLUMNS).join(", ")}
  FROM selected WHERE fact_kind = 'case' AND variant_id IS NOT NULL
    AND ((outcome = 'open' AND case_ended_at_ms IS NULL) OR
      (outcome IN ('completed', 'cancelled', 'failed') AND case_ended_at_ms >= case_started_at_ms AND case_ended_at_ms <= ${asOf}))
), observations AS (
  ${observations}
), aggregates AS (
  SELECT key, arm${dimensionSelect}, COUNT(DISTINCT case_id) AS sample_size,
    COUNT(DISTINCT CASE WHEN censored = 0 THEN case_id ELSE NULL END) AS observed_cases,
    COUNT(DISTINCT CASE WHEN censored = 1 THEN case_id ELSE NULL END) AS censored_cases,
    SUM(value_count) AS count,
    APPROX_PERCENTILE_CONT(${duration}, 0.50) AS p50_ms,
    APPROX_PERCENTILE_CONT(${duration}, 0.75) AS p75_ms,
    APPROX_PERCENTILE_CONT(${duration}, 0.90) AS p90_ms
  FROM observations GROUP BY key, arm${dimensions.map((dimension) => `, ${COLUMNS[dimension]}`).join("")}
)${
    metric.kind === "comparison"
      ? `, top_keys AS (
  SELECT key${dimensionGroup}, SUM(sample_size) AS total FROM aggregates
  GROUP BY key${dimensionGroup} ORDER BY total DESC, key${dimensionGroup} LIMIT ${query.topN + 1}
)`
      : ""
  }
SELECT a.* FROM aggregates a${metric.kind === "comparison" ? ` JOIN top_keys t ON a.key = t.key${dimensions.map((dimension) => ` AND a."${dimension}" = t."${dimension}"`).join("")}` : ""}
ORDER BY ${metric.kind === "comparison" ? "t.total" : "a.sample_size"} DESC, a.key${dimensions.map((dimension) => `, a."${dimension}"`).join("")}, a.arm
LIMIT ${maxRows}`;
  return {
    sql,
    readOnly: true,
    dialect: "basin-datafusion-candidate",
    maxRows,
    columns: [
      "key",
      "arm",
      "sample_size",
      "observed_cases",
      "censored_cases",
      "count",
      "p50_ms",
      "p75_ms",
      "p90_ms",
    ],
    groupColumns: dimensions,
  };
}
