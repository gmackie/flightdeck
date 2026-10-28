-- Query admission: relative units are a safety budget, not Cloudflare charges.
CREATE TABLE IF NOT EXISTS query_budgets (
  project_id TEXT NOT NULL,
  period TEXT NOT NULL,
  units_used INTEGER NOT NULL DEFAULT 0 CHECK(units_used >= 0),
  units_limit INTEGER NOT NULL CHECK(units_limit >= 0),
  PRIMARY KEY(project_id, period)
);
CREATE TABLE IF NOT EXISTS query_audit (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  query_kind TEXT NOT NULL,
  units_reserved INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_query_audit_project_created
  ON query_audit(project_id,created_at);
