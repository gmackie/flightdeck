/**
 * The seam to the external Iceberg-compatible transaction engine. Basin SQL is SELECT-only, so
 * Flightdeck can neither delete forwarded rows nor expire snapshots itself; a maintenance runner
 * (for example Spark with the Iceberg catalog, see spark.ts) must. This interface is how a runner
 * would be plugged in. No implementation ships: the default fails closed and never reports
 * success, so an erasure job can only complete with signed receipts from a real runner.
 *
 * Executors return `unknown` on purpose: whatever they return is untrusted until
 * receipt.ts has authenticated it against the job.
 */

export type ExecutorRequest = {
  appId: string;
  /** Opaque producer case id (never PII by contract). */
  caseId: string;
  /** App-scoped hashed identity: see caseDigest() in spark.ts. */
  caseDigest: string;
  purgeGeneration: number;
  /** Per-request nonce the receipt must echo. */
  nonce: string;
  /** Iceberg table, `catalog.namespace.table`. */
  table: string;
  /** The DELETE must not commit before this (in-flight Pipelines writes have landed). */
  notBefore: number;
};

export type CleanupRequest = ExecutorRequest & {
  /** The verified DELETE snapshot and its checksum: cleanup is relative to them. */
  deleteSnapshotId: string;
  deleteCommittedAt: number;
  logicalReceiptChecksum: string;
};

export interface BasinErasureExecutor {
  /** Runs the conditional Iceberg DELETE and returns a signed `logical_delete` receipt. */
  deleteForwardedRows(request: ExecutorRequest): Promise<unknown>;
  /** Expires pre-DELETE snapshots, removes orphan files, returns a signed `physical_cleanup` receipt. */
  expireAndCleanup(request: CleanupRequest): Promise<unknown>;
}

/** Operator-fixable: no runner is configured. The job waits; no attempt is spent. */
export class ExecutorUnavailable extends Error {
  readonly code = "executor_unconfigured";
  constructor() {
    super("executor_unconfigured");
    this.name = "ExecutorUnavailable";
  }
}

/** The runner accepted the work and has no receipt yet: poll again later, no attempt spent. */
export class ExecutorPending extends Error {
  readonly code = "executor_pending";
  constructor() {
    super("executor_pending");
    this.name = "ExecutorPending";
  }
}

/** A runner failure. `code` is machine-safe; messages are never stored or logged. */
export class ExecutorError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = true,
  ) {
    super(code);
    this.name = "ExecutorError";
  }
}

export const failClosedExecutor: BasinErasureExecutor = {
  async deleteForwardedRows() {
    throw new ExecutorUnavailable();
  },
  async expireAndCleanup() {
    throw new ExecutorUnavailable();
  },
};
