/**
 * Fingerprints and the copies index (P4b-2):
 * - `files.hash_error` holds the plain reason a file could not be read for fingerprinting. A row
 *   with an error is not in the hash queue until a listing sees the file change, or "Try again".
 * - `idx_files_to_hash` is rebuilt without errored rows, so the queue (smallest first) never loops
 *   on them.
 * - Two covering indexes serve the copies index: same content by sha256 (local to local) and by
 *   md5 + size (local to Google Drive). Both skip rows marked gone.
 * - "Last looked" of the laptop and OneDrive still held the old F4 polling value, which meant
 *   "seen connected". It now means "last full listing finished", so it is reset to NULL wherever no
 *   `list.place` job for that place is done. Nothing else is touched.
 */
export const fingerprintsSql = `
ALTER TABLE files ADD COLUMN hash_error TEXT;

DROP INDEX idx_files_to_hash;
CREATE INDEX idx_files_to_hash ON files(place_id, size)
  WHERE sha256 IS NULL AND gone_at IS NULL AND cloud_only = 0 AND hash_error IS NULL;

CREATE INDEX idx_files_sha256_live ON files(sha256, place_id)
  WHERE sha256 IS NOT NULL AND gone_at IS NULL;
CREATE INDEX idx_files_md5_size ON files(md5, size, place_id)
  WHERE md5 IS NOT NULL AND gone_at IS NULL;

UPDATE places
   SET last_looked_at = NULL
 WHERE kind IN ('laptop', 'onedrive')
   AND last_looked_at IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM jobs j
      WHERE j.kind = 'list.place'
        AND j.state = 'done'
        AND CASE WHEN json_valid(j.params_json) THEN json_extract(j.params_json, '$.placeId') END = places.id
   );
`;
