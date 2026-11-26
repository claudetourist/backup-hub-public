/**
 * Backup profiles and the one ledger (Profiles step 1a, PROFILES-PLAN.md "The one ledger"). Additive only: nothing is dropped,
 * no table is rebuilt, and `files` (about 1.1 M rows) only gets new nullable columns without defaults, so ADD COLUMN stays instant.
 * Words: a Person is a row of `profiles` (the old table, not renamed); a "backup profile" is one backup (`backup_profiles`).
 *
 * New `files` columns (all NULL until something fills them; no REFERENCES and no CHECK on purpose: a constraint on ADD COLUMN would
 * make SQLite read every row, and the rules live in the code):
 * - origin_file_id: the source file's row this copy came from (phone or folder). One source row links to every copy.
 * - backup_run_id: the backup run that created the copy.
 * - expected_sha256: what the copy should be; a mismatch on a backup drive is a red error.
 * - verified_at / verified_how (read_both | imported | name_size | none).
 * - gone_reason (gone_from_source | removed_on_purpose | merged | compressed | kept_only_on_other_drive | phone_cleaned).
 * - archive_file_id / archive_member: after Compress.
 *
 * New tables:
 * - backup_profiles: one backup = a source (phone or folder), a folder prefix, a change rule, filters. `import_key` (e.g. 'poco') is
 *   the key it had in PhoneBackup's config.json, so seeding twice finds the same profile. `phone_serial` is unique: a phone can
 *   never belong to two profiles.
 * - backup_destinations: a backup folder on a drive place (never a drive letter). `root` has forward slashes, relative to the drive.
 * - backup_runs, backup_exclusions (permanent "never back up this file", per profile), file_problems, ledger_imports (one row per
 *   imported PhoneBackup ledger.db, identified by the sha256 of the file so it is imported once).
 */
export const backupProfilesSql = `
ALTER TABLE files ADD COLUMN origin_file_id INTEGER;
ALTER TABLE files ADD COLUMN backup_run_id INTEGER;
ALTER TABLE files ADD COLUMN expected_sha256 TEXT;
ALTER TABLE files ADD COLUMN verified_at INTEGER;
ALTER TABLE files ADD COLUMN verified_how TEXT;
ALTER TABLE files ADD COLUMN gone_reason TEXT;
ALTER TABLE files ADD COLUMN archive_file_id INTEGER;
ALTER TABLE files ADD COLUMN archive_member TEXT;
CREATE INDEX idx_files_origin ON files(origin_file_id) WHERE origin_file_id IS NOT NULL;
CREATE INDEX idx_files_backup_run ON files(backup_run_id) WHERE backup_run_id IS NOT NULL;

CREATE TABLE backup_profiles (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id       INTEGER NOT NULL REFERENCES profiles(id),
  name            TEXT NOT NULL,
  source_kind     TEXT NOT NULL CHECK (source_kind IN ('phone', 'folder')),
  source_place_id TEXT REFERENCES places(id),
  source_root     TEXT NOT NULL DEFAULT '',
  phone_serial    TEXT,
  folder_prefix   TEXT NOT NULL,
  change_rule     TEXT NOT NULL CHECK (change_rule IN ('size_and_date', 'size_or_date')),
  filters_json    TEXT NOT NULL DEFAULT '{}',
  enabled         INTEGER NOT NULL DEFAULT 1,
  import_key      TEXT UNIQUE,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_backup_profiles_name ON backup_profiles(person_id, name COLLATE NOCASE);
CREATE UNIQUE INDEX idx_backup_profiles_serial ON backup_profiles(phone_serial) WHERE phone_serial IS NOT NULL;

CREATE TABLE backup_destinations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_profile_id INTEGER NOT NULL REFERENCES backup_profiles(id),
  place_id          TEXT NOT NULL REFERENCES places(id),
  root              TEXT NOT NULL DEFAULT '',
  role              TEXT NOT NULL DEFAULT 'primary' CHECK (role IN ('primary', 'copy')),
  enabled           INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_backup_destinations_unique ON backup_destinations(backup_profile_id, place_id, root COLLATE NOCASE);

CREATE TABLE backup_runs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_profile_id    INTEGER NOT NULL REFERENCES backup_profiles(id),
  destination_place_id TEXT REFERENCES places(id),
  folder               TEXT,
  started_at           INTEGER NOT NULL,
  ended_at             INTEGER,
  state                TEXT NOT NULL DEFAULT 'running',
  files_copied         INTEGER NOT NULL DEFAULT 0,
  bytes_copied         INTEGER NOT NULL DEFAULT 0,
  failed_json          TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_backup_runs_profile ON backup_runs(backup_profile_id, started_at);

CREATE TABLE backup_exclusions (
  backup_profile_id INTEGER NOT NULL REFERENCES backup_profiles(id),
  source_path       TEXT NOT NULL,
  added_at          INTEGER NOT NULL,
  PRIMARY KEY (backup_profile_id, source_path)
) WITHOUT ROWID;

CREATE TABLE file_problems (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id     INTEGER NOT NULL REFERENCES files(id),
  kind        TEXT NOT NULL,
  detected_at INTEGER NOT NULL,
  state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved', 'acknowledged')),
  resolved_at INTEGER
);
CREATE INDEX idx_file_problems_file ON file_problems(file_id);
CREATE INDEX idx_file_problems_state ON file_problems(state, kind);

CREATE TABLE ledger_imports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  backup_profile_id INTEGER REFERENCES backup_profiles(id),
  ledger_path       TEXT NOT NULL,
  ledger_sha256     TEXT NOT NULL,
  imported_at       INTEGER NOT NULL,
  rows              INTEGER NOT NULL,
  problems_json     TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX idx_ledger_imports_sha ON ledger_imports(ledger_sha256);
`;
