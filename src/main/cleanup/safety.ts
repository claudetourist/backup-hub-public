/**
 * The safety rules of Clean up, as pure functions: no database, no files, no adb, no clock (the time is passed in).
 * Everything that decides "may this file be removed?" lives here so it can be tested hard.
 *
 * - SAFE rule (phone): the same SHA-256 on a named drive (the T7) AND in the cloud (Google Drive or OneDrive).
 *   Drive rows have an MD5 but no SHA-256, so a Google copy is matched through the drive copy's MD5 + size.
 * - 24 h freshness of every place that vouches, locks of 30 days, a re-check right before the removal.
 * - Laptop duplicates: protected folders, OneDrive-synced folders, quarantine paths and the age rules for emptying.
 */
import path from 'node:path';
import {
  CLEAN_PLAN_LIFETIME_MS,
  FOLDER_VOUCHER_KIND,
  FOLDER_VOUCHER_PREFIX,
  FRESH_MS,
  LOCK_MS,
  QUARANTINE_ASK_MS,
  type Bucket,
  type CleanDestination,
  type DuplicateGroup,
  type LaptopCleanPlan,
  type PhoneCleanFile,
  type PhoneCleanPlan,
  type Voucher,
} from '../../shared/cleanup';
import { APP_FOLDER, LEGACY_CARD_FOLDER, LEGACY_QUARANTINE_FOLDER, QUARANTINE_PARTS } from '../../shared/appFolders';
import { isCurrentBackupRel } from '../../shared/start';
import { isSafePhonePath } from '../adb/phoneModel';

// ---- Freshness and locks -----------------------------------------------------------------------------------------------

/** Clock differences of a few minutes are tolerated; a "last looked" time further ahead than that is not trusted. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** True when the place was looked at within the last 24 hours (never looked, or a time from the future, is not fresh). */
export function isFresh(lastLookedAt: number | null, now: number): boolean {
  if (lastLookedAt === null || !Number.isFinite(lastLookedAt)) return false;
  if (lastLookedAt > now + CLOCK_SKEW_MS) return false;
  return now - lastLookedAt <= FRESH_MS;
}

export interface LockRow {
  placeId: string;
  relPath: string;
  expiresAt: number;
}

const lockKey = (placeId: string, relPath: string): string => `${placeId}\u0000${relPath.toLowerCase()}`;

/** A copy is locked while a lock on it has not expired (paths compare without regard to case, the safe side on Windows). */
export function isLocked(locks: readonly LockRow[], placeId: string, relPath: string, now: number): boolean {
  const key = lockKey(placeId, relPath);
  return locks.some((l) => l.expiresAt > now && lockKey(l.placeId, l.relPath) === key);
}

/** When a lock made now ends: 30 days. */
export const lockExpiry = (now: number): number => now + LOCK_MS;

// ---- The SAFE rule ----------------------------------------------------------------------------------------------------

/** What the catalog knows about one file in one place. */
export interface CatalogRow {
  placeId: string;
  placeKind: string;
  placeLabel: string;
  relPath: string;
  size: number | null;
  sha256: string | null;
  md5: string | null;
  cloudOnly: boolean;
  goneAt: number | null;
  mtime: number | null;
  /** Phone backup rule: the place of the backup this copy stands for. */
  destinationId?: number;
}

export type Judgement =
  | { verdict: 'safe'; reason: string; vouchers: CatalogRow[] }
  | { verdict: 'waiting'; reason: string; vouchers: CatalogRow[] }
  | { verdict: 'stale'; reason: string; vouchers: CatalogRow[]; stalePlaceIds: string[] }
  | { verdict: 'none'; reason: string; vouchers: CatalogRow[] };

/** A verified copy in a laptop folder, as main found it by hashing (path is absolute). */
export interface FolderCopy {
  path: string;
  size: number;
  sha256: string;
}

/**
 * The Phone backup rule. A phone file is SAFE only when EVERY enabled place of the Phone backup holds a verified copy of the same
 * content: a drive (a live row with the same SHA-256 and size, drive plugged in and looked at in 24 h), a Google group (a live row
 * on one of its accounts with the MD5 and size of a SHA-256-matched copy, looked at in 24 h) and a laptop folder (a file found and
 * hashed by main: `folderCopies`). A place with no copy makes the file "waiting"; a copy that needs a fresh look makes it "stale".
 */
export function judgeForDestinations(file: { sha256: string; size: number }, pool: readonly CatalogRow[], dests: readonly CleanDestination[], ctx: JudgeContext, folderCopies: ReadonlyMap<number, FolderCopy | null>): Judgement {
  if (file.sha256.length !== 64 || file.size <= 0) return { verdict: 'none', reason: 'The phone did not give a usable checksum.', vouchers: [] };
  if (dests.length === 0) return { verdict: 'none', reason: 'This backup has no place to copy to yet. Choose where it copies to first.', vouchers: [] };
  const sameSha = pool.filter((r) => live(r) && r.sha256 === file.sha256 && r.size === file.size);
  const anchorMd5 = new Set(sameSha.map((r) => r.md5).filter((m): m is string => m !== null));
  const vouchers: CatalogRow[] = [];
  const missing: string[] = [];
  const stale = new Set<string>();
  let anyCopy = false;
  for (const d of dests) {
    if (d.kind === 'drive') {
      const rows = sameSha.filter((r) => r.placeKind === 'drive' && r.placeId === d.placeId && (d.backupsLayout !== true || isCurrentBackupRel(r.relPath))).toSorted(byPlace);
      if (rows.length === 0 || d.placeId === null) {
        missing.push(d.label);
        continue;
      }
      anyCopy = true;
      if (!ctx.drivePluggedIn(d.placeId) || !ctx.fresh(d.placeId)) stale.add(d.placeId);
      else vouchers.push({ ...rows[0]!, destinationId: d.id });
    } else if (d.kind === 'google') {
      const rows = pool
        .filter((r) => live(r) && r.placeKind === 'gdrive' && d.accounts.includes(r.placeId) && r.size === file.size && r.md5 !== null && anchorMd5.has(r.md5) && (r.sha256 === null || r.sha256 === file.sha256))
        .toSorted(byPlace);
      if (rows.length === 0) {
        missing.push(d.label);
        continue;
      }
      anyCopy = true;
      const fresh = rows.find((r) => ctx.fresh(r.placeId));
      if (fresh) vouchers.push({ ...fresh, destinationId: d.id });
      else for (const r of rows) stale.add(r.placeId);
    } else {
      const found = folderCopies.get(d.id);
      if (!found || found.size !== file.size || found.sha256 !== file.sha256) {
        missing.push(d.label);
        continue;
      }
      anyCopy = true;
      vouchers.push({ placeId: `${FOLDER_VOUCHER_PREFIX}${d.id}`, placeKind: FOLDER_VOUCHER_KIND, placeLabel: d.label, relPath: found.path, size: found.size, sha256: found.sha256, md5: null, cloudOnly: false, goneAt: null, mtime: null, destinationId: d.id });
    }
  }
  if (!anyCopy) return { verdict: 'none', reason: 'No place of this backup holds a copy with identical contents.', vouchers: [] };
  if (missing.length > 0) return { verdict: 'waiting', reason: `Waiting for a copy on ${missing.join(' and ')}.`, vouchers };
  if (stale.size > 0) return { verdict: 'stale', reason: 'A place of this backup must be plugged in and checked again first.', vouchers: [], stalePlaceIds: [...stale] };
  return { verdict: 'safe', reason: `Identical copy on ${dests.map((d) => d.label).join(' and ')}.`, vouchers };
}

/** True for the pseudo copy of a laptop folder (not in the catalog: no lock, no catalog re-check, the job hashes the file). */
export const isFolderVoucher = (v: { placeKind: string }): boolean => v.placeKind === FOLDER_VOUCHER_KIND;

/**
 * The same rule, right before a removal: the vouchers must cover EVERY enabled place the Phone backup has NOW (a place added since the
 * plan was made makes the file wait), and every catalog copy must still pass `recheckVoucher`. Laptop folder copies are checked by the job.
 */
export function recheckDestinationVouchers(vouchers: readonly Voucher[], dests: readonly CleanDestination[], lookup: (v: Voucher) => VoucherNow, time: number): Recheck {
  if (dests.length === 0) return { ok: false, reason: 'The Phone backup has no place to copy to.' };
  for (const d of dests) {
    const mine = vouchers.filter((v) => v.destinationId === d.id);
    if (mine.length === 0) return { ok: false, reason: `${d.label} does not hold a verified copy in this list.` };
    if (d.backupsLayout === true && d.kind === 'drive' && !mine.some((v) => isCurrentBackupRel(v.relPath))) return { ok: false, reason: `The copy on ${d.label} is not in the Backups folder.` };
  }
  for (const v of vouchers) {
    if (isFolderVoucher(v)) continue;
    const r = recheckVoucher(v, lookup(v), time);
    if (!r.ok) return r;
  }
  return { ok: true };
}

export interface JudgeContext {
  /** Was this place looked at in the last 24 h? */
  fresh(placeId: string): boolean;
  /** Is this named drive plugged in right now (so a copy can really be put back)? */
  drivePluggedIn(placeId: string): boolean;
}

const live = (r: CatalogRow): boolean => r.goneAt === null && !r.cloudOnly;
const byPlace = (a: CatalogRow, b: CatalogRow): number => a.placeLabel.localeCompare(b.placeLabel) || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);

/**
 * Judges one phone file (its SHA-256 and size, read from the phone) against the catalog rows that could vouch for it.
 * SAFE needs a live copy on a named drive with the SAME SHA-256 and size, that is plugged in and looked at in the last
 * 24 h, AND a live cloud copy (OneDrive: same SHA-256; Google Drive: same MD5 and size as that drive copy), also looked at
 * in the last 24 h. A cloud copy that is only a OneDrive placeholder (not on this PC) never counts.
 */
export function judgePhoneFile(file: { sha256: string; size: number }, pool: readonly CatalogRow[], ctx: JudgeContext): Judgement {
  if (file.sha256.length !== 64 || file.size <= 0) return { verdict: 'none', reason: 'The phone did not give a usable checksum.', vouchers: [] };
  const drives = pool.filter((r) => r.placeKind === 'drive' && live(r) && r.sha256 === file.sha256 && r.size === file.size).toSorted(byPlace);
  if (drives.length === 0) return { verdict: 'none', reason: 'No copy with identical contents is on a backup drive.', vouchers: [] };

  const stale = new Set<string>();
  const usableDrives = drives.filter((d) => {
    if (!ctx.drivePluggedIn(d.placeId)) {
      stale.add(d.placeId);
      return false;
    }
    if (!ctx.fresh(d.placeId)) {
      stale.add(d.placeId);
      return false;
    }
    return true;
  });
  if (usableDrives.length === 0) return { verdict: 'stale', reason: 'The backup drive must be plugged in and checked again first.', vouchers: [], stalePlaceIds: [...stale] };

  let anyCloud = false;
  for (const drive of usableDrives) {
    const clouds = pool
      .filter((r) => {
        if (!live(r) || r.placeId === drive.placeId) return false;
        if (r.placeKind === 'onedrive') return r.sha256 === file.sha256 && r.size === file.size;
        if (r.placeKind === 'gdrive') return drive.md5 !== null && r.md5 === drive.md5 && r.size === drive.size && (r.sha256 === null || r.sha256 === file.sha256);
        return false;
      })
      .toSorted(byPlace);
    if (clouds.length > 0) anyCloud = true;
    const fresh = clouds.find((c) => ctx.fresh(c.placeId));
    if (fresh) return { verdict: 'safe', reason: `Identical copy on ${drive.placeLabel} and in ${fresh.placeLabel}.`, vouchers: [drive, fresh] };
    for (const c of clouds) stale.add(c.placeId);
  }
  if (anyCloud) return { verdict: 'stale', reason: 'The cloud copy must be checked again first (refresh the account).', vouchers: [], stalePlaceIds: [...stale] };
  return { verdict: 'waiting', reason: 'Waiting for a cloud copy.', vouchers: [usableDrives[0]!] };
}

export function toVoucher(r: CatalogRow): Voucher {
  return { placeId: r.placeId, placeLabel: r.placeLabel, placeKind: r.placeKind, relPath: r.relPath, size: r.size ?? 0, sha256: r.sha256, md5: r.md5, ...(r.destinationId === undefined ? {} : { destinationId: r.destinationId }) };
}

// ---- The re-check right before a removal -------------------------------------------------------------------------------

/** What is true NOW for one vouching copy (read fresh from the catalog and the disk just before the removal). */
export interface VoucherNow {
  row: CatalogRow | null;
  lastLookedAt: number | null;
  /** The size of the file on disk for a plugged-in drive copy, null when it is not there; undefined = not checked (cloud). */
  onDiskSize?: number | null;
}

export type Recheck = { ok: true } | { ok: false; reason: string };

/** One vouching copy: still there, same size and fingerprints, place looked at in the last 24 h, file really on the drive. */
export function recheckVoucher(expected: Voucher, now: VoucherNow, time: number): Recheck {
  const where = expected.placeLabel;
  if (!now.row) return { ok: false, reason: `The copy on ${where} is not in Backup Hub's list any more.` };
  const row = now.row;
  if (row.goneAt !== null) return { ok: false, reason: `The copy on ${where} is marked as gone.` };
  if (row.cloudOnly) return { ok: false, reason: `The copy on ${where} is only in the cloud, not on this PC.` };
  if (row.size !== expected.size) return { ok: false, reason: `The copy on ${where} changed size.` };
  if (expected.sha256 !== null && row.sha256 !== expected.sha256) return { ok: false, reason: `The checksum of the copy on ${where} changed.` };
  if (expected.md5 !== null && row.md5 !== expected.md5) return { ok: false, reason: `The MD5 of the copy on ${where} changed.` };
  if (!isFresh(now.lastLookedAt, time)) return { ok: false, reason: `${where} was not checked in the last 24 hours. Check it first.` };
  if (now.onDiskSize !== undefined && now.onDiskSize !== expected.size) return { ok: false, reason: `The copy on ${where} is not on the drive (or has another size).` };
  return { ok: true };
}

/**
 * The whole vouching set must still hold: at least one named-drive copy and at least one cloud copy, every one passing
 * `recheckVoucher`. Any failure means the file is skipped.
 */
export function recheckVouchers(vouchers: readonly Voucher[], lookup: (v: Voucher) => VoucherNow, time: number): Recheck {
  if (!vouchers.some((v) => v.placeKind === 'drive')) return { ok: false, reason: 'No copy on a backup drive vouches for this file.' };
  if (!vouchers.some((v) => v.placeKind === 'gdrive' || v.placeKind === 'onedrive')) return { ok: false, reason: 'No cloud copy vouches for this file.' };
  for (const v of vouchers) {
    const r = recheckVoucher(v, lookup(v), time);
    if (!r.ok) return r;
  }
  return { ok: true };
}

// ---- Phone paths and selection --------------------------------------------------------------------------------------

/** A file path Backup Hub may ever pass to `rm` or `push` on the phone: safe, below a folder of /sdcard, a real file name. */
export function isRemovablePhonePath(p: unknown): p is string {
  if (!isSafePhonePath(p)) return false;
  const parts = p.split('/').filter((s) => s !== '');
  return parts.length >= 3 && !p.endsWith('/');
}

/** "2026-03" (UTC) from seconds since 1970; "unknown" for 0 or nonsense. */
export function monthOf(mtimeSec: number): string {
  if (!Number.isFinite(mtimeSec) || mtimeSec <= 0) return 'unknown';
  return new Date(mtimeSec * 1000).toISOString().slice(0, 7);
}

export function sumBucket(items: readonly { size: number }[]): Bucket {
  return { files: items.length, bytes: items.reduce((s, f) => s + f.size, 0) };
}

export type Selection<T> = { ok: true; items: T[]; bytes: number } | { ok: false; message: string };

const NOTHING = 'Nothing was removed.';

/** The ticked files of a phone plan: only SAFE rows of the plan, no repeats, and the count and size must be what the person confirmed. */
export function selectPhoneFiles(plan: Pick<PhoneCleanPlan, 'files'>, indexes: unknown, expectCount: unknown, expectBytes: unknown): Selection<PhoneCleanFile> {
  if (!Array.isArray(indexes) || indexes.length === 0) return { ok: false, message: `Tick at least one file. ${NOTHING}` };
  if (indexes.length > 20_000 || indexes.some((i) => !Number.isInteger(i))) return { ok: false, message: `The ticked list is not valid. ${NOTHING}` };
  const byIndex = new Map(plan.files.map((f) => [f.index, f]));
  const items: PhoneCleanFile[] = [];
  const seen = new Set<number>();
  for (const i of indexes as number[]) {
    if (seen.has(i)) continue;
    seen.add(i);
    const f = byIndex.get(i);
    if (!f) return { ok: false, message: `A ticked file is not in the plan. Make a new plan. ${NOTHING}` };
    if (f.verdict !== 'safe' || f.sha256 === null || f.vouchers.length < 1) return { ok: false, message: `"${f.name}" is not safe to remove (${f.reason}). ${NOTHING}` };
    if (!isRemovablePhonePath(f.path)) return { ok: false, message: `"${f.name}" has a path Backup Hub will not use. ${NOTHING}` };
    items.push(f);
  }
  const bytes = items.reduce((s, f) => s + f.size, 0);
  if (expectCount !== items.length || expectBytes !== bytes) return { ok: false, message: `What is ticked is not what was confirmed. Look at the list again. ${NOTHING}` };
  return { ok: true, items, bytes };
}

export const planIsStale = (createdAt: number, now: number): boolean => now - createdAt > CLEAN_PLAN_LIFETIME_MS;

// ---- Laptop duplicates --------------------------------------------------------------------------------------------------

/** Forward slashes, no trailing slash. The drive letter stays. */
export function normalizeAbs(p: string): string {
  return p.replaceAll('\\', '/').replace(/\/+$/, '');
}

const PROTECTED_SEGMENTS = new Map<string, string>([
  ['backuphub', 'It is in a Backup Hub folder (archive, backups or data).'],
  [LEGACY_QUARANTINE_FOLDER.toLowerCase(), 'It is already in the quarantine.'],
  [LEGACY_CARD_FOLDER.toLowerCase(), 'It is a Backup Hub drive marker folder.'],
  [APP_FOLDER.toLowerCase(), 'It is in the folder Backup Hub makes on a drive (its backups, own files and quarantine).'],
  ['google-fleet-manager', 'It is in the Google Fleet Manager folder.'],
  ['phonebackup', 'It is in a phone backup folder.'],
  ['mydata', 'It is in a MyData folder (your own backup tree).'],
  ['$recycle.bin', 'It is in the Recycle Bin.'],
  ['system volume information', 'It is a system folder.'],
  ['node_modules', 'It is in a program folder (node_modules).'],
  ['.git', 'It is in a git folder.'],
]);
const PROTECTED_TOP = new Map<string, string>([
  ['windows', 'It is in a Windows system folder.'],
  ['program files', 'It is in a program folder.'],
  ['program files (x86)', 'It is in a program folder.'],
  ['programdata', 'It is in a program data folder.'],
]);

/** Why this laptop path is never touched (a PLAN section 3 protected folder or a system folder), or null. Works on any drive letter. */
export function protectedReason(abs: string): string | null {
  const parts = normalizeAbs(abs).split('/').filter((s) => s !== '');
  if (parts.length === 0) return 'It is a drive root.';
  const first = /^[A-Za-z]:$/.test(parts[0]!) ? 1 : 0;
  const top = parts[first]?.toLowerCase();
  if (top !== undefined && PROTECTED_TOP.has(top)) return PROTECTED_TOP.get(top)!;
  for (const seg of parts.slice(first)) {
    const r = PROTECTED_SEGMENTS.get(seg.toLowerCase());
    if (r !== undefined) return r;
  }
  return null;
}

/** Is the path inside one of the OneDrive folders (given), or in a folder named like a OneDrive sync folder? Moving there would sync a delete. */
export function syncedReason(abs: string, oneDriveRoots: readonly string[]): string | null {
  const p = normalizeAbs(abs).toLowerCase();
  for (const root of oneDriveRoots) {
    const r = normalizeAbs(root).toLowerCase();
    if (r !== '' && (p === r || p.startsWith(`${r}/`))) return 'It is in a OneDrive folder: removing it there would remove it from the cloud too.';
  }
  const parts = p.split('/').filter((s) => s !== '');
  if (parts.some((s) => /^onedrive(\b|$)/.test(s))) return 'It is in a OneDrive folder: removing it there would remove it from the cloud too.';
  return null;
}

export const USER_FOLDERS_WHY = 'It is in your own C: folders (Documents, Desktop, Pictures, Downloads...). Turn on "Also look for duplicates in my C: folders" to include these.';

/** Is the path inside one of the user-folder roots (the Windows profile)? Only given when the setting is off. */
export function userFolderReason(abs: string, roots: readonly string[]): string | null {
  const p = normalizeAbs(abs).toLowerCase();
  for (const root of roots) {
    const r = normalizeAbs(root).toLowerCase();
    if (r !== '' && (p === r || p.startsWith(`${r}/`))) return USER_FOLDERS_WHY;
  }
  return null;
}

export interface MoveContext {
  oneDriveRoots: readonly string[];
  locks: readonly LockRow[];
  laptopPlaceId: string;
  now: number;
  /** Folders of the cloud/drive places that exist on this PC (other places' roots: a drive's letter root). Paths under them are never moved. */
  otherPlaceRoots?: readonly string[];
  /** The user's own folders on this PC (the Windows profile) when duplicates there are switched OFF (the default): nothing below is moved. */
  userFolderRoots?: readonly string[];
}

/** May Backup Hub MOVE this laptop file to the quarantine? (It may always be the one that is kept.) */
export function movability(abs: string, ctx: MoveContext): { ok: true } | { ok: false; why: string } {
  const prot = protectedReason(abs);
  if (prot !== null) return { ok: false, why: prot };
  const synced = syncedReason(abs, ctx.oneDriveRoots);
  if (synced !== null) return { ok: false, why: synced };
  const p = normalizeAbs(abs).toLowerCase();
  for (const root of ctx.otherPlaceRoots ?? []) {
    const r = normalizeAbs(root).toLowerCase();
    if (r !== '' && (p === r || p.startsWith(`${r}/`))) return { ok: false, why: 'It is on a backup drive or another place Backup Hub does not clean.' };
  }
  const inUser = userFolderReason(abs, ctx.userFolderRoots ?? []);
  if (inUser !== null) return { ok: false, why: inUser };
  if (isLocked(ctx.locks, ctx.laptopPlaceId, abs, ctx.now)) return { ok: false, why: 'It is locked: it vouched for a file removed from the phone in the last 30 days.' };
  return { ok: true };
}

export interface KeepCandidate {
  relPath: string;
  mtime: number | null;
  inCollection: boolean;
}

/** Default copy to keep: the one inside a collection, else the oldest (smallest modified time), else the shortest path. */
export function chooseKeeper(members: readonly KeepCandidate[]): string {
  if (members.length === 0) throw new Error('A group needs at least one member.');
  const pool = members.some((m) => m.inCollection) ? members.filter((m) => m.inCollection) : members;
  const order = pool.toSorted((a, b) => {
    const ma = a.mtime ?? Number.MAX_SAFE_INTEGER;
    const mb = b.mtime ?? Number.MAX_SAFE_INTEGER;
    return ma - mb || a.relPath.length - b.relPath.length || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0);
  });
  return order[0]!.relPath;
}

/**
 * Which members move when `keep` is the copy kept. The kept copy never moves, a member that is not removable never moves,
 * and at least one copy always stays (the kept one). Returns an error when `keep` is not a member.
 */
export function removalsFor(members: readonly { relPath: string; removable: boolean }[], keep: string): { ok: true; remove: string[] } | { ok: false; message: string } {
  if (!members.some((m) => m.relPath === keep)) return { ok: false, message: 'The copy to keep is not one of the identical files.' };
  const remove = members.filter((m) => m.relPath !== keep && m.removable).map((m) => m.relPath);
  return { ok: true, remove };
}

/** The ticked duplicate groups: each group must be in the plan, `keep` a member, and the count and size what the person confirmed. */
export function selectDuplicateGroups(
  plan: Pick<LaptopCleanPlan, 'groups'>,
  chosen: unknown,
  expectCount: unknown,
  expectBytes: unknown,
): Selection<{ group: DuplicateGroup; keep: string; remove: string[] }> {
  if (!Array.isArray(chosen) || chosen.length === 0) return { ok: false, message: `Tick at least one group. ${NOTHING}` };
  if (chosen.length > 5000) return { ok: false, message: `The ticked list is not valid. ${NOTHING}` };
  const byId = new Map(plan.groups.map((g) => [g.id, g]));
  const seen = new Set<string>();
  const items: { group: DuplicateGroup; keep: string; remove: string[] }[] = [];
  for (const c of chosen as unknown[]) {
    if (c === null || typeof c !== 'object') return { ok: false, message: `The ticked list is not valid. ${NOTHING}` };
    const { id, keep } = c as { id?: unknown; keep?: unknown };
    if (typeof id !== 'string' || typeof keep !== 'string') return { ok: false, message: `The ticked list is not valid. ${NOTHING}` };
    if (seen.has(id)) continue;
    seen.add(id);
    const group = byId.get(id);
    if (!group) return { ok: false, message: `A ticked group is not in the plan. Make a new plan. ${NOTHING}` };
    const r = removalsFor(group.members, keep);
    if (!r.ok) return { ok: false, message: `${r.message} ${NOTHING}` };
    if (r.remove.length === 0) return { ok: false, message: `Nothing in one ticked group can be moved. ${NOTHING}` };
    items.push({ group, keep, remove: r.remove });
  }
  const count = items.reduce((s, i) => s + i.remove.length, 0);
  const bytes = items.reduce((s, i) => s + i.remove.length * i.group.size, 0);
  if (expectCount !== count || expectBytes !== bytes) return { ok: false, message: `What is ticked is not what was confirmed. Look at the list again. ${NOTHING}` };
  return { ok: true, items, bytes };
}

// ---- Quarantine paths, undo and emptying -------------------------------------------------------------------------------------

/** "2026-11-03" in local time. */
export function quarantineDate(now: number): string {
  const d = new Date(now);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** The quarantine folder of the same drive for a laptop path ("D:/x/y.jpg" gives the quarantine folder inside D:'s app folder; see `shared/appFolders.ts`), or null without a drive letter. */
export function quarantineRootFor(abs: string): string | null {
  const m = /^([A-Za-z]):[\\/]/.exec(abs);
  return m ? path.win32.join(`${m[1]!.toUpperCase()}:\\`, ...QUARANTINE_PARTS) : null;
}

/** The old quarantine folder of the drive `root` is on (files moved there by an earlier version still wait there), or null. */
function legacyQuarantineRootOf(root: string): string | null {
  const m = /^([A-Za-z]):/.exec(root);
  return m ? `${m[1]!.toUpperCase()}:\\${LEGACY_QUARANTINE_FOLDER}` : null;
}

/** Inside the quarantine folder `root`, or inside the old quarantine folder of the same drive. */
function inQuarantine(root: string, p: string): boolean {
  const legacy = legacyQuarantineRootOf(root);
  return isInside(root, p) || (legacy !== null && isInside(legacy, p));
}

/**
 * Where a file waits: `<root>\<date>\<original path without the drive>`. A name that is already taken gets " (2)", " (3)" ...
 * `exists` is asked for each candidate, so an earlier quarantined file is never overwritten.
 */
export function quarantinePathFor(root: string, date: string, abs: string, exists: (p: string) => boolean): string | null {
  const m = /^[A-Za-z]:[\\/](.+)$/.exec(abs);
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parts = m[1]!.split(/[\\/]/);
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return null;
  const file = parts.pop()!;
  const dir = path.win32.join(root, date, ...parts);
  const dot = file.lastIndexOf('.');
  for (let n = 1; n < 1000; n += 1) {
    const name = n === 1 ? file : dot > 0 ? `${file.slice(0, dot)} (${n})${file.slice(dot)}` : `${file} (${n})`;
    const candidate = path.win32.join(dir, name);
    if (!exists(candidate)) return candidate;
  }
  return null;
}

/** Is `child` strictly inside `parent` (Windows rules: case-insensitive, either slash)? */
export function isInside(parent: string, child: string): boolean {
  const p = normalizeAbs(path.win32.normalize(parent)).toLowerCase();
  const c = normalizeAbs(path.win32.normalize(child)).toLowerCase();
  return c.startsWith(`${p}/`) && !c.slice(p.length + 1).split('/').includes('..');
}

/** May the app ASK about emptying a batch moved at `removedAt`? Only after 30 days. */
export function canAskToEmpty(removedAt: number, now: number): boolean {
  return now - removedAt >= QUARANTINE_ASK_MS;
}

export interface QuarantineEntry {
  removedAt: number;
  undoneAt: number | null;
  emptiedAt: number | null;
  quarantinePath: string | null;
  size: number;
}

/** May this logged file be undone (moved back)? Only while it waits in the quarantine. */
export function canUndoEntry(e: QuarantineEntry, root: string | null): boolean {
  return e.undoneAt === null && e.emptiedAt === null && e.quarantinePath !== null && root !== null && inQuarantine(root, e.quarantinePath);
}

/** May this logged file be emptied (deleted for good) now? Only with the person's confirm, after 30 days, inside the quarantine. */
export function canEmptyEntry(e: QuarantineEntry, root: string | null, now: number): { ok: true } | { ok: false; reason: string } {
  if (e.undoneAt !== null) return { ok: false, reason: 'It was put back.' };
  if (e.emptiedAt !== null) return { ok: false, reason: 'It was already emptied.' };
  if (e.quarantinePath === null || root === null || !inQuarantine(root, e.quarantinePath)) return { ok: false, reason: 'It is not inside the quarantine folder.' };
  if (!canAskToEmpty(e.removedAt, now)) return { ok: false, reason: 'It has not waited 30 days yet.' };
  return { ok: true };
}
