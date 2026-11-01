-- Lifecycle erasure jobs and retention bookkeeping (src/lifecycle-erasure). Additive and inert
-- until LIFECYCLE_ERASURE_MODE / LIFECYCLE_RETENTION_MODE are set: nothing reads or writes these
-- tables while both are "off" (the default).
--
-- Ordering: 0041 follows 0040_lifecycle_privacy_budget.sql from the privacy PR (#54), which
-- must be applied first. This file touches none of that migration's tables and depends on no
-- column from it; the number only reserves a free slot after it (0031 is the latest on main).
-- It reads lifecycle_snapshot_tombstones (0031) only through application code.
--
-- Rules shared by every table:
-- * app_id leads every key and every read binds it. No foreign key to apps: erasure evidence must
--   outlive the app registration.
-- * Machine-safe only. Ids are opaque tokens, every code column is a short [a-z0-9_.:-] token
--   enforced by CHECK, checksums are lowercase hex SHA-256. No names, emails, free text, row
--   payloads, receipts' raw bodies or credentials are stored.

-- One row per (case, purge generation). The D1 side of an erasure request: the tombstone hides
-- and suppresses the case locally at once; the job tracks the external Basin (Iceberg) deletion,
-- which D1 cannot perform or prove by itself. stage 'complete' is only reachable with a verified
-- logical-delete receipt AND a verified physical-cleanup receipt (enforced by the CHECKs below,
-- not just by application code).
--   requested             accepted; local hiding not yet verified
--   local_hidden          D1 evidence, queue, diagnostics and served rows gone; tombstone holds
--   basin_pending         waiting out the settle window / for a logical-delete receipt
--   basin_verified        Iceberg DELETE committed and verified. LOGICAL ONLY: files still exist
--   files_cleanup_pending waiting for snapshot expiration + orphan cleanup receipt
--   complete              physical cleanup verified; the only state that may be reported as erased
--   failed                retries exhausted or a non-retryable error; an operator must reopen
CREATE TABLE lifecycle_erasure_jobs (
  app_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  purge_generation INTEGER NOT NULL CHECK (purge_generation >= 1),
  -- sha256(case_id) in lowercase hex: the stable hashed identity used for Basin-side deletion
  -- and the only identity the audit table carries.
  case_digest TEXT NOT NULL CHECK (length(case_digest) = 64 AND case_digest NOT GLOB '*[^0-9a-f]*'),
  -- Random per request; binds receipts to exactly this job (no replay across generations).
  nonce TEXT NOT NULL CHECK (length(nonce) = 32 AND nonce NOT GLOB '*[^0-9a-f]*'),
  stage TEXT NOT NULL CHECK (stage IN ('requested', 'local_hidden', 'basin_pending',
    'basin_verified', 'files_cleanup_pending', 'complete', 'failed')),
  failed_stage TEXT CHECK (failed_stage IS NULL OR failed_stage IN ('requested', 'local_hidden',
    'basin_pending', 'basin_verified', 'files_cleanup_pending')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 64 AND reason NOT GLOB '*[^a-z0-9_.:-]*'),
  requested_by TEXT NOT NULL CHECK (length(requested_by) BETWEEN 1 AND 64
    AND requested_by NOT GLOB '*[^a-z0-9_.:-]*'),
  requested_at INTEGER NOT NULL,
  retention_policy_version TEXT NOT NULL CHECK (length(retention_policy_version) BETWEEN 1 AND 64
    AND retention_policy_version NOT GLOB '*[^A-Za-z0-9_.:-]*'),
  -- Optimistic concurrency and a lease, so overlapping cron runs never double-dispatch a step.
  version INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error_code TEXT CHECK (last_error_code IS NULL OR (length(last_error_code) BETWEEN 1 AND 64
    AND last_error_code NOT GLOB '*[^a-z0-9_.:-]*')),
  -- Earliest time the Iceberg DELETE may run: lets in-flight Pipelines sends land first.
  settle_until INTEGER,
  -- Evidence rows at request time. forwarded_rows is rows that MAY have reached Basin (sent, or
  -- attempted); it is informational (Basin can drop non-conforming rows), never a pass/fail gate.
  local_rows_removed INTEGER NOT NULL DEFAULT 0,
  forwarded_rows INTEGER NOT NULL DEFAULT 0,
  last_verified_at INTEGER,
  evidence_checksum TEXT CHECK (evidence_checksum IS NULL OR (length(evidence_checksum) = 64
    AND evidence_checksum NOT GLOB '*[^0-9a-f]*')),
  -- Logical deletion (Iceberg DELETE snapshot) facts from a verified receipt.
  logical_snapshot_id TEXT CHECK (logical_snapshot_id IS NULL OR (length(logical_snapshot_id) BETWEEN 1 AND 40
    AND logical_snapshot_id NOT GLOB '*[^0-9a-zA-Z_-]*')),
  logical_committed_at INTEGER,
  logical_rows_deleted INTEGER,
  logical_receipt_checksum TEXT CHECK (logical_receipt_checksum IS NULL OR (length(logical_receipt_checksum) = 64
    AND logical_receipt_checksum NOT GLOB '*[^0-9a-f]*')),
  logical_verified_at INTEGER,
  -- Physical cleanup (snapshot expiration + orphan file removal) facts from a verified receipt.
  physical_receipt_checksum TEXT CHECK (physical_receipt_checksum IS NULL OR (length(physical_receipt_checksum) = 64
    AND physical_receipt_checksum NOT GLOB '*[^0-9a-f]*')),
  physical_verified_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, case_id, purge_generation),
  CHECK ((stage = 'failed') = (failed_stage IS NOT NULL)),
  CHECK ((stage = 'complete') = (completed_at IS NOT NULL)),
  CHECK (stage NOT IN ('basin_verified', 'files_cleanup_pending', 'complete')
    OR (logical_receipt_checksum IS NOT NULL AND logical_snapshot_id IS NOT NULL
        AND logical_committed_at IS NOT NULL AND logical_verified_at IS NOT NULL)),
  CHECK (stage != 'complete'
    OR (physical_receipt_checksum IS NOT NULL AND physical_verified_at IS NOT NULL
        AND evidence_checksum IS NOT NULL AND last_verified_at IS NOT NULL))
) WITHOUT ROWID;
CREATE INDEX lifecycle_erasure_due ON lifecycle_erasure_jobs (next_attempt_at, app_id)
  WHERE stage NOT IN ('complete', 'failed');

-- Append-only machine audit: one row per stage transition or rejected receipt. Keyed by the
-- hashed identity, never the case id. actor_kind is who acted; actor_id is an opaque token.
CREATE TABLE lifecycle_erasure_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  case_digest TEXT NOT NULL CHECK (length(case_digest) = 64 AND case_digest NOT GLOB '*[^0-9a-f]*'),
  purge_generation INTEGER NOT NULL,
  stage TEXT NOT NULL,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64 AND code NOT GLOB '*[^a-z0-9_.:-]*'),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('operator', 'system', 'executor')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 64 AND actor_id NOT GLOB '*[^a-z0-9_.:-]*'),
  at INTEGER NOT NULL,
  last_verified_at INTEGER,
  retention_policy_version TEXT NOT NULL,
  evidence_checksum TEXT CHECK (evidence_checksum IS NULL OR (length(evidence_checksum) = 64
    AND evidence_checksum NOT GLOB '*[^0-9a-f]*'))
);
CREATE INDEX lifecycle_erasure_events_by_job
  ON lifecycle_erasure_events (app_id, case_digest, purge_generation, id);

-- Cases whose replay log was compacted by retention (not erased). Each also gets a
-- lifecycle_case_tombstones row with reason 'retention_expired', so a late event, retry or
-- backfill cannot resurrect a partial case from the few rows that arrive after compaction.
CREATE TABLE lifecycle_retired_cases (
  app_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 64
    AND policy_version NOT GLOB '*[^A-Za-z0-9_.:-]*'),
  rows_removed INTEGER NOT NULL,
  retired_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, case_id)
) WITHOUT ROWID;

-- The newest verified Basin reconciliation per app: Basin was confirmed to hold every D1 log row
-- with seq <= reconciled_through_seq. Retention never retires rows beyond it. Written only from
-- a signed attestation (see receipt.ts), never from an unsigned caller claim.
CREATE TABLE lifecycle_retention_checkpoints (
  app_id TEXT PRIMARY KEY,
  reconciled_through_seq INTEGER NOT NULL CHECK (reconciled_through_seq >= 0),
  verified_at INTEGER NOT NULL,
  evidence_checksum TEXT NOT NULL CHECK (length(evidence_checksum) = 64
    AND evidence_checksum NOT GLOB '*[^0-9a-f]*'),
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
