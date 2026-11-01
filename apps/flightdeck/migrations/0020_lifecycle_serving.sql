-- Lifecycle serving read model (src/lifecycle-serving). Every table is DERIVED: a projector
-- rebuilds it from lifecycle evidence, so dropping all rows for an app and replaying is always
-- safe. Nothing here is an operational source of truth. Numbered 0020 to leave room for the
-- parallel lifecycle ingestion and authorization migrations.
--
-- Rules shared by every table:
-- * app_id leads every primary key and index; every read binds it.
-- * Ids are opaque tokens chosen by the projector (never names, emails or other personal data);
--   labels are short slugs or definition metadata, not free text about people.
-- * No foreign key to apps: a late projection for a deleted app must not fail the projector.
-- * generation/source_watermark/as_of record provenance. A write only lands when it is not
--   older than the row it replaces (see repository.ts).
-- * deleted_at soft-deletes (superseded by a newer generation, retention, or a source tombstone);
--   readers skip soft-deleted rows and purgeDeleted() removes them for good.

-- Per-app projection status: the committed generation readers see, the one being rebuilt, the
-- source watermark the committed data reflects, and the last run's diagnostics (codes only).
-- issued_generation is the highest generation ever begun, so a failed one is never reused.
CREATE TABLE lifecycle_projection_state (
  app_id TEXT PRIMARY KEY,
  active_generation INTEGER NOT NULL DEFAULT 0,
  building_generation INTEGER,
  issued_generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('empty', 'ready', 'rebuilding', 'failed')),
  source_watermark INTEGER,
  as_of INTEGER,
  reducer_version TEXT,
  rows_written INTEGER NOT NULL DEFAULT 0,
  last_success_at INTEGER,
  last_failure_at INTEGER,
  last_error_code TEXT,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE lifecycle_process_definitions (
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

CREATE TABLE lifecycle_case_snapshots (
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

-- Keyset pagination: newest first within one process.
CREATE INDEX lifecycle_cases_by_process
  ON lifecycle_case_snapshots (app_id, process_key, started_at DESC, case_id DESC);
CREATE INDEX lifecycle_cases_by_start
  ON lifecycle_case_snapshots (app_id, started_at DESC, case_id DESC);
CREATE INDEX lifecycle_cases_by_parent ON lifecycle_case_snapshots (app_id, parent_case_id);

-- One row per stage interval of a case; a case snapshot replaces all of its intervals.
-- exited_at is NULL while the interval is open (right-censored).
CREATE TABLE lifecycle_stage_intervals (
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

CREATE INDEX lifecycle_intervals_by_stage
  ON lifecycle_stage_intervals (app_id, stage_key, state);

-- Typed relations between cases other than the parent link (which lives on the case row).
-- Edges are owned by, and replaced with, their from_case_id snapshot.
CREATE TABLE lifecycle_case_edges (
  app_id TEXT NOT NULL,
  from_case_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  to_case_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  PRIMARY KEY (app_id, from_case_id, relation, to_case_id)
) WITHOUT ROWID;

CREATE INDEX lifecycle_edges_by_target ON lifecycle_case_edges (app_id, to_case_id);

-- Requests to rebuild an app's projection from a source watermark. Consumed by a projector
-- that does not exist yet; error codes only, never source payloads.
CREATE TABLE lifecycle_replay_requests (
  app_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  from_watermark INTEGER,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error_code TEXT,
  PRIMARY KEY (app_id, request_id)
) WITHOUT ROWID;

CREATE INDEX lifecycle_replay_by_status
  ON lifecycle_replay_requests (app_id, status, requested_at);
