/**
 * The run of a confirmed folder backup (job `folder.backup`, R2.1 and R2.8). Per file, in this order: the file must still be in the folder with the size
 * and date of the list; OneDrive files are asked about first (an online-only file is never opened, so nothing is downloaded); an earlier cut-off temp
 * name of this file is settled; a file already at the final name on the drive is compared (same: already there; different: a Problem, never replaced);
 * otherwise the file is READ ONCE, hashed while it is written to a temp name under the drive's own files; then the S1 sequence (flush, cache-free
 * read-back compared, link that cannot replace, flush) and only then the index row. A file in use by another program is skipped and listed (tried again
 * next time). A file whose content is already in the backup is linked, not copied again. The drive going away, or the laptop sleeping, pauses the run
 * at a safe point for the person's Continue. Never deletes, never overwrites.
 */
import { JobAborted, turnOf } from '../jobs/jobService';
import { adoptVerifiedTemp } from '../localCopy/verifiedCopy';
import { cleanSegment } from '../localCopy/localModel';
import { prefixUpperBound } from '../listing/skipRules';
import { finishSliced, writeSliced } from '../sliceWork';
import { FOLDER_LIST_HEADER, listCsvSteps, runDate } from '../phoneBackup/runCsv';
import { RunProgress } from '../phoneBackup/runProgress';
import { finishRun, recordCopy, startRun, type ConfirmedRun } from '../phoneBackup/runStore';
import { listRowsSteps } from '../mirror/mirrorStore';
import { DRIVE_TROUBLE, lines, nameOf, note, type Reasons } from '../mirror/mirrorRun';
import type { MirrorDrive } from '../mirror/mirrorTypes';
import { IN_USE_REASON, ONLINE_ONLY_REASON, type FolderBackupReport } from '../../shared/folderBackup';
import { relOfRulePath } from './folderPaths';
import { learnSourceSha, linkOriginOnly, saveFolderReport } from './folderStore';
import type { FolderBackupDeps, FolderSource, RunCtx } from './folderTypes';

/** What is kept at every file, so a Continue after a restart carries on (the index says what is done; this keeps the counts). */
export interface FolderCheckpoint {
  runId: number;
  startedAt: number;
  next: number;
  copied: number;
  bytes: number;
  alreadyThere: number;
  linked: number;
  linkedApplied: boolean;
  bytesDone: number;
  skipped: Reasons;
  failed: Reasons;
  inUse: Reasons;
  inUseCount: number;
  onlineOnlyFiles: number;
  onlineOnlyBytes: number;
  failedList: { path: string; reason: string }[];
}

export const emptyFolderCheckpoint = (): FolderCheckpoint => ({ runId: 0, startedAt: 0, next: 0, copied: 0, bytes: 0, alreadyThere: 0, linked: 0, linkedApplied: false, bytesDone: 0, skipped: {}, failed: {}, inUse: {}, inUseCount: 0, onlineOnlyFiles: 0, onlineOnlyBytes: 0, failedList: [] });

const MAX_FAILED_LIST = 2000;
const RECONNECT_LIMIT = 3;
const PROGRESS_EVERY_MS = 500;
/** Windows is asked about the next files this many at a time, and an answer older than this is asked again before a file is opened. */
const CLOUD_AHEAD = 200;
const CLOUD_FRESH_MS = 30_000;
/** A file in use, or one Windows will not let this program read. */
const LOCKED_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ELOCKED', 'ETXTBSY']);

const mb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6).toLocaleString('en-US')} MB`);

type Item = ConfirmedRun['items'][number];
type Attempt = { k: 'copied' } | { k: 'already' } | { k: 'linked' } | { k: 'retry'; reason: string } | { k: 'fail'; reason: string } | { k: 'problem'; reason: string } | { k: 'inuse' } | { k: 'gone' } | { k: 'drive_gone' } | { k: 'full' } | { k: 'changed' };

/** The file as the person reads it in the report: its place below the backed-up folder. */
const shown = (item: Item): string => relOfRulePath(item.path) ?? item.path;

const tag = (err: unknown, side: 'source' | 'drive'): void => {
  if (err !== null && typeof err === 'object' && (err as { side?: string }).side === undefined) (err as { side?: string }).side = side;
};

export class FolderBackupRun {
  private cp: FolderCheckpoint;
  private drive!: MirrorDrive;
  private driveLabel = 'the drive';
  private src!: FolderSource;
  private lastWake: number;
  private full = false;
  private readonly now: () => number;
  private readonly cloud = new Map<string, { state: string; at: number }>();
  private bytesTotal = 0;
  /** What the window shows while the copy runs (read only). */
  readonly progress: RunProgress;

  constructor(
    private readonly deps: FolderBackupDeps,
    private readonly ctx: RunCtx,
    private readonly run: ConfirmedRun,
    private readonly jobId: number,
    resume: Partial<FolderCheckpoint> | null,
  ) {
    this.now = deps.now ?? Date.now;
    this.cp = { ...emptyFolderCheckpoint(), ...resume };
    this.lastWake = deps.wakeCount?.() ?? 0;
    this.progress = new RunProgress(run.items, this.cp.next, this.cp.failedList);
  }

  async execute(): Promise<FolderBackupReport> {
    const { deps, ctx, run } = this;
    const release = deps.keepAwake?.();
    try {
      if (this.cp.runId === 0) {
        this.cp.runId = startRun(deps.db, run.backupId, run.destPlaceId, run.sessionFolder === '' ? run.destRoot : run.sessionFolder, this.now());
        this.cp.startedAt = this.now();
        ctx.checkpoint(this.cp);
      }
      await this.getDrive();
      await this.getSource();
      await this.applyRelinks();
      const total = run.items.length;
      this.bytesTotal = run.items.reduce((s, i) => s + i.size, 0);
      if (this.cp.next > 0) ctx.log('info', `Continuing at file ${Math.min(this.cp.next + 1, total)} of ${total}`);
      for (let i = this.cp.next; i < total; i += 1) {
        const item = run.items[i]!;
        await ctx.yield();
        if ((deps.wakeCount?.() ?? 0) !== this.lastWake) {
          this.lastWake = deps.wakeCount?.() ?? 0;
          ctx.log('info', 'The laptop slept. Looking at the folder and the drive again before going on.');
          await this.reconnect('sleep');
        }
        this.progress.begin(i);
        await this.one(item, i, total);
        this.cp.next = i + 1;
        this.cp.bytesDone += item.size;
        ctx.checkpoint(this.cp);
        ctx.progress(i + 1, total, { bytesDone: this.cp.bytesDone, bytesTotal: this.bytesTotal });
      }
      return await this.finish();
    } finally {
      release?.();
      this.progress.end();
    }
  }

  // ---- the drive and the folder ------------------------------------------------------------------------------------------------

  private async getDrive(): Promise<void> {
    for (;;) {
      const found = await this.deps.driveFor(this.run.destPlaceId);
      if (found) {
        this.drive = found.drive;
        this.driveLabel = found.label;
        return;
      }
      await this.ctx.needsYou('The drive for this backup is not plugged in. Plug it in, then press Continue. Nothing is lost; the copy carries on where it stopped.', ['Continue']);
    }
  }

  private async getSource(): Promise<void> {
    const { deps, run, ctx } = this;
    for (;;) {
      const p = deps.db.prepare('SELECT id, name, source_root, import_key, folder_prefix FROM backup_profiles WHERE id = ?').get(run.backupId) as { id: number; name: string; source_root: string; import_key: string | null; folder_prefix: string } | undefined;
      if (!p) throw new Error('The backup is not there any more.');
      const found = await deps.sourceFor({ id: p.id, name: p.name, sourceRoot: p.source_root, importKey: p.import_key, folderPrefix: p.folder_prefix });
      if (found.ok) {
        this.src = found.source;
        this.cloud.clear();
        return;
      }
      await ctx.needsYou(`${found.message} Then press Continue. Nothing is lost; the copy carries on where it stopped.`, ['Continue']);
    }
  }

  private async reconnect(why: 'sleep' | 'drive'): Promise<void> {
    if (why === 'drive') await this.ctx.needsYou('The drive was unplugged or stopped answering. Plug it in, then press Continue. Nothing is lost; the copy carries on where it stopped.', ['Continue']);
    await this.getDrive();
    await this.getSource();
  }

  /** Copies already in the backup whose content the index knows to be the file's: they now point at it. Their size, date, path and checksum are never touched. */
  private async applyRelinks(): Promise<void> {
    if (this.cp.linkedApplied) return;
    let n = 0;
    const { db } = this.deps;
    // Thousands of links in one go froze the window: short transactions with turns between them (sliceWork.ts).
    await writeSliced(this.run.relinks, (slice) => {
      db.transaction(() => {
        for (const r of slice) if (linkOriginOnly(db, r.copyRowId, r.phoneRowId)) n += 1;
      }).immediate();
    }, { pause: () => this.ctx.yield() });
    this.cp.linked = n;
    this.cp.linkedApplied = true;
    this.ctx.checkpoint(this.cp);
  }

  // ---- OneDrive: online-only files are never opened -----------------------------------------------------------------------------

  /** True when the file may be opened. Windows is asked about this file and the next ones in one go; an old answer is asked again. */
  private async mayOpen(index: number, rel: string): Promise<boolean> {
    if (!this.src.cloudAware) return true;
    let hit = this.cloud.get(rel);
    if (!hit || this.now() - hit.at > CLOUD_FRESH_MS) {
      const group: string[] = [];
      for (let j = index; j < this.run.items.length && group.length < CLOUD_AHEAD; j += 1) {
        const r = relOfRulePath(this.run.items[j]!.path);
        if (r !== null) group.push(r);
      }
      const states = await this.src.cloudStates(group, this.ctx.signal);
      const at = this.now();
      for (const r of group) this.cloud.set(r, { state: states.get(r) ?? 'unknown', at });
      hit = this.cloud.get(rel);
    }
    // 'unknown' (Windows could not say) counts as online only: it is never opened to find out. 'missing' is found by the next step.
    return hit !== undefined && (hit.state === 'local' || hit.state === 'missing');
  }

  // ---- one file ----------------------------------------------------------------------------------------------------------------

  private async one(item: Item, index: number, total: number): Promise<void> {
    const { ctx, cp } = this;
    const rel = relOfRulePath(item.path);
    const skip = (reason: string): void => {
      note(cp.skipped, reason, shown(item));
      this.progress.fail(reason);
    };
    if (rel === null) return skip('This name is not one the backup can use.');
    if (this.full) return skip('The drive is full.');
    const retries = this.deps.retries ?? 2;
    let tries = 0;
    let reconnects = 0;
    for (;;) {
      const st = await this.src.stat(rel);
      if (st === null) return skip('It is not in the folder any more.');
      if (st.size !== item.size || Math.abs(st.mtimeMs / 1000 - item.mtimeSec) > 2.5) return skip('It changed after the list was made. The next backup picks it up.');
      if (!(await this.mayOpen(index, rel))) {
        cp.onlineOnlyFiles += 1;
        cp.onlineOnlyBytes += item.size;
        return skip(ONLINE_ONLY_REASON);
      }
      const free = await this.drive.freeBytes();
      if (free !== null && free - item.size < 200_000_000) {
        this.full = true;
        ctx.warn('The drive has no room left. The remaining files were not copied.');
        return skip('The drive is full.');
      }
      ctx.progress(index, total, { bytesDone: cp.bytesDone, bytesTotal: this.bytesTotal, message: `Copying ${nameOf(item.path)} (${index + 1} of ${total})` });
      const r = await this.attempt(item, rel, st, index, total);
      switch (r.k) {
        case 'copied':
          cp.copied += 1;
          cp.bytes += item.size;
          this.progress.done();
          return;
        case 'already':
          cp.alreadyThere += 1;
          this.progress.done();
          return;
        case 'linked':
          cp.linked += 1;
          this.progress.done();
          return;
        case 'inuse':
          cp.inUseCount += 1;
          note(cp.inUse, IN_USE_REASON, shown(item));
          this.progress.fail(IN_USE_REASON);
          ctx.warn(`${nameOf(item.path)}: ${IN_USE_REASON}`);
          return;
        case 'gone':
          return skip('It is not in the folder any more.');
        case 'changed':
          return skip('It changed while it was being copied. The next backup picks it up.');
        case 'full':
          this.full = true;
          ctx.warn('The drive is full. The remaining files were not copied.');
          return skip('The drive is full.');
        case 'problem':
        case 'fail':
          return this.fail(item, r.reason);
        case 'drive_gone':
          reconnects += 1;
          if (reconnects > RECONNECT_LIMIT) return this.fail(item, 'The drive kept going away while this file was copied.');
          await this.reconnect('drive');
          tries = 0;
          continue;
        case 'retry':
          tries += 1;
          if (tries > retries) return this.fail(item, r.reason);
          ctx.log('warn', `${nameOf(item.path)}: ${r.reason} Trying again (${tries} of ${retries}).`);
          await (this.deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms))))(1000 * tries);
      }
    }
  }

  private fail(item: Item, reason: string): void {
    note(this.cp.failed, reason, shown(item));
    if (this.cp.failedList.length < MAX_FAILED_LIST) this.cp.failedList.push({ path: item.path, reason });
    this.ctx.warn(`${nameOf(item.path)}: ${reason}`);
    this.progress.fail(reason);
  }

  /** The folder's file read once (hashed), every block handed on. A failure of the drive side (the writer) is tagged so it is not mistaken for the file's own. */
  private async readSrc(rel: string, onBlock?: (block: Buffer) => Promise<void>): Promise<{ sha256: string; bytes: number }> {
    try {
      return await this.src.readFile(
        rel,
        async (block) => {
          if (!onBlock) return;
          try {
            await onBlock(block);
          } catch (err) {
            tag(err, 'drive');
            throw err;
          }
        },
        turnOf(this.ctx), // the middle of a file: a Pause waits for the file to be copied, checked and recorded
      );
    } catch (err) {
      tag(err, 'source');
      throw err;
    }
  }

  /** A live copy in the backup with this content (found by its checksum), or null. */
  private byContent(sha256: string, size: number): { id: number; origin: number | null } | null {
    if (this.run.flat === true) return null;
    const base = this.run.destRoot.replace(/\/+$/, '') + '/';
    const r = this.deps.db
      .prepare('SELECT id, origin_file_id FROM files WHERE sha256 = ? AND place_id = ? AND gone_at IS NULL AND size = ? AND rel_path > ? AND rel_path < ? LIMIT 1')
      .get(sha256, this.run.destPlaceId, size, base, prefixUpperBound(base)) as { id: number; origin_file_id: number | null } | undefined;
    return r ? { id: r.id, origin: r.origin_file_id } : null;
  }

  private record(item: Item, mtimeMs: number, sha256: string): void {
    recordCopy(this.deps.db, { destPlaceId: this.run.destPlaceId, destRel: item.destRel, size: item.size, mtimeMs, sha256, phoneRowId: item.rowId, runId: this.cp.runId, now: this.now() });
  }

  private async attempt(item: Item, rel: string, st: { size: number; mtimeMs: number }, index: number, total: number): Promise<Attempt> {
    const { deps, ctx, drive } = this;
    const final = drive.finalPath(item.destRel);
    const yieldNow = turnOf(ctx); // the middle of a file: a Pause waits for the file to be copied, checked and recorded
    try {
      let srcSha: string | null = null;
      const readSource = async (): Promise<string> => (srcSha ??= (await this.readSrc(rel)).sha256);
      // An earlier cut-off copy of this name is finished or cleared first; a file at the name is compared, never replaced.
      await drive.settle(final, async () => (await drive.ops.exists(final)) && (await drive.ops.hash(final, yieldNow)) === (await readSource()));
      if (await drive.ops.exists(final)) {
        if ((await drive.ops.sizeOf(final)) !== item.size) return { k: 'problem', reason: 'A different file is already at this name on the drive. It was not touched and this file was not copied.' };
        const there = await drive.ops.hash(final, yieldNow);
        const want = await readSource();
        if (there !== want) return { k: 'problem', reason: 'A different file is already at this name on the drive. It was not touched and this file was not copied.' };
        this.record(item, st.mtimeMs, want);
        return { k: 'already' };
      }
      await drive.ensureDir(final);
      const tmp = drive.tmpPath(final);
      const writer = await drive.openTemp(tmp);
      let read: { sha256: string; bytes: number };
      let reportedAt = 0;
      let blockBytes = 0;
      try {
        read = await this.readSrc(rel, async (block) => {
          await writer.write(block);
          blockBytes += block.length;
          const t = this.now();
          if (t - reportedAt >= PROGRESS_EVERY_MS) {
            reportedAt = t;
            ctx.progress(index, total, { bytesDone: this.cp.bytesDone + blockBytes, bytesTotal: this.bytesTotal, message: `Copying ${nameOf(item.path)} (${index + 1} of ${total})` });
          }
        });
        await writer.finish(st.mtimeMs);
      } catch (err) {
        await writer.abort().catch(() => undefined);
        await drive.ops.removeTemp(tmp);
        throw err;
      }
      if (read.bytes !== item.size) {
        await drive.ops.removeTemp(tmp);
        return { k: 'retry', reason: 'The file came back with another size than the list said.' };
      }
      // The file must still be the one that was read: a file that changed while it was copied is left for the next backup.
      const after = await this.src.stat(rel);
      if (after === null || after.size !== st.size || Math.abs(after.mtimeMs - st.mtimeMs) > 2000) {
        await drive.ops.removeTemp(tmp);
        return after === null ? { k: 'gone' } : { k: 'changed' };
      }
      // Its content may already be in the backup (a date off by whole hours, or the same file under another name or in another dated folder).
      const known = await this.knownCopy(item, read.sha256);
      if (known !== null) {
        await drive.ops.removeTemp(tmp);
        if (item.rowId !== null) {
          learnSourceSha(deps.db, item.rowId, item.size, read.sha256, this.now());
          if (known.origin === null) linkOriginOnly(deps.db, known.id, item.rowId);
        }
        ctx.log('info', `${nameOf(item.path)}: its content is already in the backup, so it was linked and not copied again`);
        return { k: 'linked' };
      }
      const placed = await adoptVerifiedTemp({ tmp, final, size: item.size, expectedSha256: read.sha256, yieldNow, ops: drive.ops });
      if (!placed.ok) {
        if (placed.reason === 'short') return { k: 'retry', reason: 'The file was written shorter than it is.' };
        if (placed.reason === 'mismatch') return { k: 'retry', reason: `The copy did not read back the same from ${this.driveLabel}.` };
        if (placed.reason === 'exists') return { k: 'problem', reason: 'A different file is already at this name on the drive. It was not touched and this file was not copied.' };
        return { k: 'fail', reason: 'This name is inside the Backup Hub own-files folder, which is never written to.' };
      }
      this.record(item, st.mtimeMs, read.sha256);
      ctx.log('info', `${nameOf(item.path)}: copied and checked (SHA-256 ${read.sha256.slice(0, 12)}...)`);
      return { k: 'copied' };
    } catch (err) {
      if (err instanceof JobAborted || ctx.signal.aborted) throw err;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const side = (err as { side?: string }).side;
      if (side === 'source') {
        if (LOCKED_CODES.has(code)) return { k: 'inuse' };
        if (code === 'ENOENT' || code === 'ENOTDIR') return { k: 'gone' };
        return { k: 'retry', reason: `The file could not be read (${code || 'error'}).` };
      }
      if (code === 'ENOSPC') return { k: 'full' };
      if (err instanceof Error && err.name === 'DriveWriteProtectedError') return { k: 'fail', reason: err.message };
      if (DRIVE_TROUBLE.has(code) || /not plugged in/i.test((err as Error).message)) return { k: 'drive_gone' };
      throw err;
    }
  }

  /** A copy already in the backup with this content: one the plan found doubtful (checked against the drive's own bytes), else any with this checksum. */
  private async knownCopy(item: Item, sha256: string): Promise<{ id: number; origin: number | null } | null> {
    for (const c of item.candidates ?? []) {
      let theirs = c.sha256;
      if (theirs === null) {
        const file = this.drive.finalPath(c.relPath);
        if (!(await this.drive.ops.exists(file))) continue;
        try {
          theirs = await this.drive.ops.hash(file, turnOf(this.ctx));
        } catch (err) {
          if (this.ctx.signal.aborted) throw err;
          continue;
        }
      }
      if (theirs === sha256) {
        const origin = this.deps.db.prepare('SELECT origin_file_id FROM files WHERE id = ?').pluck().get(c.id) as number | null | undefined;
        return { id: c.id, origin: origin ?? null };
      }
    }
    return this.byContent(sha256, item.size);
  }

  // ---- the end -----------------------------------------------------------------------------------------------------------------

  private async finish(): Promise<FolderBackupReport> {
    const { deps, run, cp, ctx } = this;
    const finishedAt = this.now();
    let listPath: string | null = null;
    let listProblem: string | null = null;
    try {
      const pause = (): Promise<void> => ctx.yield();
      const rows = await finishSliced(listRowsSteps(deps.db, cp.runId), pause);
      listPath = await this.drive.writeList(`${cleanSegment(run.backupName)}/${runDate(new Date(finishedAt))}.csv`, await finishSliced(listCsvSteps(rows, FOLDER_LIST_HEADER), pause));
    } catch (err) {
      if (err instanceof JobAborted || ctx.signal.aborted) throw err;
      listProblem = `The list of this run could not be written to the drive (${(err as Error).message}). The copies themselves are fine.`;
      ctx.warn(listProblem);
    }
    const failedCount = Object.values(cp.failed).reduce((s, r) => s + r.count, 0);
    finishRun(deps.db, cp.runId, failedCount === 0 ? 'done' : cp.copied + cp.linked + cp.alreadyThere > 0 ? 'done_warnings' : 'failed', cp.copied, cp.bytes, JSON.stringify(cp.failedList.slice(0, 200)), finishedAt);
    const planned = run.onlineOnly ?? { files: 0, bytes: 0, examples: [] };
    const report: FolderBackupReport = {
      jobId: this.jobId,
      runId: cp.runId,
      backupName: run.backupName,
      sourceWords: run.phoneName,
      layout: run.flat === true ? 'flat' : 'dated',
      startedAt: cp.startedAt,
      finishedAt,
      copied: { files: cp.copied, bytes: cp.bytes },
      linked: cp.linked + cp.alreadyThere,
      inUse: lines(cp.inUse),
      inUseCount: cp.inUseCount,
      skipped: lines(cp.skipped),
      failed: lines(cp.failed),
      leftOut: run.leftOut,
      onlineOnly: { files: planned.files + cp.onlineOnlyFiles, bytes: planned.bytes + cp.onlineOnlyBytes, examples: planned.examples },
      where: cp.copied + cp.linked > 0 ? [`${this.driveLabel}: ${(run.sessionFolder === '' ? run.destRoot : `${run.destRoot}/${run.sessionFolder}`).split('/').join('\\')}`] : [],
      listPath,
      listProblem,
    };
    saveFolderReport(deps.db, this.jobId, report);
    ctx.log('info', `Copied and checked ${report.copied.files} files (${mb(report.copied.bytes)}); ${report.linked} already in the backup; ${report.inUseCount} in use; ${failedCount} failed.`);
    return report;
  }
}
