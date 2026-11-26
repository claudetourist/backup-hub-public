/**
 * Clean up (Batch 5). Two small tables, nothing else changes:
 * - `clean_locks`: copies that vouched for a removed file (the T7 copy and the cloud copy). Never offered by any clean-up until
 *   `expires_at` (30 days after the removal).
 * - `removal_log`: every removal, what and where and which copies vouched for it. Laptop removals are MOVES into a quarantine
 *   folder (`quarantine_path`); `undone_at` is set when the file went back, `emptied_at` when the person agreed to empty it.
 */
export const cleanupSql = `
CREATE TABLE clean_locks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id   TEXT NOT NULL REFERENCES places(id),
  rel_path   TEXT NOT NULL,
  sha256     TEXT,
  reason     TEXT NOT NULL,
  locked_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  removal_id INTEGER
);
CREATE INDEX idx_clean_locks_path ON clean_locks(place_id, rel_path);

CREATE TABLE removal_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          INTEGER,
  kind            TEXT NOT NULL CHECK (kind IN ('phone', 'laptop')),
  place_id        TEXT,
  device          TEXT,
  path            TEXT NOT NULL,
  size            INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  vouchers_json   TEXT NOT NULL,
  quarantine_path TEXT,
  removed_at      INTEGER NOT NULL,
  undone_at       INTEGER,
  emptied_at      INTEGER
);
CREATE INDEX idx_removal_log_kind ON removal_log(kind, removed_at);
`;
