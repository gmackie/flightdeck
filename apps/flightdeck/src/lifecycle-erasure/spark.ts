import { ICEBERG_IDENTIFIER } from "./config";
import { sha256Hex } from "./receipt";

/**
 * The documented Iceberg maintenance statements for a runner to execute. Rendering text is all
 * this module does: Flightdeck never runs these, holds no catalog credential, and the statements
 * are UNVERIFIED against a real Basin catalog (see docs/operations/lifecycle-erasure-retention.md).
 *
 * Basin SQL is read-only, and R2 data/metadata files must never be deleted by hand: both the
 * DELETE and the cleanup go through the catalog in an Iceberg-compatible engine.
 */

/** App-scoped stable hashed identity of a case; Spark recomputes it from the row's own columns. */
export const caseDigest = (appId: string, caseId: string) =>
  sha256Hex(`flightdeck.erasure.v1|${appId}|${caseId}`);

/**
 * Logical deletion. Named parameters (`spark.sql(statement, args={...})`) carry the values; the
 * predicate matches on the hashed identity so the statement text never contains a case id. It is
 * a no-op when no row matches, so re-running it is safe. Creates a new snapshot; older snapshots
 * still reference the deleted rows until they are expired.
 */
export function deleteStatement(table: string): string {
  assertTable(table);
  return `DELETE FROM ${table}
WHERE app_id = :app_id
  AND sha2(concat_ws('|', 'flightdeck.erasure.v1', app_id, case_id), 256) = :case_digest`;
}

/** Read-only check, also valid as Basin SQL, that no row of the identity remains. */
export function residualCountStatement(table: string): string {
  assertTable(table);
  return `SELECT count(*) AS rows_remaining FROM ${table}
WHERE app_id = :app_id
  AND sha2(concat_ws('|', 'flightdeck.erasure.v1', app_id, case_id), 256) = :case_digest`;
}

/**
 * Physical cleanup, after the DELETE committed at `deleteCommittedAt`. `retain_last` MUST be 1:
 * a larger value (or an automatic policy with `--retain-last 5`) keeps older snapshots, and the
 * deleted rows with them, until enough newer snapshots exist.
 */
export function cleanupStatements(table: string, deleteCommittedAtMs: number): string[] {
  assertTable(table);
  const [catalog, ...rest] = table.split(".");
  const iso = new Date(deleteCommittedAtMs).toISOString().replace("T", " ").replace("Z", "");
  return [
    `CALL ${catalog}.system.expire_snapshots(table => '${rest.join(".")}', older_than => TIMESTAMP '${iso}', retain_last => 1)`,
    `CALL ${catalog}.system.remove_orphan_files(table => '${rest.join(".")}')`,
  ];
}

function assertTable(table: string) {
  if (!ICEBERG_IDENTIFIER.test(table)) throw new Error("invalid_iceberg_identifier");
}
