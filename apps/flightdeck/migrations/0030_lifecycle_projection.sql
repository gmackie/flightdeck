-- Lifecycle projection pipeline (src/lifecycle-projection): the evidence the projector replays
-- into the serving read model (0020), the work queue that drives it, and the Basin outbox.
--
-- Roles: the producing domain app stays the operational source of truth. Basin (the
-- LIFECYCLE_EVENTS stream) is the long-term historical evidence. lifecycle_event_log is the
-- projector's bounded working copy: accepting a lifecycle batch commits it here, in one D1
-- transaction with its projection work, and forwards it to Basin from the outbox columns.
-- Rows hold the validated LifecycleRecord only: opaque ids and low-cardinality codes, never
-- personal data (the ingest schema rejects personal-data keys before anything is stored), and
-- every row conforms to a registered process version (process_definitions, 0006).

-- Accepted lifecycle events. seq is the app-independent commit order: an app's watermark is the
-- highest seq its projection reflects. (app_id, event_id, fingerprint) dedupes exact retries; a
-- reused event id with a different payload is kept as a second row so the reducer can see the
-- conflict and exclude both copies (reported as a diagnostic, never silently resolved).
CREATE TABLE lifecycle_event_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  case_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  -- Basin outbox: NULL until the row was sent to LIFECYCLE_EVENTS.
  forwarded_at INTEGER,
  forward_attempts INTEGER NOT NULL DEFAULT 0,
  forward_next_at INTEGER NOT NULL DEFAULT 0,
  forward_error TEXT,
  UNIQUE (app_id, event_id, fingerprint)
);
CREATE INDEX lifecycle_log_by_case ON lifecycle_event_log (app_id, case_id, seq);
CREATE INDEX lifecycle_log_outbox ON lifecycle_event_log (forward_next_at, seq)
  WHERE forwarded_at IS NULL;

-- Cases whose snapshot must be (re)computed. enqueued_seq is the newest log row for the case;
-- a projection only clears the entry if it covered that row, so late events are never lost.
CREATE TABLE lifecycle_projection_queue (
  app_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  enqueued_seq INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error_code TEXT,
  PRIMARY KEY (app_id, case_id)
) WITHOUT ROWID;
CREATE INDEX lifecycle_queue_due ON lifecycle_projection_queue (next_attempt_at, app_id);

-- Reducer and adapter diagnostics per case (codes and counts only, replaced on each projection).
-- case_id '' holds app-level counters such as events suppressed for erased cases.
CREATE TABLE lifecycle_projection_diagnostics (
  app_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  code TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, case_id, code)
) WITHOUT ROWID;

-- Erased cases. Evidence for them is deleted and never accepted into the log again, so neither a
-- late event nor a backfill can resurrect the case, including before its first projection.
CREATE TABLE lifecycle_case_tombstones (
  app_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  erased_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, case_id)
) WITHOUT ROWID;
