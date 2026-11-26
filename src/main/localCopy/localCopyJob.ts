/**
 * Job `copy.toLocal` (heavy, resumable). Copies the files of a confirmed "Back up now" plan, WHOLE, to a plugged-in named
 * drive. For every file: the source is only opened for reading; the bytes go to a temporary name in the drive's temp folder (in the app's own files),
 * are flushed, read back without the Windows cache and compared (SHA-256 against what was read from the source, MD5 against the
 * catalog), and only then linked to the real name (never replacing). The copy gets the source's modified time and a row in the catalog.
 *
 * Safe by construction: nothing is ever overwritten, moved or deleted except this job's own temporary files. A
 * file that already exists under the final name is never replaced: if it is the same content it counts as already there,
 * otherwise it is reported. After a restart the job continues at the file it was on and copies that file again from the start.
 */
import { rawFs as fs } from '../rawFs';
import path from 'node:path';
import { COPY_TO_LOCAL_JOB_KIND, LOCAL_MIN_FREE_BYTES, type LocalCopyJobParams, type LocalOutcome, type LocalPlanFile, type LocalReport } from '../../shared/localCopy';
import type { Db } from '../db/connection';
import { assertWritable, DriveWriteProtectedError } from '../fsutil';
import { absolutePathFor } from '../hashing/paths';
import { JobAborted, JobFailure, turnOf, type JobContext, type JobHandler, type JobServiceLogger } from '../jobs/jobService';
import { upsertFiles } from '../listing/fileStore';
import { backupsFolder } from '../places/appFolders';
import { reportLine } from './localModel';
import { existsAsync, hashFileOnce, settleLeftover, sweepStaleTemps, tmpDirFor, verifiedCopy, type Hashes } from './verifiedCopy';

export const COPY_LOCAL_TITLE = 'Back up now';

export interface LocalCopyJobDeps {
  db: Db;
  log: JobServiceLogger;
  /** Where a place's folders are right now ('' for the laptop), or null when it is not reachable. */
  baseOf(placeId: string): Promise<string | null>;
  /** Free bytes on the drive that holds `root`, or null when it cannot be read. */
  /** Free bytes on the drive (null: unknown). May answer later: the real one is `freeBytesOfAsync`. */
  freeBytes(root: string): number | null | Promise<number | null>;
  now?: () => number;
  /** Read and write size; tests use a small one. */
  chunkBytes?: number;
  /** Where the temp files go (default: the temp folder of the drive of the copy). Tests only.*/
  tmpDir?: string;
}

interface Checkpoint {
  next: number;
  outcomes: Record<string, LocalOutcome>;
  reasons: Record<string, string>;
  bytesDone: number;
}

const emptyCheckpoint = (): Checkpoint => ({ next: 0, outcomes: {}, reasons: {}, bytesDone: 0 });
const mb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6).toLocaleString('en-US')} MB`);

export function copyToLocalHandler(deps: LocalCopyJobDeps): JobHandler {
  return { kind: COPY_TO_LOCAL_JOB_KIND, heavy: true, resumable: true, run: (ctx) => new LocalRun(deps, ctx).run() };
}

class LocalRun {
  private cp = emptyCheckpoint();
  private readonly plan;
  private bytesTotal = 0;
  private stopped = false;

  constructor(
    private readonly deps: LocalCopyJobDeps,
    private readonly ctx: JobContext,
  ) {
    this.plan = (ctx.params as Partial<LocalCopyJobParams> | null)?.plan;
  }

  async run(): Promise<string> {
    const { ctx, deps } = this;
    const plan = this.plan;
    if (!plan || !Array.isArray(plan.files) || plan.files.length === 0) throw new JobFailure('This backup has no files in it. Make a new plan and try again.');
    this.bytesTotal = plan.files.reduce((sum, f) => sum + f.size, 0);
    const resume = ctx.resume as Partial<Checkpoint> | null;
    if (resume) {
      this.cp = { ...emptyCheckpoint(), ...resume };
      if (this.cp.next > 0) ctx.log('info', `Continuing at file ${Math.min(this.cp.next + 1, plan.files.length)} of ${plan.files.length}`);
    }
    // A laptop folder (phone backup only) takes the copy when the plan says so; its files get no catalog row (it is not listed).
    const base = plan.targetFolder ?? (await deps.baseOf(plan.targetPlaceId));
    if (base === null || base === '') throw new JobFailure(`${plan.targetLabel} is not plugged in. Plug it in and press Retry. Nothing was lost.`);
    if (plan.targetFolder !== undefined && !(await existsAsync(base))) throw new JobFailure('The laptop folder is not there any more. Nothing was lost.');

    // T7 write ban: a protected drive gets nothing, and the job says so plainly before any file is looked at.
    try {
      assertWritable(path.join(backupsFolder(base), '.guard'));
    } catch (err) {
      if (err instanceof DriveWriteProtectedError) throw new JobFailure(err.message);
      throw err;
    }

    await sweepStaleTemps(tmpDirFor(path.join(backupsFolder(base), '.guard'), deps.tmpDir)); // temp files of copies that never reached a final name

    for (let i = this.cp.next; i < plan.files.length; i += 1) {
      const file = plan.files[i]!;
      this.cp.next = i;
      await ctx.yield();
      let outcome: LocalOutcome;
      if (this.stopped) outcome = 'no_space';
      else outcome = await this.copyOne(file, base);
      this.cp.outcomes[String(file.index)] = outcome;
      this.cp.bytesDone += file.size;
      this.cp.next = i + 1;
      ctx.checkpoint(this.cp);
      ctx.progress(i + 1, plan.files.length, { bytesDone: this.cp.bytesDone, bytesTotal: this.bytesTotal });
    }
    return this.summary();
  }

  private reason(file: LocalPlanFile, text: string): void {
    this.cp.reasons[String(file.index)] = text;
  }

  /** The folder and file on the drive, refused when the path would leave the drive root. */
  private destination(base: string, file: LocalPlanFile): { dir: string; final: string } | null {
    const dir = path.resolve(base, ...file.folder.split('/'));
    const root = path.resolve(base);
    const final = path.join(dir, file.name);
    if (!(dir + path.sep).startsWith(root.endsWith(path.sep) ? root : root + path.sep) || path.dirname(final) !== dir) return null;
    if (file.folder.split('/').some((s) => s === '..' || s === '.' || s === '') || file.name.includes('/') || file.name.includes('\\')) return null;
    return { dir, final };
  }

  private async copyOne(file: LocalPlanFile, base: string): Promise<LocalOutcome> {
    const { ctx, deps } = this;
    const plan = this.plan!;

    // The source must be exactly the file the plan counted on.
    const sourceBase = await deps.baseOf(file.sourcePlaceId);
    const kind = (deps.db.prepare('SELECT kind FROM places WHERE id = ?').get(file.sourcePlaceId) as { kind: string } | undefined)?.kind;
    const abs = sourceBase !== null && (kind === 'laptop' || kind === 'drive' || kind === 'onedrive') ? absolutePathFor(kind, sourceBase, file.sourceRel) : null;
    if (abs === null) {
      this.reason(file, `${file.sourcePlaceLabel} is not reachable.`);
      ctx.warn(`${file.name}: ${file.sourcePlaceLabel} is not plugged in or checked, so it was skipped.`);
      return 'missing';
    }
    try {
      const st = await fs.promises.stat(abs);
      if (!st.isFile() || st.size !== file.size || (file.mtime !== null && Math.trunc(st.mtimeMs) !== file.mtime)) {
        this.reason(file, 'It changed after the plan was made.');
        ctx.warn(`${file.name} changed since the plan was made, so it was skipped. Make a new plan.`);
        return 'changed';
      }
    } catch {
      this.reason(file, 'It is not there any more.');
      ctx.warn(`${file.name} is not at ${file.sourceShown} any more, so it was skipped.`);
      return 'missing';
    }
    const row = deps.db.prepare('SELECT md5, size FROM files WHERE place_id = ? AND rel_path = ? AND gone_at IS NULL').get(file.sourcePlaceId, file.sourceRel) as { md5: string | null; size: number } | undefined;
    if (!row || row.md5 !== file.md5 || row.size !== file.size) {
      this.reason(file, 'Backup Hub\'s list changed after the plan was made.');
      ctx.warn(`${file.name}: Backup Hub's list no longer matches the plan, so it was skipped. Make a new plan.`);
      return 'changed';
    }
    const alreadyListed = deps.db.prepare('SELECT 1 FROM files WHERE place_id = ? AND md5 = ? AND size = ? AND gone_at IS NULL LIMIT 1').get(plan.targetPlaceId, file.md5, file.size);
    if (alreadyListed) {
      ctx.log('info', `${file.name} is already on ${plan.targetLabel}`);
      return 'already';
    }

    const dest = this.destination(base, file);
    if (!dest) {
      this.reason(file, 'The place on the drive is not valid.');
      ctx.warn(`${file.name}: the place on the drive is not valid, so it was skipped.`);
      return 'failed';
    }
    const free = await deps.freeBytes(base);
    if (free !== null && free - file.size < LOCAL_MIN_FREE_BYTES) {
      this.stopped = true;
      this.reason(file, `${plan.targetLabel} is full.`);
      ctx.warn(`${plan.targetLabel} has no room left (${mb(Math.max(0, free))} free). The remaining files were not copied.`);
      return 'no_space';
    }

    assertWritable(dest.final); // before anything is created, renamed or removed on the drive
    try {
      await fs.promises.mkdir(dest.dir, { recursive: true });
      if (await existsAsync(dest.final)) {
        // Never replaced. The same content counts as already there; anything else is reported.
        const sameSize = (await fs.promises.stat(dest.final)).size === file.size;
        const hashes = sameSize ? await hashFileOnce(dest.final, { ...(deps.chunkBytes === undefined ? {} : { chunkBytes: deps.chunkBytes }), yieldNow: turnOf(ctx), md5: true }) : null;
        if (hashes && hashes.md5 === file.md5) {
          // A file linked by a run that was cut off before its flush: flush it now and clear the temp name.
          await settleLeftover(dest.final, { ...(deps.tmpDir === undefined ? {} : { tmpDir: deps.tmpDir }), isExpected: () => Promise.resolve(true) });
          ctx.log('info', `${file.name} is already at ${plan.targetLabel}:${file.folder}`);
          await this.recordRow(plan.targetPlaceId, base, dest.final, hashes);
          return 'already';
        }
        this.reason(file, 'A different file with that name is already on the drive. It was not touched.');
        ctx.warn(`${file.name}: a different file is already at ${file.folder}/${file.name} on ${plan.targetLabel}. It was left alone and this file was skipped.`);
        return 'exists';
      }
      const result = await verifiedCopy({
        source: abs,
        final: dest.final,
        size: file.size,
        md5: true,
        ...(deps.chunkBytes === undefined ? {} : { chunkBytes: deps.chunkBytes }),
        ...(deps.tmpDir === undefined ? {} : { tmpDir: deps.tmpDir }),
        yieldNow: turnOf(ctx), // Pause lets the file finish (a Pause holds between files only)
        onProgress: (done, checking) => {
          const message = checking ? `Checking ${file.name} on ${plan.targetLabel}` : `Copying ${file.name} to ${plan.targetLabel} (${file.index + 1} of ${plan.files.length})`;
          ctx.progress(file.index, plan.files.length, { bytesDone: this.cp.bytesDone + (checking ? 0 : done), bytesTotal: this.bytesTotal, message });
        },
        // A copy counts only when what was read from the source is what the catalog holds.
        acceptSource: (h) => h.md5 === file.md5,
      });
      if (!result.ok) {
        if (result.reason === 'source_changed') {
          this.reason(file, 'What was read from the source is not what Backup Hub\'s list holds (it changed).');
          ctx.warn(`${file.name} does not match Backup Hub's list any more, so nothing was kept. Make a new plan.`);
          return 'changed';
        }
        if (result.reason === 'protected_name') {
          this.reason(file, 'It is inside the Backup Hub own-files folder, which is never copied.');
          ctx.warn(`${file.name}: it is inside the Backup Hub own-files folder, which is never copied, so it was skipped.`);
          return 'skipped_protected';
        }
        if (result.reason === 'mismatch') {
          this.reason(file, 'The copy did not match the original after writing, so it was not kept.');
          ctx.warn(`${file.name}: the copy on ${plan.targetLabel} did not match the original, so it was thrown away (only this job's own temporary file). Try again; if it repeats, check the drive.`);
          return 'mismatch';
        }
        this.reason(file, 'A file with that name appeared on the drive meanwhile. It was not touched.');
        ctx.warn(`${file.name}: a file with that name appeared on ${plan.targetLabel} meanwhile. It was left alone.`);
        return 'exists';
      }
      const back = result.hashes;
      await this.recordRow(plan.targetPlaceId, base, dest.final, back);
      ctx.log('info', `${file.name}: copied to ${plan.targetLabel}:${file.folder} and checked (SHA-256 ${back.sha256.slice(0, 12)}...)`);
      return 'copied';
    } catch (err) {
      if (err instanceof JobAborted) throw err; // verifiedCopy has already removed this copy's temp file
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC') {
        this.stopped = true;
        this.reason(file, `${plan.targetLabel} is full.`);
        ctx.warn(`${plan.targetLabel} is full. The remaining files were not copied.`);
        return 'no_space';
      }
      if (code === 'ENOENT' || code === 'EIO' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EMFILE') {
        const text = code === 'ENOENT' ? `The drive or the source went away while copying (${code}).` : `The file could not be read or written (${code}).`;
        this.reason(file, text);
        ctx.warn(`${file.name}: ${text}`);
        return 'failed';
      }
      throw err;
    }
  }

  /** The copy gets its row in the catalog now (with its fingerprints, which were just checked), so the coverage is right at once. */
  private async recordRow(placeId: string, base: string, finalPath: string, hashes: Hashes): Promise<void> {
    if (this.plan?.targetFolder !== undefined) return; // a laptop folder is not in the catalog
    const now = (this.deps.now ?? Date.now)();
    const rel = path.relative(base, finalPath).split(path.sep).join('/');
    const st = await fs.promises.stat(finalPath);
    upsertFiles(this.deps.db, placeId, [{ relPath: rel, size: st.size, mtimeMs: Math.trunc(st.mtimeMs), cloudOnly: false }], now, true);
    this.deps.db.prepare('UPDATE files SET sha256 = ?, md5 = ?, hashed_at = ?, hash_error = NULL WHERE place_id = ? AND rel_path = ?').run(hashes.sha256, hashes.md5, now, placeId, rel);
  }

  private summary(): string {
    const { ctx } = this;
    const plan = this.plan!;
    const report: LocalReport = { copied: 0, copiedBytes: 0, already: 0, skipped: 0, failed: 0 };
    for (const f of plan.files) {
      const o = this.cp.outcomes[String(f.index)];
      if (o === 'copied') {
        report.copied += 1;
        report.copiedBytes += f.size;
      } else if (o === 'already') report.already += 1;
      else if (o === 'changed' || o === 'missing' || o === 'exists' || o === 'no_space' || o === 'skipped_protected') report.skipped += 1;
      else report.failed += 1;
    }
    const line = reportLine(report, plan.targetLabel, mb);
    if (report.copied === 0 && report.already === 0 && plan.files.length > 0) throw new JobFailure(`${line}. Nothing was copied. See the warnings above.`);
    ctx.log('info', line);
    return `${line}. Nothing was deleted or overwritten; the files in ${plan.targetLabel}:BackupHub are new copies.`;
  }
}
