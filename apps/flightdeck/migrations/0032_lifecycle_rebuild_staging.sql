-- Isolated rebuild storage. Serving tables retain the committed generation until
-- repository.commitRebuild publishes all four staged tables in one D1 batch transaction.
-- No source evidence or existing serving rows are modified by this additive migration.

CREATE TABLE lifecycle_process_definitions_staging (
  app_id TEXT NOT NULL,
  process_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  label TEXT NOT NULL,
  -- JSON array of { key, label, terminal } in definition order.
  stages_json TEXT NOT NULL,
  generation INTEGER NOT NULL,
  source_watermark INTEGER NOT NULL,
  as_of INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_reason TEXT,
  PRIMARY KEY (app_id, process_key, version)
) WITHOUT ROWID;

CREATE TABLE lifecycle_case_snapshots_staging (
  app_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  process_key TEXT NOT NULL,
  process_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  outcome TEXT,
  current_stage TEXT,
  parent_case_id TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_event_at INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  source_watermark INTEGER NOT NULL,
  reducer_version TEXT NOT NULL,
  as_of INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_reason TEXT,
  PRIMARY KEY (app_id, case_id),
  CHECK ((status = 'open' AND ended_at IS NULL) OR (status = 'closed' AND ended_at IS NOT NULL))
) WITHOUT ROWID;

CREATE TABLE lifecycle_stage_intervals_staging (
  app_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  stage_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'blocked')),
  entered_at INTEGER NOT NULL,
  exited_at INTEGER,
  outcome TEXT,
  generation INTEGER NOT NULL,
  PRIMARY KEY (app_id, case_id, seq),
  CHECK (exited_at IS NULL OR exited_at >= entered_at)
) WITHOUT ROWID;

CREATE TABLE lifecycle_case_edges_staging (
  app_id TEXT NOT NULL,
  from_case_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  to_case_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  PRIMARY KEY (app_id, from_case_id, relation, to_case_id)
) WITHOUT ROWID;

