/**
 * Your own choices about files (Batch 2). Two small additive tables, nothing existing changes, nothing is ever deleted:
 * - `kind_overrides`: the kind you gave a file (for example "Camera videos"). It wins over the automatic kind, and the
 *   sorting job uses it whenever it sorts a row again. Keyed by place and path, like the rows of `files`.
 * - `review_decisions`: what you decided in the review of unprotected files: 'backup' (added to a collection), 'ignore'
 *   (not counted as unprotected anywhere, can be undone) or 'later'. Keyed by place and path as well.
 */
export const reviewSql = `
CREATE TABLE kind_overrides (
  place_id TEXT NOT NULL REFERENCES places(id),
  rel_path TEXT NOT NULL,
  kind     TEXT NOT NULL,
  set_at   INTEGER NOT NULL,
  PRIMARY KEY (place_id, rel_path)
) WITHOUT ROWID;

CREATE TABLE review_decisions (
  place_id      TEXT NOT NULL REFERENCES places(id),
  rel_path      TEXT NOT NULL,
  decision      TEXT NOT NULL CHECK (decision IN ('backup', 'ignore', 'later')),
  collection_id INTEGER,
  decided_at    INTEGER NOT NULL,
  PRIMARY KEY (place_id, rel_path)
) WITHOUT ROWID;
CREATE INDEX idx_review_decisions_decision ON review_decisions(decision, place_id);
`;
