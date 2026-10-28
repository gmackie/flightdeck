-- Source authority moves from an immutable Worker secret to D1 for admin UI.
-- Source tokens are never stored in plaintext in D1.
ALTER TABLE sources ADD COLUMN token_sha256 TEXT;
ALTER TABLE sources ADD COLUMN rotating_sha256_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sources ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sources ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sources ADD COLUMN updated_at TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_sources_enabled_project ON sources(project_id,enabled,id);
