/**
 * R3.1 (25 Nov 2026): the search index. Additive only; nothing is dropped, rebuilt or filled here.
 * - search_names: every file name cut into 3-letter pieces (FTS5 "trigram"), so any part of a name is found whatever its case. It holds no
 *   copy of the names (external content = the files table), only the pieces.
 * - search_dirs: the words of every path (FTS5, no positions), so a folder word is found without reading the paths.
 * - search_index_state: the one row that says how far the index is filled (`filled_to` = the highest file id in it) and whether the first
 *   fill is over (`ready`). The first fill of ~1.1 M rows must not run in a migration (that blocks the start): the tables are made EMPTY
 *   here and the query worker fills them in slices afterwards (src/main/query/searchIndexFill.ts), resumable at any point.
 * - No trigger on INSERT: the index of new rows is the worker's tail fill (every row above `filled_to`), so the listing's writes pay nothing
 *   (measured: a trigger that wrote the index cost +87% on 100,000 inserted rows and a merge spike of 2.6 s inside one transaction).
 *   A search reads the few rows above `filled_to` straight from the table, so a new file is found at once.
 * - Two small triggers for the rare writes that CHANGE a row already in the index (a move or rename changes rel_path; a delete): they queue
 *   the row's id in search_dirty with the OLD name and path (an external-content index can only forget a row by those exact values). The
 *   first entry of an id wins (later ones are ignored: the index still holds the first values). The worker applies the queue and empties it.
 *   They only act on ids at or below `filled_to`: a row above it is not in the index yet. The name is a stored generated column of
 *   rel_path, so only a change of rel_path changes either entry. Rows marked gone stay in the index (searches skip them).
 * - saved_searches: the searches saved on the Files screen (a name and the request as JSON).
 */
export const searchIndexSql = `
CREATE VIRTUAL TABLE search_names USING fts5(name, content='files', content_rowid='id', tokenize='trigram', columnsize=0);
CREATE VIRTUAL TABLE search_dirs USING fts5(rel_path, content='files', content_rowid='id', tokenize='unicode61 remove_diacritics 2', detail='none', columnsize=0);

CREATE TABLE search_index_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  filled_to  INTEGER NOT NULL DEFAULT 0,
  ready      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
);
INSERT INTO search_index_state (id, filled_to, ready) VALUES (1, 0, 0);

CREATE TABLE search_dirty (
  id           INTEGER PRIMARY KEY,
  old_name     TEXT NOT NULL,
  old_rel_path TEXT NOT NULL
);

CREATE TRIGGER search_index_ad AFTER DELETE ON files
WHEN old.id <= (SELECT filled_to FROM search_index_state)
BEGIN
  INSERT OR IGNORE INTO search_dirty (id, old_name, old_rel_path) VALUES (old.id, old.name, old.rel_path);
END;

CREATE TRIGGER search_index_au AFTER UPDATE OF rel_path ON files
WHEN old.rel_path IS NOT new.rel_path AND old.id <= (SELECT filled_to FROM search_index_state)
BEGIN
  INSERT OR IGNORE INTO search_dirty (id, old_name, old_rel_path) VALUES (old.id, old.name, old.rel_path);
END;

CREATE TABLE saved_searches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER,
  name       TEXT NOT NULL,
  request    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;
