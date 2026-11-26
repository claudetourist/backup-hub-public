import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { COPY_TO_LOCAL_JOB_KIND } from '../../shared/localCopy';
import { DRIVE_REFRESH_JOB_KIND } from '../../shared/drive';
import { HASH_FILES_JOB_KIND } from '../../shared/fingerprint';
import { IMPORT_V1_JOB_KIND } from '../../shared/importV1';
import { LIST_PLACE_JOB_KIND, LOOK_AGAIN_JOB_KIND } from '../../shared/listing';
import type { SavedCopiesDrive, SavedCopiesOverview, SavedCopy } from '../../shared/settings';
import { copyDatabase, type Db } from '../db';
import { JobFailure, type JobHandler, type JobServiceLogger } from '../jobs/jobService';
import { dbCopiesFolder } from '../places/appFolders';
import { readDriveCard, type CardRead } from '../places/driveCard';
import type { PlaceService } from '../places/placeService';
import type { SettingsStore } from './settingsStore';
import { buildExport } from './exportImport';
import { assertWritable, protectedDriveFor, protectedDriveMessage, writeFileAtomic } from '../fsutil';
import { ownRemove } from '../danger/ownFiles';

export const KIND_SAVE_SETTINGS = 'settings.saveToDrive';
export const SAVED_FILES_KEPT = 7;
/**
 * A drive that already got a copy this recently is left alone (plugging in twice is not a reason to write twice, and
 * the database copy can be hundreds of MB over USB). Only the Save now button ignores it.
 */
export const MIN_SAVE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, '0');

function stamp(at: Date): string {
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

/** Exact patterns of the files this job owns; pruning never touches anything else in the folder. */
const SETTINGS_FILE = /^backuphub-settings-(\d{8}-\d{6})\.json$/;
const DB_FILE = /^backuphub-db-(\d{8}-\d{6})\.db$/;

export function settingsFileName(at: Date): string {
  return `backuphub-settings-${stamp(at)}.json`;
}

export function dbCopyFileName(at: Date): string {
  return `backuphub-db-${stamp(at)}.db`;
}

export function driveSettingsDir(root: string): string {
  return dbCopiesFolder(root);
}

/** Our files of one kind in `dir`, newest first. */
export function listOwnFiles(dir: string, pattern: RegExp): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && pattern.test(e.name))
    .map((e) => e.name)
    .toSorted()
    .toReversed();
}

/**
 * Keep the newest `keep` of each kind of our files; delete only exact-pattern matches. Returns names removed.
 * Only called when the person switched "remove old copies automatically" on.
 */
export function pruneOwnFiles(dir: string, keep: number = SAVED_FILES_KEPT): string[] {
  assertWritable(dir); // T7 write ban
  const removed: string[] = [];
  for (const pattern of [SETTINGS_FILE, DB_FILE]) {
    for (const name of listOwnFiles(dir, pattern).slice(Math.max(0, keep))) {
      ownRemove(path.join(dir, name));
      removed.push(name);
    }
  }
  return removed;
}

/**
 * True when some connected named drive has no save from the last 6 hours AND something changed since its last save
 * (`isChanged`, by drive folder; without it every drive counts as changed). Used before a job is made, so plugging the
 * drive in again and again (or waking the laptop) does not fill the Jobs list with "already saved" entries.
 */
export function saveIsDue(roots: readonly string[], now: Date, isChanged: (root: string) => boolean = () => true): boolean {
  if (roots.length === 0) return false;
  return roots.some((root) => {
    const recent = newestSavedAt(driveSettingsDir(root));
    if (recent !== null && now.getTime() - recent.getTime() < MIN_SAVE_INTERVAL_MS) return false;
    return recent === null || isChanged(root);
  });
}

// ---- "Did anything change since the last save?" -----------------------------------------------------------------

/** Jobs whose end changes what the database copy holds (the file lists, fingerprints, Drive numbers). */
const DATA_JOB_KINDS = [LIST_PLACE_JOB_KIND, LOOK_AGAIN_JOB_KIND, HASH_FILES_JOB_KIND, DRIVE_REFRESH_JOB_KIND, IMPORT_V1_JOB_KIND, COPY_TO_LOCAL_JOB_KIND];
const MARKER_KEY_PREFIX = 'saveToDrive.marker.';

/**
 * A cheap fingerprint of "what a save would contain": the settings, profiles, places (with their stored details),
 * collections and their folders (all small tables), the newest file row id, and how many jobs that change the file
 * lists have finished and when the last one did. There is no per-row "updated" column, and `PRAGMA data_version` does not
 * survive a restart, so changes in the middle of a long job (for example a fingerprint run) are noticed when the job
 * ends, not before. Reads only; the large `files` table is touched by one `max(id)` lookup.
 */
export function changeMarker(db: Db, settings: SettingsStore): string {
  const kinds = DATA_JOB_KINDS.map(() => '?').join(',');
  const parts = [
    JSON.stringify(settings.get()),
    JSON.stringify(db.prepare('SELECT id, name, color FROM profiles ORDER BY id').all()),
    JSON.stringify(db.prepare('SELECT id, profile_id, kind, label, identity_json, root_hint FROM places ORDER BY id').all()),
    JSON.stringify(db.prepare('SELECT id, profile_id, name, tier, rules_json FROM collections ORDER BY id').all()),
    JSON.stringify(db.prepare('SELECT collection_id, place_id, rel_path FROM collection_roots ORDER BY collection_id, place_id, rel_path').all()),
    JSON.stringify(db.prepare('SELECT max(id) AS newest FROM files').get()),
    JSON.stringify(db.prepare(`SELECT kind, count(*) AS n, max(finished_at) AS last FROM jobs WHERE finished_at IS NOT NULL AND kind IN (${kinds}) GROUP BY kind ORDER BY kind`).all(...DATA_JOB_KINDS)),
  ];
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** The marker taken when this drive was last saved to, or null. */
export function savedMarker(db: Db, placeId: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`${MARKER_KEY_PREFIX}${placeId}`) as { value: string } | undefined;
  return row?.value ?? null;
}

function rememberMarker(db: Db, placeId: string, marker: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`${MARKER_KEY_PREFIX}${placeId}`, marker);
}

/** When our newest settings file in `dir` was written (from its name), or null. */
export function newestSavedAt(dir: string): Date | null {
  const newest = listOwnFiles(dir, SETTINGS_FILE)[0];
  const m = newest ? SETTINGS_FILE.exec(newest) : null;
  if (!m) return null;
  return stampToDate(m[1]!);
}

/** Our files of one kind in `dir` with the time in their name and their size, newest first. Read only. */
async function describeCopies(dir: string, pattern: RegExp, kind: SavedCopy['kind']): Promise<SavedCopy[]> {
  const out: SavedCopy[] = [];
  for (const name of listOwnFiles(dir, pattern)) {
    const m = pattern.exec(name);
    if (!m) continue;
    let bytes = 0;
    try {
      bytes = (await fs.promises.stat(path.join(dir, name))).size;
    } catch {
      // Gone or unreadable meanwhile: listed with size 0.
    }
    out.push({ name, kind, savedAt: stampToDate(m[1]!).getTime(), bytes });
  }
  return out;
}

function stampToDate(s: string): Date {
  return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
}

/**
 * Read only: the saved copies (settings files and database copies) on each given connected named drive, newest first,
 * and how many are older than the newest `keep` of their kind. Exact-name matches only; nothing is changed.
 */
export async function listSavedCopies(drives: readonly { placeId: string; label: string; root: string }[], keep: number): Promise<SavedCopiesOverview> {
  const out: SavedCopiesDrive[] = [];
  for (const drive of drives) {
    const dir = driveSettingsDir(drive.root);
    const settingsCopies = await describeCopies(dir, SETTINGS_FILE, 'settings');
    const dbCopies = await describeCopies(dir, DB_FILE, 'database');
    const exceeding = Math.max(0, settingsCopies.length - keep) + Math.max(0, dbCopies.length - keep);
    out.push({
      placeId: drive.placeId,
      label: drive.label,
      copies: [...settingsCopies, ...dbCopies].toSorted((a, b) => b.savedAt - a.savedAt || a.kind.localeCompare(b.kind)),
      exceeding,
    });
  }
  return { keep, drives: out };
}

export interface SaveResult {
  dir: string;
  written: string[];
  pruned: string[];
}

/** What happens to older copies after a save. Nothing is removed unless `autoRemove` is true. */
export interface PrunePolicy {
  autoRemove: boolean;
  keep: number;
}

/**
 * Write one settings file and one database copy into the drive's database safety copies folder (see `appFolders.ts`); then, only if the person switched on
 * automatic removal, prune our own old files (the newest `keep` of each kind stay). Both files are written under a
 * temporary name and renamed. The database copy goes in small steps (`copyDatabase`), so the app stays responsive while
 * it is written over USB.
 */
export async function saveToDriveRoot(
  db: Db,
  settings: SettingsStore,
  appVersion: string,
  root: string,
  now: Date,
  policy: PrunePolicy = { autoRemove: false, keep: SAVED_FILES_KEPT },
): Promise<SaveResult> {
  const dir = driveSettingsDir(root);
  assertWritable(dir); // T7 write ban: before the folder, the settings file or the database copy is created
  fs.mkdirSync(dir, { recursive: true });
  const settingsName = settingsFileName(now);
  const dbName = dbCopyFileName(now);
  writeFileAtomic(path.join(dir, settingsName), `${JSON.stringify(buildExport(db, settings, appVersion, now), null, 2)}\n`);
  await copyDatabase(db, path.join(dir, dbName));
  return { dir, written: [settingsName, dbName], pruned: policy.autoRemove ? pruneOwnFiles(dir, policy.keep) : [] };
}

export interface SaveJobDeps {
  db: Db;
  settings: SettingsStore;
  places: PlaceService;
  appVersion: string;
  log: JobServiceLogger;
  now?: () => Date;
  /** Injectable for tests. */
  readCard?: (root: string) => Promise<CardRead>;
}

/**
 * Job `settings.saveToDrive` (light): for every NAMED drive that is connected, re-check that the
 * card on it still matches, then save settings and a database copy to its database safety copies
 * folder. Does nothing when the setting is off or no named drive is connected. A drive is saved to at most once every 6
 * hours, and only when something changed since its last save (`changeMarker`). `params.force` skips both shortcuts
 * (the Save now button). Old copies are removed only when `autoRemoveOldCopies` is on.
 */
export function saveToDriveHandler(deps: SaveJobDeps): JobHandler {
  const readCard = deps.readCard ?? ((root: string) => readDriveCard(root));
  const nowFn = deps.now ?? (() => new Date());
  return {
    kind: KIND_SAVE_SETTINGS,
    heavy: false,
    async run(ctx) {
      const force = (ctx.params as { force?: unknown } | null)?.force === true;
      if (!force && !deps.settings.get().snapshotToDrive) return 'Saving settings to a drive is switched off';
      // A plan saves to one chosen drive (`placeIds`); without it every connected named drive is saved to.
      const only = (ctx.params as { placeIds?: unknown } | null)?.placeIds;
      const drives = deps.places.connectedDrives().filter((d) => !Array.isArray(only) || only.includes(d.place.id));
      if (drives.length === 0) return 'No named backup drive is connected, so nothing was saved';
      let saved = 0;
      let failed = 0;
      /** Drives skipped because the card on them is not the named drive: the safety check working, not a failure. */
      const notNamed: string[] = [];
      let protectedName: string | null = null;
      for (const [index, drive] of drives.entries()) {
        await ctx.yield();
        ctx.progress(index, drives.length, { message: `Saving to ${drive.place.label}` });
        const names = new Set(deps.settings.get().writeProtectedDrives.map((n) => n.toLowerCase()));
        const guarded = names.has(drive.place.label.toLowerCase()) || names.has(drive.place.id.toLowerCase()) ? drive.place.label : protectedDriveFor(drive.root);
        if (guarded !== null) {
          protectedName = guarded;
          ctx.log('info', protectedDriveMessage(guarded));
          continue;
        }
        const card = await readCard(drive.root);
        if (card.status !== 'ok' || card.card.id !== drive.place.id) {
          ctx.warn(`Skipped ${drive.place.label}: the drive in ${drive.place.rootHint ?? 'that letter'} is not the named ${drive.place.label} any more, so nothing was written`);
          notNamed.push(drive.place.label);
          continue;
        }
        const recent = newestSavedAt(driveSettingsDir(drive.root));
        if (!force && recent && nowFn().getTime() - recent.getTime() < MIN_SAVE_INTERVAL_MS) {
          ctx.log('info', `${drive.place.label}: already saved within the last 6 hours, skipped`);
          continue;
        }
        // Taken before the copy starts, so anything that changes while it is written counts as a change next time.
        const marker = changeMarker(deps.db, deps.settings);
        if (!force && recent && savedMarker(deps.db, drive.place.id) === marker) {
          ctx.log('info', `${drive.place.label}: nothing has changed since the last copy, skipped`);
          continue;
        }
        try {
          const current = deps.settings.get();
          const result = await saveToDriveRoot(deps.db, deps.settings, deps.appVersion, drive.root, nowFn(), { autoRemove: current.autoRemoveOldCopies, keep: current.savedCopiesKeep });
          rememberMarker(deps.db, drive.place.id, marker);
          ctx.log('info', `${drive.place.label}: wrote ${result.written.join(', ')}${current.autoRemoveOldCopies ? `; removed ${result.pruned.length} old file(s)` : '; no old copies were removed'}`);
          saved += 1;
        } catch (err) {
          deps.log.warn(`settings.saveToDrive: ${drive.place.label} failed`, err);
          ctx.warn(`${drive.place.label}: could not write to the drive (it may be full or write-protected)`);
          failed += 1;
        }
      }
      ctx.progress(drives.length, drives.length);
      if (saved === 0 && failed > 0) {
        throw new JobFailure('Settings could not be saved to any connected drive. Nothing on the drives was changed.');
      }
      if (saved === 0 && failed === 0 && protectedName !== null) return protectedDriveMessage(protectedName);
      // Nothing was written because the wrong drive sat in that letter: done with a warning (already recorded above), not failed.
      if (saved === 0 && failed === 0 && notNamed.length > 0) return `Skipped ${notNamed.join(', ')}: not the named drive, nothing was written`;
      return saved > 0 ? `Saved settings and a database copy to ${saved} ${saved === 1 ? 'drive' : 'drives'}` : 'Every connected drive already has a recent copy, or nothing has changed since its last one';
    },
  };
}
