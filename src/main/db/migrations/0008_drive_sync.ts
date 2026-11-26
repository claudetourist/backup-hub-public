/**
 * Drive refresh (P4c). Two small tables, nothing else changes:
 * - `drive_items` keeps the raw name and parent of every live item a Google account owns (folders
 *   and files), so file paths can be rebuilt after a folder is renamed or moved without asking
 *   Google again.
 * - `drive_sync` keeps, per account, the "changes" bookmark Google gave us, and when the full list
 *   and the last changes run finished.
 * Rows already imported from Fleet Manager v1 stay as they are until a refresh touches them.
 */
export const driveSyncSql = `
CREATE TABLE drive_items (
  place_id      TEXT NOT NULL REFERENCES places(id),
  ext_id        TEXT NOT NULL,
  parent_ext_id TEXT,
  name          TEXT NOT NULL,
  is_folder     INTEGER NOT NULL,
  PRIMARY KEY (place_id, ext_id)
);

CREATE TABLE drive_sync (
  place_id        TEXT PRIMARY KEY REFERENCES places(id),
  changes_token   TEXT,
  full_listed_at  INTEGER,
  changes_at      INTEGER
);
`;
