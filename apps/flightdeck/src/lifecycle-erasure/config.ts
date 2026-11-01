/**
 * Erasure and retention configuration. Everything is OFF unless an operator sets a variable, and
 * every invalid value fails closed (to "off", with the problem listed), so a typo can never turn
 * destructive behavior on. Nothing here reads a credential; the receipt verification key is a
 * public key.
 */

export type Mode = "off" | "dry_run" | "enforce";

/** Unknown, empty or mistyped values are "off". */
export function parseMode(value: unknown): Mode {
  return value === "dry_run" || value === "enforce" ? value : "off";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A Spark/Iceberg identifier `catalog.namespace.table` (also used to render the documented SQL). */
export const ICEBERG_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){1,3}$/;
const POLICY_VERSION = /^[A-Za-z0-9_.:-]{1,64}$/;

type Vars = Record<string, unknown>;

/** A positive integer within [min, max], or undefined (and a problem when `required`/invalid). */
function integer(
  vars: Vars,
  key: string,
  bounds: { min: number; max: number },
  problems: string[],
  fallback?: number,
): number | undefined {
  const raw = vars[key];
  if (raw === undefined || raw === "") {
    if (fallback === undefined) problems.push(`missing_${key.toLowerCase()}`);
    return fallback;
  }
  const n =
    typeof raw === "number" ? raw : /^\d{1,15}$/.test(String(raw)) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < bounds.min || n > bounds.max) {
    problems.push(`invalid_${key.toLowerCase()}`);
    return fallback;
  }
  return n;
}

export type ErasureConfig = {
  /** Effective mode: "off" whenever `problems` is not empty. */
  mode: Mode;
  /** Configured mode before problems were applied (for health output). */
  requestedMode: Mode;
  problems: string[];
  /** Iceberg table that holds forwarded lifecycle events, e.g. `r2dc.flightdeck.lifecycle_events`. */
  table: string;
  /** Wait after the request before the Iceberg DELETE: lets in-flight Pipelines writes land. */
  settleMs: number;
  /** Minimum wait between the verified DELETE and snapshot expiration. */
  cleanupDelayMs: number;
  /** Jobs older than this and not complete are reported overdue. */
  overdueMs: number;
  /** Recorded on every job and audit row. */
  policyVersion: string;
};

export function erasureConfig(env: object): ErasureConfig {
  const vars = env as Vars;
  const requestedMode = parseMode(vars.LIFECYCLE_ERASURE_MODE);
  const problems: string[] = [];
  const table = String(vars.LIFECYCLE_BASIN_TABLE ?? "");
  const policyVersion = String(vars.LIFECYCLE_ERASURE_POLICY_VERSION ?? "");
  const settleMs = integer(
    vars,
    "LIFECYCLE_ERASURE_SETTLE_MS",
    { min: 2 * MINUTE, max: DAY },
    problems,
    15 * MINUTE,
  );
  const cleanupDelayMs = integer(
    vars,
    "LIFECYCLE_ERASURE_CLEANUP_DELAY_MS",
    { min: 1, max: 30 * DAY },
    problems,
    HOUR,
  );
  const overdueMs = integer(
    vars,
    "LIFECYCLE_ERASURE_OVERDUE_MS",
    { min: HOUR, max: 365 * DAY },
    problems,
    30 * DAY,
  );
  if (requestedMode !== "off") {
    if (!ICEBERG_IDENTIFIER.test(table)) problems.push("invalid_lifecycle_basin_table");
    if (!POLICY_VERSION.test(policyVersion))
      problems.push("invalid_lifecycle_erasure_policy_version");
  }
  return {
    mode: problems.length ? "off" : requestedMode,
    requestedMode,
    problems,
    table,
    settleMs: settleMs ?? 15 * MINUTE,
    cleanupDelayMs: cleanupDelayMs ?? HOUR,
    overdueMs: overdueMs ?? 30 * DAY,
    policyVersion,
  };
}

export type RetentionConfig = {
  mode: Mode;
  requestedMode: Mode;
  problems: string[];
  policyVersion: string;
  /** A case is a candidate once it has been closed this long. */
  closedAfterMs: number;
  /** Its newest log row must also be at least this old. */
  logAfterMs: number;
  /** Cases handled per app per run. */
  batch: number;
};

export const SERVED_WINDOW_DAYS = 366;

/** Retention periods are a policy decision: they have no defaults, only validation. */
export function retentionConfig(env: object): RetentionConfig {
  const vars = env as Vars;
  const requestedMode = parseMode(vars.LIFECYCLE_RETENTION_MODE);
  const problems: string[] = [];
  const policyVersion = String(vars.LIFECYCLE_RETENTION_POLICY_VERSION ?? "");
  let closedDays = 0;
  let logDays = 0;
  let batch = 200;
  if (requestedMode !== "off") {
    if (!POLICY_VERSION.test(policyVersion))
      problems.push("invalid_lifecycle_retention_policy_version");
    closedDays =
      integer(vars, "LIFECYCLE_RETENTION_CLOSED_DAYS", { min: 1, max: 3650 }, problems) ?? 0;
    logDays = integer(vars, "LIFECYCLE_RETENTION_LOG_DAYS", { min: 1, max: 3650 }, problems) ?? 0;
    batch = integer(vars, "LIFECYCLE_RETENTION_BATCH", { min: 1, max: 1000 }, problems, 200) ?? 200;
    // The replay log is the rebuild input: it must outlive the served case, never the reverse.
    if (closedDays && logDays && logDays < closedDays)
      problems.push("log_retention_shorter_than_closed");
    // The served read model advertises a 366-day aggregate window; a rebuild after retirement
    // would drop retired cases, so none may be retired while still inside it.
    if (closedDays && closedDays < SERVED_WINDOW_DAYS)
      problems.push("closed_retention_inside_served_window");
  }
  return {
    mode: problems.length ? "off" : requestedMode,
    requestedMode,
    problems,
    policyVersion,
    closedAfterMs: closedDays * DAY,
    logAfterMs: logDays * DAY,
    batch,
  };
}
