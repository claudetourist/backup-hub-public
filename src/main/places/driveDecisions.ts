/**
 * "Needs your decision" items about drive identity (S1; PLAN.md section 12). A drive whose ID card matches a known place is the same
 * drive only if its serial and size still match what was stored. When they do not (a copied card on another drive, a drive that was
 * formatted or swapped), nothing is written to it until the person answers, and the stored facts are NEVER overwritten silently. Two
 * connected drives that carry the same card are blocked the same way. Rows live in `drive_decisions` (migration 0021).
 *
 * Answers: 'accepted' = it is the same drive, take the new serial and size; 'rejected' = it is not: the drive stays blocked. A
 * duplicate-card item cannot be accepted: it closes by itself ('resolved') when only one drive carries the card again.
 *
 * A drive with an ID card at the new place AND one at the old place that name different drives is the same kind of item
 * ('card_conflict'): nothing is written to it, it cannot be answered here, and it closes by itself when the two cards agree again
 * (the person removes or fixes one by hand; the app never removes either).
 */
import type { Db } from '../db/connection';

export type DecisionKind = 'serial_changed' | 'size_changed' | 'cloned_card' | 'card_conflict';

export interface DriveDecision {
  id: number;
  placeId: string;
  kind: DecisionKind;
  detail: Record<string, unknown>;
  foundAt: number;
  answeredAt: number | null;
  answer: 'accepted' | 'rejected' | 'resolved' | null;
}

interface Row {
  id: number;
  place_id: string;
  kind: DecisionKind;
  detail_json: string;
  found_at: number;
  answered_at: number | null;
  answer: DriveDecision['answer'];
}

const toDecision = (r: Row): DriveDecision => ({ id: r.id, placeId: r.place_id, kind: r.kind, detail: safeParse(r.detail_json), foundAt: r.found_at, answeredAt: r.answered_at, answer: r.answer });

function safeParse(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Every item that is open or was rejected, newest first. */
export function listDecisions(db: Db, onlyOpen = false): DriveDecision[] {
  const sql = onlyOpen ? 'SELECT * FROM drive_decisions WHERE answered_at IS NULL ORDER BY id DESC' : 'SELECT * FROM drive_decisions ORDER BY id DESC LIMIT 200';
  return (db.prepare(sql).all() as Row[]).map(toDecision);
}

/**
 * Stores an item for `placeId` unless the same one is already open, or was rejected with the same facts (a rejected drive stays
 * blocked without asking again). Returns true when a new item was stored.
 */
export function recordDecision(db: Db, placeId: string, kind: DecisionKind, detail: Record<string, unknown>, now: number): boolean {
  const json = JSON.stringify(detail);
  const same = db.prepare("SELECT 1 FROM drive_decisions WHERE place_id = ? AND kind = ? AND detail_json = ? AND (answered_at IS NULL OR answer = 'rejected') LIMIT 1").get(placeId, kind, json);
  if (same) return false;
  db.prepare('INSERT INTO drive_decisions (place_id, kind, detail_json, found_at) VALUES (?, ?, ?, ?)').run(placeId, kind, json, now);
  return true;
}

/** Card ids that must not be written to: an open item, or a rejected one. Value = the plain sentence to show. */
export function blockedCards(db: Db): Map<string, string> {
  const out = new Map<string, string>();
  const rows = db.prepare("SELECT * FROM drive_decisions WHERE answered_at IS NULL OR answer = 'rejected' ORDER BY id").all() as Row[];
  for (const r of rows) {
    const why =
      r.kind === 'cloned_card'
        ? 'Two connected drives carry the same ID card, so nothing is written to either until you decide.'
        : r.kind === 'card_conflict'
          ? 'This drive has two different ID cards (one in the old place, one in the new place), so nothing is written to it until only one is left.'
          : r.kind === 'serial_changed'
            ? 'This drive has the ID card of a known drive but another serial number, so nothing is written to it until you decide whether it is the same drive.'
            : 'This drive has the ID card of a known drive but another size, so nothing is written to it until you decide whether it is the same drive.';
    out.set(r.place_id.toLowerCase(), why);
  }
  return out;
}

function resolveGone(db: Db, kind: DecisionKind, still: ReadonlySet<string>, now: number): void {
  const open = db.prepare('SELECT id, place_id FROM drive_decisions WHERE kind = ? AND answered_at IS NULL').all(kind) as { id: number; place_id: string }[];
  for (const r of open) if (!still.has(r.place_id)) db.prepare("UPDATE drive_decisions SET answered_at = ?, answer = 'resolved' WHERE id = ?").run(now, r.id);
}

/** Closes the open duplicate-card items of every card that is no longer duplicated ("resolved"). */
export function resolveGoneDuplicates(db: Db, stillDuplicated: ReadonlySet<string>, now: number): void {
  resolveGone(db, 'cloned_card', stillDuplicated, now);
}

/** Closes the open two-cards items of every drive whose two cards no longer disagree ("resolved"). */
export function resolveGoneConflicts(db: Db, stillConflicting: ReadonlySet<string>, now: number): void {
  resolveGone(db, 'card_conflict', stillConflicting, now);
}

export type AnswerResult = { ok: true; decision: DriveDecision } | { ok: false; message: string };

/** Answers an open item. 'accepted' on a serial or size item returns the new facts for the caller to store. */
export function answerDecision(db: Db, id: number, answer: 'accepted' | 'rejected', now: number): AnswerResult {
  const row = db.prepare('SELECT * FROM drive_decisions WHERE id = ?').get(id) as Row | undefined;
  if (!row) return { ok: false, message: 'That item is not there any more.' };
  if (row.answered_at !== null) return { ok: false, message: 'That item was already answered.' };
  if (row.kind === 'card_conflict') return { ok: false, message: 'This drive has two different ID cards. Remove or fix one of them yourself; this item closes when only one is left.' };
  if (row.kind === 'cloned_card' && answer === 'accepted') return { ok: false, message: 'Two drives with the same card cannot both be this drive. Give one of them a new ID card, or unplug it.' };
  db.prepare('UPDATE drive_decisions SET answered_at = ?, answer = ? WHERE id = ?').run(now, answer, id);
  return { ok: true, decision: toDecision({ ...row, answered_at: now, answer }) };
}
