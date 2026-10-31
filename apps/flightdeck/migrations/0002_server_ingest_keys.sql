-- Store SHA-256 digests only. Multiple keys per app allow overlapping rotation.
CREATE TABLE server_ingest_keys (
  token_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
