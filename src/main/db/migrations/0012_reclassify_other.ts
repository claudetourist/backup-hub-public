/**
 * The camera rules learned more file names (Canon 0I2A1030, Sony DSC01234, GoPro, DJI, date-time names ...). Rows that were
 * sorted as "other photos" or "other videos" under the old rules are sent back to NULL so the `files.classify` job sorts them
 * again on the next start. This only touches the derived `kind` column (a user's own choice is applied again by the job);
 * no file, path, size or fingerprint changes.
 */
export const reclassifyOtherSql = `
UPDATE files SET kind = NULL WHERE kind IN ('photo-other', 'video-other');
`;
