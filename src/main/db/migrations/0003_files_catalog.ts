/**
 * Catalog support for cloud places (Google Drive), still generic:
 * - `size` may be NULL (Google Docs, Sheets and similar have no byte size).
 * - `ext_id` is the place's own id for the file (the Drive file id), `mime` its type and
 *   `web_link` a link to open it. A unique index on (place_id, ext_id) lets a re-import update
 *   the same row even when the file was moved or renamed.
 * SQLite cannot drop NOT NULL in place, so the table is rebuilt; existing rows keep their ids.
 * Nothing else references `files`, so no foreign key is affected.
 */
export const filesCatalogSql = `
CREATE TABLE files_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id      TEXT NOT NULL REFERENCES places(id),
  rel_path      TEXT NOT NULL,
  name          TEXT GENERATED ALWAYS AS (
                  replace(rel_path, rtrim(rel_path, replace(rel_path, '/', '')), '')
                ) STORED,
  size          INTEGER,
  mtime         INTEGER,
  sha256        TEXT,
  md5           TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  gone_at       INTEGER,
  ext_id        TEXT,
  mime          TEXT,
  web_link      TEXT,
  UNIQUE (place_id, rel_path)
);
INSERT INTO files_new (id, place_id, rel_path, size, mtime, sha256, md5, first_seen_at, last_seen_at, gone_at)
  SELECT id, place_id, rel_path, size, mtime, sha256, md5, first_seen_at, last_seen_at, gone_at FROM files;
DROP TABLE files;
ALTER TABLE files_new RENAME TO files;
CREATE INDEX idx_files_sha256 ON files(sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX idx_files_md5 ON files(md5) WHERE md5 IS NOT NULL;
CREATE INDEX idx_files_size_name ON files(size, name);
CREATE UNIQUE INDEX idx_files_place_ext ON files(place_id, ext_id) WHERE ext_id IS NOT NULL;
`;
