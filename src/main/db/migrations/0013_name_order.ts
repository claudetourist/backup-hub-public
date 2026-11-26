/**
 * Name order for Search: live rows by name (case-insensitive, SQLite's NOCASE), so a search with no text, or sorted by name,
 * walks this index for its first page instead of grouping every row. Additive only: one index, no column, no data change.
 * (About 35 MB and a few seconds on the real catalog, built once at the first start after this version.)
 */
export const nameOrderSql = `
CREATE INDEX idx_files_name_nocase ON files(name COLLATE NOCASE) WHERE gone_at IS NULL;
`;
