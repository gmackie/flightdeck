-- A serving retention decision survives staging, purging and full rebuilds.
-- Cutoffs only advance. Staging remains in the already published migration 0032.
CREATE TABLE lifecycle_retention_policy (
  app_id TEXT PRIMARY KEY,
  closed_before INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
