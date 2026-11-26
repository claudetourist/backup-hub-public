/**
 * Get files back: what the index says about a backup's copies on a drive. Read only, and every loop over files is a generator step
 * (`sliceWork.ts`), so a backup of 100,000 files never blocks the window. Nothing here touches a drive.
 *
 * A backup keeps its files at `<root>/<dated folder>/<path below the backed-up folder>` on a drive (the Keep notes: `<root>/<path>`, flat).
 */
import path from 'node:path';
import type { Db } from '../db';
import { sessionDate } from '../backupProfiles/history';
import { parseSessionRel, nameKey } from '../folderBackup/folderPaths';
import { prefixUpperBound } from '../listing/skipRules';
import { sortSteps, STEP_ITEMS, type Steps } from '../sliceWork';
import { KEEP_SYNC_KEY } from '../../shared/folderBackup';
import type { RestoreDateView, RestoreEntry } from '../../shared/restore';
import { cleanName, heldReason, numberedFile, safeParts } from './restoreModel';

const PAGE = 5000;
/** Sorts after every character that can appear in a path. */
const AFTER_ALL = String.fromCharCode(0xffff);
/** A folder with more files than this lists only this many of them (the rest are counted). */
export const MAX_LISTED_FILES = 3000;

export interface BackupDest {
  placeId: string;
  /** The backup folder on the drive, forward slashes, no slash at either end ("MyData/POCO"). */
  root: string;
  position: number;
  label: string;
  placeKind: string;
}

export interface BackupInfo {
  id: number;
  name: string;
  kind: 'phone' | 'folder';
  /** The Keep notes: one flat folder, no dated folders. */
  flat: boolean;
  prefix: string;
  /** The backed-up folder (a folder backup), else ''. */
  sourceRoot: string;
  destinations: BackupDest[];
}

const cleanRoot = (r: string): string => r.replace(/^\/+|\/+$/g, '');

export function loadBackup(db: Db, backupId: number): BackupInfo | null {
  const p = db.prepare('SELECT id, name, source_kind, source_root, folder_prefix, import_key FROM backup_profiles WHERE id = ?').get(backupId) as
    | { id: number; name: string; source_kind: 'phone' | 'folder'; source_root: string; folder_prefix: string; import_key: string | null }
    | undefined;
  if (!p) return null;
  const dests = db
    .prepare('SELECT d.place_id, d.root, d.position, pl.label, pl.kind FROM backup_destinations d JOIN places pl ON pl.id = d.place_id WHERE d.backup_profile_id = ? AND d.enabled = 1 ORDER BY d.position, d.id')
    .all(backupId) as { place_id: string; root: string; position: number; label: string; kind: string }[];
  return {
    id: p.id,
    name: p.name,
    kind: p.source_kind,
    flat: p.import_key === KEEP_SYNC_KEY,
    prefix: p.folder_prefix,
    sourceRoot: p.source_root,
    destinations: dests.map((d) => ({ placeId: d.place_id, root: cleanRoot(d.root), position: d.position, label: d.label, placeKind: d.kind })),
  };
}

/** Every backup folder of every backup: where a copy found by a file's id belongs. Longest folder first (a folder inside another one). */
export interface RootRef {
  backup: BackupInfo;
  placeId: string;
  root: string;
}

export function loadAllRoots(db: Db): RootRef[] {
  const ids = db.prepare('SELECT id FROM backup_profiles ORDER BY id').pluck().all() as number[];
  const out: RootRef[] = [];
  for (const id of ids) {
    const backup = loadBackup(db, id);
    if (backup) for (const d of backup.destinations) out.push({ backup, placeId: d.placeId, root: d.root });
  }
  return out.toSorted((a, b) => b.root.length - a.root.length);
}

interface Row {
  id: number;
  place_id: string;
  rel_path: string;
  size: number;
  mtime: number | null;
  sha256: string | null;
  expected_sha256: string | null;
  verified_how: string | null;
}

const COLS = 'id, place_id, rel_path, size, mtime, sha256, expected_sha256, verified_how';
const upper = (prefix: string): string => (prefix === '' ? AFTER_ALL : prefixUpperBound(prefix));
const basePrefix = (root: string): string => (root === '' ? '' : root + '/');

/** The live rows under a prefix (ending with "/", or "" for a whole drive), in path order, a page at a time. */
function* scan(db: Db, placeId: string, prefix: string, onRow: (r: Row) => void): Steps<void> {
  const page = db.prepare(`SELECT ${COLS} FROM files WHERE place_id = ? AND rel_path > ? AND rel_path < ? AND gone_at IS NULL AND size IS NOT NULL ORDER BY rel_path LIMIT ${PAGE}`);
  const hi = upper(prefix);
  let last = prefix;
  let n = 0;
  for (;;) {
    const rows = page.all(placeId, last, hi) as Row[];
    for (const r of rows) {
      if (n++ % STEP_ITEMS === STEP_ITEMS - 1) yield;
      onRow(r);
    }
    if (rows.length < PAGE) return;
    last = rows[rows.length - 1]!.rel_path;
    yield;
  }
}

// ---- the dated folders -------------------------------------------------------------------------------------------------------------------

/** The dated folders of a backup on a drive, newest first. It hops from one folder to the next along the (place, path) index, so it costs one read per folder. */
export function* listDatesSteps(db: Db, o: { placeId: string; root: string; prefix: string }): Steps<RestoreDateView[]> {
  const base = basePrefix(o.root);
  const next = db.prepare('SELECT rel_path FROM files WHERE place_id = ? AND rel_path > ? AND gone_at IS NULL ORDER BY rel_path LIMIT 1').pluck();
  const out: RestoreDateView[] = [];
  let cursor = base;
  for (let hops = 0; hops < 20_000; hops += 1) {
    const rel = next.get(o.placeId, cursor) as string | undefined;
    if (rel === undefined || !rel.startsWith(base)) break;
    const folder = rel.slice(base.length).split('/')[0]!;
    const at = sessionDate(o.prefix, folder);
    if (at !== null && rel.length > base.length + folder.length) out.push({ folder, at });
    cursor = base + folder + '/' + AFTER_ALL;
    if (hops % 40 === 39) yield;
  }
  return out.toSorted((a, b) => b.at - a.at || (a.folder < b.folder ? 1 : a.folder > b.folder ? -1 : 0));
}

// ---- one folder of a date ----------------------------------------------------------------------------------------------------------------

/** What is directly in a folder: its folders (with how many files and bytes are below) and its files. Folders first, then files, each by name. */
export function* browseSteps(db: Db, o: { placeId: string; root: string; folder: string | null; path: string }): Steps<{ entries: RestoreEntry[]; moreFiles: number }> {
  const prefix = basePrefix(o.root) + (o.folder === null ? '' : o.folder + '/') + (o.path === '' ? '' : o.path + '/');
  const folders = new Map<string, RestoreEntry>();
  const files: RestoreEntry[] = [];
  let more = 0;
  yield* scan(db, o.placeId, prefix, (r) => {
    const below = r.rel_path.slice(prefix.length);
    const slash = below.indexOf('/');
    const held = heldReason({ size: r.size, sha256: r.sha256, expected: r.expected_sha256, verifiedHow: r.verified_how }) === null ? 0 : 1;
    if (slash < 0) {
      if (files.length < MAX_LISTED_FILES) files.push({ name: below, folder: false, files: 1, bytes: r.size, mtime: r.mtime, held });
      else more += 1;
      return;
    }
    const name = below.slice(0, slash);
    const have = folders.get(name);
    if (have) {
      have.files += 1;
      have.bytes += r.size;
      have.held += held;
      if (r.mtime !== null && (have.mtime === null || r.mtime > have.mtime)) have.mtime = r.mtime;
    } else folders.set(name, { name, folder: true, files: 1, bytes: r.size, mtime: r.mtime, held });
  });
  const byName = (a: RestoreEntry, b: RestoreEntry): number => a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true });
  const list = [...folders.values()];
  yield* sortSteps(list, byName);
  yield* sortSteps(files, byName);
  return { entries: [...list, ...files], moreFiles: more };
}

// ---- the files to bring back --------------------------------------------------------------------------------------------------------------

/** One copy on a drive that is to come back. */
export interface RestoreItem {
  rowId: number;
  placeId: string;
  /** Where it is on the drive (path from the drive root, forward slashes). */
  rel: string;
  /** Where it goes below the new folder (forward slashes). */
  destRel: string;
  /** Its path below the backup's folder on the drive (the dated folder and the path in it): the same place on another drive of the backup. */
  below: string;
  size: number;
  mtime: number | null;
  sha256: string | null;
  expected: string | null;
  verifiedHow: string | null;
  backupId: number;
  /** Where the file was before (a folder backup only), else null. */
  original: string | null;
}

/** Where a file of a folder backup was: the backed-up folder plus the path below it. */
export function originalPathOf(backup: Pick<BackupInfo, 'kind' | 'flat' | 'sourceRoot'>, rest: string): string | null {
  if (backup.kind !== 'folder' || backup.flat || !/^[A-Za-z]:/.test(backup.sourceRoot)) return null;
  const parts = safeParts(rest);
  return parts === null ? null : path.join(backup.sourceRoot, ...parts);
}

const itemOf = (r: Row, backup: BackupInfo, rest: string, below: string): RestoreItem => ({
  rowId: r.id,
  placeId: r.place_id,
  rel: r.rel_path,
  destRel: rest,
  below,
  size: r.size,
  mtime: r.mtime,
  sha256: r.sha256,
  expected: r.expected_sha256,
  verifiedHow: r.verified_how,
  backupId: backup.id,
  original: originalPathOf(backup, rest),
});

export type ExpandPick = { kind: 'date'; folder: string | null; items: readonly string[] } | { kind: 'newest' };

/** The copies of one backup on one drive that a pick names: a dated folder (all of it, or the ticked paths), or the newest copy of every file. */
export function* expandBackupSteps(db: Db, backup: BackupInfo, placeId: string, pick: ExpandPick): Steps<RestoreItem[]> {
  const dest = backup.destinations.find((d) => d.placeId === placeId);
  if (!dest) return [];
  const base = basePrefix(dest.root);
  if (pick.kind === 'newest') {
    const best = new Map<string, { row: Row; at: number; rest: string }>();
    yield* scan(db, placeId, base, (r) => {
      let rest = r.rel_path.slice(base.length);
      let at = 0;
      if (!backup.flat) {
        const parsed = parseSessionRel(backup.prefix, rest);
        if (parsed === null) return; // not under a dated folder of this backup
        rest = parsed.rest;
        at = parsed.sessionAt;
      }
      const key = nameKey(rest);
      const have = best.get(key);
      if (!have || at > have.at || (at === have.at && r.id > have.row.id)) best.set(key, { row: r, at, rest });
    });
    const items = [...best.values()].map((b) => itemOf(b.row, backup, b.rest, b.row.rel_path.slice(base.length)));
    yield* sortSteps(items, (a, b) => (a.destRel < b.destRel ? -1 : a.destRel > b.destRel ? 1 : 0));
    return items;
  }
  if (backup.flat !== (pick.folder === null)) return [];
  if (pick.folder !== null && (pick.folder.includes('/') || sessionDate(backup.prefix, pick.folder) === null)) return [];
  const folderBase = base + (pick.folder === null ? '' : pick.folder + '/');
  const seen = new Set<number>();
  const out: RestoreItem[] = [];
  const take = (r: Row): void => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push(itemOf(r, backup, r.rel_path.slice(folderBase.length), r.rel_path.slice(base.length)));
  };
  if (pick.items.length === 0) yield* scan(db, placeId, folderBase, take);
  const exact = db.prepare(`SELECT ${COLS} FROM files WHERE place_id = ? AND rel_path = ? AND gone_at IS NULL AND size IS NOT NULL`);
  for (const item of pick.items) {
    const isFolder = item.endsWith('/');
    if (safeParts(isFolder ? item.slice(0, -1) : item) === null) continue;
    if (isFolder) yield* scan(db, placeId, folderBase + item, take);
    else {
      const r = exact.get(placeId, folderBase + item) as Row | undefined;
      if (r) take(r);
    }
    yield;
  }
  yield* sortSteps(out, (a, b) => (a.destRel < b.destRel ? -1 : a.destRel > b.destRel ? 1 : 0));
  return out;
}

/** Every drive place a backup is kept on, with the plugged-in ones first (as given), then the rest: the order a Files pick prefers its copies in. */
export function rankPlaces(db: Db, plugged: readonly string[]): string[] {
  const rest = loadAllRoots(db)
    .map((r) => r.placeId)
    .filter((id) => !plugged.includes(id));
  return [...new Set([...plugged, ...rest])];
}

/** One place a file can be brought back from: a drive's copy, or the Google Drive copy (a download). */
export type RestoreCopy = { kind: 'drive'; placeId: string; rel: string; rowId: number } | { kind: 'google'; placeId: string; extId: string; rowId: number };

interface CopyRow {
  id: number;
  place_id: string;
  rel_path: string;
  size: number;
  sha256: string | null;
  verified_how: string | null;
}

/** The three lookups of `copiesOf`, prepared once per database (they run once per file). */
export const COPY_SQL = {
  exact: 'SELECT id, place_id, rel_path, size, sha256, verified_how FROM files WHERE place_id = ? AND rel_path = ? AND gone_at IS NULL AND size IS NOT NULL',
  bySha: 'SELECT id, place_id, rel_path, size, sha256, verified_how FROM files WHERE sha256 = ? AND place_id = ? AND gone_at IS NULL AND size = ? AND rel_path > ? AND rel_path < ? ORDER BY rel_path LIMIT 1',
  google: "SELECT f.id, f.place_id, f.ext_id FROM files f JOIN places p ON p.id = f.place_id WHERE f.sha256 = ? AND f.size = ? AND p.kind = 'gdrive' AND f.ext_id IS NOT NULL AND f.gone_at IS NULL ORDER BY f.id LIMIT 4",
} as const;
interface Stmt {
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}
const prepared = new WeakMap<object, { exact: Stmt; bySha: Stmt; google: Stmt }>();
function copyStatements(db: Db): { exact: Stmt; bySha: Stmt; google: Stmt } {
  let have = prepared.get(db);
  if (!have) {
    have = { exact: db.prepare(COPY_SQL.exact) as unknown as Stmt, bySha: db.prepare(COPY_SQL.bySha) as unknown as Stmt, google: db.prepare(COPY_SQL.google) as unknown as Stmt };
    prepared.set(db, have);
  }
  return have;
}

/**
 * The copies of one item that can be tried, best first: the plugged-in drives of its backup in the order given (the same place on another drive: the same path below the
 * backup's folder, else the same checksum inside that folder), then the Google copies (a Google row with the same checksum and size, made by "Copy to Google").
 * A copy found different, or with another checksum or size, is left out. Read only: a handful of reads by (place, path) and by checksum.
 */
export function copiesOf(db: Db, backup: BackupInfo, item: RestoreItem, pluggedDrives: readonly string[], sha: string, withGoogle = true): RestoreCopy[] {
  const out: RestoreCopy[] = [];
  const { exact, bySha, google: googleRows } = copyStatements(db);
  const usable = (r: CopyRow | undefined): r is CopyRow => r !== undefined && r.size === item.size && r.verified_how !== 'differs' && (r.sha256 === null || r.sha256 === sha);
  for (const placeId of pluggedDrives) {
    const dest = backup.destinations.find((d) => d.placeId === placeId);
    if (!dest) continue;
    if (placeId === item.placeId) {
      out.push({ kind: 'drive', placeId, rel: item.rel, rowId: item.rowId });
      continue;
    }
    const base = basePrefix(dest.root);
    let row = exact.get(placeId, base + item.below) as CopyRow | undefined;
    if (!usable(row)) row = bySha.get(sha, placeId, item.size, base, upper(base)) as CopyRow | undefined;
    if (usable(row)) out.push({ kind: 'drive', placeId, rel: row.rel_path, rowId: row.id });
  }
  if (withGoogle) {
    const google = googleRows.all(sha, item.size) as { id: number; place_id: string; ext_id: string }[];
    for (const g of google) out.push({ kind: 'google', placeId: g.place_id, extId: g.ext_id, rowId: g.id });
  }
  return out;
}

export interface FilesExpansion {
  items: RestoreItem[];
  /** Picked files that have no copy on a plugged-in drive. */
  notAvailable: number;
  backups: BackupInfo[];
}

/**
 * The copies that go with files picked on the Files screen. A picked file may itself be a copy in a backup, or a file a backup was made of (found by the link
 * the copy kept, or by the same checksum). The copy on the first drive of `preferPlaces` wins, then the newest.
 */
export function* expandFilesSteps(db: Db, roots: readonly RootRef[], preferPlaces: readonly string[], fileIds: readonly number[]): Steps<FilesExpansion> {
  const byPlace = new Map<string, RootRef[]>();
  for (const r of roots) {
    if (!preferPlaces.includes(r.placeId)) continue;
    const list = byPlace.get(r.placeId);
    if (list) list.push(r);
    else byPlace.set(r.placeId, [r]);
  }
  const locate = (placeId: string, rel: string): { ref: RootRef; rest: string; at: number; below: string } | null => {
    for (const ref of byPlace.get(placeId) ?? []) {
      const base = basePrefix(ref.root);
      if (!rel.startsWith(base)) continue;
      const below = rel.slice(base.length);
      if (ref.backup.flat) return below === '' ? null : { ref, rest: below, at: 0, below };
      const parsed = parseSessionRel(ref.backup.prefix, below);
      if (parsed !== null) return { ref, rest: parsed.rest, at: parsed.sessionAt, below };
    }
    return null;
  };
  const one = db.prepare(`SELECT ${COLS} FROM files WHERE id = ? AND gone_at IS NULL AND size IS NOT NULL`);
  const byOrigin = db.prepare(`SELECT ${COLS} FROM files WHERE origin_file_id = ? AND gone_at IS NULL AND size IS NOT NULL LIMIT 50`);
  const bySha = db.prepare(`SELECT ${COLS} FROM files WHERE sha256 = ? AND size = ? AND gone_at IS NULL LIMIT 50`);

  const chosen = new Map<number, { row: Row; ref: RootRef; rest: string; below: string }>();
  let notAvailable = 0;
  let n = 0;
  for (const id of fileIds) {
    if (n++ % 50 === 49) yield;
    const row = one.get(id) as Row | undefined;
    if (!row) {
      notAvailable += 1;
      continue;
    }
    let candidates: Row[] = [];
    if (locate(row.place_id, row.rel_path)) candidates = [row];
    else {
      candidates = byOrigin.all(row.id) as Row[];
      if (row.sha256 !== null) candidates = candidates.concat(bySha.all(row.sha256, row.size) as Row[]);
    }
    let best: { row: Row; ref: RootRef; rest: string; at: number; rank: number; below: string } | null = null;
    for (const c of candidates) {
      const at = locate(c.place_id, c.rel_path);
      if (!at) continue;
      const rank = preferPlaces.indexOf(c.place_id);
      if (best === null || rank < best.rank || (rank === best.rank && (at.at > best.at || (at.at === best.at && c.id > best.row.id)))) best = { row: c, ref: at.ref, rest: at.rest, at: at.at, rank, below: at.below };
    }
    if (best === null) notAvailable += 1;
    else chosen.set(best.row.id, { row: best.row, ref: best.ref, rest: best.rest, below: best.below });
  }
  const backups = [...new Map([...chosen.values()].map((c) => [c.ref.backup.id, c.ref.backup] as const)).values()];
  // Files from more than one backup go into a folder each; two picked files that would get one name get " (2)".
  const used = new Set<string>();
  const items: RestoreItem[] = [];
  for (const c of chosen.values()) {
    const where = backups.length > 1 ? (cleanName(c.ref.backup.name) || 'Backup') + '/' + c.rest : c.rest;
    let destRel = where;
    for (let k = 2; used.has(nameKey(destRel)); k += 1) {
      const slash = where.lastIndexOf('/');
      destRel = (slash < 0 ? '' : where.slice(0, slash + 1)) + numberedFile(where.slice(slash + 1), k);
    }
    used.add(nameKey(destRel));
    items.push({ ...itemOf(c.row, c.ref.backup, c.rest, c.below), destRel });
  }
  yield* sortSteps(items, (a, b) => (a.destRel < b.destRel ? -1 : a.destRel > b.destRel ? 1 : 0));
  return { items, notAvailable, backups };
}
