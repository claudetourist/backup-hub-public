/**
 * Backup plans (Batch 9). A plan IS a collection plus destinations and a schedule, so nothing is copied into a second system:
 * `collections` gets six columns (what kind of source, copy mode, how many dated copies to keep, the schedule as JSON, whether
 * the cloud is allowed, and which built-in plan it is) and two small tables hold where each plan copies to and every run of it.
 * `jobs.started_by` holds the plain line "Started by itself: T7 was plugged in, last copy 8 days ago".
 * Additive only: no table is rebuilt and no row is changed except the defaults of the new columns.
 */
export const plansSql = `
ALTER TABLE collections ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'folders';
ALTER TABLE collections ADD COLUMN copy_mode TEXT NOT NULL DEFAULT 'new';
ALTER TABLE collections ADD COLUMN keep_versions INTEGER NOT NULL DEFAULT 8;
ALTER TABLE collections ADD COLUMN schedule TEXT;
ALTER TABLE collections ADD COLUMN cloud_allowed INTEGER NOT NULL DEFAULT 1;
ALTER TABLE collections ADD COLUMN builtin TEXT;

CREATE TABLE plan_destinations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL REFERENCES collections(id),
  kind          TEXT NOT NULL CHECK (kind IN ('drive', 'google', 'laptop')),
  place_id      TEXT,
  accounts      TEXT,
  folder        TEXT,
  auto          INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_plan_destinations_collection ON plan_destinations(collection_id);

CREATE TABLE plan_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  destination_id INTEGER NOT NULL,
  job_id         INTEGER,
  trigger_line   TEXT NOT NULL DEFAULT '',
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER,
  outcome        TEXT,
  files          INTEGER NOT NULL DEFAULT 0,
  bytes          INTEGER NOT NULL DEFAULT 0,
  skipped        TEXT,
  folder         TEXT
);
CREATE INDEX idx_plan_runs_destination ON plan_runs(destination_id, started_at);
CREATE INDEX idx_plan_runs_job ON plan_runs(job_id);

ALTER TABLE jobs ADD COLUMN started_by TEXT;
`;
