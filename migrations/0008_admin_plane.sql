-- Flightdeck administrator control plane.
-- No raw source tokens, SQL credentials, Cloudflare tokens or secrets in D1.
CREATE TABLE IF NOT EXISTS admin_settings (
  project_id TEXT PRIMARY KEY,
  query_units_monthly INTEGER NOT NULL DEFAULT 50000 CHECK(query_units_monthly BETWEEN 0 AND 100000000),
  ai_investigations_daily INTEGER NOT NULL DEFAULT 3 CHECK(ai_investigations_daily BETWEEN 0 AND 100),
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS admin_change_requests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','applying','applied','rejected','failed')),
  reviewed_by TEXT,
  review_rationale TEXT,
  proposed_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_change_requests_project
 ON admin_change_requests(project_id,status,proposed_at);
