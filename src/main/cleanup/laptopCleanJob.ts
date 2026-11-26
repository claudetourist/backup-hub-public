/**
 * Job `clean.laptop`: MOVES the ticked duplicate files into the quarantine folder of the same drive (`shared/appFolders.ts`), then `<date>\<original path>` (a rename on
 * the same drive: nothing is copied and nothing is deleted). For every file, right before the move:
 *   - the laptop was looked at in the last 24 h;
 *   - the file and the copy that is kept are still in the catalog with the same SHA-256, size and modified time, and on disk with
 *     that size and modified time (a file edited since the last look is skipped), and they are not the same file (a hard link);
 *   - the file is not in a protected folder, a OneDrive folder, on a named drive, and not locked.
 * The kept copy is locked for 30 days. The move is logged (with the kept copy as the one that vouched for it) before it happens.
 * Any mismatch skips that file only. Undo moves it back (see quarantine.ts).
 */
import fs from 'node:fs';
import { CLEAN_LAPTOP_JOB_KIND, plural, type LaptopCleanJobParams, type Voucher } from '../../shared/cleanup';
import type { Db } from '../db/connection';
import { absolutePathFor } from '../hashing/paths';
import { JobAborted, JobFailure, type JobContext, type JobHandler, type JobServiceLogger } from '../jobs/jobService';
import { hashConfirmed, runDanger, type ConfirmedEntry } from '../danger';
import { sha256OfFile } from './hashLocal';
import { CleanStore } from './cleanStore';
import { type QuarantineDeps, toWindowsPath } from './quarantine';
import { isFresh, isInside, movability, normalizeAbs, quarantineDate, quarantinePathFor, quarantineRootFor, toVoucher } from './safety';

export interface LaptopCleanDeps {
  db: Db;
  log: JobServiceLogger;
  quarantine?: QuarantineDeps | undefined;
  oneDriveRoots(): string[];
  driveRoots(): Promise<string[]>;
  /** See LaptopCleanPlannerDeps.userFolderRoots. Asked again for every start, so the setting is read live. */
  userFolderRoots?(): string[];
  now?: () => number;
  changed?: () => void;
}

const SHA = /^[0-9a-f]{64}$/;
const mb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6).toLocaleString('en-US')} MB`);

export function laptopCleanHandler(deps: LaptopCleanDeps): JobHandler {
  return { kind: CLEAN_LAPTOP_JOB_KIND, heavy: false, resumable: false, run: (ctx) => runLaptopClean(deps, ctx) };
}

/** What the person confirmed, in the form the guarded path hashes: one entry per file, in the order of the list. */
export function laptopConfirmed(files: LaptopCleanJobParams['files']): ConfirmedEntry[] {
  return files.map((f, i) => ({ id: String(i), action: 'quarantine' as const, target: (typeof f.relPath === 'string' ? absolutePathFor('laptop', '', f.relPath) : null) ?? String(f.relPath), contentHash: typeof f.sha256 === 'string' ? f.sha256 : null }));
}

async function runLaptopClean(deps: LaptopCleanDeps, ctx: JobContext): Promise<string> {
  const params = ctx.params as Partial<LaptopCleanJobParams> | null;
  const files = params?.files;
  if (!Array.isArray(files) || files.length === 0) throw new JobFailure('This clean-up has no files in it. Make a new plan. Nothing was moved.');
  const confirmed = laptopConfirmed(files);
  if (typeof params?.listId !== 'string' || typeof params.listHash !== 'string' || hashConfirmed(confirmed) !== params.listHash) throw new JobFailure('The list is not the one that was confirmed. Make a new plan. Nothing was moved.');
  const now = deps.now ?? Date.now;
  const dangerEnv = { db: deps.db, now };
  const store = new CleanStore(deps.db, now);
  const laptop = store.laptopPlaceId();
  if (laptop === null) throw new JobFailure('This laptop is not known to Backup Hub. Nothing was moved.');
  if (!isFresh(store.lastLooked(laptop), now())) throw new JobFailure('The laptop was not checked in the last 24 hours. Check it first (Devices), then make a new plan. Nothing was moved.');
  const rootFor = deps.quarantine?.rootFor ?? quarantineRootFor;
  const date = quarantineDate(now());
  const oneDriveRoots = deps.oneDriveRoots();
  const otherPlaceRoots = await deps.driveRoots();
  const userFolderRoots = deps.userFolderRoots?.() ?? [];
  const total = files.length;
  let moved = 0;
  let movedBytes = 0;
  let skipped = 0;
  const skip = (name: string, why: string): void => {
    skipped += 1;
    ctx.warn(`${name}: skipped (${why}). It was not moved.`);
  };

  for (let i = 0; i < total; i += 1) {
    await ctx.yield();
    const f = files[i]!;
    const name = typeof f.relPath === 'string' ? f.relPath.slice(f.relPath.lastIndexOf('/') + 1) : 'file';
    ctx.progress(i, total, { message: `Moving ${name} (${i + 1} of ${total})` });
    try {
      if (typeof f.relPath !== 'string' || typeof f.keep !== 'string' || typeof f.sha256 !== 'string' || !SHA.test(f.sha256) || !Number.isInteger(f.size) || f.size <= 0) {
        skip(name, 'its details are not valid');
        continue;
      }
      const abs = absolutePathFor('laptop', '', f.relPath);
      const keepAbs = absolutePathFor('laptop', '', f.keep);
      if (abs === null || keepAbs === null) {
        skip(name, 'its path cannot be trusted');
        continue;
      }
      if (normalizeAbs(abs).toLowerCase() === normalizeAbs(keepAbs).toLowerCase()) {
        skip(name, 'it is the copy that is kept');
        continue;
      }
      if (!isFresh(store.lastLooked(laptop), now())) {
        skip(name, 'the laptop was not checked in the last 24 hours. Check it first');
        continue;
      }
      const m = movability(f.relPath, { oneDriveRoots, locks: store.activeLocks(), laptopPlaceId: laptop, now: now(), otherPlaceRoots, userFolderRoots });
      if (!m.ok) {
        skip(name, m.why);
        continue;
      }
      const row = store.row(laptop, f.relPath);
      const keepRow = store.row(laptop, f.keep);
      const live = (r: typeof row): boolean => r !== null && r.goneAt === null && !r.cloudOnly && r.sha256 === f.sha256 && r.size === f.size && r.mtime !== null;
      if (!row || !keepRow || !live(row) || !live(keepRow) || row.mtime !== f.mtime || keepRow.mtime !== f.keepMtime || f.keepSize !== f.size) {
        skip(name, 'Backup Hub\'s list no longer shows two identical copies');
        continue;
      }
      let st: fs.Stats;
      let keepSt: fs.Stats;
      try {
        st = fs.statSync(abs);
        keepSt = fs.statSync(keepAbs);
      } catch {
        skip(name, 'it or the copy that is kept is not on the disk any more');
        continue;
      }
      if (!st.isFile() || !keepSt.isFile() || st.size !== f.size || keepSt.size !== f.size || Math.trunc(st.mtimeMs) !== row.mtime || Math.trunc(keepSt.mtimeMs) !== keepRow.mtime) {
        skip(name, 'it or the copy that is kept changed since the laptop was last checked');
        continue;
      }
      if (st.ino !== 0 && st.ino === keepSt.ino && st.dev === keepSt.dev) {
        skip(name, 'both names are the same file on the disk');
        continue;
      }
      const root = rootFor(f.relPath);
      const target = root === null ? null : quarantinePathFor(root, date, toWindowsPath(abs), (p) => fs.existsSync(p));
      if (root === null || target === null || !isInside(root, target)) {
        skip(name, 'no safe quarantine place was found');
        continue;
      }
      const voucher: Voucher = toVoucher(keepRow);
      const lockIds = store.addLocks([voucher], `Kept when ${f.relPath} was moved to the quarantine`);
      const logId = store.logRemoval({ runId: ctx.jobId, kind: 'laptop', placeId: laptop, device: null, path: f.relPath, size: f.size, sha256: f.sha256, vouchers: [voucher], quarantinePath: target });
      store.attachLocks(lockIds, logId);
      // The move goes through the guarded path: the confirmed list, a fresh read of the copy that is kept, a hard link that never
      // replaces, then the old name goes. The proof is read now, from the disk, not from the catalog.
      const confirmedItem = confirmed[i]!;
      const result = (
        await runDanger(dangerEnv, {
          listId: params.listId,
          confirmedHash: params.listHash,
          confirmed,
          items: [{ ...confirmedItem, to: target, toRoot: root, size: f.size, survivors: [{ where: f.keep, ref: keepAbs, readFresh: () => sha256OfFile(keepAbs, () => ctx.yield()).catch((err: unknown) => (ctx.signal.aborted ? Promise.reject(err) : null)) }] }],
        })
      )[0];
      if (result?.outcome !== 'done') {
        if (ctx.signal.aborted) throw new JobAborted();
        if (result?.outcome === 'failed' && !fs.existsSync(abs)) throw new Error(result.reason ?? 'the move failed'); // moved after all? unknown state: let the outer handler report it
        store.dropLog(logId);
        skip(name, `it could not be moved (${result?.reason?.slice(0, 100) ?? 'unknown error'})`);
        continue;
      }
      if (fs.existsSync(abs) || !fs.existsSync(target)) {
        store.dropLog(logId);
        skip(name, 'the move could not be confirmed');
        continue;
      }
      store.setGone(laptop, f.relPath, true);
      moved += 1;
      movedBytes += f.size;
      ctx.log('info', `${f.relPath} moved to ${target}; ${f.keep} is kept (same SHA-256 ${f.sha256.slice(0, 12)}...)`);
    } catch (err) {
      if (err instanceof JobAborted || ctx.signal.aborted) throw err instanceof JobAborted ? err : new JobAborted();
      skip(name, `something went wrong (${(err as Error).message.split('\n')[0]?.slice(0, 100) ?? 'unknown error'})`);
    }
  }
  ctx.progress(total, total, {});
  deps.changed?.();
  const line = `Moved ${plural(moved, 'duplicate')} (${mb(movedBytes)}) to the quarantine${skipped > 0 ? `; ${plural(skipped, 'file')} skipped and left where they were` : ''}`;
  if (moved === 0) throw new JobFailure(`${line}. Nothing was moved. See the warnings above.`);
  ctx.log('info', line);
  return `${line}. Nothing was deleted: Undo (Clean up, "What was removed") puts a file back, and Backup Hub asks before emptying the quarantine after 30 days.`;
}
