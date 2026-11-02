-- FLIG-35 review fixes for the erasure/retention tables created by 0041 (already on main, so it
-- is extended here, never edited). Additive and inert while LIFECYCLE_ERASURE_MODE and
-- LIFECYCLE_RETENTION_MODE are "off". Follows 0042 (serving retention).
--
-- 1. Reconciliation checkpoints (P1-1). A checkpoint recorded under the old rules could cover a
--    sequence range that did not exist yet, and so authorize pruning of rows that were never
--    reconciled. They cannot be told apart from honest ones, so every existing checkpoint is
--    dropped: retention retires nothing until an app is reconciled again under the new rules
--    (bounded by the allocated sequence, with a digest of the exact rows).
-- 2. Writer fence for the Basin outbox (P1-2).
-- 3. Physical-cleanup contract (P1-3): the job remembers how the Iceberg DELETE was written, which
--    data files held the rows, and when cleanup may first run (P2-4).

DELETE FROM lifecycle_retention_checkpoints;
ALTER TABLE lifecycle_retention_checkpoints ADD COLUMN allocated_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lifecycle_retention_checkpoints ADD COLUMN rows_digest TEXT NOT NULL DEFAULT '';
-- Where the next retention run resumes scanning (case_id), so a case that stays blocked cannot
-- starve the ones behind it (P2-5). '' starts from the beginning.
ALTER TABLE lifecycle_retention_checkpoints ADD COLUMN scan_cursor TEXT NOT NULL DEFAULT '';

-- ALTER TABLE cannot add a CHECK that mentions other columns, so these hold the invariants.
CREATE TRIGGER lifecycle_checkpoint_bounds_insert BEFORE INSERT ON lifecycle_retention_checkpoints
WHEN NEW.allocated_seq < NEW.reconciled_through_seq
  OR length(NEW.rows_digest) != 64 OR NEW.rows_digest GLOB '*[^0-9a-f]*'
BEGIN
  SELECT RAISE(ABORT, 'checkpoint_outside_allocated_range_or_unattested');
END;
CREATE TRIGGER lifecycle_checkpoint_bounds_update BEFORE UPDATE ON lifecycle_retention_checkpoints
WHEN NEW.allocated_seq < NEW.reconciled_through_seq
  OR length(NEW.rows_digest) != 64 OR NEW.rows_digest GLOB '*[^0-9a-f]*'
  OR NEW.reconciled_through_seq < OLD.reconciled_through_seq
BEGIN
  SELECT RAISE(ABORT, 'checkpoint_outside_allocated_range_or_unattested');
END;

-- Cases claimed by an in-flight outbox send. forwardOutbox claims the cases of a batch before
-- handing rows to Pipelines (only while erasure is enabled) and releases the claim when the send
-- returns or fails. A claim is never granted to a tombstoned case, and an erasure job does not
-- accept a logical-delete receipt while a claim is live, or before released_at (lease_until, if
-- the sender died) plus the drain bound. Ids and timestamps only; pruned after two days.
CREATE TABLE lifecycle_forward_claims (
  claim_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  released_at INTEGER,
  PRIMARY KEY (claim_id, app_id, case_id)
) WITHOUT ROWID;
CREATE INDEX lifecycle_forward_claims_by_case ON lifecycle_forward_claims (app_id, case_id);

ALTER TABLE lifecycle_erasure_jobs ADD COLUMN logical_delete_mode TEXT
  CHECK (logical_delete_mode IS NULL OR logical_delete_mode IN ('copy_on_write', 'merge_on_read'));
-- sha256 of the sorted data-file paths that held the identity's rows before the DELETE, and how
-- many there were. The physical receipt must show those exact files gone.
ALTER TABLE lifecycle_erasure_jobs ADD COLUMN logical_affected_digest TEXT
  CHECK (logical_affected_digest IS NULL
    OR (length(logical_affected_digest) = 64 AND logical_affected_digest NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE lifecycle_erasure_jobs ADD COLUMN logical_affected_files INTEGER;
-- Earliest time physical cleanup may have run (logical commit + configured cleanup delay).
ALTER TABLE lifecycle_erasure_jobs ADD COLUMN cleanup_not_before INTEGER;

-- A job may only reach the stages that follow a logical delete with the new evidence recorded.
-- (0041's CHECKs already require the checksum, snapshot and times; a trigger adds the rest.)
CREATE TRIGGER lifecycle_erasure_contract BEFORE UPDATE OF stage ON lifecycle_erasure_jobs
WHEN NEW.stage IN ('basin_verified', 'files_cleanup_pending', 'complete')
  AND (NEW.logical_delete_mode IS NULL OR NEW.logical_affected_digest IS NULL
    OR NEW.cleanup_not_before IS NULL AND NEW.stage != 'basin_verified')
BEGIN
  SELECT RAISE(ABORT, 'erasure_physical_contract_incomplete');
END;
