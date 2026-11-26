import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { makeKindResolver } from '../classify/sortKinds';
import type { Db } from '../db';
import { openImmutable, type ExternalDb } from '../db/externalDb';
import { isUnder, pathKey } from './pathForms';
import type { BackupProfileStore, SourceKind } from './profileStore';

/**
 * Import ONE PhoneBackup `ledger.db` (an old history file) for ONE backup profile (Profiles step 1a).
 *
 * Read only on the old file: it is opened with `openImmutable` (its bytes are read into memory; nothing is created beside it).
 * In Backup Hub's own database only NEW columns of existing `files` rows are ever set (verified_how, expected_sha256, origin_file_id,
 * gone_reason); size, mtime, sha256, md5, gone_at, first_seen_at and last_seen_at of an existing row are never changed, and no backup
 * row is ever created from the old file (a path the index does not have is counted as a problem). The only rows created are the
 * SOURCE rows of a phone backup (the phone's own paths), in a place of kind 'phone'.
 *
 * Paths: a `local_path` such as `F:\MyData\POCO\Poco-F4-31Mar25\DCIM\x.jpg` loses its drive letter (letters change; the drive is found by
 * its card) and is looked up as `MyData/POCO/Poco-F4-31Mar25/DCIM/x.jpg` in the backup drive's place, case-insensitively like the rest of
 * the app. A row found twice differing only by case is never guessed at (counted as a problem).
 * Old file times are whole seconds; `files.mtime` is milliseconds.
 */

export type ProblemKind =
  | 'not_in_index'
  | 'size_differs'
  | 'checksum_differs'
  | 'outside_backup_folder'
  | 'no_backup_path'
  | 'no_size'
  | 'ambiguous_case'
  | 'index_changed'
  | 'bad_source_path'
  | 'source_not_in_index'
  | 'no_source_place'
  | 'source_outside_profile_folder';

export interface ProblemCount {
  count: number;
  /** Up to MAX_EXAMPLES paths. */
  examples: string[];
}

export const MAX_EXAMPLES = 20;
export const DEFAULT_CHUNK_ROWS = 3000;
const INDEX_PAGE_ROWS = 20_000;

export interface LedgerSummary {
  /** Rows of the old history file that were read. */
  rowsRead: number;
  /** Backup rows of the index that were found with the same size and updated (new columns only). */
  linked: number;
  /** Of those, how many now point at a source row. */
  originLinked: number;
  /** Source rows made for a phone backup / found already there. */
  sourceRowsCreated: number;
  sourceRowsReused: number;
  /** Rows with no source path (PhoneBackup could not match them to a phone file); nothing is imported for their source side. */
  looseRows: number;
  /** Rows that name a Google account or path; not imported yet. */
  cloudRows: number;
  /** Linked backup rows that are gone, and how many of those got gone_reason 'kept_only_on_other_drive'. */
  goneRows: number;
  goneReasonSet: number;
  /** Rows in the "kept only on the other drive" folders (Spare): in the old file; marked (gone here, now or before); still shown as on the drive. */
  keptInHistory: number;
  keptMarked: number;
  keptStillShown: number;
  /** "Never back up this file" entries copied over. */
  exclusionsCopied: number;
  problems: Partial<Record<ProblemKind, ProblemCount>>;
  notes: string[];
}

export type LedgerImportResult =
  | { ok: true; alreadyImported: false; importId: number; summary: LedgerSummary }
  | { ok: true; alreadyImported: true; importId: number; message: string }
  | { ok: false; message: string };

export interface LedgerImportInput {
  db: Db;
  store: BackupProfileStore;
  /** The old history file. */
  ledgerPath: string;
  profile: { id: number; sourceKind: SourceKind; sourceRoot: string };
  /** The place of the backup drive and the folder on it that the old file's `local_path`s are under ('MyData/POCO'). */
  destination: { placeId: string; root: string };
  /** Phone backup: the place of kind 'phone' that holds the source rows. */
  phonePlaceId?: string | null;
  /**
   * Folder backup: the place that holds the folder, and the Windows folder that is that place's root ('' for the laptop, whose
   * rel_paths are whole paths such as "D:/MyData/a.jpg"; the OneDrive folder for the OneDrive place).
   */
  sourcePlace?: { placeId: string; base: string } | null;
  /**
   * Folders (below the drive, or below the dated folder of a session, e.g. "MyData/Spare") whose gone rows get gone_reason
   * 'kept_only_on_other_drive'. Matched without regard to case.
   */
  keptOnlyOnOtherDrive?: readonly string[];
  /** Run again even though this file was imported before (every step is safe to repeat). */
  force?: boolean;
  now?: () => number;
  yieldNow?: () => Promise<void>;
  chunkRows?: number;
  /** Tests may swap how the old file is opened. */
  openLedger?: (file: string) => ExternalDb;
}

interface LedgerRow {
  id: number;
  file_size: number | null;
  file_hash: string | null;
  local_path: string | null;
  original_phone_path: string | null;
  file_mtime: number | null;
  cloud_account: string | null;
  cloud_path: string | null;
}

interface IndexEntry {
  id: number;
  rel: string;
  size: number | null;
  sha: string | null;
  gone: boolean;
  goneReason: string | null;
  goneReasonEmpty: boolean;
  ambiguous: boolean;
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * A file that sits beside an old history file and holds changes that were not saved into it: a `-journal` (PhoneBackup stopped half
 * way, or is writing right now) or a `-wal` that is not empty. Its path, or null when there is none. The `.lock` files are PhoneBackup's
 * own marker and are ignored. The old file is not read while this is there: what we read would be the older half of a change.
 */
export function historySideFile(ledgerPath: string): string | null {
  const journal = `${ledgerPath}-journal`;
  if (fs.existsSync(journal)) return journal;
  const wal = `${ledgerPath}-wal`;
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0) return wal;
  return null;
}

export const sideFileMessage = (ledgerPath: string): string =>
  `The old history file ${ledgerPath} has changes beside it that were not saved into it (PhoneBackup may be running, or it stopped half way). Close PhoneBackup, let it finish, and try again. Nothing was read.`;

const sha256OfFile = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Windows path of a backup file -> rel_path form below the drive (no letter), or null for a path that is not on a lettered drive. */
export function driveRelOf(localPath: string): string | null {
  const m = /^[A-Za-z]:[\\/]*(.*)$/.exec(localPath.trim());
  if (!m) return null;
  return m[1]!.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

/** A phone path ("/sdcard/DCIM/a.jpg") in rel_path form ("sdcard/DCIM/a.jpg"), or null when it is empty or could leave the phone's storage. */
export function phoneRelOf(phonePath: string): string | null {
  const rel = phonePath.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  if (rel === '' || rel.split('/').some((s) => s === '..' || s === '.')) return null;
  return rel;
}

/**
 * Index rows of one place under a folder, keyed by the lower-case rel_path. Read in pages along the (place_id, rel_path) index,
 * with a turn for the event loop between pages. `prefixKey` is the folder in lower case ('' for the whole place).
 */
async function loadIndex(db: Db, placeId: string, prefixKey: string, yieldNow: () => Promise<void>): Promise<Map<string, IndexEntry>> {
  const map = new Map<string, IndexEntry>();
  const page = db.prepare(
    `SELECT id, rel_path, size, sha256, gone_at, gone_reason FROM files WHERE place_id = ? AND rel_path > ? ORDER BY rel_path LIMIT ${INDEX_PAGE_ROWS}`,
  );
  let last = '';
  for (;;) {
    const rows = page.all(placeId, last) as { id: number; rel_path: string; size: number | null; sha256: string | null; gone_at: number | null; gone_reason: string | null }[];
    for (const r of rows) {
      const key = r.rel_path.toLowerCase();
      if (!isUnder(key, prefixKey) || key === prefixKey) continue;
      const seen = map.get(key);
      if (seen) {
        seen.ambiguous = true;
        continue;
      }
      map.set(key, {
        id: r.id,
        rel: r.rel_path,
        size: r.size,
        sha: r.sha256,
        gone: r.gone_at !== null,
        goneReason: r.gone_reason,
        goneReasonEmpty: r.gone_reason === null || r.gone_reason === '',
        ambiguous: false,
      });
    }
    if (rows.length < INDEX_PAGE_ROWS) return map;
    last = rows[rows.length - 1]!.rel_path;
    await yieldNow();
  }
}

const UPDATE_BACKUP_ROW = `
UPDATE files SET
  verified_how = CASE WHEN verified_how IS NULL OR verified_how IN ('', 'none') THEN 'imported' ELSE verified_how END,
  expected_sha256 = CASE WHEN (expected_sha256 IS NULL OR expected_sha256 = '') AND sha256 IS NOT NULL AND sha256 <> '' THEN sha256 ELSE expected_sha256 END,
  origin_file_id = coalesce(origin_file_id, @origin),
  gone_reason = CASE WHEN gone_at IS NOT NULL AND @goneReason IS NOT NULL AND (gone_reason IS NULL OR gone_reason = '') THEN @goneReason ELSE gone_reason END
WHERE id = @id AND size = @size`;

export async function importLedgerFile(input: LedgerImportInput): Promise<LedgerImportResult> {
  const { db, store, profile, destination } = input;
  const now = input.now ?? Date.now;
  const yieldNow = input.yieldNow ?? nextTurn;
  const chunkRows = Math.max(1, input.chunkRows ?? DEFAULT_CHUNK_ROWS);

  const sideFile = historySideFile(input.ledgerPath);
  if (sideFile !== null) return { ok: false, message: sideFileMessage(input.ledgerPath) };
  let fileHash: string;
  try {
    fileHash = sha256OfFile(input.ledgerPath);
  } catch {
    return { ok: false, message: 'The old history file could not be read.' };
  }
  const earlier = db.prepare('SELECT id, backup_profile_id, imported_at FROM ledger_imports WHERE ledger_sha256 = ?').get(fileHash) as { id: number; backup_profile_id: number | null; imported_at: number } | undefined;
  if (earlier && input.force !== true) {
    return { ok: true, alreadyImported: true, importId: earlier.id, message: 'This history file was already brought in. Nothing was changed.' };
  }

  let ledger: ExternalDb;
  try {
    ledger = (input.openLedger ?? openImmutable)(input.ledgerPath);
  } catch {
    return { ok: false, message: 'The old history file could not be opened.' };
  }
  try {
    const columns = new Set((ledger.prepare('PRAGMA table_info(ledger)').all() as { name: string }[]).map((c) => c.name));
    for (const need of ['id', 'file_size', 'local_path'] as const) {
      if (!columns.has(need)) return { ok: false, message: 'This is not a PhoneBackup history file.' };
    }
    const col = (name: string): string => (columns.has(name) ? name : `NULL AS ${name}`);
    const readPage = ledger.prepare(
      `SELECT id, file_size, ${col('file_hash')}, local_path, ${col('original_phone_path')}, ${col('file_mtime')}, ${col('cloud_account')}, ${col('cloud_path')}
       FROM ledger WHERE id > ? ORDER BY id LIMIT ${chunkRows}`,
    );

    const summary: LedgerSummary = {
      rowsRead: 0, linked: 0, originLinked: 0, sourceRowsCreated: 0, sourceRowsReused: 0, looseRows: 0, cloudRows: 0,
      goneRows: 0, goneReasonSet: 0, keptInHistory: 0, keptMarked: 0, keptStillShown: 0, exclusionsCopied: 0, problems: {}, notes: [],
    };
    const problem = (kind: ProblemKind, example: string): void => {
      const p = (summary.problems[kind] ??= { count: 0, examples: [] });
      p.count += 1;
      if (p.examples.length < MAX_EXAMPLES) p.examples.push(example);
    };

    // The backup drive's rows under the backup folder, and (folder backups) the source rows under the backed-up folder.
    const rootKey = pathKey(destination.root);
    const destIndex = await loadIndex(db, destination.placeId, rootKey, yieldNow);
    const keptKeys = (input.keptOnlyOnOtherDrive ?? []).map(pathKey).filter((k) => k !== '');
    /** Is this lower-case rel_path in a "kept only on the other drive" folder? Also below the dated session folder: "<root>/<session>/Spare/x" is "Spare/x" there. */
    const isKeptKey = (key: string): boolean => {
      if (keptKeys.length === 0) return false;
      const below = key.startsWith(rootKey === '' ? '' : `${rootKey}/`) ? key.slice(rootKey === '' ? 0 : rootKey.length + 1) : key;
      const afterSession = below.includes('/') ? below.slice(below.indexOf('/') + 1) : '';
      return keptKeys.some((k) => isUnder(key, k) || isUnder(afterSession, k));
    };
    const goneReasonFor = (entry: IndexEntry): string | null => (isKeptKey(entry.rel.toLowerCase()) ? 'kept_only_on_other_drive' : null);

    const phonePlaceId = profile.sourceKind === 'phone' ? (input.phonePlaceId ?? null) : null;
    if (profile.sourceKind === 'phone' && phonePlaceId === null) return { ok: false, message: 'The phone of this backup has no place yet.' };
    const sourcePlace = profile.sourceKind === 'folder' ? (input.sourcePlace ?? null) : null;
    const sourceRootKey = pathKey(profile.sourceRoot);
    const sourceBaseKey = sourcePlace ? pathKey(sourcePlace.base) : '';
    const sourceIndex =
      sourcePlace === null
        ? new Map<string, IndexEntry>()
        : await loadIndex(db, sourcePlace.placeId, sourcePlace.base === '' ? sourceRootKey : relKeyBelow(sourceRootKey, sourceBaseKey), yieldNow);

    const updateBackup = db.prepare(UPDATE_BACKUP_ROW);
    const insertSource = db.prepare(
      'INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (place_id, rel_path) DO NOTHING',
    );
    const kindFor = makeKindResolver(db);
    const findSource = db.prepare('SELECT id FROM files WHERE place_id = ? AND rel_path = ?').pluck();
    const importTime = now();

    /** The source row of a ledger row: made (phone) or found (folder). Null when there is none. */
    const sourceFor = (row: LedgerRow, size: number): number | null => {
      const from = row.original_phone_path;
      if (!from || from.trim() === '') return null;
      if (phonePlaceId !== null) {
        const rel = phoneRelOf(from);
        if (rel === null) {
          problem('bad_source_path', from);
          return null;
        }
        const mtime = typeof row.file_mtime === 'number' ? row.file_mtime * 1000 : null;
        const made = insertSource.run(phonePlaceId, rel, size, mtime, importTime, importTime, kindFor(phonePlaceId, rel, null, size)).changes === 1;
        if (made) summary.sourceRowsCreated += 1;
        else summary.sourceRowsReused += 1;
        return (findSource.get(phonePlaceId, rel) as number | undefined) ?? null;
      }
      if (sourcePlace === null) {
        problem('no_source_place', from);
        return null;
      }
      const key = pathKey(from);
      if (!isUnder(key, sourceRootKey)) {
        problem('source_outside_profile_folder', from);
        return null;
      }
      if (!isUnder(key, sourceBaseKey)) {
        problem('source_not_in_index', from);
        return null;
      }
      const rel = sourcePlace.base === '' ? key : key.slice(sourceBaseKey === '' ? 0 : sourceBaseKey.length + 1);
      const hit = sourceIndex.get(rel);
      if (!hit || hit.ambiguous) {
        problem('source_not_in_index', from);
        return null;
      }
      return hit.id;
    };

    const doChunk = db.transaction((rows: LedgerRow[]): void => {
      for (const row of rows) {
        summary.rowsRead += 1;
        const hasSource = typeof row.original_phone_path === 'string' && row.original_phone_path.trim() !== '';
        if (!hasSource) summary.looseRows += 1;
        if ((row.cloud_account ?? '') !== '' || (row.cloud_path ?? '') !== '') summary.cloudRows += 1;
        const label = row.local_path ?? `#${row.id}`;
        if (typeof row.file_size !== 'number') {
          problem('no_size', label);
          continue;
        }
        const origin = hasSource ? sourceFor(row, row.file_size) : null;
        if (!row.local_path || row.local_path.trim() === '') {
          problem('no_backup_path', `#${row.id}`);
          continue;
        }
        const below = driveRelOf(row.local_path);
        const belowKey = below === null ? null : below.toLowerCase();
        if (belowKey === null || !isUnder(belowKey, rootKey) || belowKey === rootKey) {
          problem('outside_backup_folder', row.local_path);
          continue;
        }
        const kept = isKeptKey(belowKey);
        if (kept) summary.keptInHistory += 1;
        const entry = destIndex.get(belowKey);
        if (!entry) {
          problem('not_in_index', row.local_path);
          continue;
        }
        if (entry.ambiguous) {
          problem('ambiguous_case', row.local_path);
          continue;
        }
        if (entry.size !== row.file_size) {
          problem('size_differs', row.local_path);
          continue;
        }
        const theirs = (row.file_hash ?? '').trim().toLowerCase();
        if (entry.sha !== null && /^[0-9a-f]{64}$/.test(theirs) && entry.sha.toLowerCase() !== theirs) {
          problem('checksum_differs', row.local_path);
          continue;
        }
        const goneReason = entry.gone ? goneReasonFor(entry) : null;
        const changed = updateBackup.run({ id: entry.id, size: entry.size, origin, goneReason }).changes;
        if (changed === 0) {
          problem('index_changed', row.local_path);
          continue;
        }
        summary.linked += 1;
        if (origin !== null) summary.originLinked += 1;
        if (entry.gone) {
          summary.goneRows += 1;
          if (goneReason !== null && entry.goneReasonEmpty) summary.goneReasonSet += 1;
        }
        if (kept) {
          if (!entry.gone) summary.keptStillShown += 1;
          else if (goneReason !== null && (entry.goneReasonEmpty || entry.goneReason === goneReason)) summary.keptMarked += 1;
        }
      }
    });

    let after = 0;
    for (;;) {
      const rows = readPage.all(after) as LedgerRow[];
      if (rows.length === 0) break;
      doChunk.immediate(rows);
      after = rows[rows.length - 1]!.id;
      await yieldNow();
    }

    // "Never back up this file" entries (the table may not exist in an older file).
    if (ledger.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'excluded_paths'").get()) {
      const excluded = ledger.prepare('SELECT original_phone_path AS path, added_at FROM excluded_paths').all() as { path: string | null; added_at: string | number | null }[];
      for (const e of excluded) {
        if (typeof e.path !== 'string' || e.path.trim() === '') continue;
        const at = typeof e.added_at === 'string' ? Date.parse(`${e.added_at.replace(' ', 'T')}Z`) : typeof e.added_at === 'number' ? e.added_at : NaN;
        const added = store.addExclusion(profile.id, e.path, Number.isFinite(at) ? at : importTime);
        if (added.ok && added.added) summary.exclusionsCopied += 1;
      }
    }

    const problemsJson = JSON.stringify(summary);
    let importId: number;
    if (earlier) {
      db.prepare('UPDATE ledger_imports SET backup_profile_id = ?, ledger_path = ?, imported_at = ?, rows = ?, problems_json = ? WHERE id = ?').run(profile.id, input.ledgerPath, importTime, summary.rowsRead, problemsJson, earlier.id);
      importId = earlier.id;
    } else {
      importId = Number(
        db.prepare('INSERT INTO ledger_imports (backup_profile_id, ledger_path, ledger_sha256, imported_at, rows, problems_json) VALUES (?, ?, ?, ?, ?, ?)').run(profile.id, input.ledgerPath, fileHash, importTime, summary.rowsRead, problemsJson).lastInsertRowid,
      );
    }
    return { ok: true, alreadyImported: false, importId, summary };
  } finally {
    try {
      ledger.close();
    } catch {
      // The copy in memory only.
    }
  }
}

/** The part of `folderKey` below `baseKey` (both made with pathKey), or the whole key when it is not below it. */
function relKeyBelow(folderKey: string, baseKey: string): string {
  if (baseKey === '') return folderKey;
  return isUnder(folderKey, baseKey) ? folderKey.slice(baseKey.length + 1) : folderKey;
}
