-- Source-authored application architecture graph.
CREATE TABLE IF NOT EXISTS graph_nodes (
  project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  attributes_json TEXT NOT NULL,
  revision TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(project_id,source_id,node_id)
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_kind
  ON graph_nodes(project_id,kind,active);
CREATE TABLE IF NOT EXISTS graph_edges (
  project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  provenance TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_json TEXT NOT NULL,
  revision TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(project_id,source_id,from_id,to_id,relation)
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_from
  ON graph_edges(project_id,source_id,from_id);
-- AI investigation lifecycle. All rows are project-scoped.
CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('proposed','reviewed','archived')),
  model_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  interpretation_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_investigations_project_created
  ON investigations(project_id,created_at);
CREATE TABLE IF NOT EXISTS proposed_actions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  investigation_id TEXT NOT NULL REFERENCES investigations(id),
  action_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  acceptance_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('proposed','approved','rejected')),
  decided_by TEXT,
  approval_rationale TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposed_actions_project
  ON proposed_actions(project_id,status,created_at);
