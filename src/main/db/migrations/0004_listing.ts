/**
 * Listing support (P4b-1):
 * - `files.cloud_only` marks OneDrive Files On-Demand placeholders (listed, never downloaded).
 * - `files.hashed_at` is when sha256/md5 were computed (set by the later fingerprint job).
 * - `place_roots` lists the folders of a place that the listing job walks. The laptop's roots are
 *   absolute paths; the roots of named drives and OneDrive are relative, and '' means the whole place.
 * - `idx_files_to_hash` serves "which rows still need a fingerprint", smallest first.
 * - "Last looked" used to mean "last seen connected" for drives. It now means "when the last full
 *   listing finished", so the old values are reset (the connect time moves to identity_json).
 * Existing rows keep their values; nothing is removed.
 */
export const listingSql = `
ALTER TABLE files ADD COLUMN cloud_only INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN hashed_at INTEGER;

CREATE TABLE place_roots (
  place_id   TEXT NOT NULL REFERENCES places(id),
  root       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (place_id, root)
) WITHOUT ROWID;

CREATE INDEX idx_files_to_hash ON files(place_id, size)
  WHERE sha256 IS NULL AND gone_at IS NULL AND cloud_only = 0;

UPDATE places
   SET identity_json = json_set(
         CASE WHEN json_valid(identity_json) THEN identity_json ELSE '{}' END,
         '$.lastConnectedAt', last_looked_at),
       last_looked_at = NULL
 WHERE kind = 'drive' AND last_looked_at IS NOT NULL;

`;
