/**
 * Initial schema (PLAN.md section 6). Conventions:
 * - Timestamps are INTEGER milliseconds since the Unix epoch (UTC).
 * - `rel_path` uses forward slashes, relative to the place root.
 * - Foreign keys never cascade away user-facing rows; only job events follow their job.
 * - JSON columns are TEXT holding JSON.
 */
export const initialSql = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE profiles (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE places (
  id             TEXT PRIMARY KEY,
  profile_id     INTEGER NOT NULL REFERENCES profiles(id),
  kind           TEXT NOT NULL CHECK (kind IN ('laptop', 'drive', 'phone', 'gdrive', 'onedrive')),
  label          TEXT NOT NULL,
  identity_json  TEXT NOT NULL DEFAULT '{}',
  root_hint      TEXT,
  last_looked_at INTEGER,
  status         TEXT NOT NULL DEFAULT 'unknown',
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_places_profile ON places(profile_id);

-- "name" is the last segment of rel_path, derived by SQLite so it can never disagree with it.
-- (rtrim strips the trailing non-slash characters, leaving the folder part with its final slash.)
CREATE TABLE files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id      TEXT NOT NULL REFERENCES places(id),
  rel_path      TEXT NOT NULL,
  name          TEXT GENERATED ALWAYS AS (
                  replace(rel_path, rtrim(rel_path, replace(rel_path, '/', '')), '')
                ) STORED,
  size          INTEGER NOT NULL,
  mtime         INTEGER,
  sha256        TEXT,
  md5           TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  gone_at       INTEGER,
  UNIQUE (place_id, rel_path)
);
CREATE INDEX idx_files_sha256 ON files(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX idx_files_md5 ON files(md5) WHERE md5 IS NOT NULL;
CREATE INDEX idx_files_size_name ON files(size, name);

CREATE TABLE collections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  name       TEXT NOT NULL,
  tier       TEXT NOT NULL CHECK (tier IN ('irreplaceable', 'important', 'replaceable')),
  rules_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (profile_id, name)
);

CREATE TABLE collection_roots (
  collection_id INTEGER NOT NULL REFERENCES collections(id),
  place_id      TEXT NOT NULL REFERENCES places(id),
  rel_path      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (collection_id, place_id, rel_path)
) WITHOUT ROWID;

CREATE TABLE jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL,
  title          TEXT NOT NULL,
  state          TEXT NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued', 'running', 'needs_you', 'done', 'done_warnings', 'failed')),
  progress_done  INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  bytes_done     INTEGER NOT NULL DEFAULT 0,
  bytes_total    INTEGER NOT NULL DEFAULT 0,
  message        TEXT,
  warnings_json  TEXT NOT NULL DEFAULT '[]',
  error          TEXT,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER,
  resume_json    TEXT,
  log_path       TEXT
);
CREATE INDEX idx_jobs_state ON jobs(state);

CREATE TABLE job_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  at     INTEGER NOT NULL,
  level  TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  text   TEXT NOT NULL
);
CREATE INDEX idx_job_events_job ON job_events(job_id, at);
CREATE INDEX idx_job_events_at ON job_events(at);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT
) WITHOUT ROWID;

CREATE TABLE secrets (
  name       TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  nonce      BLOB NOT NULL,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

INSERT INTO meta (key, value) VALUES ('created_at', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
INSERT INTO profiles (name, color, created_at)
  VALUES ('You', '#0b6b5c', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
`;
