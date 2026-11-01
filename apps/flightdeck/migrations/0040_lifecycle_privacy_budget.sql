-- FLIG-36. Apply AFTER 0030 (and 0006/0010/0020). No seed approvals or enabled apps.
-- New namespace/number: never rename/reuse an earlier stack migration.
CREATE TABLE lifecycle_privacy_limits (
  -- 'principal' is a global cross-app ceiling; app rows use the actual app id.
  kind TEXT NOT NULL CHECK (kind IN ('principal', 'app')),
  scope TEXT NOT NULL,
  query_count INTEGER NOT NULL CHECK (query_count BETWEEN 1 AND 1000),
  row_budget INTEGER NOT NULL CHECK (row_budget BETWEEN 1 AND 11000000),
  scan_budget INTEGER NOT NULL CHECK (scan_budget BETWEEN 1 AND 1000000000),
  time_budget_ms INTEGER NOT NULL CHECK (time_budget_ms BETWEEN 1 AND 3600000),
  PRIMARY KEY (kind, scope),
  CHECK (kind != 'principal' OR scope = 'global')
) WITHOUT ROWID;

-- Operator-only release policy, tied to an exact immutable registered definition digest.
-- Producers/clients cannot classify their own process or approve restricted reads.
CREATE TABLE lifecycle_privacy_processes (
  app_id TEXT NOT NULL,
  process_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition_hash TEXT NOT NULL CHECK (length(definition_hash) = 64),
  classification TEXT NOT NULL CHECK (classification IN ('aggregate', 'restricted')),
  review_id TEXT NOT NULL CHECK (length(review_id) BETWEEN 1 AND 64),
  restricted_approved INTEGER NOT NULL DEFAULT 0 CHECK (restricted_approved IN (0, 1)),
  PRIMARY KEY (app_id, process_id, version),
  FOREIGN KEY (app_id, process_id, version)
    REFERENCES process_definitions(app_id, process_id, version)
) WITHOUT ROWID;

-- Accounting, separate from the audit projection. No raw principals/app ids/query inputs.
-- Fixed UTC-day epochs, server selected. Failed/abandoned reservations are never refunded.
CREATE TABLE lifecycle_privacy_ledger (
  id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  principal TEXT NOT NULL,
  app TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  rows INTEGER NOT NULL,
  scans INTEGER NOT NULL,
  time_ms INTEGER NOT NULL
);
CREATE INDEX lifecycle_privacy_ledger_app ON lifecycle_privacy_ledger(app, epoch);
CREATE INDEX lifecycle_privacy_ledger_principal ON lifecycle_privacy_ledger(principal, epoch);

-- Only opaque identifiers, keyed query digest and a fixed decision vocabulary.
CREATE TABLE lifecycle_privacy_audit (
  principal TEXT NOT NULL,
  app TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('admitted', 'denied', 'withheld', 'released'))
);
-- Bounded indexed cohort selection; LIMIT alone does not bound physical rows scanned.
CREATE INDEX lifecycle_privacy_cohort ON lifecycle_case_snapshots
  (app_id, process_key, process_version, started_at, case_id) WHERE deleted_at IS NULL;
