/**
 * The Start run (Batch 11, Simple plan). Additive only: new tables, nothing existing is touched. Every table carries profile_id
 * (profiles come later; today everything belongs to the first profile).
 * - start_sources: the laptop folders to back up (with "most important") and the "Kept only on Seagate" list.
 * - start_prefs: small remembered choices (Start ticks, most important phone/OneDrive, ticked Google accounts, seeded marker).
 * - start_good: the last good state of every file on T7 and Seagate (path + checksum); the red-error check compares with it.
 * - start_errors: red errors (missing / damaged), with "restored" and "I deleted this on purpose" outcomes.
 * - start_runs: every Start run with its steps and findings (JSON).
 * - start_clean_log: files removed from T7 by the user's clean-up of old versions (so they never raise an error).
 */
export const startSql = `
CREATE TABLE start_sources (
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  kind       TEXT NOT NULL CHECK (kind IN ('laptop', 'kept_seagate')),
  path       TEXT NOT NULL,
  important  INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, kind, path)
) WITHOUT ROWID;

CREATE TABLE start_prefs (
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (profile_id, key)
) WITHOUT ROWID;

CREATE TABLE start_good (
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  place_id   TEXT NOT NULL REFERENCES places(id),
  rel_path   TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  size       INTEGER NOT NULL,
  noted_at   INTEGER NOT NULL,
  PRIMARY KEY (place_id, rel_path)
) WITHOUT ROWID;

CREATE TABLE start_errors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id      INTEGER NOT NULL REFERENCES profiles(id),
  place_id        TEXT NOT NULL REFERENCES places(id),
  rel_path        TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('missing', 'damaged')),
  expected_sha256 TEXT NOT NULL,
  found_sha256    TEXT,
  size            INTEGER NOT NULL,
  detected_at     INTEGER NOT NULL,
  state           TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'restored', 'acknowledged')),
  resolved_at     INTEGER,
  UNIQUE (place_id, rel_path, kind)
);
CREATE INDEX idx_start_errors_state ON start_errors(profile_id, state);

CREATE TABLE start_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id  INTEGER NOT NULL REFERENCES profiles(id),
  job_id      INTEGER,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  state       TEXT NOT NULL DEFAULT 'running',
  ticks       TEXT NOT NULL DEFAULT '{}',
  steps       TEXT NOT NULL DEFAULT '[]',
  findings    TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_start_runs_profile ON start_runs(profile_id, started_at);

CREATE TABLE start_clean_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL REFERENCES profiles(id),
  place_id   TEXT NOT NULL REFERENCES places(id),
  rel_path   TEXT NOT NULL,
  size       INTEGER NOT NULL,
  age_group  TEXT NOT NULL,
  removed_at INTEGER NOT NULL
);
CREATE INDEX idx_start_clean_log_place ON start_clean_log(place_id, rel_path);
`;
