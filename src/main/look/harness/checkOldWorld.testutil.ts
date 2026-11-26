import { classifyPhoneFiles, loadPhoneBackup, uncheckedItems } from '../../phoneBackup/checkOld';
import { CheckOldRun, type CheckOldCheckpoint } from '../../phoneBackup/checkOldRun';
import type { CheckOldInput } from '../../phoneBackup/checkOldStore';
import type { CheckOldReport } from '../../../shared/phoneBackup';
import { FakeCtx, type ProductWorld } from './phoneBackupWorld.testutil';
import type { World } from './world.testutil';

/**
 * Helpers for "Check old copies" in the fake world: copies the old tool made (rows with verified_how 'imported' or 'name_size', never
 * compared), and a run of the real check against the fake phone and the unkind fake drive.
 */
export const OLD_FOLDER = 'MyData/POCO/OLD-TOOL';

export interface SeedOptions {
  /** What the drive actually holds (default: the phone's file as it is). Same size is kept by the caller when the old tool recorded the phone's size. */
  driveContent?: Buffer | string | null;
  how?: 'imported' | 'name_size';
  /** Where on the drive (default under OLD_FOLDER, keeping the phone's folders). */
  driveRel?: string;
}

/** The phone file must be in the index already (call `w.look()` first). Writes the file to drive 1 for good and the index row of the copy. Returns the row id and the drive path. */
export function seedImported(w: World, phonePath: string, options: SeedOptions = {}): { copyId: number; driveRel: string } {
  const phoneRel = phonePath.replace(/^\//, '');
  const row = w.db.prepare('SELECT id, size, mtime FROM files WHERE place_id = ? AND rel_path = ?').get(w.placeId, phoneRel) as { id: number; size: number; mtime: number } | undefined;
  if (!row) throw new Error(`not in the index: ${phonePath}`);
  const driveRel = options.driveRel ?? `${OLD_FOLDER}/${phoneRel.replace(/^sdcard\//, '')}`;
  const drive = w.drives[0]!;
  if (options.driveContent !== null) {
    drive.write(driveRel, options.driveContent ?? w.phone.read(phonePath), Math.floor(row.mtime / 1000));
    drive.flush(driveRel);
  }
  const copyId = Number(
    w.db
      .prepare(
        `INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, origin_file_id, verified_how)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(w.destinations[0]!.placeId, driveRel, row.size, row.mtime, w.nowMs, w.nowMs, row.id, options.how ?? 'imported').lastInsertRowid,
  );
  return { copyId, driveRel };
}

export function copyRow(w: World, copyId: number): { verified_how: string | null; verified_at: number | null; expected_sha256: string | null; gone_at: number | null; gone_reason: string | null; size: number | null; rel_path: string } {
  return w.db.prepare('SELECT verified_how, verified_at, expected_sha256, gone_at, gone_reason, size, rel_path FROM files WHERE id = ?').get(copyId) as never;
}

/** The check's list, made the way the service makes it (the same functions), for the folders given (default: all). */
export function buildInput(w: World, folders?: readonly string[]): CheckOldInput {
  const loaded = loadPhoneBackup(w.db, w.profileId);
  if (!loaded.ok) throw new Error(loaded.message);
  const files = classifyPhoneFiles(w.db, loaded.backup, loaded.dest);
  const chosen = new Set(folders ?? files.filter((f) => f.state === 'unchecked').map((f) => f.group));
  const items = uncheckedItems(files, chosen);
  return {
    key: 'test-key',
    backupId: w.profileId,
    backupName: loaded.backup.name,
    phoneName: 'Fake phone',
    serial: w.phone.serial,
    destPlaceId: loaded.dest.placeId,
    driveLabel: 'Fake T7',
    items: items.map((i) => ({ copyId: i.copyId!, phoneRowId: i.rowId, path: i.path, size: i.size, copyRel: i.copyRel!, group: i.group })),
  };
}

export interface CheckRun {
  report: CheckOldReport | null;
  ctx: FakeCtx;
  checkpoint: CheckOldCheckpoint | null;
  error: unknown;
}

/** Runs the real check once (a throw is returned, not raised: a killed app is a result). */
export async function runCheck(p: ProductWorld, input: CheckOldInput, options: { ctx?: FakeCtx; resume?: CheckOldCheckpoint | null; jobId?: number } = {}): Promise<CheckRun> {
  const ctx = options.ctx ?? new FakeCtx();
  try {
    const report = await new CheckOldRun(p.deps, ctx, input, options.jobId ?? 1, options.resume ?? null).execute();
    return { report, ctx, checkpoint: ctx.last as CheckOldCheckpoint | null, error: null };
  } catch (error) {
    return { report: null, ctx, checkpoint: ctx.last as CheckOldCheckpoint | null, error };
  }
}

/** Records every file the check reads back from the drive (the cache-free read), in order. */
export function spyOnDriveReads(p: ProductWorld): string[] {
  const reads: string[] = [];
  const ops = p.drive.ops;
  const original = ops.hash.bind(ops);
  ops.hash = async (file, yieldNow) => {
    reads.push(file);
    return original(file, yieldNow);
  };
  return reads;
}
