-- The app's own state.
CREATE TABLE deploys (
  id TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  stage_instance TEXT NOT NULL
);

-- Lifecycle events written in the same D1 batch as the state change they describe, so an event
-- exists exactly when its change committed. `seq` is the event's sourceSequence.
CREATE TABLE lifecycle_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  sent_at INTEGER,
  quarantined_at INTEGER
);
CREATE INDEX lifecycle_outbox_pending ON lifecycle_outbox (seq)
  WHERE sent_at IS NULL AND quarantined_at IS NULL;
