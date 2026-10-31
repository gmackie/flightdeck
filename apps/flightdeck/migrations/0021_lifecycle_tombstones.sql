-- Persistent case deletions for the lifecycle serving read model (src/lifecycle-serving).
-- A tombstone outlives the case row, rebuilds, dropApp() and purgeDeleted(): it is the one
-- piece of serving state a replay must not recreate. It is recorded even when the case was never
-- projected, so a late or replayed snapshot cannot bring a deleted case back.
--
-- While a tombstone is active (restored_at IS NULL) every write for the case is refused, at any
-- generation or watermark. An explicitly authorized restore (restored_at set) re-admits only
-- snapshots strictly newer than source_watermark, so the pre-deletion evidence stays dead.
--
-- Holds only the opaque case id, slugs and numbers: no case content, no principal identity.
-- restore_ref is an opaque approval reference supplied by the authorizer.
CREATE TABLE lifecycle_case_tombstones (
  app_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_watermark INTEGER NOT NULL,
  as_of INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL,
  restored_at INTEGER,
  restore_reason TEXT,
  restore_ref TEXT,
  PRIMARY KEY (app_id, case_id)
) WITHOUT ROWID;
