CREATE TABLE apps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  access_aud TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
