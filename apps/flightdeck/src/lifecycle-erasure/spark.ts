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
 * Read-only, run BEFORE the DELETE: the data files that hold the identity's rows. The runner
 * records sha256 of the sorted paths in the logical receipt, and the physical receipt must show
 * those same files gone. Paths hold no case content.
 */
export function affectedFilesStatement(table: string): string {
  assertTable(table);
  return `SELECT DISTINCT input_file_name() AS file_path FROM ${table}
WHERE app_id = :app_id
  AND sha2(concat_ws('|', 'flightdeck.erasure.v1', app_id, case_id), 256) = :case_digest
ORDER BY file_path`;
}

/**
 * Materializes a merge-on-read DELETE. A merge-on-read DELETE only writes a delete file: the
 * original data file keeps the bytes and is still referenced. (A copy-on-write DELETE rewrites
 * the file itself, so this step is a no-op there.) Run after the DELETE, as its own commit.
 */
export function materializeStatements(table: string, appId: string): string[] {
  assertTable(table);
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(appId)) throw new Error("invalid_app_id");
  const [catalog, ...rest] = table.split(".");
  const name = rest.join(".");
  return [
    `CALL ${catalog}.system.rewrite_data_files(table => '${name}', where => "app_id = '${appId}'", options => map('delete-file-threshold', '1'))`,
    `CALL ${catalog}.system.rewrite_position_delete_files(table => '${name}', options => map('rewrite-all', 'true'))`,
  ];
}

/**
 * Physical cleanup. `materializedAtMs` is the commit time of the rewrite (the DELETE for
 * copy-on-write): snapshots older than it still reference the original files. `retain_last` MUST
 * be 1: a larger value (or an automatic policy with `--retain-last 5`) keeps older snapshots, and
 * the deleted bytes with them, until enough newer snapshots exist.
 */
export function cleanupStatements(table: string, materializedAtMs: number): string[] {
  assertTable(table);
  const [catalog, ...rest] = table.split(".");
  const iso = new Date(materializedAtMs).toISOString().replace("T", " ").replace("Z", "");
  return [
    `CALL ${catalog}.system.expire_snapshots(table => '${rest.join(".")}', older_than => TIMESTAMP '${iso}', retain_last => 1)`,
    `CALL ${catalog}.system.remove_orphan_files(table => '${rest.join(".")}')`,
  ];
}

function assertTable(table: string) {
  if (!ICEBERG_IDENTIFIER.test(table)) throw new Error("invalid_iceberg_identifier");
}
