/**
 * Google Drive "shared with me" (finish plan, 3 Nov 2026). Files other people own that were shared with one of the person's
 * accounts. They live in their OWN table, never in `files` or `drive_items`, so no coverage, copy or clean-up count can ever
 * mistake them for a backup copy: the owner can remove them at any time. Replaced as a whole on each look; Backup Hub only reads.
 */
export const sharedWithMeSql = `
CREATE TABLE shared_with_me (
  place_id    TEXT NOT NULL REFERENCES places(id),
  file_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  mime_type   TEXT,
  size        INTEGER,
  mtime       INTEGER,
  web_link    TEXT,
  owner_name  TEXT,
  owner_email TEXT,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (place_id, file_id)
);
CREATE TABLE shared_with_me_runs (
  place_id    TEXT PRIMARY KEY REFERENCES places(id),
  looked_at   INTEGER NOT NULL,
  item_count  INTEGER NOT NULL,
  truncated   INTEGER NOT NULL DEFAULT 0
);
`;
