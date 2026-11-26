/**
 * The run of a confirmed "Check old copies" (job `mirror.checkOld`, R1.3b): the files that were already on the second drive with the same size (old copies
 * of an older tool) are PROVEN. Per file the second drive's copy is read once, without the Windows cache, streaming; the first drive's file is read at the
 * same time ONLY when its checksum is not known (the phone's expected one, or one proven earlier): the report says how many needed one read and how many
 * two. Same checksum: the second drive's file becomes a verified copy (index row as the copy job links it). Another checksum: never replaced, a "Needs your
 * decision" case. Nothing is written to either drive, nothing is deleted or replaced; the first drive's files are never touched.
 *
 * Photos and videos come first, then documents, then the rest (the list is in that order), so a stop part-way has the valuable ones proven. The index is
 * written in batches (a few hundred files in one transaction, in turns for the window): a hard kill loses at most the last batch, which is read again on
 * Continue; the checkpoint only ever names files whose rows are written. A drive that goes away, USB trouble or sleep pauses at a safe point like the copy.
 */
import { JobAborted, turnOf } from '../jobs/jobService';
import { writeSliced } from '../sliceWork';
import { MIRROR_CHECK_GROUP_WORDS, MIRROR_CHECK_GROUPS, checkGroupOf, type MirrorCheckGroup, type MirrorCheckReport, type MirrorCheckReportBackup } from '../../shared/mirrorCheck';
import { DRIVE_TROUBLE, lines, nameOf, note, type Reasons } from './mirrorRun';
import { recordCheckedBatch, type CheckedLink, type ConfirmedMirror } from './mirrorStore';
import { DriveWatch } from './mirrorWatch';
import type { MirrorCtx, MirrorDeps, MirrorDrive, MirrorItem } from './mirrorTypes';

interface PerBackup {
  verified: number;
  differs: number;
  skipped: number;
  failed: number;
}

/** What is kept when the index is written, so a Continue after a restart carries on. */
export interface CheckCheckpoint {
  startedAt: number;
  next: number;
  per: PerBackup[];
  oneRead: number;
  twoReads: number;
  /** Files looked at so far, per group (photos and videos, documents, other). */
  done: [number, number, number];
  skipped: Reasons;
  failed: Reasons;
  usbPauses: number;
}

/** Rows written in one go, and how long at most a result waits for its batch. */
export const CHECK_BATCH = 500;
export const CHECK_FLUSH_MS = 20_000;
/** Rows in one transaction: a transaction is a block of the window's thread, so a batch is written in pieces with a turn between them. */
export const CHECK_TX_ROWS = 250;
const PROGRESS_EVERY_MS = 400;
/**
 * Small files are read a few at a time (the next ones are started while the first is still being read): per file the time is mostly waiting for the
 * drive, not reading, so several in flight keep it busy. Files over SMALL_FILE bytes are read alone and in order (a big sequential read is not mixed
 * with others: that makes a spinning disk seek). The results are still used one at a time, in list order.
 */
export const CHECK_AHEAD = 4;
export const SMALL_FILE = 16 * 1024 * 1024;
const RECONNECT_LIMIT = 3;
const MAX_WARNINGS = 20;
/** A file that cannot be read for its own reason (not the drive going away): counted as failed, the check goes on. */
const FILE_TROUBLE = new Set(['EACCES', 'EPERM', 'EISDIR', 'ENAMETOOLONG', 'EMFILE', 'ENOTDIR']);

export const emptyCheckCheckpoint = (pairs: number): CheckCheckpoint => ({ startedAt: 0, next: 0, per: Array.from({ length: pairs }, () => ({ verified: 0, differs: 0, skipped: 0, failed: 0 })), oneRead: 0, twoReads: 0, done: [0, 0, 0], skipped: {}, failed: {}, usbPauses: 0 });

const groupIndex = (item: MirrorItem): number => MIRROR_CHECK_GROUPS.indexOf(item.group ?? checkGroupOf(item.rel));
const noop = (): void => undefined;
const formatNumber = (n: number): string => n.toLocaleString('en-US');

type Read = { sha256: string; bytes: number };
interface Pair {
  epoch: number;
  d: PromiseSettledResult<Read>;
  s: PromiseSettledResult<Read | null>;
}

type Outcome = { k: 'verified' } | { k: 'differs' } | { k: 'skip'; reason: string } | { k: 'fail'; reason: string };

export class MirrorCheckRun {
  private live: CheckCheckpoint;
  private readonly watch: DriveWatch;
  private readonly now: () => number;
  private readonly totals: [number, number, number] = [0, 0, 0];
  private links: CheckedLink[] = [];
  private differs: { srcRowId: number; now: number }[] = [];
  private lastFlush: number;
  /** Rows per write transaction, learned from the last writes (sliceWork `writeSliced`). */
  private readonly writeRows = { rows: 2 };
  private lastProgress = Number.NEGATIVE_INFINITY;
  /** Reads already started for the next files (by index), and which "drives were reconnected" round they belong to. */
  private readonly ahead = new Map<number, Promise<Pair>>();
  private epoch = 0;
  private warned = 0;
  private finishedAt = 0;

  constructor(
    private readonly deps: MirrorDeps,
    private readonly ctx: MirrorCtx,
    private readonly run: ConfirmedMirror,
    private readonly jobId: number,
    resume: Partial<CheckCheckpoint> | null,
  ) {
    this.now = deps.now ?? Date.now;
    this.live = JSON.parse(JSON.stringify({ ...emptyCheckCheckpoint(run.pairs.length), ...resume })) as CheckCheckpoint;
    this.lastFlush = this.now();
    this.watch = new DriveWatch(deps, ctx, run.pairs, 'check', () => {
      this.live.usbPauses += 1;
    });
  }

  async execute(): Promise<MirrorCheckReport> {
    const { deps, ctx, run, live } = this;
    const release = deps.keepAwake?.();
    // A Pause holds at the top of the file loop: the results waiting for their batch are written and the checkpoint saved first.
    ctx.beforeHold?.(() => this.flush(false));
    try {
      if (live.startedAt === 0) {
        live.startedAt = this.now();
        ctx.checkpoint(live);
      }
      for (const i of run.items) this.totals[groupIndex(i)]! += 1;
      const total = run.items.length;
      if (live.next > 0) ctx.log('info', `Continuing at file ${Math.min(live.next + 1, total)} of ${total}`);
      this.progress(true);
      for (let i = live.next; i < total; i += 1) {
        const item = run.items[i]!;
        await ctx.yield();
        const was = this.watch.round;
        await this.watch.afterSleep(item.b);
        await this.watch.usbCheck(item.b, false);
        if (this.watch.round !== was) {
          this.epoch += 1;
          this.ahead.clear();
        }
        await this.one(item, i);
        live.done[groupIndex(item)]! += 1;
        live.next = i + 1;
        this.progress(false);
        if (this.links.length + this.differs.length >= CHECK_BATCH || this.now() - this.lastFlush >= CHECK_FLUSH_MS) await this.flush(true);
      }
      await this.flush(true);
      this.progress(true);
      this.finishedAt = this.now();
      const report = this.report(true);
      ctx.log('info', `Checked ${formatNumber(report.verified + report.differs)} files: ${formatNumber(report.verified)} the same, ${formatNumber(report.differs)} different; ${formatNumber(report.oneRead)} needed one read, ${formatNumber(report.twoReads)} two.`);
      return report;
    } catch (err) {
      // A stop (or the app closing) keeps what was proven. A kill does not get here: the rows of its last batch are read again on Continue.
      if (err instanceof JobAborted || this.ctx.signal.aborted) await this.flush(false);
      throw err;
    } finally {
      release?.();
    }
  }

  /** What was proven so far (a stop leaves this as the report). */
  partialReport(): MirrorCheckReport {
    this.finishedAt = this.now();
    return this.report(false);
  }

  // ---- one file ----------------------------------------------------------------------------------------------------------------

  /** The second drive's file is always read; the first drive's only when its checksum is not known. Both at the same time (two different drives). Never throws. */
  private read(item: MirrorItem, drives: { src: MirrorDrive; dst: MirrorDrive }): Promise<Pair> {
    const pair = this.run.pairs[item.b]!;
    const yieldNow = turnOf(this.ctx); // reads are read only, but a Pause still waits for the file in turn
    const epoch = this.epoch;
    return Promise.allSettled([drives.dst.readFile(`${pair.dstRoot}/${item.rel}`, noop, yieldNow), item.sha256 === null ? drives.src.readFile(`${pair.srcRoot}/${item.rel}`, noop, yieldNow) : Promise.resolve(null)]).then(([d, s]) => ({ epoch, d, s }));
  }

  /** Starts the reads of the next few small files (only on drives that are already connected: waiting for a plug is the file in turn's business). */
  private startAhead(index: number): void {
    const items = this.run.items;
    if (items[index]!.size > SMALL_FILE) return;
    for (let j = index + 1; j < Math.min(items.length, index + 1 + CHECK_AHEAD); j += 1) {
      const next = items[j]!;
      if (next.size > SMALL_FILE) return;
      if (this.ahead.has(j)) continue;
      const drives = this.watch.connected(next.b);
      if (!drives) return;
      this.ahead.set(j, this.read(next, drives));
    }
  }

  private async one(item: MirrorItem, index: number): Promise<void> {
    const { ctx, live, run } = this;
    const pair = run.pairs[item.b]!;
    const per = live.per[item.b]!;
    const dstRel = `${pair.dstRoot}/${item.rel}`;
    let reconnects = 0;
    for (;;) {
      const drives = await this.watch.drivesOf(item.b);
      let started = this.ahead.get(index);
      this.ahead.delete(index);
      if (!started || (await started).epoch !== this.epoch) started = this.read(item, drives);
      this.startAhead(index);
      const { d, s } = await started;
      const failed = d.status === 'rejected' ? { err: d.reason as unknown, label: pair.dstLabel } : s.status === 'rejected' ? { err: s.reason as unknown, label: pair.srcLabel } : null;
      let outcome: Outcome;
      if (failed) {
        const c = await this.classify(failed.err, item.b, failed.label);
        if (c === 'drive') {
          reconnects += 1;
          if (reconnects > RECONNECT_LIMIT) outcome = { k: 'fail', reason: 'A drive kept going away while this file was checked.' };
          else {
            await this.watch.usbCheck(item.b, true);
            await this.watch.reconnect(item.b, 'drive');
            this.epoch += 1;
            this.ahead.clear();
            continue;
          }
        } else outcome = c;
      } else {
        const dr = (d as PromiseFulfilledResult<{ sha256: string; bytes: number }>).value;
        const sr = (s as PromiseFulfilledResult<{ sha256: string; bytes: number } | null>).value;
        if (dr.bytes !== item.size) outcome = { k: 'skip', reason: `It changed on the ${pair.dstLabel} after the list was made. Make a new list, then check again.` };
        else if (sr && sr.bytes !== item.size) outcome = { k: 'skip', reason: `It changed on the ${pair.srcLabel} after the list was made. Make a new list, then check again.` };
        else {
          if (sr) live.twoReads += 1;
          else live.oneRead += 1;
          const want = item.sha256 ?? sr!.sha256;
          if (dr.sha256 === want) {
            this.links.push({ dstPlaceId: pair.dstPlaceId, dstRel, size: item.size, mtimeMs: item.mtimeMs, sha256: want, originId: item.originId, srcRowId: item.srcRowId, srcRead: sr !== null, now: this.now() });
            outcome = { k: 'verified' };
          } else {
            this.differs.push({ srcRowId: item.srcRowId, now: this.now() });
            outcome = { k: 'differs' };
          }
        }
      }
      switch (outcome.k) {
        case 'verified':
          per.verified += 1;
          return;
        case 'differs':
          per.differs += 1;
          if (this.warned < MAX_WARNINGS) {
            this.warned += 1;
            ctx.warn(`${nameOf(item.rel)}: a different file is already on the ${pair.dstLabel}. It was not replaced. See Needs your decision.`);
          }
          return;
        case 'skip':
          per.skipped += 1;
          note(live.skipped, outcome.reason, item.rel);
          return;
        case 'fail':
          per.failed += 1;
          note(live.failed, outcome.reason, item.rel);
          if (this.warned < MAX_WARNINGS) {
            this.warned += 1;
            ctx.warn(`${nameOf(item.rel)}: ${outcome.reason}`);
          }
          return;
      }
    }
  }

  /** What a read that failed means: the drive went away, the file is not there, or the file cannot be read. Anything else is not ours to hide. */
  private async classify(err: unknown, b: number, label: string): Promise<'drive' | Outcome> {
    if (err instanceof JobAborted || this.ctx.signal.aborted) throw err;
    const code = (err as NodeJS.ErrnoException).code ?? '';
    const message = err instanceof Error ? err.message : String(err);
    if (/not plugged in/i.test(message)) return 'drive';
    if (code === 'ENOENT' || /ENOENT/.test(message)) return (await this.watch.stillThere(b)) ? { k: 'skip', reason: `It is not on the ${label} any more. The next look and copy picks it up.` } : 'drive';
    if (DRIVE_TROUBLE.has(code)) return 'drive';
    if (FILE_TROUBLE.has(code)) return { k: 'fail', reason: `The file could not be read from the ${label} (${code}).` };
    throw err;
  }

  // ---- the index, in batches ---------------------------------------------------------------------------------------------------

  /** Writes what is waiting, a few hundred rows per transaction, then saves the checkpoint (it names only files whose rows are written). */
  private async flush(giveTurns: boolean): Promise<void> {
    const links = this.links;
    const differs = this.differs;
    this.links = [];
    this.differs = [];
    // Short transactions that adapt to how long a row takes (sliceWork.ts `writeSliced`), CHECK_TX_ROWS at most; no turns when the job is ending.
    const pause = giveTurns ? () => this.ctx.yield() : () => Promise.resolve();
    await writeSliced(links, (slice) => recordCheckedBatch(this.deps.db, slice, []), { pause, maxRows: CHECK_TX_ROWS, memo: this.writeRows });
    await writeSliced(differs, (slice) => recordCheckedBatch(this.deps.db, [], slice), { pause, maxRows: CHECK_TX_ROWS, memo: this.writeRows });
    this.lastFlush = this.now();
    this.ctx.checkpoint(this.live);
  }

  private progress(force: boolean): void {
    const t = this.now();
    if (!force && t - this.lastProgress < PROGRESS_EVERY_MS) return;
    this.lastProgress = t;
    this.ctx.progress(this.live.next, this.run.items.length, { message: this.sentence() });
  }

  /** "Checked so far: photos and videos 12,340 of 18,000 · documents 40 of 2,000 · other files 0 of 20,000". */
  private sentence(): string {
    const parts = MIRROR_CHECK_GROUPS.filter((_, g) => this.totals[g]! > 0).map((g) => `${MIRROR_CHECK_GROUP_WORDS[g]} ${formatNumber(this.live.done[MIRROR_CHECK_GROUPS.indexOf(g)]!)} of ${formatNumber(this.totals[MIRROR_CHECK_GROUPS.indexOf(g)]!)}`);
    return `Checked so far: ${parts.join(' · ')}`;
  }

  // ---- the end -----------------------------------------------------------------------------------------------------------------

  private report(complete: boolean): MirrorCheckReport {
    const { live, run } = this;
    const sum = (f: (p: PerBackup) => number): number => live.per.reduce((s, p) => s + f(p), 0);
    const backups: MirrorCheckReportBackup[] = run.pairs.map((pair, b) => ({ backupId: pair.backupId, backupName: pair.backupName, targetLabel: pair.dstLabel, verified: live.per[b]!.verified, differs: live.per[b]!.differs, skipped: live.per[b]!.skipped, failed: live.per[b]!.failed }));
    const groups = MIRROR_CHECK_GROUPS.map((group: MirrorCheckGroup, g) => ({ group, done: live.done[g]!, total: this.totals[g]! })).filter((g) => g.total > 0);
    return {
      jobId: this.jobId,
      startedAt: live.startedAt,
      finishedAt: this.finishedAt,
      complete,
      backups,
      verified: sum((p) => p.verified),
      differs: sum((p) => p.differs),
      oneRead: live.oneRead,
      twoReads: live.twoReads,
      groups,
      skipped: lines(live.skipped),
      failed: lines(live.failed),
      usbPauses: live.usbPauses,
    };
  }
}
