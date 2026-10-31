-- Warm tier: each AppDO upserts its finalized hour here (src/rollups.ts), so the dashboard's
-- trends never scan the cold tier. `hour` is the UTC hour key, e.g. 2026-10-30T14.
-- No foreign key to apps: a late flush for a deleted app must not fail the AppDO alarm.
CREATE TABLE hourly_rollups (
  app_id TEXT NOT NULL,
  hour TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (app_id, hour, kind, name)
) WITHOUT ROWID;

-- Unique sessions seen in each app-hour. Summing hours over-counts sessions that span them.
CREATE TABLE hourly_sessions (
  app_id TEXT NOT NULL,
  hour TEXT NOT NULL,
  sessions INTEGER NOT NULL,
  PRIMARY KEY (app_id, hour)
) WITHOUT ROWID;
