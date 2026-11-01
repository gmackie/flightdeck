-- Credential scopes, space-separated. Existing keys keep exactly what they could do before:
-- generic server events. Writing lifecycle events needs a key minted with `lifecycle.write`.
ALTER TABLE server_ingest_keys ADD COLUMN scopes TEXT NOT NULL DEFAULT 'events.write';

-- Per-app capabilities, granted by an operator with parameterized D1 statements. There is no
-- admin API for them: an Access session alone can never enable lifecycle writes for an app.
CREATE TABLE app_capabilities (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN ('lifecycle.write')),
  granted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  PRIMARY KEY (app_id, capability)
) WITHOUT ROWID;
