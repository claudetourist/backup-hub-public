/**
 * The database side of "Copy to Google": which files of a backup are on the drive and on Google, the choices (which kinds go), the row that
 * records a Google copy, and the report of a run. Every walk over the backup's files is a paged generator (sliceWork.ts): the window gets a turn
 * between pages. The one writer of Google copy rows (see the contract in shared/googleCopy.ts).
 */
import type { Db } from '../db';
import { FILE_KINDS, isFileKind, kindOf, type FileKind } from '../../shared/fileKinds';
import {
  GOOGLE_LEAVE_OUT_DESTINATION,
  GOOGLE_TOP_FOLDER,
  GOOGLE_VERIFIED_HOW,
  googleKindPattern,
  kindOfGooglePattern,
  type GoogleCopyReport,
  type GoogleSentLine,
} from '../../shared/googleCopy';
import { withIdSuffix } from '../import/fleetV1/paths';
import { loadDestinations } from '../look/lookStore';
import { stillOnPhoneSql } from '../freeUp/onPhone';
import { prefixUpperBound } from '../listing/skipRules';
import type { Steps } from '../sliceWork';

// Small pages: the window gets a turn between them (a page must stay well under 250 ms even on the real 1.1M-row index).
const PAGE_ROWS = 200;

/** The backup a copy to Google starts from: its first drive and the folder on it. */
export interface BackupSource {
  backupId: number;
  name: string;
  personId: number;
  placeId: string;
  placeLabel: string;
  /** The backup folder on the drive, forward slashes, no slash at either end. */
  root: string;
  /** A phone backup, and the place its phone listing is kept in (null until the phone was listed). */
  isPhone: boolean;
  phonePlaceId: string | null;
}

const cleanRoot = (root: string): string => root.replace(/^\/+|\/+$/g, '');

export function sourceOf(db: Db, backupId: number): BackupSource | null {
  const profile = db.prepare('SELECT id, name, person_id, source_kind, source_place_id FROM backup_profiles WHERE id = ?').get(backupId) as { id: number; name: string; person_id: number; source_kind: string; source_place_id: string | null } | undefined;
  if (!profile) return null;
  const first = loadDestinations(db, backupId)[0];
  if (!first) return null;
  const place = db.prepare("SELECT label FROM places WHERE id = ? AND kind = 'drive'").get(first.placeId) as { label: string } | undefined;
  if (!place) return null;
  return { backupId, name: profile.name, personId: profile.person_id, placeId: first.placeId, placeLabel: place.label, root: cleanRoot(first.root), isPhone: profile.source_kind === 'phone', phonePlaceId: profile.source_kind === 'phone' ? profile.source_place_id : null };
}

export interface Candidate {
  /** The T7 copy's files.id. */
  id: number;
  /** The path inside the backup folder. */
  rel: string;
  size: number;
  sha256: string;
  kind: FileKind;
  mtime: number | null;
}

interface PageRow {
  id: number;
  rel: string;
  name: string;
  size: number;
  mtime: number | null;
  sha256: string | null;
  kind: string | null;
  onGoogle: number;
}

/**
 * The statement that reads one page of the backup's files on the drive (live, not empty), each with "is it on Google already" (the sha256 index).
 * `onlyOnPhone`: only files whose content is still on the phone (freeUp/onPhone.ts, the rule of Free up phone space); with no phone listing nothing is.
 */
function pageStatement(db: Db, src: BackupSource, onlyOnPhone: boolean): (after: string) => PageRow[] {
  const prefix = src.root + '/';
  const hi = prefixUpperBound(prefix);
  if (onlyOnPhone && src.phonePlaceId === null) return () => [];
  const phone = onlyOnPhone ? { phone: src.phonePlaceId } : {};
  const stmt = db.prepare(
    `SELECT a.id AS id, a.rel_path AS rel, a.name AS name, a.size AS size, a.mtime AS mtime, a.sha256 AS sha256, a.kind AS kind,
       CASE WHEN a.sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM files g INDEXED BY idx_files_sha256_live WHERE g.sha256 = a.sha256 AND g.gone_at IS NULL AND g.place_id IN (SELECT id FROM places WHERE kind = 'gdrive') AND g.verified_how = '${GOOGLE_VERIFIED_HOW}') THEN 1 ELSE 0 END AS onGoogle
     FROM files a WHERE a.place_id = @place AND a.rel_path > @after AND a.rel_path < @hi AND a.gone_at IS NULL AND a.size > 0${onlyOnPhone ? ` AND ${stillOnPhoneSql('a')}` : ''} ORDER BY a.rel_path LIMIT @limit`,
  );
  return (after) => stmt.all({ place: src.placeId, after: after === '' ? prefix : after, hi, limit: PAGE_ROWS, ...phone }) as PageRow[];
}

const kindFor = (r: PageRow): FileKind => (isFileKind(r.kind) ? r.kind : kindOf(r.rel, r.name, null, r.size));

export interface KindTotals {
  /** Different files (each content once): a repeat of another file in the list is not counted here. */
  files: number;
  bytes: number;
  onFiles: number;
  onBytes: number;
  /** Repeats of a file that still has to go (the same picture in an older phone backup): sent once, counted here only. */
  repeatFiles: number;
  repeatBytes: number;
}

export interface Scan {
  kinds: Map<FileKind, KindTotals>;
  /** Files with no checksum yet. */
  noChecksum: number;
}

/** The same content is the same SHA-256 (the whole checksum: only equal contents are ever called repeats). */
const contentKey = (sha256: string): string => sha256;

/** Counts per kind of the backup's files: all (each content once), and the ones already on Google. A repeat of a file still to go is counted as a repeat. */
export function* scanKindsSteps(db: Db, src: BackupSource, onlyOnPhone = false): Steps<Scan> {
  const page = pageStatement(db, src, onlyOnPhone);
  const out: Scan = { kinds: new Map(), noChecksum: 0 };
  const seen = new Set<string>();
  let after = '';
  for (;;) {
    const rows = page(after);
    for (const r of rows) {
      if (r.sha256 === null) {
        out.noChecksum += 1;
        continue;
      }
      const kind = kindFor(r);
      const t = out.kinds.get(kind) ?? { files: 0, bytes: 0, onFiles: 0, onBytes: 0, repeatFiles: 0, repeatBytes: 0 };
      const key = `${kind}:${contentKey(r.sha256)}`;
      if (seen.has(key)) {
        if (r.onGoogle !== 1) {
          t.repeatFiles += 1;
          t.repeatBytes += r.size;
        }
        continue;
      }
      seen.add(key);
      t.files += 1;
      t.bytes += r.size;
      if (r.onGoogle === 1) {
        t.onFiles += 1;
        t.onBytes += r.size;
      }
      out.kinds.set(kind, t);
    }
    if (rows.length < PAGE_ROWS) break;
    after = rows[rows.length - 1]!.rel;
    yield;
  }
  return out;
}

/**
 * The files of the chosen kinds that are not on Google yet (with a checksum), as the run will send them (unsorted). Each content is listed once (the first
 * in path order): older phone backups hold the same picture again, and those repeats are only counted in `stats.repeats`.
 */
export function* candidatesSteps(db: Db, src: BackupSource, kinds: ReadonlySet<FileKind>, onlyOnPhone = false, stats?: { repeats: number }): Steps<Candidate[]> {
  const page = pageStatement(db, src, onlyOnPhone);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const prefixLen = src.root.length + 1;
  let after = '';
  for (;;) {
    const rows = page(after);
    for (const r of rows) {
      if (r.sha256 === null || r.onGoogle === 1) continue;
      const kind = kindFor(r);
      if (!kinds.has(kind)) continue;
      const key = contentKey(r.sha256);
      if (seen.has(key)) {
        if (stats) stats.repeats += 1;
        continue;
      }
      seen.add(key);
      out.push({ id: r.id, rel: r.rel.slice(prefixLen), size: r.size, sha256: r.sha256, kind, mtime: r.mtime });
    }
    if (rows.length < PAGE_ROWS) break;
    after = rows[rows.length - 1]!.rel;
    yield;
  }
  return out;
}

/** Is there a checked Google copy of this content already (one indexed lookup)? */
export function isOnGoogle(db: Db, sha256: string): boolean {
  return db.prepare(`SELECT 1 FROM files INDEXED BY idx_files_sha256 WHERE sha256 = ? AND verified_how = '${GOOGLE_VERIFIED_HOW}' AND gone_at IS NULL LIMIT 1`).pluck().get(sha256) === 1;
}

// ---- the person's choices (which kinds go) ------------------------------------------------------------------------------------------------

/** The kinds the person left out of Google for this backup (rule rows with the destination 'google'). */
export function leftOutKinds(db: Db, backupId: number): Set<FileKind> {
  const rows = db.prepare("SELECT pattern FROM backup_rules WHERE (backup_id = ? OR backup_id IS NULL) AND scope = 'pattern' AND choice = 'leave_out' AND destination = ?").all(backupId, GOOGLE_LEAVE_OUT_DESTINATION) as { pattern: string }[];
  const out = new Set<FileKind>();
  for (const r of rows) {
    const kind = kindOfGooglePattern(r.pattern);
    if (kind !== null) out.add(kind);
  }
  return out;
}

/** Saves the choice: every offered kind that is not ticked becomes "leave out of Google", every ticked one stops being left out. Writes only these rows. */
export function saveKindChoices(db: Db, backupId: number, offered: readonly FileKind[], ticked: ReadonlySet<FileKind>, now: number): void {
  const add = db.prepare("INSERT OR IGNORE INTO backup_rules (backup_id, scope, pattern, choice, destination, note, created_at) VALUES (?, 'pattern', ?, 'leave_out', ?, 'Left out of Google on the capacity screen', ?)");
  const drop = db.prepare("DELETE FROM backup_rules WHERE backup_id = ? AND scope = 'pattern' AND pattern = ? AND choice = 'leave_out' AND destination = ?");
  db.transaction(() => {
    for (const kind of offered) {
      if (!(FILE_KINDS as readonly string[]).includes(kind)) continue;
      if (ticked.has(kind)) drop.run(backupId, googleKindPattern(kind), GOOGLE_LEAVE_OUT_DESTINATION);
      else add.run(backupId, googleKindPattern(kind), GOOGLE_LEAVE_OUT_DESTINATION, now);
    }
  })();
}

// ---- the row of a Google copy -------------------------------------------------------------------------------------------------------------

export interface GoogleCopyRecord {
  accountPlaceId: string;
  extId: string;
  /** "Backup Hub/<backup name>/<path inside the backup folder>" (without "My Drive/"). */
  pathInGoogle: string;
  size: number;
  /** Google's md5Checksum (equal to the MD5 read from the T7 bytes). */
  md5: string;
  /** SHA-256 read from the T7 copy (equal to the T7 row's). */
  sha256: string;
  originFileId: number;
  mtime: number | null;
  kind: FileKind;
  now: number;
  /** The Drive id of the folder the file was put in, and the file's name there: written to drive_items so "Free up phone space" can ask Google about this exact file again. */
  parentExtId: string;
  name: string;
}

/** The path of the row in the account's list: the same as the Drive refresh makes for it ("My Drive/..."), so the refresh finds the same row by its id. */
export const googleRelPath = (pathInGoogle: string): string => 'My Drive/' + pathInGoogle;

/** A folder or file name for Drive: no slash (it is the path separator of the file list) and no control characters. */
export function safeName(name: string): string {
  const clean = [...name].map((ch) => (ch.charCodeAt(0) < 32 || ch === '/' || ch === '\\' ? '-' : ch)).join('').trim();
  return clean === '' || clean === '.' || clean === '..' ? '_' : clean;
}

/** The folders of a file in Google, top first: "Backup Hub", the backup's name, then the folders inside the backup folder. */
export const googleFolderPath = (backupName: string, rel: string): string[] => {
  const dirs = rel.split('/').slice(0, -1).filter((s) => s !== '');
  return [GOOGLE_TOP_FOLDER, safeName(backupName), ...dirs.map(safeName)];
};

/**
 * Records one Google copy (the contract in shared/googleCopy.ts) and, in the same transaction, the MD5 on the T7 row when it had none. The row is
 * found by (account, Drive id); a path that another row already holds gets the Drive id added, like the refresh does.
 */
export function recordGoogleCopy(db: Db, r: GoogleCopyRecord): void {
  const insert = db.prepare(
    `INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, first_seen_at, last_seen_at, gone_at, ext_id, kind, origin_file_id, verified_at, verified_how, hashed_at)
     VALUES (@place, @path, @size, @mtime, @sha, @md5, @now, @now, NULL, @ext, @kind, @origin, @now, '${GOOGLE_VERIFIED_HOW}', @now)
     ON CONFLICT(place_id, ext_id) WHERE ext_id IS NOT NULL DO UPDATE SET
       rel_path = excluded.rel_path, size = excluded.size, md5 = excluded.md5, sha256 = excluded.sha256, origin_file_id = excluded.origin_file_id,
       verified_at = excluded.verified_at, verified_how = excluded.verified_how, hashed_at = excluded.hashed_at, last_seen_at = excluded.last_seen_at, gone_at = NULL`,
  );
  const touch = db.prepare('UPDATE files SET md5 = ? WHERE id = ? AND md5 IS NULL');
  const item = db.prepare('INSERT INTO drive_items (place_id, ext_id, parent_ext_id, name, is_folder) VALUES (?, ?, ?, ?, 0) ON CONFLICT(place_id, ext_id) DO UPDATE SET parent_ext_id = excluded.parent_ext_id, name = excluded.name');
  db.transaction(() => {
    const base = { place: r.accountPlaceId, size: r.size, mtime: r.mtime, sha: r.sha256, md5: r.md5, now: r.now, ext: r.extId, kind: r.kind, origin: r.originFileId };
    try {
      insert.run({ ...base, path: googleRelPath(r.pathInGoogle) });
    } catch (err) {
      // A failed statement only undoes itself: the transaction goes on.
      if (!String((err as { code?: string }).code ?? '').startsWith('SQLITE_CONSTRAINT')) throw err;
      insert.run({ ...base, path: withIdSuffix(googleRelPath(r.pathInGoogle), r.extId) });
    }
    touch.run(r.md5, r.originFileId);
    item.run(r.accountPlaceId, r.extId, r.parentExtId, r.name);
  })();
}

// ---- the report ------------------------------------------------------------------------------------------------------------------------------

const reportKey = (jobId: number): string => `google.copy.report.${jobId}`;
const sentKey = (jobId: number): string => `google.copy.sent.${jobId}`;

/** What each account of a copy has been sent (checked files only), written right after every recorded file: the numbers survive a restart. */
export function saveSent(db: Db, jobId: number, lines: readonly GoogleSentLine[]): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(sentKey(jobId), JSON.stringify(lines));
}

export function loadSent(db: Db, jobId: number): GoogleSentLine[] {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(sentKey(jobId)) as { value: string } | undefined;
  if (!row) return [];
  try {
    const v = JSON.parse(row.value) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((l): l is GoogleSentLine => typeof l === 'object' && l !== null && typeof (l as GoogleSentLine).placeId === 'string' && typeof (l as GoogleSentLine).bytes === 'number');
  } catch {
    return [];
  }
}

export function saveReport(db: Db, jobId: number, report: GoogleCopyReport): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(reportKey(jobId), JSON.stringify(report));
}

export function loadReport(db: Db, jobId: number): GoogleCopyReport | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(reportKey(jobId)) as { value: string } | undefined;
  if (!row) return null;
  try {
    const report = JSON.parse(row.value) as GoogleCopyReport;
    return { ...report, repeats: report.repeats ?? 0 }; // an older report has no repeats
  } catch {
    return null;
  }
}

// ---- the accounts ticked for a backup (remembered, pre-ticked next time) -----------------------------------------------------------------------

const accountTicksKey = (backupId: number): string => `google.copy.accounts.${backupId}`;

/** The accounts ticked the last time this backup was copied to Google (place ids); empty the first time. */
export function loadAccountTicks(db: Db, backupId: number): string[] {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(accountTicksKey(backupId)) as { value: string } | undefined;
  if (!row) return [];
  try {
    const v = JSON.parse(row.value) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function saveAccountTicks(db: Db, backupId: number, placeIds: readonly string[]): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(accountTicksKey(backupId), JSON.stringify([...placeIds]));
}

// ---- the accounts of one running copy: the first ticks and the ones the person added when the first were full ---------------------------------

export interface JobAccounts {
  backupId: number;
  kinds: string[];
  /** Ticked on the confirm step before the copy started. */
  accountIds: string[];
  /** Added later, each time the person confirmed more accounts after "the accounts you picked are full". */
  moreIds: string[];
  /** The two switches of the start (written only when on). */
  onlyOnPhone?: boolean;
  fitBiggest?: boolean;
}

const jobAccountsKey = (jobId: number): string => `google.copy.job.${jobId}`;

export function saveJobAccounts(db: Db, jobId: number, record: JobAccounts): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(jobAccountsKey(jobId), JSON.stringify(record));
}

export function loadJobAccounts(db: Db, jobId: number): JobAccounts | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(jobAccountsKey(jobId)) as { value: string } | undefined;
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Partial<JobAccounts>;
    const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : []);
    if (typeof v.backupId !== 'number') return null;
    return { backupId: v.backupId, kinds: strings(v.kinds), accountIds: strings(v.accountIds), moreIds: strings(v.moreIds), ...(v.onlyOnPhone === true ? { onlyOnPhone: true } : {}), ...(v.fitBiggest === true ? { fitBiggest: true } : {}) };
  } catch {
    return null;
  }
}
