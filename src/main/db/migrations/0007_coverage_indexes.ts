/**
 * Coverage for all places (P4b-4) in the query worker without scanning the whole files table twice more:
 * - `idx_files_nosha_md5`: live rows that have an MD5 and a size but no SHA-256 (Google Drive rows), so
 *   "which places hold this MD5 without a SHA-256" is an index-only read of a few thousand entries.
 * - `idx_files_unfingerprinted`: live rows with neither hash (not fingerprinted yet, or cloud-only),
 *   per place, so their counts are an index-only read. It shrinks as files are fingerprinted.
 */
export const coverageIndexesSql = `
CREATE INDEX idx_files_nosha_md5 ON files(md5, size, place_id)
  WHERE gone_at IS NULL AND sha256 IS NULL AND md5 IS NOT NULL AND size IS NOT NULL;
CREATE INDEX idx_files_unfingerprinted ON files(place_id, cloud_only, size)
  WHERE gone_at IS NULL AND sha256 IS NULL AND md5 IS NULL;
`;
