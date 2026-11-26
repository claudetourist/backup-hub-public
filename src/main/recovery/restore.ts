/**
 * "Restore Backup Hub": check a saved copy and STAGE it; the swap happens at the next start (src/main/db/restore.ts), with the
 * database in use moved aside, never deleted. Sources: a database copy on a plugged-in backup drive, or a file the person chose
 * (a plain database copy, or a recovery file downloaded from Google Drive, which needs the recovery passphrase).
 *
 * Nothing is read from the network here (Backup Hub cannot download from Drive; the person downloads the recovery file in a
 * browser). Every source is only read. The staged file is checked (`quick_check` on a worker, schema version, tables) before it
 * counts as staged.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RestoreResult } from '../../shared/settings';
import { MIGRATIONS } from '../db/migrations';
import { assertWritable } from '../fsutil';
import { PENDING_DB, PENDING_INFO, restoreDir, type PendingRestore } from '../db/restore';
import { openReadOnly } from '../query/queryCore';
import type { QuickCheckResult } from '../query/queryTypes';
import { driveSettingsDir, listOwnFiles } from '../settings/saveToDrive';
import type { VaultService } from '../vault/vaultService';
import { openRecoveryFile, readRecoveryHeader, RECOVERY_MAGIC, RecoveryFileError } from './recoveryFile';
import { ownMove, ownRemove } from '../danger/ownFiles';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
const DB_COPY = /^backuphub-db-\d{8}-\d{6}\.db$/;

export interface RestoreDeps {
  dataDir: string;
  vault: Pick<VaultService, 'keyFromRecord'>;
  /** Named drives that are plugged in right now. */
  drives(): { placeId: string; label: string; root: string }[];
  checkInWorker(file: string): Promise<QuickCheckResult | null>;
  freeBytes(dir: string): number | null;
  now?: () => number;
  log?: { info(...args: unknown[]): void };
}

export type FileKind = 'database' | 'recovery' | 'unknown';

/** What a file is, from its first bytes (never from its name). */
export function sniffFile(file: string): FileKind {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(16);
      const n = fs.readSync(fd, head, 0, 16, 0);
      if (n >= SQLITE_MAGIC.length && head.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) return 'database';
      if (n >= RECOVERY_MAGIC.length && head.subarray(0, RECOVERY_MAGIC.length).equals(RECOVERY_MAGIC)) return 'recovery';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Unreadable: unknown.
  }
  return 'unknown';
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const fail = (message: string, extra: Partial<RestoreResult> = {}): RestoreResult => ({ ok: false, message, ...extra });

/** Restore from a database copy saved on a plugged-in drive. `confirmed` must be true (the window asked first). */
export async function restoreFromSavedCopy(deps: RestoreDeps, placeId: unknown, name: unknown, confirmed: unknown): Promise<RestoreResult> {
  if (confirmed !== true) return fail('Please confirm first. Nothing was changed.');
  const drive = typeof placeId === 'string' ? deps.drives().find((d) => d.placeId === placeId) : undefined;
  if (!drive) return fail('That drive is not plugged in. Plug it in and try again. Nothing was changed.');
  if (typeof name !== 'string' || !DB_COPY.test(name)) return fail('That is not one of the database copies Backup Hub saves. Nothing was changed.');
  const dir = driveSettingsDir(drive.root);
  if (!listOwnFiles(dir, DB_COPY).includes(name)) return fail('That copy is not on the drive any more. Nothing was changed.');
  return stage(deps, path.join(dir, name), `${drive.label}: ${name}`, null);
}

/** Restore from a file the person chose. A recovery file needs the recovery passphrase. */
export async function restoreFromChosenFile(deps: RestoreDeps, file: string | null, passphrase: unknown, confirmed: unknown): Promise<RestoreResult> {
  if (confirmed !== true) return fail('Please confirm first. Nothing was changed.');
  if (file === null) return fail('Choose a file first. Nothing was changed.');
  const kind = sniffFile(file);
  if (kind === 'unknown') return fail('That file is not a Backup Hub database copy or recovery file. Nothing was changed.');
  if (kind === 'recovery' && (typeof passphrase !== 'string' || passphrase.length === 0)) return fail('This is a recovery file. Type your recovery passphrase to open it.', { needsPassphrase: true });
  return stage(deps, file, path.basename(file), typeof passphrase === 'string' ? passphrase : null);
}

async function stage(deps: RestoreDeps, source: string, label: string, passphrase: string | null): Promise<RestoreResult> {
  const dir = restoreDir(deps.dataDir);
  const part = path.join(dir, `${PENDING_DB}.part`);
  try {
    assertWritable(part); // T7 write ban: the staging folder is in the data folder, normally on the laptop
  } catch (err) {
    return fail(`${(err as Error).message} Nothing was changed.`);
  }
  const kind = sniffFile(source);
  const size = fs.statSync(source).size;
  fs.mkdirSync(dir, { recursive: true });
  // The copy, plus room for the swap's second file: a recovery file expands (the database is compressed in it).
  const need = (kind === 'recovery' ? size * 6 : size) * 1.1 + 100_000_000;
  const free = deps.freeBytes(deps.dataDir);
  if (free !== null && free < need) return fail(`There is not enough free space here to check the copy (needs about ${Math.ceil(need / 1e6).toLocaleString('en-US')} MB). Nothing was changed.`);
  ownRemove(part);
  try {
    if (kind === 'recovery') {
      let header;
      try {
        header = (await readRecoveryHeader(source)).header;
      } catch (err) {
        return fail(err instanceof RecoveryFileError ? `${err.message} Nothing was changed.` : 'That file could not be read. Nothing was changed.');
      }
      let key: Buffer | null = null;
      try {
        key = await deps.vault.keyFromRecord(header.vault, passphrase);
      } catch {
        key = null;
      }
      if (!key) return fail('That is not the right recovery passphrase for this file. Nothing was changed.', { needsPassphrase: true });
      try {
        if (!(await openRecoveryFile(source, part, key))) return fail('This recovery file is damaged or was changed, so it cannot be opened. Nothing was changed.');
      } finally {
        key.fill(0);
      }
    } else {
      await fs.promises.copyFile(source, part, fs.constants.COPYFILE_EXCL);
    }
    const check = await deps.checkInWorker(part);
    if (check === null) return fail('The check could not run. Nothing was changed.');
    if (!check.ok) return fail(`This copy is damaged: ${check.messages.slice(0, 2).join('; ')}. Pick another one. Nothing was changed.`);
    const summary = inspect(part);
    if (typeof summary === 'string') return fail(`${summary} Nothing was changed.`);
    // Opening a WAL-mode copy read only leaves empty side files; they belong to the checks, not to the copy.
    for (const suffix of ['-wal', '-shm']) ownRemove(`${part}${suffix}`);
    ownMove(part, path.join(dir, PENDING_DB));
    const info: PendingRestore = { source: label, stagedAt: (deps.now ?? Date.now)(), summary: summary.text };
    fs.writeFileSync(path.join(dir, PENDING_INFO), JSON.stringify(info), 'utf8');
    deps.log?.info(`restore: staged ${label} (${summary.text})`);
    return { ok: true, message: `This copy is ready: it holds ${summary.text}. Close Backup Hub and open it again to finish. What you have now is moved aside (not deleted) into the "before-restore" folder in the data folder.` };
  } catch {
    return fail('The copy could not be prepared (the disk may be full or the file in use). Nothing was changed.');
  } finally {
    for (const suffix of ['', '-wal', '-shm']) ownRemove(`${part}${suffix}`);
  }
}

/** Opens the staged copy read only: its schema must be one this version knows, and the tables must be there. */
function inspect(file: string): { text: string } | string {
  const db = openReadOnly(file);
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    const version = row ? Number(row.value) : Number.NaN;
    if (!Number.isInteger(version)) return 'This is not a Backup Hub database.';
    if (version > MIGRATIONS.length) return 'This copy was made by a newer Backup Hub than this one. Update the app first.';
    const count = (table: string): number => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const files = (db.prepare('SELECT max(id) AS n FROM files').get() as { n: number | null }).n ?? 0;
    return { text: `${plural(count('profiles'), 'profile')}, ${plural(count('places'), 'place')}, ${plural(count('collections'), 'collection')} and about ${files.toLocaleString('en-US')} files` };
  } catch {
    return 'This is not a Backup Hub database.';
  } finally {
    db.close();
  }
}
