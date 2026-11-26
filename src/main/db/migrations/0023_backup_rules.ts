/**
 * R1.2b part 1 (23 Nov 2026): "your choices". Additive only; nothing is dropped, `backup_exclusions` stays as it is.
 * - backup_rules: what the person said about a file, a folder or a kind of file. `backup_id` null = every backup. `scope` file | folder |
 *   pattern; `pattern` is the phone path (file, folder) or "*.ext" (pattern); `choice` leave_out | include; `destination` is for "leave out
 *   of one destination" later (unused now).
 * - Every backup_exclusions row is copied in as a leave_out choice (a path ending in "/" is a folder, anything else a file). The copy
 *   can be run again: the unique index makes a second run add nothing.
 * - backup_checklist: the tick-offs of "things no backup can copy", per backup.
 */
export const COPY_EXCLUSIONS_SQL = `
INSERT OR IGNORE INTO backup_rules (backup_id, scope, pattern, choice, destination, note, created_at)
SELECT e.backup_profile_id,
       CASE WHEN e.source_path LIKE '%/' THEN 'folder' ELSE 'file' END,
       CASE WHEN e.source_path LIKE '%/' THEN rtrim(e.source_path, '/') ELSE e.source_path END,
       'leave_out',
       NULL,
       'Carried over from the old never-back-up list',
       e.added_at
FROM backup_exclusions e
WHERE trim(e.source_path, '/') <> '';
`;

export const backupRulesSql = `
CREATE TABLE backup_rules (
  id          INTEGER PRIMARY KEY,
  backup_id   INTEGER,
  scope       TEXT NOT NULL CHECK (scope IN ('file', 'folder', 'pattern')),
  pattern     TEXT NOT NULL,
  choice      TEXT NOT NULL CHECK (choice IN ('leave_out', 'include')),
  destination TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_backup_rules_backup ON backup_rules(backup_id);
CREATE UNIQUE INDEX idx_backup_rules_unique ON backup_rules(coalesce(backup_id, 0), scope, pattern, choice, coalesce(destination, ''));

CREATE TABLE backup_checklist (
  backup_id INTEGER NOT NULL,
  item      TEXT NOT NULL,
  ticked_at INTEGER,
  PRIMARY KEY (backup_id, item)
);
${COPY_EXCLUSIONS_SQL}
`;
