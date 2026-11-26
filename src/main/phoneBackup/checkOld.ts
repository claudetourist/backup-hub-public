/**
 * What the index says about the phone's files and their copies on the backup's drive (R1.4b, "Check old copies"): counts per folder and
 * the list of copies still to be checked. Read only, no adb, no drive: it answers from the index in one pass. The decision "is this file
 * backed up, and is that copy worth anything" is `backedUpAt` of the look (the same one the plan uses), so the counts, the plan and the
 * check can never disagree. Only the drive of destination 1 is asked about for now; the destination is a parameter so position 2 can be
 * added later without a rewrite.
 */
import type { Db } from '../db';
import { prefixUpperBound } from '../listing/skipRules';
import { parseFilters } from '../backupProfiles/filters';
import { phoneFolderGroup, type CheckOldCounts, type CheckOldCountsResult, type CheckOldFolder, type CheckOldFolderCounts, type CountBucket } from '../../shared/phoneBackup';
import { backedUpAt, type ChangeRule, type CopyRow, type DestinationRef } from '../look/compare';
import { loadDestinations } from '../look/lookStore';
import { leftOutBy, nomediaDirsOf } from './filterModel';
import { isLeftOut } from '../rules/ruleMatcher';
import { RulesStore } from '../rules/rulesStore';
import { finishSync, STEP_ITEMS, type Steps } from '../sliceWork';

export type CheckState = 'checked' | 'unchecked' | 'none' | 'left_out';

/** One phone file as the index knows it, with what the destination holds for it. */
export interface PhoneFileState {
  rowId: number;
  /** "/sdcard/DCIM/Camera/a.jpg" */
  path: string;
  size: number;
  group: string;
  state: CheckState;
  /** The copy at the destination (checked or unchecked), else null. */
  copyId: number | null;
  copyRel: string | null;
}

export interface PhoneBackupInfo {
  id: number;
  name: string;
  phonePlaceId: string;
  serial: string | null;
  changeRule: ChangeRule;
  filtersJson: string;
  enabled: boolean;
}

/** The phone backup with this id, or why it cannot be used. */
export function loadPhoneBackup(db: Db, backupId: unknown): { ok: true; backup: PhoneBackupInfo; dest: DestinationRef } | { ok: false; message: string } {
  if (typeof backupId !== 'number' || !Number.isInteger(backupId) || backupId <= 0) return { ok: false, message: 'That backup is not valid.' };
  const row = db.prepare('SELECT id, name, source_kind, source_place_id, phone_serial, change_rule, filters_json, enabled FROM backup_profiles WHERE id = ?').get(backupId) as
    | { id: number; name: string; source_kind: string; source_place_id: string | null; phone_serial: string | null; change_rule: ChangeRule; filters_json: string; enabled: number }
    | undefined;
  if (!row) return { ok: false, message: 'That backup does not exist.' };
  if (row.source_kind !== 'phone' || row.source_place_id === null) return { ok: false, message: 'That is not a phone backup.' };
  if (row.enabled !== 1) return { ok: false, message: 'This backup is switched off.' };
  // Destination 1 only: the drive the phone is copied to. (Destination 2, the mirror, is not checked here.)
  const dest = loadDestinations(db, row.id)[0];
  if (!dest) return { ok: false, message: 'This backup has no drive to go to yet.' };
  return { ok: true, backup: { id: row.id, name: row.name, phonePlaceId: row.source_place_id, serial: row.phone_serial, changeRule: row.change_rule, filtersJson: row.filters_json, enabled: true }, dest };
}

/**
 * Reading 100,000 phone rows and their copies touches more pages than the connection's usual cache holds, and half of the time went to
 * reading the same pages again. The cache is made bigger for the two reads only and put back.
 */
function withBigCache<T>(db: Db, read: () => T): T {
  const before = db.pragma('cache_size', { simple: true }) as number;
  db.pragma('cache_size = -131072');
  try {
    return read();
  } finally {
    db.pragma(`cache_size = ${before}`);
  }
}

/** Rows per page of the two big reads (a few milliseconds each, so a sliced caller can give the window a turn between pages). */
const PAGE_ROWS = 2000;
/** The same reads for a caller that runs them all at once (worker thread, tests): fewer, bigger pages. */
const ALL_AT_ONCE_PAGE_ROWS = 50_000;

type CopyTuple = [number, string, number | null, number | null, string | null, string | null, number, string | null, number | null];

/**
 * Every copy row in a place that points at a source row and still counts as a copy (a gone one or one marked different never does, so it is
 * not even read), read a page at a time in path order: a caller that runs on the main thread yields between pages (see sliceWork.ts).
 */
function* copiesInSteps(db: Db, placeId: string, pageRows: number): Steps<Map<number, CopyRow[]>> {
  // Plain arrays, not objects: 100,000 rows come back in about half the time.
  const page = db
    .prepare(`SELECT id, rel_path, size, mtime, sha256, expected_sha256, origin_file_id, verified_how, gone_at FROM files WHERE place_id = ? AND rel_path > ? AND origin_file_id IS NOT NULL AND gone_at IS NULL AND (verified_how IS NULL OR verified_how <> 'differs') ORDER BY rel_path LIMIT ${pageRows}`)
    .raw();
  const by = new Map<number, CopyRow[]>();
  let after = '';
  for (;;) {
    const rows = page.all(placeId, after) as CopyTuple[];
    for (const [id, relPath, size, mtime, sha256, expected, origin, how, goneAt] of rows) {
      const copy: CopyRow = { id, placeId, relPath, size, mtimeMs: mtime, sha256, expectedSha256: expected, originFileId: origin, verifiedHow: how, goneAt };
      const list = by.get(origin);
      if (list) list.push(copy);
      else by.set(origin, [copy]);
    }
    if (rows.length < pageRows) return by;
    after = rows[rows.length - 1]![1];
    yield;
  }
}

/** The live rows of the phone below /sdcard, a page at a time in path order. */
function* liveRowsSteps(db: Db, placeId: string, pageRows: number): Steps<[number, string, number | null, number | null, string | null][]> {
  const lo = 'sdcard/';
  const hi = prefixUpperBound(lo);
  const first = db.prepare(`SELECT id, rel_path, size, mtime, sha256 FROM files WHERE place_id = ? AND gone_at IS NULL AND rel_path >= ? AND rel_path < ? ORDER BY rel_path LIMIT ${pageRows}`).raw();
  const next = db.prepare(`SELECT id, rel_path, size, mtime, sha256 FROM files WHERE place_id = ? AND gone_at IS NULL AND rel_path > ? AND rel_path < ? ORDER BY rel_path LIMIT ${pageRows}`).raw();
  const out: [number, string, number | null, number | null, string | null][] = [];
  let rows = first.all(placeId, lo, hi) as typeof out;
  for (;;) {
    for (const r of rows) out.push(r);
    if (rows.length < pageRows) return out;
    yield;
    rows = next.all(placeId, rows[rows.length - 1]![1], hi) as typeof out;
  }
}

/**
 * Every phone file on the phone at the last look, sorted into: a checked copy at the destination, a copy that was never checked, no copy
 * and left out on purpose (a filter or the person's own rule), no copy and wanted. A file with a copy is counted by its copy (as the
 * plan does); a copy marked as different or gone does not count as a copy.
 * Written once as steps (a yield between pages and every STEP_ITEMS files): the main thread runs it sliced, the worker thread all at once.
 */
export function* classifyPhoneFilesSteps(db: Db, backup: PhoneBackupInfo, dest: DestinationRef, pageRows: number = PAGE_ROWS): Steps<PhoneFileState[]> {
  const live = yield* liveRowsSteps(db, backup.phonePlaceId, pageRows);
  const copies = yield* copiesInSteps(db, dest.placeId, pageRows);
  const filters = parseFilters(backup.filtersJson);
  const rules = new RulesStore(db).compiled(backup.id);
  const nomedia = nomediaDirsOf(live.filter((r) => r[1].endsWith('/.nomedia')).map((r) => '/' + r[1]));
  yield;
  const out: PhoneFileState[] = [];
  for (const [id, relPath, rowSize, mtime, sha256] of live) {
    const path = '/' + relPath;
    const size = rowSize ?? 0;
    const here = backedUpAt(id, { size: rowSize, mtimeMs: mtime, sha256 }, dest, copies.get(id) ?? [], backup.changeRule);
    let state: CheckState;
    let copy: CopyRow | undefined;
    if (here.backedUp) {
      state = here.worth === 'verified' ? 'checked' : 'unchecked';
      copy = copies.get(id)!.find((c) => c.id === here.copyId);
    } else state = isLeftOut(rules.match(path), () => leftOutBy(path, filters, nomedia)) ? 'left_out' : 'none';
    out.push({ rowId: id, path, size, group: phoneFolderGroup(path), state, copyId: copy?.id ?? null, copyRel: copy?.relPath ?? null });
    if (out.length % STEP_ITEMS === 0) yield;
  }
  return out;
}

/** All at once, on a worker thread or in a test (the big reads get a bigger page cache; see `withBigCache`). */
export function classifyPhoneFiles(db: Db, backup: PhoneBackupInfo, dest: DestinationRef): PhoneFileState[] {
  return withBigCache(db, () => finishSync(classifyPhoneFilesSteps(db, backup, dest, ALL_AT_ONCE_PAGE_ROWS)));
}

const empty = (): CountBucket => ({ files: 0, bytes: 0 });
const emptyCounts = (): CheckOldCounts => ({ onPhone: empty(), checked: empty(), unchecked: empty(), noCopy: empty(), leftOut: empty() });
const add = (b: CountBucket, size: number): void => {
  b.files += 1;
  b.bytes += size;
};

function addTo(c: CheckOldCounts, f: PhoneFileState): void {
  add(c.onPhone, f.size);
  add(f.state === 'checked' ? c.checked : f.state === 'unchecked' ? c.unchecked : f.state === 'left_out' ? c.leftOut : c.noCopy, f.size);
}

/** Totals and one line per folder (biggest first). */
export function countPhoneFiles(files: readonly PhoneFileState[]): { total: CheckOldCounts; folders: CheckOldFolderCounts[] } {
  const total = emptyCounts();
  const by = new Map<string, CheckOldFolderCounts>();
  for (const f of files) {
    addTo(total, f);
    let line = by.get(f.group);
    if (!line) by.set(f.group, (line = { folder: f.group, ...emptyCounts() }));
    addTo(line, f);
  }
  return { total, folders: [...by.values()].toSorted((a, b) => b.onPhone.bytes - a.onPhone.bytes || (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0)) };
}

/**
 * The whole answer of "how many files have a checked copy" for one backup, in steps (see `classifyPhoneFilesSteps`). Reads only the index:
 * no phone, no drive. `checkOldCountsOf` is the same answer all at once, for the worker thread.
 */
export function* checkOldCountsSteps(db: Db, backupId: unknown, pageRows: number = PAGE_ROWS): Steps<CheckOldCountsResult> {
  const loaded = loadPhoneBackup(db, backupId);
  if (!loaded.ok) return loaded;
  const { backup, dest } = loaded;
  const files = yield* classifyPhoneFilesSteps(db, backup, dest, pageRows);
  const { total, folders } = countPhoneFiles(files);
  const driveLabel = (db.prepare('SELECT label FROM places WHERE id = ?').pluck().get(dest.placeId) as string | undefined) ?? 'the drive';
  const lookedAt = (db.prepare('SELECT last_looked_at FROM places WHERE id = ?').pluck().get(backup.phonePlaceId) as number | null | undefined) ?? null;
  return { ok: true, backupId: backup.id, driveLabel, lookedAt, total, folders };
}

export function checkOldCountsOf(db: Db, backupId: unknown): CheckOldCountsResult {
  return withBigCache(db, () => finishSync(checkOldCountsSteps(db, backupId, ALL_AT_ONCE_PAGE_ROWS)));
}

/** The folders that hold copies not checked yet, largest first. */
export function uncheckedFolders(files: readonly PhoneFileState[]): CheckOldFolder[] {
  const by = new Map<string, CheckOldFolder>();
  for (const f of files) {
    if (f.state !== 'unchecked') continue;
    const line = by.get(f.group) ?? { folder: f.group, files: 0, bytes: 0 };
    line.files += 1;
    line.bytes += f.size;
    by.set(f.group, line);
  }
  return [...by.values()].toSorted((a, b) => b.bytes - a.bytes || (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
}

/** The copies to check for the chosen folders, in a fixed order (folder, then name), so a Continue goes on from the same place. */
export function uncheckedItems(files: readonly PhoneFileState[], folders: ReadonlySet<string>): PhoneFileState[] {
  return files.filter((f) => f.state === 'unchecked' && folders.has(f.group) && f.copyId !== null && f.copyRel !== null).toSorted((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : a.rowId - b.rowId));
}
