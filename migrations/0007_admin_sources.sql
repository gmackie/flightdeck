-- Dynamic source credentials administered through Access-protected console.
-- No plaintext token is persisted here. All entries are account and project scoped.
CREATE TABLE IF NOT EXISTS source_credentials (
  project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  token_sha256 TEXT NOT NULL,
  previous_sha256 TEXT,
  policy_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(project_id,source_id)
);
CREATE INDEX IF NOT EXISTS idx_source_credentials_project
  ON source_credentials(project_id,enabled);

-- Source identity is global within an installation; project is resolved server-side.
CREATE UNIQUE INDEX IF NOT EXISTS uq_source_credentials_id ON source_credentials(source_id);
