-- Registered lifecycle process versions (FLIG-25). Immutable: a version's definition never
-- changes once events can reference it; publish a new version instead.
CREATE TABLE process_definitions (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  process_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  -- ProcessDefinitionV1 as validated JSON.
  definition TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (app_id, process_id, version)
) WITHOUT ROWID;
