/**
 * The run of a confirmed phone backup (job `phone.backup`, R1.2a). Per file, in this order: the checksum is read ON THE PHONE (for the
 * next few files in copy order with ONE adb call, kept in memory; a file whose checksum is not there, or that is tried again, is read alone); a leftover
 * temp name of an earlier cut-off copy is settled; a file already at the final name is compared (same content: already there; different:
 * a Problem, never replaced); `adb pull` writes to the temp name under the drive's own files; the size is checked; the temp file is
 * flushed, read back from the drive without the cache and compared with the phone's checksum; it is linked into place (cannot replace);
 * the final file is flushed; only then the index row is written. A failed pull is tried again twice. The phone or the drive going away, or
 * the laptop sleeping, is treated like an unplug: the run stops at a safe point, waits for the person's Continue, looks again, and carries
 * on without copying anything that is already done. Never deletes, never overwrites.
 */
import { JobAborted, turnOf } from '../jobs/jobService';
import type { LookEntry } from '../look/compare';
import { runLook } from '../look/lookRun';
import type { DecisionKind } from '../look/lookGuard';
import { adoptVerifiedTemp } from '../localCopy/verifiedCopy';
import type { PhoneBackupReport, ReasonLine } from '../../shared/phoneBackup';
import { checkPhone } from './planJob';
import { nextBatch } from './checkOldRun';
import { RunProgress } from './runProgress';
import { finishSliced, writeSliced } from '../sliceWork';
import { listCsvSteps, runDate } from './runCsv';
import { cleanSegment } from '../localCopy/localModel';
import { finishRun, linkConfirmedCopy, recordCopy, runListRowsSteps, saveReport, startRun, type ConfirmedRun } from './runStore';
import type { BackupDrive } from './backupDrive';
import type { PhoneBackupDeps, RunCtx } from './phoneBackupTypes';

interface Reasons {
  [reason: string]: { count: number; examples: string[] };
}

/** What is kept at every file, so a Continue after a restart carries on (the index says what is done; this keeps the counts). */
export interface RunCheckpoint {
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
  failedList: { path: string; reason: string }[];
}

const MAX_EXAMPLES = 5;
const MAX_FAILED_LIST = 2000;
const RECONNECT_LIMIT = 3;
const DRIVE_TROUBLE = new Set(['EIO', 'ENODEV', 'ENXIO', 'ENOENT', 'EBUSY', 'UNKNOWN', 'ENOTCONN']);

const note = (into: Reasons, reason: string, example: string): void => {
  const r = (into[reason] ??= { count: 0, examples: [] });
  r.count += 1;
  if (r.examples.length < MAX_EXAMPLES) r.examples.push(example);
};
const lines = (r: Reasons): ReasonLine[] => Object.entries(r).map(([reason, v]) => ({ reason, count: v.count, examples: v.examples })).toSorted((a, b) => b.count - a.count);
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const mb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6).toLocaleString('en-US')} MB`);

export const emptyCheckpoint = (): RunCheckpoint => ({ runId: 0, startedAt: 0, next: 0, copied: 0, bytes: 0, alreadyThere: 0, linked: 0, linkedApplied: false, bytesDone: 0, skipped: {}, failed: {}, failedList: [] });

type Attempt = { k: 'copied' } | { k: 'already' } | { k: 'retry'; reason: string } | { k: 'fail'; reason: string } | { k: 'problem'; reason: string } | { k: 'phone_gone' } | { k: 'drive_gone' } | { k: 'full' };

export class PhoneBackupRun {
  private cp: RunCheckpoint;
  private entries = new Map<string, LookEntry>();
  private drive!: BackupDrive;
  private lastWake: number;
  private full = false;
  /** Phone checksums read ahead, in one adb call for the next files in copy order (path -> sha256). In memory only: never part of the checkpoint. */
  private readonly ahead = new Map<string, string>();
  /** After a failed batch call the run reads each file alone until this copy-order index, then tries a batch again. */
  private aheadPausedUntil = 0;
  private readonly now: () => number;
  /** What the window shows while the copy runs (read only). */
  readonly progress: RunProgress;

  constructor(
    private readonly deps: PhoneBackupDeps,
    private readonly ctx: RunCtx,
    private readonly run: ConfirmedRun,
    private readonly jobId: number,
    resume: Partial<RunCheckpoint> | null,
  ) {
    this.now = deps.now ?? Date.now;
    this.cp = { ...emptyCheckpoint(), ...resume };
    this.lastWake = deps.wakeCount?.() ?? 0;
    this.progress = new RunProgress(run.items, this.cp.next, this.cp.failedList);
  }

  async execute(): Promise<PhoneBackupReport> {
    const { deps, ctx, run } = this;
    const release = deps.keepAwake?.();
    try {
      if (this.cp.runId === 0) {
        this.cp.runId = startRun(deps.db, run.backupId, run.destPlaceId, run.sessionFolder, this.now());
        this.cp.startedAt = this.now();
        ctx.checkpoint(this.cp);
      }
      await this.getDrive();
      await this.refresh();
      await this.applyRelinks();
      const total = run.items.length;
      const bytesTotal = run.items.reduce((s, i) => s + i.size, 0);
      if (this.cp.next > 0) ctx.log('info', `Continuing at file ${Math.min(this.cp.next + 1, total)} of ${total}`);
      for (let i = this.cp.next; i < total; i += 1) {
        const item = run.items[i]!;
        await ctx.yield();
        if ((deps.wakeCount?.() ?? 0) !== this.lastWake) {
          this.lastWake = deps.wakeCount?.() ?? 0;
          ctx.log('info', 'The laptop slept. Looking at the phone and the drive again before going on.');
          await this.reconnect('sleep');
        }
        this.progress.begin(i);
        await this.readAhead(i);
        await this.one(item, i, total, bytesTotal);
        this.ahead.delete(item.path);
        this.cp.next = i + 1;
        this.cp.bytesDone += item.size;
        ctx.checkpoint(this.cp);
        ctx.progress(i + 1, total, { bytesDone: this.cp.bytesDone, bytesTotal });
      }
      return await this.finish();
    } finally {
      release?.();
      this.progress.end();
    }
  }

  // ---- the drive and the phone -------------------------------------------------------------------------------------------------

  private async getDrive(): Promise<void> {
    for (;;) {
      const found = await this.deps.driveFor(this.run.destPlaceId);
      if (found) {
        this.drive = found.drive;
        return;
      }
      await this.ctx.needsYou('The drive for this backup is not plugged in. Plug it in, then press Continue. Nothing is lost; the copy carries on where it stopped.', ['Continue']);
    }
  }

  /** The phone's own look, again: what is on the phone now (also recorded in the index) and what is already backed up. */
  private async refresh(): Promise<void> {
    const { deps, run, ctx } = this;
    // Whatever was read ahead belongs to the phone as it was before: after a look again, every file is read afresh.
    this.ahead.clear();
    this.aheadPausedUntil = 0;
    for (;;) {
      const checked = await checkPhone(deps, run.serial);
      if (checked.problem === null) {
        const report = await runLook({
          db: deps.db,
          placeId: run.phonePlaceId,
          serial: run.serial,
          folders: run.folders,
          run: deps.adb.listRunner(),
          changeRule: 'size_and_date',
          backupProfileId: run.backupId,
          accept: run.accept as DecisionKind[],
          allowRoot: true,
          now: this.now,
          signal: ctx.signal,
          pause: () => ctx.yield(),
        });
        if (report.outcome.ok) {
          this.entries = new Map(report.outcome.compare.entries.map((e) => [e.path, e]));
          return;
        }
        await ctx.needsYou(`${report.outcome.decision.plain} Press Continue to check again.`, ['Continue']);
        continue;
      }
      await ctx.needsYou(`${checked.problem} Then press Continue. Nothing is lost; the copy carries on where it stopped.`, ['Continue']);
    }
  }

  /** Like an unplug: wait for the person when the phone or the drive is not there, then look again. */
  private async reconnect(why: 'sleep' | 'phone' | 'drive'): Promise<void> {
    if (why === 'drive') await this.getDriveAgain();
    else await this.getDrive();
    await this.refresh();
  }

  private async getDriveAgain(): Promise<void> {
    await this.ctx.needsYou('The drive was unplugged or stopped answering. Plug it in, then press Continue. Nothing is lost; the copy carries on where it stopped.', ['Continue']);
    await this.getDrive();
  }

  private async applyRelinks(): Promise<void> {
    if (this.cp.linkedApplied) return;
    let n = 0;
    const { db } = this.deps;
    // Thousands of links in one go froze the window: short transactions with turns between them (sliceWork.ts).
    await writeSliced(this.run.relinks, (slice) => {
      db.transaction(() => {
        for (const r of slice) if (linkConfirmedCopy(db, r.copyRowId, r.phoneRowId, r.sha256, this.cp.runId, this.now())) n += 1;
      }).immediate();
    }, { pause: () => this.ctx.yield() });
    this.cp.linked = n;
    this.cp.linkedApplied = true;
    this.ctx.checkpoint(this.cp);
    if (n > 0) this.ctx.log('info', `${n} files were already on the drive; the phone's checksum confirmed them, so they were linked and not copied again.`);
  }

  // ---- the phone's checksums, many files per adb call --------------------------------------------------------------------------

  /** Will this file get as far as a checksum? (It is still on the phone as confirmed, not backed up already, and the drive has room.) */
  private wantsChecksum(item: ConfirmedRun['items'][number]): boolean {
    const e = this.entries.get(item.path);
    return !this.full && e !== undefined && e.destinations[0]?.backedUp !== true && e.size === item.size && Math.abs(e.mtimeSec - item.mtimeSec) <= 2;
  }

  /**
   * A file costs about 0.4 s of fixed adb time whatever its size, and one call per file for the checksum was half of it: so when the checksum
   * of this file is not known yet, the checksums of the next files in copy order are read with ONE call (the same `sha256Many` and the same
   * limits as "Check old copies": 40 files, 512 MB, 12,000 characters of paths) and kept in memory. Each file is then pulled and verified
   * exactly as before: the drive's read-back must equal the phone's checksum, so a file that changed after its checksum was read simply fails the
   * comparison and is tried again with a checksum read alone. Any trouble with the call (the phone away, adb stopped, a file with no answer)
   * only means those files are read alone, as they always were.
   */
  private async readAhead(index: number): Promise<void> {
    const { deps, run, ctx } = this;
    const first = run.items[index]!;
    if (this.ahead.has(first.path) || index < this.aheadPausedUntil || !this.wantsChecksum(first)) return;
    const wanted: ConfirmedRun['items'] = [];
    for (let j = index; j < run.items.length && j < index + 400 && wanted.length < 100; j += 1) if (this.wantsChecksum(run.items[j]!)) wanted.push(run.items[j]!);
    const batch = wanted.slice(0, nextBatch(wanted, 0));
    if (batch.length < 2) return;
    try {
      const answer = await deps.adb.sha256Many(run.serial, batch.map((b) => b.path), ctx.signal, batch.reduce((s, b) => s + b.size, 0));
      if (answer.adbError !== null) {
        this.aheadPausedUntil = index + batch.length;
        return;
      }
      for (const b of batch) {
        const a = answer.answers.get(b.path);
        if (a?.kind === 'sha256') this.ahead.set(b.path, a.sha256);
      }
    } catch (err) {
      if (err instanceof JobAborted || ctx.signal.aborted) throw err;
      this.aheadPausedUntil = index + batch.length;
    }
  }

  // ---- one file ----------------------------------------------------------------------------------------------------------------

  private async one(item: ConfirmedRun['items'][number], index: number, total: number, bytesTotal: number): Promise<void> {
    const { ctx, cp } = this;
    const skip = (reason: string): void => {
      note(cp.skipped, reason, item.path);
      this.progress.fail(reason);
    };
    const e = this.entries.get(item.path);
    if (!e) return skip('It is not on the phone any more.');
    if (e.destinations[0]?.backedUp === true) {
      cp.alreadyThere += 1;
      this.progress.done();
      return;
    }
    if (e.size !== item.size || Math.abs(e.mtimeSec - item.mtimeSec) > 2) return skip('It changed on the phone after the preview. The next backup picks it up.');
    if (this.full) return skip('The drive is full.');
    const free = await this.drive.freeBytes();
    if (free !== null && free - item.size < 200_000_000) {
      this.full = true;
      ctx.warn(`The drive has no room left. The remaining files were not copied.`);
      return skip('The drive is full.');
    }
    const retries = this.deps.retries ?? 2;
    let tries = 0;
    let reconnects = 0;
    for (;;) {
      ctx.progress(index, total, { bytesDone: cp.bytesDone, bytesTotal, message: `Copying ${nameOf(item.path)} (${index + 1} of ${total})` });
      const r = await this.attempt(item, tries === 0 && reconnects === 0);
      if (r.k === 'copied') {
        cp.copied += 1;
        cp.bytes += item.size;
        this.progress.done();
        return;
      }
      if (r.k === 'already') {
        cp.alreadyThere += 1;
        this.progress.done();
        return;
      }
      if (r.k === 'full') {
        this.full = true;
        ctx.warn('The drive is full. The remaining files were not copied.');
        return skip('The drive is full.');
      }
      if (r.k === 'problem') return this.fail(item, r.reason);
      if (r.k === 'fail') return this.fail(item, r.reason);
      if (r.k === 'phone_gone' || r.k === 'drive_gone') {
        reconnects += 1;
        if (reconnects > RECONNECT_LIMIT) return this.fail(item, r.k === 'phone_gone' ? 'The phone kept going away while this file was copied.' : 'The drive kept going away while this file was copied.');
        await this.reconnect(r.k === 'phone_gone' ? 'phone' : 'drive');
        const again = this.entries.get(item.path);
        if (!again) return skip('It is not on the phone any more.');
        if (again.destinations[0]?.backedUp === true) {
          cp.alreadyThere += 1;
          this.progress.done();
          return;
        }
        if (again.size !== item.size || Math.abs(again.mtimeSec - item.mtimeSec) > 2) return skip('It changed on the phone after the preview. The next backup picks it up.');
        tries = 0;
        continue;
      }
      tries += 1;
      if (tries > retries) return this.fail(item, r.reason);
      ctx.log('warn', `${nameOf(item.path)}: ${r.reason} Trying again (${tries} of ${retries}).`);
      await (this.deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms))))(1000 * tries);
    }
  }

  private fail(item: ConfirmedRun['items'][number], reason: string): void {
    note(this.cp.failed, reason, item.path);
    if (this.cp.failedList.length < MAX_FAILED_LIST) this.cp.failedList.push({ path: item.path, reason });
    this.ctx.warn(`${nameOf(item.path)}: ${reason}`);
    this.progress.fail(reason);
  }

  private async attempt(item: ConfirmedRun['items'][number], useAhead: boolean): Promise<Attempt> {
    const { deps, run, ctx, drive } = this;
    const final = drive.finalPath(item.destRel);
    const yieldNow = turnOf(ctx); // the middle of a file: a Pause waits for the file to be copied, checked and recorded
    try {
      // The checksum read ahead is used once, for the first try only: a file tried again (the copy did not match) is read alone, afresh.
      const readAhead = this.ahead.get(item.path);
      this.ahead.delete(item.path);
      const phoneSha = useAhead && readAhead !== undefined ? readAhead : await deps.adb.sha256(run.serial, item.path, ctx.signal);
      if (phoneSha === null) {
        const gone = (await checkPhone(deps, run.serial)).problem !== null;
        return gone ? { k: 'phone_gone' } : { k: 'retry', reason: "The phone could not give this file's checksum." };
      }
      // An earlier cut-off copy of this name is finished or cleared first; a file at the name is compared, never replaced.
      await drive.settle(final, async () => (await drive.ops.exists(final)) && (await drive.ops.hash(final, yieldNow)) === phoneSha);
      if (await drive.ops.exists(final)) {
        const there = await drive.ops.hash(final, yieldNow);
        if (there !== phoneSha) return { k: 'problem', reason: 'A different file is already at this name on the drive. It was not touched and this file was not copied.' };
        this.record(item, final, phoneSha);
        return { k: 'already' };
      }
      await drive.ensureDir(final);
      const tmp = drive.tmpPath(final);
      try {
        await deps.adb.pull(run.serial, item.path, tmp, ctx.signal, item.size);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        await drive.ops.removeTemp(tmp);
        if (/no space left/i.test((err as Error).message)) return { k: 'full' };
        if ((await checkPhone(deps, run.serial)).problem !== null) return { k: 'phone_gone' };
        return { k: 'retry', reason: 'The copy from the phone did not finish.' };
      }
      const placed = await adoptVerifiedTemp({ tmp, final, size: item.size, expectedSha256: phoneSha, yieldNow, ops: drive.ops });
      if (!placed.ok) {
        if (placed.reason === 'short') return { k: 'retry', reason: 'The file came back shorter than the phone said.' };
        if (placed.reason === 'mismatch') return { k: 'retry', reason: "The copy did not match the phone's checksum." };
        if (placed.reason === 'exists') return { k: 'problem', reason: 'A different file appeared at this name on the drive meanwhile. It was not touched.' };
        return { k: 'fail', reason: 'This name is inside the Backup Hub own-files folder, which is never written to.' };
      }
      this.record(item, final, phoneSha);
      ctx.log('info', `${nameOf(item.path)}: copied and checked (SHA-256 ${phoneSha.slice(0, 12)}...)`);
      return { k: 'copied' };
    } catch (err) {
      if (err instanceof JobAborted || ctx.signal.aborted) throw err;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOSPC') return { k: 'full' };
      if (err instanceof Error && err.name === 'DriveWriteProtectedError') return { k: 'fail', reason: err.message };
      if (DRIVE_TROUBLE.has(code) || /not plugged in/i.test((err as Error).message)) return { k: 'drive_gone' };
      throw err;
    }
  }

  private record(item: ConfirmedRun['items'][number], final: string, sha256: string): void {
    void final;
    recordCopy(this.deps.db, {
      destPlaceId: this.run.destPlaceId,
      destRel: item.destRel,
      size: item.size,
      mtimeMs: item.mtimeSec * 1000,
      sha256,
      phoneRowId: item.rowId,
      runId: this.cp.runId,
      now: this.now(),
    });
  }

  // ---- the end -----------------------------------------------------------------------------------------------------------------

  private async finish(): Promise<PhoneBackupReport> {
    const { deps, run, cp, ctx } = this;
    const finishedAt = this.now();
    let listPath: string | null = null;
    let listProblem: string | null = null;
    try {
      const pause = (): Promise<void> => ctx.yield();
      const rows = await finishSliced(runListRowsSteps(deps.db, cp.runId), pause);
      listPath = await this.drive.writeList(`${cleanSegment(run.backupName)}/${runDate(new Date(finishedAt))}.csv`, await finishSliced(listCsvSteps(rows), pause));
    } catch (err) {
      if (err instanceof JobAborted || ctx.signal.aborted) throw err;
      listProblem = `The list of this run could not be written to the drive (${(err as Error).message}). The copies themselves are fine.`;
      ctx.warn(listProblem);
    }
    const label = (deps.db.prepare('SELECT label FROM places WHERE id = ?').pluck().get(run.destPlaceId) as string | undefined) ?? 'the drive';
    const failedCount = Object.values(cp.failed).reduce((s, r) => s + r.count, 0);
    const report: PhoneBackupReport = {
      jobId: this.jobId,
      runId: cp.runId,
      backupName: run.backupName,
      phoneName: run.phoneName,
      startedAt: cp.startedAt,
      finishedAt,
      copied: { files: cp.copied, bytes: cp.bytes },
      linked: cp.linked + cp.alreadyThere,
      skipped: lines(cp.skipped),
      failed: lines(cp.failed),
      leftOut: run.leftOut,
      where: cp.copied + cp.linked + cp.alreadyThere > 0 ? [`${label}: ${run.destRoot.split('/').join('\\')}\\${run.sessionFolder}`] : [],
      notCovered: run.notCovered,
      listPath,
      listProblem,
    };
    finishRun(deps.db, cp.runId, failedCount === 0 ? 'done' : cp.copied + cp.linked + cp.alreadyThere > 0 ? 'done_warnings' : 'failed', cp.copied, cp.bytes, JSON.stringify(cp.failedList), finishedAt);
    saveReport(deps.db, this.jobId, report);
    ctx.log('info', `Copied and checked ${cp.copied} files (${mb(cp.bytes)}); ${cp.linked + cp.alreadyThere} already on the drive; ${failedCount} failed.`);
    return report;
  }
}
