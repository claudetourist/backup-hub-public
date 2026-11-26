/**
 * Speed of the Start run on a big index (Batch 13). Additive only: two partial indexes, no table touched.
 * - idx_files_gone_place: the rows that are gone, per place. "Missing on a backup drive" looks only at these instead of every row.
 * - idx_files_place_hashed: when a row was last fingerprinted, per place. "Damaged on a backup drive" and the first-sight baseline
 *   look only at rows fingerprinted since the drive was last checked.
 */
export const startSpeedSql = `
CREATE INDEX idx_files_gone_place ON files(place_id, id) WHERE gone_at IS NOT NULL;
CREATE INDEX idx_files_place_hashed ON files(place_id, hashed_at) WHERE hashed_at IS NOT NULL;
`;
