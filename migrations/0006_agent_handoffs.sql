-- External issue creation is a distinct, explicitly reviewed operation.
-- "uncertain" means GitHub may have created the issue before an error.
ALTER TABLE proposed_actions ADD COLUMN handoff_status TEXT NOT NULL DEFAULT 'not_started'
  CHECK(handoff_status IN ('not_started','creating','created','uncertain'));
ALTER TABLE proposed_actions ADD COLUMN handoff_issue_url TEXT;
ALTER TABLE proposed_actions ADD COLUMN handoff_attempted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_handoff_project_status
  ON proposed_actions(project_id,handoff_status,created_at);
