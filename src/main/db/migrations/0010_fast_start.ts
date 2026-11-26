/**
 * Fast start and a fresh ledger (Batch 1). Three small additive tables, nothing existing changes:
 * - `data_version` (one row): a counter that goes up whenever something the Home numbers are counted from changes
 *   (files listed or gone, fingerprints, kinds, collections, Drive catalog). Cheap to read and to bump.
 * - `count_cache`: the last result of each heavy count (file stats, coverage, collection coverage) as JSON, with the
 *   data version it was counted at, so the next start shows it at once and recounts only if the version moved on.
 * - `scan_folders`: the folders the listing walked and their modified time when read. A quick "look again" skips a
 *   folder whose time has not moved (adding, removing or renaming a file always moves it).
 */
export const fastStartSql = `
CREATE TABLE data_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n  INTEGER NOT NULL
);
INSERT INTO data_version (id, n) VALUES (1, 1);

CREATE TABLE count_cache (
  key          TEXT PRIMARY KEY,
  data_version INTEGER NOT NULL,
  counted_at   INTEGER NOT NULL,
  json         TEXT NOT NULL
);

CREATE TABLE scan_folders (
  place_id TEXT NOT NULL REFERENCES places(id),
  rel_path TEXT NOT NULL,
  parent   TEXT NOT NULL,
  mtime    INTEGER NOT NULL,
  seen_at  INTEGER NOT NULL,
  PRIMARY KEY (place_id, rel_path)
) WITHOUT ROWID;
CREATE INDEX idx_scan_folders_parent ON scan_folders(place_id, parent);
`;
