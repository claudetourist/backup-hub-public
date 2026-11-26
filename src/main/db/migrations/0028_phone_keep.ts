/**
 * R1.5 (25 Nov 2026): "Keep on the phone". Additive only: one new table, nothing else changes.
 * - phone_keep: a file or a folder of one phone backup that Free up phone space must never offer, even with three checked copies.
 *   `backup_id` is the phone backup (backup_profiles.id), `scope` is file or folder, `path` is the phone path ("/sdcard/DCIM/a.jpg", a folder
 *   without its trailing slash). Only `freeUp/keepStore.ts` writes it; a repeat adds nothing (unique index).
 */
export const phoneKeepSql = `
CREATE TABLE phone_keep (
  id         INTEGER PRIMARY KEY,
  backup_id  INTEGER NOT NULL,
  scope      TEXT NOT NULL CHECK (scope IN ('file', 'folder')),
  path       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_phone_keep_unique ON phone_keep(backup_id, scope, path);
`;
