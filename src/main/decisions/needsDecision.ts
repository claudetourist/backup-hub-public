/**
 * "Needs your decision" (PLAN.md section 3b): ONE read-only list of the open cases that already exist. It has no table of its own and
 * writes nothing; each case is kept by the part that found it, and an answer goes back to that part (decisionService.ts):
 *  - a drive that may not be the same drive (`drive_decisions`, places/driveDecisions.ts);
 *  - a look at the phone that was refused (`phoneBackup/lookRefusals.ts`, the newest unsettled one of each backup);
 *  - copies that "Check old copies" found different from the phone's file (`file_problems`, kind copy_differs, state open).
 * Interrupted jobs that wait for Continue stay in Home's "Needs you" lines (jobs are listed there already); they are not repeated here.
 */
import { DECISION_CHOICE_LABELS, DECISIONS_LIMIT, decisionKey, type DecisionCase, type DecisionChoice, type DecisionList, type DecisionListRequest } from '../../shared/decisions';
import type { Db } from '../db';
import type { DecisionKind as LookKind } from '../look/lookGuard';
import { listDecisions as listDriveDecisions, type DriveDecision } from '../places/driveDecisions';
import { loadRefusals, type LookRefusal } from '../phoneBackup/lookRefusals';
import { MIRROR_DAMAGED_PROBLEM } from '../../shared/mirror';

const choice = (id: DecisionChoice['id'], hint?: string): DecisionChoice => ({ id, label: DECISION_CHOICE_LABELS[id], action: id === 'show_file' ? 'open' : 'answer', ...(hint ? { hint } : {}) });

const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v !== '' ? v : fallback);

// ---- drives ------------------------------------------------------------------------------------------------------------------------

export function driveCase(d: DriveDecision): DecisionCase {
  const name = str(d.detail['name'], 'A drive');
  const base = { key: decisionKey.drive(d.id), source: 'drive' as const, at: d.foundAt, backupId: null, fileId: null, similar: 0 };
  if (d.kind === 'serial_changed' || d.kind === 'size_changed') {
    const differs = d.kind === 'serial_changed' ? 'its own identification number is not the one' : 'its size is not the one';
    return {
      ...base,
      headline: `Is this still ${name}?`,
      what: `A drive that has the name card of ${name} is plugged in, but ${differs} Backup Hub remembers. Nothing is written to it until you say.`,
      choices: [choice('same_drive', 'Backup Hub remembers the new number from now on'), choice('other_drive', 'Nothing is written to it')],
      note: null,
    };
  }
  if (d.kind === 'cloned_card') {
    const letters = Array.isArray(d.detail['letters']) ? (d.detail['letters'] as unknown[]).filter((l): l is string => typeof l === 'string') : [];
    return {
      ...base,
      headline: `Two drives claim to be ${name}`,
      what: `Two plugged-in drives carry the same name card${letters.length > 0 ? ` (${letters.join(' and ')})` : ''}. Nothing is written to either until only one is left.`,
      choices: [],
      note: 'Unplug one of the two drives. This closes by itself.',
    };
  }
  return {
    ...base,
    headline: `${name} has two different name cards`,
    what: `This drive has the name card of ${name} in one place and the card of ${str(d.detail['oldName'], 'another drive')} in the other. Nothing is written to it until only one is left.`,
    choices: [],
    note: 'Remove or fix one of the two cards yourself. This closes by itself.',
  };
}

// ---- a look at the phone that was refused ---------------------------------------------------------------------------------------------

const LOOK_HEADLINES: Record<LookKind, (name: string) => string> = {
  look_incomplete: (n) => `${n}: the phone's file list did not come back complete`,
  look_empty: (n) => `${n}: the phone showed no files`,
  look_mass_change: (n) => `${n}: many files look gone or changed`,
  look_name_clash: (n) => `${n}: two files on the phone have the same name`,
};

export function lookCase(r: LookRefusal, backupName: string): DecisionCase {
  const choices = [choice('try_again', 'Reads the phone again; nothing is copied yet')];
  if (r.canAccept) choices.push(choice('accept', 'Only if you know the change is real'));
  return { key: decisionKey.look(r.backupId), source: 'phone_look', headline: LOOK_HEADLINES[r.kind](backupName), what: r.message, at: r.at, choices, note: null, backupId: r.backupId, fileId: null, similar: 0 };
}

// ---- copies found different ----------------------------------------------------------------------------------------------------------

interface DiffersRow {
  problem_id: number;
  file_id: number;
  detected_at: number;
  copy_rel: string;
  drive_label: string;
  phone_rel: string | null;
  backup_id: number | null;
}

const baseName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);

export function differsCase(r: DiffersRow, similar: number): DecisionCase {
  const name = baseName(r.phone_rel ?? r.copy_rel);
  return {
    key: decisionKey.differs(r.problem_id),
    source: 'copy_differs',
    headline: `${name}: the copy on ${r.drive_label} is not the same as the phone's file`,
    what: `Check old copies read both files and they are different. Your copy on ${r.drive_label} was not touched. The next backup copies the phone's file again into a new folder.`,
    at: r.detected_at,
    choices: [choice('copy_again', 'This is what happens anyway; this only marks it as seen'), choice('show_file', `Opens the folder on ${r.drive_label}`)],
    note: null,
    backupId: r.backup_id,
    fileId: r.file_id,
    similar,
  };
}

const DIFFERS_FROM = `
  FROM file_problems fp
  JOIN files c ON c.id = fp.file_id
  JOIN places cp ON cp.id = c.place_id
  LEFT JOIN files p ON p.id = c.origin_file_id
  LEFT JOIN backup_profiles bp ON bp.source_place_id = p.place_id AND bp.source_kind = 'phone'
  WHERE fp.kind = 'copy_differs' AND fp.state = 'open'`;

/** Open copy problems of one backup (the number "Do the same for the others" covers). */
export function openDiffers(db: Db, backupId: number | null): number {
  if (backupId === null) return 0;
  return db.prepare(`SELECT count(*) ${DIFFERS_FROM} AND bp.id = ?`).pluck().get(backupId) as number;
}

/** The backup an open copy problem belongs to (null when it belongs to none, or is not open). */
export function backupOfDiffers(db: Db, problemId: number): number | null {
  return (db.prepare(`SELECT bp.id ${DIFFERS_FROM} AND fp.id = ?`).pluck().get(problemId) as number | null | undefined) ?? null;
}

// ---- the second drive (R1.3) ------------------------------------------------------------------------------------------------------------

interface MirrorRow {
  problem_id: number;
  kind: string;
  file_id: number;
  detected_at: number;
  rel_path: string;
  src_label: string;
  dst_label: string | null;
  backup_id: number | null;
}

export function mirrorCase(r: MirrorRow): DecisionCase {
  const name = baseName(r.rel_path);
  const dst = r.dst_label ?? 'the second drive';
  const damaged = r.kind === MIRROR_DAMAGED_PROBLEM;
  return {
    key: decisionKey.mirror(r.problem_id),
    source: 'mirror',
    headline: damaged ? `${name}: this ${r.src_label} copy looks damaged` : `${name}: a different file is already on ${dst}`,
    what: damaged
      ? `The copy of this file on ${r.src_label} no longer matches the checksum it should have, so it was NOT copied to ${dst}. Nothing on either drive was changed. A good copy of it may still be on the phone or elsewhere.`
      : `A file with the same name is already on ${dst} but its content is not the same as the one on ${r.src_label}. It was not replaced and nothing on either drive was changed.`,
    at: r.detected_at,
    choices: [choice('leave_as_is', 'Only marks it as seen: the file stays as it is on both drives'), choice('show_file', `Opens the folder on ${r.src_label}`)],
    note: null,
    backupId: r.backup_id,
    fileId: r.file_id,
    similar: 0,
  };
}

const MIRROR_FROM = `
  FROM file_problems fp
  JOIN files c ON c.id = fp.file_id
  JOIN places cp ON cp.id = c.place_id
  LEFT JOIN backup_destinations bd ON bd.place_id = c.place_id AND bd.position = 1 AND bd.enabled = 1 AND substr(c.rel_path, 1, length(bd.root) + 1) = bd.root || '/'
  LEFT JOIN backup_destinations b2 ON b2.backup_profile_id = bd.backup_profile_id AND b2.position = 2 AND b2.enabled = 1
  LEFT JOIN places dp ON dp.id = b2.place_id
  WHERE fp.kind IN ('mirror_damaged', 'mirror_differs') AND fp.state = 'open'`;

// ---- the list ----------------------------------------------------------------------------------------------------------------------

/** Every open case, drives first (they block writing), then refused looks, then different copies, each newest first. Reads only. */
export function listNeedsDecision(db: Db, request: DecisionListRequest = {}): DecisionList {
  const { backupId, since } = request;
  const cases: DecisionCase[] = [];

  const driveIds =
    backupId === undefined ? null : new Set(db.prepare('SELECT place_id FROM backup_destinations WHERE backup_profile_id = ? AND enabled = 1').pluck().all(backupId) as string[]);
  for (const d of listDriveDecisions(db, true).toSorted((a, b) => b.foundAt - a.foundAt || b.id - a.id)) {
    if (driveIds !== null && !driveIds.has(d.placeId)) continue;
    if (since !== undefined && d.foundAt < since) continue;
    cases.push(driveCase(d));
  }

  const names = new Map((db.prepare("SELECT id, name FROM backup_profiles WHERE source_kind = 'phone' AND enabled = 1").all() as { id: number; name: string }[]).map((r) => [r.id, r.name]));
  for (const r of loadRefusals(db)) {
    const name = names.get(r.backupId);
    if (name === undefined) continue;
    if (backupId !== undefined && r.backupId !== backupId) continue;
    if (since !== undefined && r.at < since) continue;
    cases.push(lookCase(r, name));
  }

  const filter = `${backupId === undefined ? '' : ' AND bp.id = ?'}${since === undefined ? '' : ' AND fp.detected_at >= ?'}`;
  const args: number[] = [...(backupId === undefined ? [] : [backupId]), ...(since === undefined ? [] : [since])];
  const baseCount = cases.length;
  const mirrorFilter = `${backupId === undefined ? '' : ' AND bd.backup_profile_id = ?'}${since === undefined ? '' : ' AND fp.detected_at >= ?'}`;
  const mirrorRows = db
    .prepare(
      `SELECT fp.id AS problem_id, fp.kind AS kind, fp.file_id AS file_id, fp.detected_at AS detected_at, c.rel_path AS rel_path, cp.label AS src_label, dp.label AS dst_label, bd.backup_profile_id AS backup_id
       ${MIRROR_FROM}${mirrorFilter} ORDER BY fp.detected_at DESC, fp.id DESC LIMIT ?`,
    )
    .all(...args, DECISIONS_LIMIT) as MirrorRow[];
  for (const r of mirrorRows.slice(0, Math.max(0, DECISIONS_LIMIT - cases.length))) cases.push(mirrorCase(r));
  const mirrorTotal = (db.prepare(`SELECT count(*) ${MIRROR_FROM}${mirrorFilter}`).pluck().get(...args) as number);
  const total = (db.prepare(`SELECT count(*) ${DIFFERS_FROM}${filter}`).pluck().get(...args) as number) + baseCount + mirrorTotal;
  const rows = db
    .prepare(
      `SELECT fp.id AS problem_id, fp.file_id AS file_id, fp.detected_at AS detected_at, c.rel_path AS copy_rel, cp.label AS drive_label, p.rel_path AS phone_rel, bp.id AS backup_id
       ${DIFFERS_FROM}${filter} ORDER BY fp.detected_at DESC, fp.id DESC LIMIT ?`,
    )
    .all(...args, Math.max(0, DECISIONS_LIMIT - cases.length)) as DiffersRow[];
  const perBackup = new Map<number, number>();
  for (const r of rows) {
    if (r.backup_id !== null && !perBackup.has(r.backup_id)) perBackup.set(r.backup_id, openDiffers(db, r.backup_id));
  }
  for (const r of rows) {
    const open = r.backup_id === null ? 0 : (perBackup.get(r.backup_id) ?? 0);
    cases.push(differsCase(r, Math.max(0, open - 1)));
  }
  return { cases, total };
}
