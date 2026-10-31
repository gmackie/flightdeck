-- Authorization only: deliberately independent of lifecycle ingestion tables.
CREATE TABLE authz_projects (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 3 AND 64)
);

-- An app belongs to at most one authorization project. No implicit global role.
CREATE TABLE authz_app_projects (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES authz_projects(id) ON DELETE CASCADE
);
CREATE INDEX authz_app_projects_project ON authz_app_projects(project_id);

CREATE TABLE authz_grants (
  id TEXT PRIMARY KEY,
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('person', 'service')),
  principal_subject TEXT NOT NULL CHECK (length(principal_subject) BETWEEN 1 AND 256),
  app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES authz_projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('reader', 'analyst', 'owner', 'admin')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expires_at INTEGER,
  revoked_at INTEGER,
  CHECK ((app_id IS NOT NULL) != (project_id IS NOT NULL)),
  CHECK (principal_kind != 'service' OR (role = 'reader' AND app_id IS NOT NULL)),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX authz_grants_principal ON authz_grants(principal_kind, principal_subject);
