/**
 * What the person can do with the saved copies on a backup drive, from Settings:
 *  - "Remove old copies": deletes only our own exact-pattern files that are older than the newest `keep` of their kind,
 *    and only after the person confirmed in the window (the rule: always ask before deleting).
 *  - "Test restore": proves a database copy is usable WITHOUT touching the drive: the copy is read once into a scratch folder,
 *    checked on a worker thread (`quick_check`), opened read-only to count what it holds, and the scratch folder is removed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SavedCopyActionResult, TestRestoreResult } from '../../shared/settings';
import { assertWritable, protectedDriveFor, protectedDriveMessage } from '../fsutil';
import { openReadOnly } from '../query/queryCore';
import type { QuickCheckResult } from '../query/queryTypes';
import { driveSettingsDir, listOwnFiles, pruneOwnFiles } from './saveToDrive';
import { ownRemove } from '../danger/ownFiles';

const DB_COPY = /^backuphub-db-\d{8}-\d{6}\.db$/;
const SETTINGS_COPY = /^backuphub-settings-\d{8}-\d{6}\.json$/;

export interface SavedCopyActionDeps {
  /** Named drives that are plugged in right now. */
  drives(): { placeId: string; label: string; root: string }[];
  keep(): number;
  /** The plain "read-only (protected)" line for a drive that must not be written to, else null. */
  writeProtected?(placeId: string): string | null;
  /** The integrity check on a worker (the quick one); null when the worker could not run. */
  checkInWorker(file: string): Promise<QuickCheckResult | null>;
  /** Free bytes in the folder for scratch files, or null when unknown. */
  freeBytes(dir: string): number | null;
  /** Folder for the scratch copy (the system temp folder). */
  scratchRoot?: string;
  log?: { info(...args: unknown[]): void };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Removes our own old copies on one connected drive. Needs `confirmed` true. */
export function removeOldCopies(deps: SavedCopyActionDeps, placeId: unknown, confirmed: unknown): SavedCopyActionResult {
  if (confirmed !== true) return { ok: false, message: 'Please confirm first. Nothing was removed.' };
  const drive = typeof placeId === 'string' ? deps.drives().find((d) => d.placeId === placeId) : undefined;
  if (!drive) return { ok: false, message: 'That drive is not plugged in. Nothing was removed.' };
  const line = deps.writeProtected?.(drive.placeId) ?? null;
  if (line !== null) return { ok: false, message: `${line} Nothing was removed.` };
  const guarded = protectedDriveFor(driveSettingsDir(drive.root));
  if (guarded !== null) return { ok: false, message: `${protectedDriveMessage(guarded)} Nothing was removed.` };
  const removed = pruneOwnFiles(driveSettingsDir(drive.root), deps.keep());
  deps.log?.info(`savedCopies: removed ${removed.length} old file(s) on ${drive.label}: ${removed.join(', ')}`);
  return { ok: true, message: removed.length === 0 ? 'There was nothing older to remove.' : `Removed ${plural(removed.length, 'old copy', 'old copies')} from ${drive.label}. The newest ${deps.keep()} of each kind were kept.` };
}

/** Proves a saved database copy opens and holds the data. Nothing on the drive is changed. */
export async function testSavedCopy(deps: SavedCopyActionDeps, placeId: unknown, name: unknown): Promise<TestRestoreResult> {
  const drive = typeof placeId === 'string' ? deps.drives().find((d) => d.placeId === placeId) : undefined;
  if (!drive) return { ok: false, message: 'That drive is not plugged in. Plug it in and try again.', details: null };
  if (typeof name !== 'string' || !(DB_COPY.test(name) || SETTINGS_COPY.test(name))) return { ok: false, message: 'That is not one of the copies Backup Hub saves.', details: null };
  const dir = driveSettingsDir(drive.root);
  if (!listOwnFiles(dir, DB_COPY.test(name) ? DB_COPY : SETTINGS_COPY).includes(name)) return { ok: false, message: 'That copy is not on the drive any more.', details: null };
  const file = path.join(dir, name);

  if (SETTINGS_COPY.test(name)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ok = parsed !== null && typeof parsed === 'object';
      return { ok, message: ok ? 'This settings file reads fine.' : 'This settings file is not valid.', details: null };
    } catch {
      return { ok: false, message: 'This settings file could not be read or is damaged.', details: null };
    }
  }

  const size = fs.statSync(file).size;
  const root = deps.scratchRoot ?? os.tmpdir();
  const free = deps.freeBytes(root);
  if (free !== null && free < size * 1.2 + 100_000_000) {
    return { ok: false, message: `There is not enough free space for a test (needs about ${Math.ceil((size * 1.2) / 1e6).toLocaleString('en-US')} MB). Nothing was changed.`, details: null };
  }
  assertWritable(path.join(root, 'scratch'));
  const scratch = fs.mkdtempSync(path.join(root, 'backuphub-restore-test-'));
  try {
    const copy = path.join(scratch, 'copy.db');
    assertWritable(copy); // the scratch copy is local; the drive itself is only read
    await fs.promises.copyFile(file, copy);
    const check = await deps.checkInWorker(copy);
    if (check === null) return { ok: false, message: 'The check could not run. Nothing was changed.', details: null };
    if (!check.ok) return { ok: false, message: `This copy is damaged: ${check.messages.slice(0, 2).join('; ')}. Keep an older one.`, details: null };
    const db = openReadOnly(copy);
    try {
      const count = (table: string): number => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      const details = {
        profiles: count('profiles'),
        places: count('places'),
        collections: count('collections'),
        // The newest row id is cheap to read and tells roughly how many files the list holds.
        files: ((db.prepare('SELECT max(id) AS n FROM files').get() as { n: number | null }).n ?? 0),
      };
      deps.log?.info(`savedCopies: test restore of ${name} ok`, JSON.stringify(details));
      return {
        ok: true,
        message: `This copy opens and passes the check. It holds ${plural(details.profiles, 'profile')}, ${plural(details.places, 'place')}, ${plural(details.collections, 'collection')} and about ${details.files.toLocaleString('en-US')} files.`,
        details,
      };
    } finally {
      db.close();
    }
  } finally {
    ownRemove(scratch, { recursive: true });
  }
}
