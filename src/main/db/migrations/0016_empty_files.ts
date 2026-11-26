/**
 * "Empty files" (size 0) became their own kind. Rows that are empty were sorted under their name's kind (photos, documents ...);
 * they are sent back to NULL so the `files.classify` job sorts them again on the next start. This only touches the derived `kind`
 * column (a kind the person chose is applied again by the job); no file, path, size or fingerprint changes.
 */
export const emptyFilesSql = `
UPDATE files SET kind = NULL WHERE size = 0 AND kind IS NOT NULL;
`;
