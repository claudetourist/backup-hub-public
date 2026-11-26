/**
 * The check of Free up phone space (job `freeup.check`), in the mode the person picks (params.mode, default quick). It says what may leave the phone.
 *   QUICK (seconds, nothing read in full):
 *   - the phone: one listing of the folders, each file must still have the size and date it had at the backup;
 *   - the first drive (T7) and the second drive (Seagate): a copy whose checksum was proved when it was copied (read_both), still on the
 *     drive at its size, both with the same checksum;
 *   - Google: the index must hold a copy with that checksum whose check was "google-md5", and Google is asked again now for its MD5 and size.
 *   FULL (reads every file, one at a time; about an hour for 46 GB):
 *   - the phone's SHA-256 read on the phone now (batched), both drive copies read in full now (the T7 also gives the MD5), the phone's
 *     checksum must equal both, Google's index MD5 must equal the T7 MD5 just read, and Google asked now must give that MD5 and the size.
 * The result keeps the mode and, per step, how many files passed it (`steps`), so the screen can say plainly what the check did.
 * The removal (freeUpRemove.ts) proves each file again right before it goes, in the mode the person picks for the removal.
 * Imported, name-and-size and unchecked copies never count. Nothing is offered while a drive is unplugged or Google cannot be reached: the
 * result then says what is missing. The database is only read, in pages with a turn of the event loop between them (the job's `yield`).
 * Phone rows in the index have no leading slash ("sdcard/DCIM/..."); paths here are the phone's own ("/sdcard/DCIM/...").
 */
import fs from 'node:fs';
import {
  FREEUP_CHECK_JOB_KIND,
  FREEUP_GROUP_LABELS,
  FREEUP_MAX_NOT_READY_ROWS,
  FREEUP_GROUPS,
  GOOGLE_WORD,
  type FreeUpCheckStep,
  type FreeUpGroupId,
  type FreeUpGroupView,
  type FreeUpMode,
  type FreeUpReasonCount,
  type FreeUpRemoveFile,
  type FreeUpResultView,
} from '../../shared/freeUp';
import { KIND_LABELS, type FileKind } from '../../shared/fileKinds';
import type { Db } from '../db/connection';
import { skipReason, type Sha256Batch } from '../adb/phoneModel';
import { JobAborted, JobFailure, type JobContext, type JobHandler } from '../jobs/jobService';
import type { AdbCleanPort } from '../cleanup/adbClean';
import type { RemoveManyItem, RemoveManyStatus } from '../danger/adbRm';
import { driveFilePath, type BaseOf } from '../cleanup/diskAccess';
import { hashUnbuffered } from '../localCopy/directRead';
import { STEP_ITEMS } from '../sliceWork';
import type { GoogleAsk } from './googleAsk';
import { compareForList, copyIsInPlace, groupOf, isOfferedKind, neverOfferedPath, phoneKindOf } from './freeUpRules';
import { KeepStore, googleLeftOut } from './keepStore';

/** The phone's connection as this feature needs it: the clean-up port plus two optional extras (a batched checksum and the media refresh). */
export interface FreeUpAdb extends AdbCleanPort {
  /** The removal asks the sizes of a batch with one call and removes a batch with one call (see `AdbCleanClient`). */
  statSizes(serial: string, remotePaths: readonly string[], signal?: AbortSignal): Promise<(number | null)[]>;
  removeMany(serial: string, items: readonly RemoveManyItem[], signal?: AbortSignal): Promise<RemoveManyStatus[]>;
  sha256Many?(serial: string, remotePaths: readonly string[], signal?: AbortSignal, totalBytes?: number): Promise<Sha256Batch>;
  /** Asks the phone's gallery to look at these paths again, so a removed file leaves no ghost. Best effort. */
  scanMedia?(serial: string, remotePaths: readonly string[], signal?: AbortSignal): Promise<void>;
}

export interface DriveHash {
  sha256: string;
  md5: string | null;
  bytes: number;
}
/** Reads a file the way a check must (no Windows cache). Tests give a plain reader over a temp folder. */
export type HashFile = (absPath: string, opts: { md5: boolean; yieldNow: () => Promise<void> }) => Promise<DriveHash>;
/** The size of a file on a drive now, or null when it is not there. */
export const realFileSize = async (absPath: string): Promise<number | null> => {
  try {
    return (await fs.promises.stat(absPath)).size;
  } catch {
    return null;
  }
};
export const realHashFile: HashFile = (absPath, opts) => hashUnbuffered(absPath, { md5: opts.md5, yieldNow: opts.yieldNow });

export interface FreeUpDeps {
  db: Db;
  adb: FreeUpAdb;
  baseOf: BaseOf;
  /** Google, asked again now. Null: Google cannot be asked (nothing is offered). */
  google: GoogleAsk | null;
  results: FreeUpResults;
  hashFile?: HashFile;
  /** Size of a drive file now (tests give a fake); default: the real file system. */
  fileSize?: (absPath: string) => Promise<number | null>;
  now?: () => number;
  changed?: () => void;
}

// ---- what the check keeps --------------------------------------------------------------------------------------------------------------

export interface ReadyFile {
  path: string;
  name: string;
  folder: string;
  size: number;
  mtimeSec: number;
  sha256: string;
  kind: string;
  group: FreeUpGroupId;
  remove: FreeUpRemoveFile;
}

export interface NotReadyFile {
  path: string;
  name: string;
  folder: string;
  size: number;
  mtimeSec: number;
  group: FreeUpGroupId;
  missing: string[];
  /** Where the first drive's copy sits in the index (for "Show in folder"), when there is one. */
  t7: { placeId: string; relPath: string } | null;
}

export interface StoredCheck {
  checkId: number;
  backupId: number;
  serial: string;
  model: string;
  at: number;
  view: FreeUpResultView;
  /** In list order (big videos first). */
  ready: ReadyFile[];
  notReady: NotReadyFile[];
  notReadyTruncated: boolean;
  /** Paths of ready files the person unticked ("stays this time"). The removal takes only the ticked ones. Kept with the check, in memory. */
  unticked: Set<string>;
}

const KEEP_RESULTS = 3;
/** A full check asks the phone for this many checksums at once (or this many bytes, whichever comes first). */
const BATCH_FILES = 20;
const BATCH_BYTES = 2_000_000_000;

/** The finished checks held in memory (newest few); the check job writes, the service reads. */
export class FreeUpResults {
  private readonly byId = new Map<number, StoredCheck>();

  set(check: StoredCheck): void {
    this.byId.set(check.checkId, check);
    while (this.byId.size > KEEP_RESULTS) this.byId.delete(this.byId.keys().next().value as number);
  }

  get(checkId: number): StoredCheck | null {
    return this.byId.get(checkId) ?? null;
  }

  delete(checkId: number): void {
    this.byId.delete(checkId);
  }

  /** The confirmed list of a removal waits here for its job (a list of 50,000 files is too big to keep in the job's parameters). */
  private readonly removals = new Map<string, FreeUpRemoveFile[]>();

  holdRemoval(listId: string, files: FreeUpRemoveFile[]): void {
    this.removals.set(listId, files);
    while (this.removals.size > KEEP_RESULTS) this.removals.delete(this.removals.keys().next().value as string);
  }

  /** The confirmed list, once: null when it is not kept (the app was restarted, or the job already took it). */
  takeRemoval(listId: string): FreeUpRemoveFile[] | null {
    const files = this.removals.get(listId) ?? null;
    this.removals.delete(listId);
    return files;
  }

  /** The newest check of this backup. */
  latestFor(backupId: number): StoredCheck | null {
    let found: StoredCheck | null = null;
    for (const c of this.byId.values()) if (c.backupId === backupId && (found === null || c.checkId > found.checkId)) found = c;
    return found;
  }

  /** Every check of this backup (the keep list changed under them all). */
  forBackup(backupId: number): StoredCheck[] {
    return [...this.byId.values()].filter((c) => c.backupId === backupId);
  }
}

// ---- the backup and its three places ------------------------------------------------------------------------------------------------------

export interface Place {
  placeId: string;
  label: string;
  /** The backup's folder on the drive, forward slashes, no slash at either end. */
  root: string;
}

export interface BackupContext {
  backupId: number;
  name: string;
  serial: string;
  phonePlaceId: string | null;
  first: Place | null;
  second: Place | null;
  accounts: { id: string; label: string }[];
}

interface ProfileRow {
  name: string;
  source_kind: string;
  phone_serial: string | null;
  source_place_id: string | null;
}

/** The phone backup, its first and second drive (by position) and the Google accounts. Null when it is not a phone backup with a phone. */
export function loadBackupContext(db: Db, backupId: number): BackupContext | null {
  const p = db.prepare('SELECT name, source_kind, phone_serial, source_place_id FROM backup_profiles WHERE id = ?').get(backupId) as ProfileRow | undefined;
  if (!p || p.source_kind !== 'phone' || p.phone_serial === null) return null;
  const dests = db
    .prepare('SELECT d.place_id AS placeId, d.root AS root, pl.label AS label FROM backup_destinations d JOIN places pl ON pl.id = d.place_id WHERE d.backup_profile_id = ? AND d.enabled = 1 AND pl.kind = ? ORDER BY d.position, d.id')
    .all(backupId, 'drive') as { placeId: string; root: string; label: string }[];
  const place = (d: { placeId: string; root: string; label: string } | undefined): Place | null => (d ? { placeId: d.placeId, label: d.label, root: d.root.split('\\').join('/').replace(/^\/+|\/+$/g, '') } : null);
  const accounts = db.prepare("SELECT id, label FROM places WHERE kind = 'gdrive' ORDER BY id").all() as { id: string; label: string }[];
  return { backupId, name: p.name, serial: p.phone_serial, phonePlaceId: p.source_place_id, first: place(dests[0]), second: place(dests[1]), accounts };
}

// ---- reading the phone ----------------------------------------------------------------------------------------------------------------

export type PhoneAnswer = { kind: 'sha256'; sha256: string } | { kind: 'missing' } | { kind: 'error' };

/** The phone's own SHA-256 of these files, read now (one adb call for the lot when the connection can). Throws when the phone as a whole does not answer. */
export async function phoneHashes(adb: FreeUpAdb, serial: string, paths: readonly string[], signal: AbortSignal | undefined, totalBytes: number): Promise<Map<string, PhoneAnswer>> {
  const out = new Map<string, PhoneAnswer>();
  if (adb.sha256Many) {
    const batch = await adb.sha256Many(serial, paths, signal, totalBytes);
    if (batch.adbError !== null) throw new Error(batch.adbError);
    for (const p of paths) {
      const a = batch.answers.get(p);
      out.set(p, a?.kind === 'sha256' ? { kind: 'sha256', sha256: a.sha256 } : a?.kind === 'missing' ? { kind: 'missing' } : { kind: 'error' });
    }
    return out;
  }
  for (const p of paths) {
    if ((await adb.statSize(serial, p, signal)) === null) {
      out.set(p, { kind: 'missing' });
      continue;
    }
    const sha = await adb.sha256(serial, p, signal);
    out.set(p, sha === null ? { kind: 'error' } : { kind: 'sha256', sha256: sha });
  }
  return out;
}

// ---- the index side: which copies exist --------------------------------------------------------------------------------------------------

interface CopyRow {
  place_id: string;
  rel_path: string;
  size: number;
  sha256: string | null;
  md5: string | null;
  verified_how: string | null;
  ext_id?: string | null;
}

interface Candidate {
  path: string;
  name: string;
  folder: string;
  size: number;
  mtimeSec: number;
  kind: string;
  group: FreeUpGroupId;
  /** Phone checksum the index holds (a fallback to find copies; the real one is read from the phone). */
  indexSha: string | null;
  t7: CopyRow | null;
  second: CopyRow | null;
  google: (CopyRow & { parentId: string | null }) | null;
}

const bump = (m: Map<string, { files: number; bytes: number }>, key: string, size: number): void => {
  const c = m.get(key) ?? { files: 0, bytes: 0 };
  c.files += 1;
  c.bytes += size;
  m.set(key, c);
};

class Queries {
  private readonly originCopies;
  private readonly bySha;
  private readonly googleBySha;
  private readonly parentOf;
  constructor(db: Db) {
    this.originCopies = db.prepare('SELECT place_id, rel_path, size, sha256, md5, verified_how FROM files WHERE origin_file_id = ? AND gone_at IS NULL');
    this.bySha = db.prepare('SELECT place_id, rel_path, size, sha256, md5, verified_how FROM files WHERE sha256 = ? AND place_id = ? AND size = ? AND gone_at IS NULL');
    this.googleBySha = db.prepare("SELECT place_id, rel_path, size, sha256, md5, verified_how, ext_id FROM files WHERE sha256 = ? AND place_id = ? AND size = ? AND gone_at IS NULL AND verified_how = 'google-md5'");
    this.parentOf = db.prepare('SELECT parent_ext_id FROM drive_items WHERE place_id = ? AND ext_id = ?').pluck();
  }

  /** The best copy at one drive: a checked one in the backup's folder, found by the phone row's link, else by checksum. */
  driveCopy(phoneRowId: number, indexSha: string | null, size: number, place: Place): CopyRow | null {
    const linked = (this.originCopies.all(phoneRowId) as CopyRow[]).filter((r) => r.place_id === place.placeId && copyIsInPlace(r.rel_path, place.root));
    const pool = linked.length > 0 ? linked : indexSha === null ? [] : (this.bySha.all(indexSha, place.placeId, size) as CopyRow[]).filter((r) => copyIsInPlace(r.rel_path, place.root));
    return pool.find((r) => r.verified_how === 'read_both' && r.size === size) ?? pool[0] ?? null;
  }

  googleCopy(indexSha: string | null, size: number, accounts: readonly { id: string }[]): (CopyRow & { parentId: string | null }) | null {
    if (indexSha === null) return null;
    for (const a of accounts) {
      const r = (this.googleBySha.all(indexSha, a.id, size) as CopyRow[])[0];
      if (r) return { ...r, parentId: (this.parentOf.get(a.id, r.ext_id ?? '') as string | null | undefined) ?? null };
    }
    return null;
  }
}

const isChecked = (r: CopyRow | null): r is CopyRow => r !== null && r.verified_how === 'read_both';

function missingOf(c: Candidate, ctx: BackupContext): string[] {
  const missing: string[] = [];
  const drive = (r: CopyRow | null, place: Place | null, fallback: string): void => {
    if (place === null) missing.push(fallback);
    else if (r === null) missing.push(`No copy on ${place.label}`);
    else if (!isChecked(r)) missing.push(`The copy on ${place.label} is not checked yet`);
  };
  drive(c.t7, ctx.first, 'No first drive is set up for this backup');
  drive(c.second, ctx.second, 'No second drive is set up for this backup');
  if (c.google === null) missing.push(`No checked copy in ${GOOGLE_WORD}`);
  return missing;
}

/**
 * The groups of a ready list, in list order, without the empty ones. `files` and `bytes` count the ticked files; the unticked ones ("stays this time") are
 * counted apart (a group whose files are all unticked is still listed, so the person can tick them again).
 */
export function groupViews(ready: readonly { group: FreeUpGroupId; size: number; path?: string }[], unticked?: ReadonlySet<string>): FreeUpGroupView[] {
  const by = new Map<FreeUpGroupId, { files: number; bytes: number; leftFiles: number; leftBytes: number }>();
  for (const r of ready) {
    const t = by.get(r.group) ?? { files: 0, bytes: 0, leftFiles: 0, leftBytes: 0 };
    if (unticked !== undefined && r.path !== undefined && unticked.has(r.path)) {
      t.leftFiles += 1;
      t.leftBytes += r.size;
    } else {
      t.files += 1;
      t.bytes += r.size;
    }
    by.set(r.group, t);
  }
  const out: FreeUpGroupView[] = [];
  for (const id of FREEUP_GROUPS) {
    const t = by.get(id);
    if (t === undefined) continue;
    out.push({ id, label: FREEUP_GROUP_LABELS[id], files: t.files, bytes: t.bytes, ...(t.leftFiles > 0 ? { leftOutFiles: t.leftFiles, leftOutBytes: t.leftBytes } : {}) });
  }
  return out;
}

// ---- the job ---------------------------------------------------------------------------------------------------------------------------

export function freeUpCheckHandler(deps: FreeUpDeps): JobHandler {
  return {
    kind: FREEUP_CHECK_JOB_KIND,
    heavy: true,
    resumable: false,
    run: async (ctx) => {
      try {
        return await runCheck(deps, ctx);
      } finally {
        await deps.adb.killServer();
      }
    },
  };
}

const sizeWords = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6).toLocaleString('en-US')} MB`);

async function runCheck(deps: FreeUpDeps, ctx: JobContext): Promise<string> {
  const params = ctx.params as { backupId?: unknown; mode?: unknown } | null;
  const backupId = params?.backupId;
  const mode: FreeUpMode = params?.mode === 'full' ? 'full' : 'quick';
  if (typeof backupId !== 'number') throw new JobFailure('This check has no backup. Nothing was changed.');
  const bk = loadBackupContext(deps.db, backupId);
  if (!bk) throw new JobFailure('That is not a phone backup. Nothing was changed.');
  const now = deps.now ?? Date.now;
  const turn = (): Promise<void> => ctx.yield();

  // 1. What is missing before anything is read: the drives and Google.
  const blocked: string[] = [];
  const baseOfFirst = bk.first ? await deps.baseOf(bk.first.placeId) : null;
  const baseOfSecond = bk.second ? await deps.baseOf(bk.second.placeId) : null;
  if (bk.first === null) blocked.push('This backup has no first drive.');
  else if (baseOfFirst === null) blocked.push(`${bk.first.label} is not plugged in.`);
  if (bk.second === null) blocked.push('This backup has no second drive, so a file cannot have three copies.');
  else if (baseOfSecond === null) blocked.push(`${bk.second.label} is not plugged in.`);
  if (bk.accounts.length === 0) blocked.push('No Google account is set up, so a file cannot have a copy in Google.');
  else if (deps.google === null || !(await deps.google.reachable(bk.accounts[0]!.id, ctx.signal))) blocked.push('Google cannot be reached right now (check the internet and the sign-in).');

  if (!deps.adb.available()) throw new JobFailure('adb.exe was not found, so the phone cannot be reached. Nothing was changed.');
  const phone = (await deps.adb.devices().catch(() => [])).find((d) => d.serial === bk.serial);
  if (!phone || phone.state !== 'device') throw new JobFailure(`${bk.name} is not connected or not unlocked. Plug it in, unlock it and start again. Nothing was changed.`);
  const places = [bk.first?.label ?? 'First drive', bk.second?.label ?? 'Second drive', GOOGLE_WORD];

  const keepMatch = new KeepStore(deps.db).matcher(backupId);
  const leftOutOfGoogle = googleLeftOut(deps.db, backupId);
  const locked = { keepFiles: 0, keepBytes: 0, otherFiles: 0, otherBytes: 0 };
  const googleKinds = new Map<string, { files: number; bytes: number }>();
  const candidates: Candidate[] = [];
  const notReady: NotReadyFile[] = [];
  const reasonCounts = new Map<string, number>();
  const notReadyTotals = { files: 0, bytes: 0 };
  let notReadyTruncated = false;
  const addNotReady = (c: { path: string; name: string; folder: string; size: number; mtimeSec: number; group: FreeUpGroupId }, missing: string[], t7: { place_id: string; rel_path: string } | null = null): void => {
    notReadyTotals.files += 1;
    notReadyTotals.bytes += c.size;
    for (const m of missing) reasonCounts.set(m, (reasonCounts.get(m) ?? 0) + 1);
    if (notReady.length < FREEUP_MAX_NOT_READY_ROWS) notReady.push({ path: c.path, name: c.name, folder: c.folder, size: c.size, mtimeSec: c.mtimeSec, group: c.group, missing, t7: t7 ? { placeId: t7.place_id, relPath: t7.rel_path } : null });
    else notReadyTruncated = true;
  };

  // 2. The index: this phone's files, page by page. Nothing is read from a drive or the phone here.
  if (blocked.length === 0 && bk.phonePlaceId !== null) {
    const q = new Queries(deps.db);
    const page = deps.db.prepare('SELECT id, rel_path, size, mtime, sha256, kind FROM files WHERE place_id = ? AND rel_path > ? AND gone_at IS NULL ORDER BY rel_path LIMIT 500');
    let after = '';
    let seen = 0;
    ctx.progress(0, 0, { message: 'Reading the list of files' });
    for (;;) {
      await turn();
      const rows = page.all(bk.phonePlaceId, after) as { id: number; rel_path: string; size: number; mtime: number | null; sha256: string | null; kind: string | null }[];
      if (rows.length === 0) break;
      after = rows[rows.length - 1]!.rel_path;
      for (const r of rows) {
        seen += 1;
        if (seen % STEP_ITEMS === 0) await turn();
        const phonePath = r.rel_path.startsWith('/') ? r.rel_path : `/${r.rel_path}`;
        if (r.size <= 0 || skipReason(phonePath) !== null) continue;
        const kind = phoneKindOf(phonePath, r.size, r.kind);
        const group = groupOf(kind, r.size);
        if (neverOfferedPath(phonePath) !== null || group === null || !isOfferedKind(kind)) {
          locked.otherFiles += 1;
          locked.otherBytes += r.size;
          continue;
        }
        if (keepMatch(phonePath)) {
          locked.keepFiles += 1;
          locked.keepBytes += r.size;
          continue;
        }
        if (leftOutOfGoogle(phonePath, kind)) {
          bump(googleKinds, KIND_LABELS[kind as FileKind] ?? kind, r.size);
          continue;
        }
        const slash = phonePath.lastIndexOf('/');
        const base = { path: phonePath, name: phonePath.slice(slash + 1), folder: phonePath.slice(0, slash), size: r.size, mtimeSec: r.mtime === null ? 0 : Math.floor(r.mtime / 1000), kind, group };
        const t7 = bk.first ? q.driveCopy(r.id, r.sha256, r.size, bk.first) : null;
        const second = bk.second ? q.driveCopy(r.id, r.sha256, r.size, bk.second) : null;
        // The phone's own row usually has no checksum (phone files are not hashed in the index): find Google's copy by the
        // checksum of the linked drive copy. Safe: the phone's file is read now and must match both drives, and Google's MD5 must
        // match the first drive's read (step 3).
        const googleSha = r.sha256 ?? t7?.sha256 ?? second?.sha256 ?? null;
        const cand: Candidate = { ...base, indexSha: r.sha256, t7, second, google: q.googleCopy(googleSha, r.size, bk.accounts) };
        const missing = missingOf(cand, bk);
        if (missing.length > 0) addNotReady(base, missing, t7);
        else candidates.push(cand);
      }
    }
  }

  // 3. The looks, biggest videos first. QUICK (the default): nothing is read in full. The phone's list (size and date now), each drive copy
  // still there at its size (its checksum was proved when it was copied: read_both), both drives equal, Google asked now. FULL: the phone's
  // checksum read on the phone, both drive copies read in full, Google's MD5 against the first drive's read; one file at a time.
  // Either way the removal (freeUpRemove.ts) proves every file again in the mode the person picks for it.
  candidates.sort((a, b) => compareForList(a, b));
  const ready: ReadyFile[] = [];
  let googleDown = false;
  const totalBytes = candidates.reduce((n, c) => n + c.size, 0);
  let doneFiles = 0;
  let doneBytes = 0;
  const progress = (message: string): void => ctx.progress(doneFiles, candidates.length, { bytesDone: doneBytes, bytesTotal: totalBytes, message });
  const firstName = places[0]!;
  const secondName = places[1]!;
  const steps: FreeUpCheckStep[] = (
    mode === 'quick'
      ? [
          'Phone: file still there with the same size and date as at the backup',
          `${firstName}: copy there at the right size (its checksum was proved when it was copied)`,
          `${secondName}: copy there at the right size (its checksum was proved when it was copied)`,
          `${firstName} and ${secondName} copies have the same checksum`,
          `${GOOGLE_WORD}: asked now, its checksum and size match`,
        ]
      : [
          'Phone: checksum read on the phone now',
          `${firstName}: read in full now, same checksum as the phone`,
          `${secondName}: read in full now, same checksum as the phone`,
          `${GOOGLE_WORD}: asked now, its checksum matches the ${firstName} copy just read`,
        ]
  ).map((what) => ({ what, passed: 0, failed: 0 }));
  const googleStep = steps.length - 1;
  const tally = (step: number, ok: boolean): void => {
    if (ok) steps[step]!.passed += 1;
    else steps[step]!.failed += 1;
  };
  progress(candidates.length === 0 ? (mode === 'quick' ? 'Nothing to look at' : 'Nothing to read') : mode === 'quick' ? 'Asking the phone for its list' : 'Checking the first files');

  const baseOf = (c: Candidate): { path: string; name: string; folder: string; size: number; mtimeSec: number; group: FreeUpGroupId } => ({ path: c.path, name: c.name, folder: c.folder, size: c.size, mtimeSec: c.mtimeSec, group: c.group });
  const toVoucher = (r: CopyRow, label: string, kind: string, sha: string | null, md5: string | null): FreeUpRemoveFile['vouchers'][number] => ({ placeId: r.place_id, placeLabel: label, placeKind: kind, relPath: r.rel_path, size: r.size, sha256: sha, md5 });
  const askGoogle = (g: NonNullable<Candidate['google']>) => deps.google!.ask({ placeId: g.place_id, fileId: g.ext_id ?? '', name: g.rel_path.slice(g.rel_path.lastIndexOf('/') + 1), parentId: g.parentId }, ctx.signal);
  /** A file that passed every step: the removal's list entry (the first drive's MD5 is the one Google's copy must match). */
  const pushReady = (c: Candidate, base: ReturnType<typeof baseOf>, sha256: string, t7Md5: string | null): void => {
    const g = c.google!;
    ready.push({
      ...base,
      mtimeSec: c.mtimeSec,
      sha256,
      kind: c.kind,
      remove: {
        path: c.path,
        size: c.size,
        sha256,
        kind: c.kind,
        vouchers: [toVoucher(c.t7!, bk.first!.label, 'drive', sha256, t7Md5), toVoucher(c.second!, bk.second!.label, 'drive', sha256, null), toVoucher(g, GOOGLE_WORD, 'gdrive', sha256, g.md5)],
        google: { placeId: g.place_id, fileId: g.ext_id ?? '', name: g.rel_path.slice(g.rel_path.lastIndexOf('/') + 1), parentId: g.parentId, md5: g.md5 ?? '', size: c.size },
      },
    });
  };
  if (mode === 'quick') {
    // The phone: one listing of the folders the candidates are in.
    const onPhone = new Map<string, { size: number; mtimeSec: number }>();
    if (candidates.length > 0) {
      const folders = [...new Set(candidates.map((c) => c.folder))].toSorted();
      const roots = folders.filter((f) => !folders.some((o) => o !== f && f.startsWith(`${o}/`)));
      try {
        for (const f of await deps.adb.listFiles(bk.serial, roots, ctx.signal)) onPhone.set(f.path, { size: f.size, mtimeSec: f.mtimeSec });
      } catch (err) {
        if (ctx.signal.aborted) throw new JobAborted();
        throw new JobFailure(`The phone stopped answering (${(err as Error).message.split('\n')[0]?.slice(0, 100) ?? 'unknown'}). Nothing was changed.`);
      }
    }
    const fileSize = deps.fileSize ?? realFileSize;
    const driveThere = async (row: CopyRow, place: Place): Promise<string | null> => {
      const abs = await driveFilePath(deps.db, deps.baseOf, row.place_id, row.rel_path);
      if (abs === null) return `${place.label} is not plugged in`;
      const size = await fileSize(abs);
      if (size === null) return `The copy on ${place.label} is not on the drive`;
      return size === row.size ? null : `The copy on ${place.label} has another size now`;
    };
    const GOOGLE_AT_ONCE = 6;
    let next = 0;
    const one = async (c: Candidate): Promise<void> => {
      const base = baseOf(c);
      const fail = (...why: string[]): void => addNotReady(base, why, c.t7);
      const there = onPhone.get(c.path);
      if (!there) {
        tally(0, false);
        return fail('It is not on the phone any more');
      }
      if (there.size !== c.size || (c.mtimeSec > 0 && Math.abs(there.mtimeSec - c.mtimeSec) > 2)) {
        tally(0, false);
        return fail('It changed on the phone after the backup');
      }
      tally(0, true);
      const t7 = c.t7!;
      const sea = c.second!;
      const [t7Why, seaWhy] = await Promise.all([driveThere(t7, bk.first!), driveThere(sea, bk.second!)]);
      tally(1, t7Why === null);
      tally(2, seaWhy === null);
      const why = [t7Why, seaWhy].filter((w): w is string => w !== null);
      if (why.length > 0) return fail(...why);
      if (t7.sha256 === null || sea.sha256 !== t7.sha256) {
        tally(3, false);
        return fail(`The copies on ${bk.first!.label} and ${bk.second!.label} are not the same`);
      }
      tally(3, true);
      const g = c.google!;
      if (g.md5 === null || (g.sha256 !== null && g.sha256 !== t7.sha256)) {
        tally(googleStep, false);
        return fail(`The copy in ${GOOGLE_WORD} is not the same as the copy on ${bk.first!.label}`);
      }
      if (googleDown) {
        tally(googleStep, false);
        return fail('Google could not be asked');
      }
      const answer = await askGoogle(g);
      if (answer.kind === 'unreachable') {
        googleDown = true;
        tally(googleStep, false);
        return fail('Google could not be asked');
      }
      if (answer.kind === 'missing') {
        tally(googleStep, false);
        return fail(`${GOOGLE_WORD} does not have the copy any more`);
      }
      if (answer.md5 === null || answer.md5 !== g.md5.toLowerCase() || answer.size !== c.size) {
        tally(googleStep, false);
        return fail(`${GOOGLE_WORD} says its copy is different`);
      }
      tally(googleStep, true);
      pushReady(c, base, t7.sha256, g.md5);
    };
    const worker = async (): Promise<void> => {
      for (;;) {
        // Take the next file before the turn, so two workers never take the same one or run past the end.
        const c = candidates[next];
        if (c === undefined) return;
        next += 1;
        await turn();
        progress(`Looking at ${c.name}`);
        await one(c);
        doneFiles += 1;
        doneBytes += c.size;
      }
    };
    await Promise.all(Array.from({ length: Math.min(GOOGLE_AT_ONCE, candidates.length) }, () => worker()));
  } else {
    const hashFile = deps.hashFile ?? realHashFile;
    const readDrive = async (row: CopyRow, place: Place, wantMd5: boolean): Promise<{ ok: true; hash: DriveHash } | { ok: false; why: string }> => {
      const abs = await driveFilePath(deps.db, deps.baseOf, row.place_id, row.rel_path);
      if (abs === null) return { ok: false, why: `${place.label} is not plugged in` };
      try {
        const hash = await hashFile(abs, { md5: wantMd5, yieldNow: turn });
        if (hash.bytes !== row.size) return { ok: false, why: `The copy on ${place.label} has another size now` };
        return { ok: true, hash };
      } catch (err) {
        if (err instanceof JobAborted || ctx.signal.aborted) throw err instanceof JobAborted ? err : new JobAborted();
        return { ok: false, why: `The copy on ${place.label} could not be read` };
      }
    };
    const one = async (c: Candidate, mine: PhoneAnswer | undefined): Promise<void> => {
      const base = baseOf(c);
      const fail = (...why: string[]): void => addNotReady(base, why, c.t7);
      if (googleDown) {
        tally(googleStep, false);
        return fail('Google could not be asked');
      }
      if (mine?.kind === 'missing') {
        tally(0, false);
        return fail('It is not on the phone any more');
      }
      if (mine?.kind !== 'sha256') {
        tally(0, false);
        return fail('The phone did not give a checksum for it');
      }
      tally(0, true);
      progress(`Checking ${c.name}`);
      // The first drive's read also gives the MD5 that Google's copy must have.
      const [t7, sea] = await Promise.all([readDrive(c.t7!, bk.first!, true), readDrive(c.second!, bk.second!, false)]);
      const why: string[] = [];
      const t7Same = t7.ok && t7.hash.sha256 === mine.sha256;
      const seaSame = sea.ok && sea.hash.sha256 === mine.sha256;
      if (!t7.ok) why.push(t7.why);
      else if (!t7Same) why.push(`The phone's file is different from the copy on ${bk.first!.label}`);
      if (!sea.ok) why.push(sea.why);
      else if (!seaSame) why.push(`The phone's file is different from the copy on ${bk.second!.label}`);
      tally(1, t7Same);
      tally(2, seaSame);
      if (!t7.ok || !sea.ok || why.length > 0) return fail(...why);
      const g = c.google!;
      const t7Md5 = t7.hash.md5;
      if (t7Md5 === null || g.md5 === null || g.md5.toLowerCase() !== t7Md5.toLowerCase()) {
        tally(googleStep, false);
        return fail(`The copy in ${GOOGLE_WORD} is not the same as the copy on ${bk.first!.label}`);
      }
      const answer = await askGoogle(g);
      if (answer.kind === 'unreachable') {
        googleDown = true;
        tally(googleStep, false);
        return fail('Google could not be asked');
      }
      if (answer.kind === 'missing') {
        tally(googleStep, false);
        return fail(`${GOOGLE_WORD} does not have the copy any more`);
      }
      if (answer.md5 === null || answer.md5 !== t7Md5.toLowerCase() || answer.size !== c.size) {
        tally(googleStep, false);
        return fail(`${GOOGLE_WORD} says its copy is different`);
      }
      tally(googleStep, true);
      pushReady(c, base, mine.sha256, t7Md5);
    };
    let next = 0;
    while (next < candidates.length) {
      await turn();
      const batch: Candidate[] = [];
      let batchBytes = 0;
      while (next < candidates.length && batch.length < BATCH_FILES && (batch.length === 0 || batchBytes + candidates[next]!.size <= BATCH_BYTES)) {
        batchBytes += candidates[next]!.size;
        batch.push(candidates[next]!);
        next += 1;
      }
      let phoneNow = new Map<string, PhoneAnswer>();
      if (!googleDown) {
        try {
          phoneNow = await phoneHashes(deps.adb, bk.serial, batch.map((c) => c.path), ctx.signal, batchBytes);
        } catch (err) {
          if (ctx.signal.aborted) throw new JobAborted();
          throw new JobFailure(`The phone stopped answering (${(err as Error).message.split('\n')[0]?.slice(0, 100) ?? 'unknown'}). Nothing was changed.`);
        }
      }
      for (const c of batch) {
        await turn();
        await one(c, phoneNow.get(c.path));
        doneFiles += 1;
        doneBytes += c.size;
      }
    }
  }
  // The list keeps the agreed order whatever order the answers came in.
  ready.sort((a, b) => compareForList(a, b));
  if (googleDown) {
    blocked.push('Google could not be asked while the files were checked, so nothing can be offered.');
    // Nothing is offered: what was ready becomes "not ready" with the reason (and no longer counts as passed at the Google step).
    steps[googleStep]!.passed -= ready.length;
    steps[googleStep]!.failed += ready.length;
    for (const r of ready.splice(0)) addNotReady(r, ['Google could not be asked'], { place_id: r.remove.vouchers[0]!.placeId, rel_path: r.remove.vouchers[0]!.relPath });
  }
  progress('Done');

  // 4. The result.
  const groups = groupViews(ready);
  const reasons: FreeUpReasonCount[] = [...reasonCounts.entries()].map(([what, files]) => ({ what, files })).toSorted((a, b) => b.files - a.files || (a.what < b.what ? -1 : 1));
  const checkId = ctx.jobId;
  const view: FreeUpResultView = {
    checkId,
    mode,
    steps,
    backupId,
    at: now(),
    phoneName: bk.name,
    blocked,
    groups: blocked.length > 0 ? [] : groups,
    readyFiles: blocked.length > 0 ? 0 : ready.length,
    readyBytes: blocked.length > 0 ? 0 : ready.reduce((n, r) => n + r.size, 0),
    notReady: { files: notReadyTotals.files, bytes: notReadyTotals.bytes, reasons },
    locked: { ...locked, googleKinds: [...googleKinds.entries()].map(([label, v]) => ({ label, files: v.files, bytes: v.bytes })).toSorted((a, b) => b.bytes - a.bytes) },
    places,
  };
  deps.results.set({ checkId, backupId, serial: bk.serial, model: phone.model, at: view.at, view, ready: blocked.length > 0 ? [] : ready, notReady, notReadyTruncated, unticked: new Set() });
  if (blocked.length > 0) return `Nothing can be offered: ${blocked.join(' ')}`;
  return mode === 'quick'
    ? `Quick check: ${ready.length.toLocaleString('en-US')} files (${sizeWords(view.readyBytes)}) are on the phone and have checked copies on ${places.join(', ')}; ${notReadyTotals.files.toLocaleString('en-US')} are not ready.`
    : `Full check: ${ready.length.toLocaleString('en-US')} files (${sizeWords(view.readyBytes)}) were read in full now on the phone, ${places.join(', ')}; ${notReadyTotals.files.toLocaleString('en-US')} are not ready.`;
}
