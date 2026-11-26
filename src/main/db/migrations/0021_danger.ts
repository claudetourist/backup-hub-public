/**
 * S1 (22 Nov 2026): the permanent log of everything the one guarded path (`main/danger`) removed, moved aside or refused, and the
 * "Needs your decision" items about drive identity. Additive only: two new tables, nothing else changes.
 *
 * - danger_log: one row per item the guarded path was asked to act on. Written BEFORE the action (outcome 'started') and updated
 *   after it ('done', 'failed') or written at once as 'refused'. The app never deletes or edits these rows other than that update.
 *   proof_json holds the checksums read fresh from the surviving copies; list_hash is the hash of the list the person confirmed.
 * - drive_decisions: a drive whose ID card matches a known place but whose stored serial or size differs, or two drives that carry the
 *   same card. Nothing is written to that drive until it is answered ('accepted' = it is the same drive, take the new facts;
 *   'rejected' = it is not, the drive stays blocked).
 */
export const dangerSql = `
CREATE TABLE danger_log (
  id          INTEGER PRIMARY KEY,
  at          INTEGER NOT NULL,
  list_id     TEXT NOT NULL,
  list_hash   TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  action      TEXT NOT NULL,
  target      TEXT NOT NULL,
  to_path     TEXT,
  size        INTEGER,
  content_hash TEXT,
  proof_json  TEXT NOT NULL DEFAULT '[]',
  outcome     TEXT NOT NULL,
  detail      TEXT
);
CREATE INDEX idx_danger_log_list ON danger_log(list_id);
CREATE INDEX idx_danger_log_at ON danger_log(at);

CREATE TABLE drive_decisions (
  id          INTEGER PRIMARY KEY,
  place_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  found_at    INTEGER NOT NULL,
  answered_at INTEGER,
  answer      TEXT
);
CREATE INDEX idx_drive_decisions_place ON drive_decisions(place_id, answered_at);
`;
