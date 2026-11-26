/**
 * R1.6 (25 Nov 2026): rename and move detection. Additive only; nothing is dropped or rebuilt.
 * - files.fs_id: the file system's own id of the file (NTFS file id, with the volume's number, as text), read during the listing at no extra cost.
 *   Filled only for the laptop and OneDrive (NTFS); a backup drive or a phone never gets one (their ids are not trusted). NULL until a look fills it.
 *   A nullable column without a default: ADD COLUMN stays instant on the real ~1.1 M rows, and no JS rewrites the table.
 * - idx_files_fs_id: finds the row of a file by its id (partial: empty until the first look fills ids, so it builds in a blink).
 * - idx_files_gone_fs: the rows with an id that were marked gone, by when (the look finds "what vanished in this look" without reading the whole place).
 * - file_paths: where a row has been. The row keeps its id, checksum and copy links when the file is renamed or moved; its old paths stay here
 *   (to_at set), the path it has now has to_at NULL. "The backup as it was on 3 Nov" and restore-to-original-place read this.
 */
export const fileIdsSql = `
ALTER TABLE files ADD COLUMN fs_id TEXT;
CREATE INDEX idx_files_fs_id ON files(place_id, fs_id) WHERE fs_id IS NOT NULL;
CREATE INDEX idx_files_gone_fs ON files(place_id, gone_at) WHERE gone_at IS NOT NULL AND fs_id IS NOT NULL;

CREATE TABLE file_paths (
  file_id  INTEGER NOT NULL,
  rel_path TEXT NOT NULL,
  from_at  INTEGER NOT NULL,
  to_at    INTEGER
);
CREATE INDEX idx_file_paths_file ON file_paths(file_id);
`;
