/**
 * 25 Nov 2026: "Remove from list" for a backup. Additive only; nothing is dropped or rebuilt.
 * - backup_profiles.archived_at: when the backup was taken off the list (epoch ms), NULL = on the list. A removed backup keeps every row, run, history
 *   import, folder and file: nothing on any drive or in the file list is deleted, and "Put back" sets the column to NULL again.
 */
export const backupArchiveSql = `
ALTER TABLE backup_profiles ADD COLUMN archived_at INTEGER;
`;
