/**
 * Stored kind per file (A2). Additive only: one new column and three small partial indexes, no table rebuild.
 * - `files.kind` is the finer type of a file (src/shared/fileKinds.ts: camera photo, screenshot, voice recording ...),
 *   NULL until the `files.classify` job has sorted the row. A row whose name or path changes goes back to NULL.
 * - `idx_files_kind`: live, sorted rows by kind, so a type filter reads only that kind.
 * - `idx_files_unclassified`: the rows still waiting for the job (empty once everything is sorted), so the job and the
 *   "is everything sorted?" check never scan the table.
 * - `idx_files_mtime`: live rows by date, so "newest first" walks the index instead of grouping everything.
 */
export const fileKindSql = `
ALTER TABLE files ADD COLUMN kind TEXT;
CREATE INDEX idx_files_kind ON files(kind) WHERE gone_at IS NULL AND kind IS NOT NULL;
CREATE INDEX idx_files_unclassified ON files(id) WHERE kind IS NULL;
CREATE INDEX idx_files_mtime ON files(mtime) WHERE gone_at IS NULL;
`;
