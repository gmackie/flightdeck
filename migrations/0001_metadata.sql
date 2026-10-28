-- Flightdeck metadata. Raw product events belong in Basin, not D1.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sources_project ON sources(project_id);
CREATE TABLE IF NOT EXISTS event_definitions (
  project_id TEXT NOT NULL REFERENCES projects(id),
  event_name TEXT NOT NULL,
  version INTEGER NOT NULL,
  schema_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(project_id,event_name,version)
);
CREATE TABLE IF NOT EXISTS saved_insights (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  query_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_saved_insights_project ON saved_insights(project_id,updated_at);
CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS journey_definitions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  object_type TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  initial_state TEXT NOT NULL,
  transitions_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_journey_project_type ON journey_definitions(project_id,object_type,enabled);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_id TEXT,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_project_time ON audit_log(project_id,created_at);
