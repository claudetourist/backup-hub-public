/**
 * The run of a confirmed mirror (job `mirror.copy`, R1.3): the second drive is brought level with the first drive's backup folder. Per file, in this
 * order: the first drive's file must still be there with the size of the list; an earlier cut-off temp name of this file is settled; a file already
 * at the same place on the second drive (it was not there when the list was made) is compared (same checksum: linked, nothing copied; different: a
 * "Needs your decision" case, never replaced). Files that were already there with the same size are NOT in this job: "Check old copies" proves them (mirrorCheckRun.ts);
 * otherwise the first drive's file is READ ONCE, without the Windows cache, hashed while it is written to the temp name on the second drive; the
 * checksum read is compared with the one the file must have (the phone's, or its own recorded one: a mismatch means the first drive's copy looks damaged,
 * nothing is kept and a "Needs your decision" case is made); then the S1 sequence: flush, cache-free read-back compared, link into place (cannot
 * replace), flush, and only then the index row. A drive that goes away, USB trouble (Windows events 153 / 129) or the laptop sleeping pauses the run
 * at a safe point; Continue carries on without copying anything that is already done. Never deletes or changes anything on either drive.
 */
import { JobAborted, turnOf } from '../jobs/jobService';
import { adoptVerifiedTemp } from '../localCopy/verifiedCopy';
import { cleanSegment } from '../localCopy/localModel';
import { finishSliced } from '../sliceWork';
import { listCsvSteps, runDate } from '../phoneBackup/runCsv';
import { finishRun, startRun } from '../phoneBackup/runStore';
import { MIRROR_DAMAGED_PROBLEM, MIRROR_DIFFERS_PROBLEM, type MirrorReport, type MirrorReportBackup } from '../../shared/mirror';
import type { ReasonLine } from '../../shared/phoneBackup';
import { DriveWatch } from './mirrorWatch';
import { addMirrorProblem, linkMirrorCopy, listRowsSteps, recordMirrorCopy, type ConfirmedMirror } from './mirrorStore';
import type { MirrorCtx, MirrorDeps, MirrorDrive, MirrorItem } from './mirrorTypes';

export interface Reasons {
  [reason: string]: { count: number; examples: string[] };
}

interface PerBackup {
  copied: number;
  bytes: number;
  linked: number;
  damaged: number;
  different: number;
  failed: number;
}

/** What is kept at every file, so a Continue after a restart carries on (the index says what is done; this keeps the counts). */
export interface MirrorCheckpoint {
  startedAt: number;
  next: number;
  runIds: Record<string, number>;
  per: PerBackup[];
  ownChecksums: number;
  bytesDone: number;
  skipped: Reasons;
  failed: Reasons;
  usbPauses: number;
}

const MAX_EXAMPLES = 5;
const RECONNECT_LIMIT = 3;
export const DRIVE_TROUBLE = new Set(['EIO', 'ENODEV', 'ENXIO', 'ENOENT', 'EBUSY', 'UNKNOWN', 'ENOTCONN']);
const PROGRESS_EVERY_MS = 500;

export const note = (into: Reasons, reason: string, example: string): void => {
  const r = (into[reason] ??= { count: 0, examples: [] });
  r.count += 1;
  if (r.examples.length < MAX_EXAMPLES) r.examples.push(example);
};
export const lines = (r: Reasons): ReasonLine[] => Object.entries(r).map(([reason, v]) => ({ reason, count: v.count, examples: v.examples })).toSorted((a, b) => b.count - a.count);
export const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const mb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6).toLocaleString('en-US')} MB`);

export const emptyMirrorCheckpoint = (pairs: number): MirrorCheckpoint => ({ startedAt: 0, next: 0, runIds: {}, per: Array.from({ length: pairs }, () => ({ copied: 0, bytes: 0, linked: 0, damaged: 0, different: 0, failed: 0 })), ownChecksums: 0, bytesDone: 0, skipped: {}, failed: {}, usbPauses: 0 });

type Attempt = { k: 'copied' } | { k: 'linked' } | { k: 'retry'; reason: string } | { k: 'fail'; reason: string } | { k: 'damaged' } | { k: 'differs' } | { k: 'gone' } | { k: 'drive_gone' };

export class MirrorRun {
  private cp: MirrorCheckpoint;
  private readonly watch: DriveWatch;
  private readonly now: () => number;
  private bytesTotal = 0;
  private copyTotal = 0;

  constructor(
    private readonly deps: MirrorDeps,
    private readonly ctx: MirrorCtx,
    private readonly run: ConfirmedMirror,
    private readonly jobId: number,
    resume: Partial<MirrorCheckpoint> | null,
  ) {
    this.now = deps.now ?? Date.now;
    this.cp = { ...emptyMirrorCheckpoint(run.pairs.length), ...resume };
    this.watch = new DriveWatch(deps, ctx, run.pairs, 'copy', () => {
      this.cp.usbPauses += 1;
      ctx.checkpoint(this.cp);
    });
  }

  async execute(): Promise<MirrorReport> {
    const { deps, ctx, run } = this;
    const release = deps.keepAwake?.();
    try {
      if (this.cp.startedAt === 0) {
        this.cp.startedAt = this.now();
        ctx.checkpoint(this.cp);
      }
      // Only the files to copy count for progress and time left: the "different" ones are database notes at the end of the list.
      this.bytesTotal = run.items.reduce((s, i) => s + (i.kind === 'copy' ? i.size : 0), 0);
      const total = run.items.length;
      this.copyTotal = run.items.reduce((s, i) => s + (i.kind === 'copy' ? 1 : 0), 0);
      if (this.cp.next > 0) ctx.log('info', `Continuing at file ${Math.min(this.cp.next + 1, total)} of ${total}`);
      for (let i = this.cp.next; i < total; i += 1) {
        const item = run.items[i]!;
        await ctx.yield();
        await this.watch.afterSleep(item.b);
        await this.watch.usbCheck(item.b, false);
        await this.one(item, i);
        this.cp.next = i + 1;
        if (item.kind === 'copy') this.cp.bytesDone += item.size;
        ctx.checkpoint(this.cp);
        ctx.progress(Math.min(i + 1, this.copyTotal), this.copyTotal, { bytesDone: this.cp.bytesDone, bytesTotal: this.bytesTotal });
      }
      return await this.finish();
    } finally {
      release?.();
    }
  }

  // ---- one file ----------------------------------------------------------------------------------------------------------------

  private async one(item: MirrorItem, index: number): Promise<void> {
    const { ctx, cp } = this;
    const pair = this.run.pairs[item.b]!;
    const skip = (reason: string): void => note(cp.skipped, reason, item.rel);
    const where = `${pair.srcRoot}/${item.rel}`;
    if (item.kind === 'different') {
      if (addMirrorProblem(this.deps.db, item.srcRowId, MIRROR_DIFFERS_PROBLEM, this.now())) cp.per[item.b]!.different += 1;
      return;
    }
    const retries = this.deps.retries ?? 2;
    let tries = 0;
    let reconnects = 0;
    for (;;) {
      const { src, dst } = await this.watch.drivesOf(item.b);
      const size = await src.ops.sizeOf(src.finalPath(where));
      if (size === null) {
        if (!(await this.watch.stillThere(item.b))) {
          reconnects += 1;
          if (reconnects > RECONNECT_LIMIT) return this.fail(item, `The ${pair.srcLabel} kept going away while this file was copied.`);
          await this.watch.reconnect(item.b, 'drive');
          continue;
        }
        return skip(`It is not on the ${pair.srcLabel} any more.`);
      }
      if (size !== item.size) return skip(`It changed on the ${pair.srcLabel} after the list was made. The next look picks it up.`);
      ctx.progress(index, this.copyTotal, { bytesDone: cp.bytesDone, bytesTotal: this.bytesTotal, message: `Copying ${nameOf(item.rel)} (${index + 1} of ${this.copyTotal})` });
      const free = await dst.freeBytes();
      if (free !== null && free - item.size < 200_000_000) return this.fail(item, `${pair.dstLabel} is full.`);
      const r = await this.attempt(item, src, dst, index);
      switch (r.k) {
        case 'copied':
          cp.per[item.b]!.copied += 1;
          cp.per[item.b]!.bytes += item.size;
          if (!item.expected) cp.ownChecksums += 1;
          return;
        case 'linked':
          cp.per[item.b]!.linked += 1;
          if (!item.expected) cp.ownChecksums += 1;
          return;
        case 'damaged':
          cp.per[item.b]!.damaged += 1;
          ctx.warn(`${nameOf(item.rel)}: this copy on the ${pair.srcLabel} looks damaged, so it was not copied. See Needs your decision.`);
          return;
        case 'differs':
          cp.per[item.b]!.different += 1;
          ctx.warn(`${nameOf(item.rel)}: a different file is already on the ${pair.dstLabel}. It was not replaced. See Needs your decision.`);
          return;
        case 'gone':
          return skip(`It is not on the ${pair.srcLabel} any more.`);
        case 'fail':
          return this.fail(item, r.reason);
        case 'drive_gone':
          reconnects += 1;
          if (reconnects > RECONNECT_LIMIT) return this.fail(item, 'A drive kept going away while this file was copied.');
          await this.watch.usbCheck(item.b, true);
          await this.watch.reconnect(item.b, 'drive');
          tries = 0;
          continue;
        case 'retry':
          tries += 1;
          if (tries > retries) return this.fail(item, r.reason);
          ctx.log('warn', `${nameOf(item.rel)}: ${r.reason} Trying again (${tries} of ${retries}).`);
          await (this.deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms))))(1000 * tries);
      }
    }
  }

  private fail(item: MirrorItem, reason: string): void {
    note(this.cp.failed, reason, item.rel);
    this.cp.per[item.b]!.failed += 1;
    this.ctx.warn(`${nameOf(item.rel)}: ${reason}`);
  }

  private async attempt(item: MirrorItem, src: MirrorDrive, dst: MirrorDrive, index: number): Promise<Attempt> {
    const { ctx, deps } = this;
    const pair = this.run.pairs[item.b]!;
    const srcRel = `${pair.srcRoot}/${item.rel}`;
    const dstRel = `${pair.dstRoot}/${item.rel}`;
    const dstFinal = dst.finalPath(dstRel);
    const yieldNow = turnOf(ctx); // the middle of a file: a Pause waits for the file to be copied, checked and recorded
    const record = { dstPlaceId: pair.dstPlaceId, dstRel, size: item.size, mtimeMs: item.mtimeMs, originId: item.originId, srcRowId: item.srcRowId, runId: this.runId(item.b), now: 0 };
    try {
      let srcSha: string | null = item.sha256;
      const readSource = async (): Promise<string> => (srcSha ??= (await src.readFile(srcRel, () => undefined, yieldNow)).sha256);
      // An earlier cut-off copy of this name is finished or cleared first.
      await dst.settle(dstFinal, async () => (await dst.ops.exists(dstFinal)) && (await dst.ops.hash(dstFinal, yieldNow)) === (await readSource()));
      if (await dst.ops.exists(dstFinal)) {
        if ((await dst.ops.sizeOf(dstFinal)) !== item.size) return this.differs(item);
        const there = await dst.ops.hash(dstFinal, yieldNow);
        const want = await readSource();
        if (there !== want) return this.differs(item);
        linkMirrorCopy(deps.db, { ...record, sha256: want, now: this.now() });
        return { k: 'linked' };
      }
      await dst.ensureDir(dstFinal);
      const tmp = dst.tmpPath(dstFinal);
      const writer = await dst.openTemp(tmp);
      let read: { sha256: string; bytes: number };
      let reportedAt = 0;
      let blockBytes = 0;
      try {
        read = await src.readFile(
          srcRel,
          async (block) => {
            await writer.write(block);
            blockBytes += block.length;
            const t = this.now();
            if (t - reportedAt >= PROGRESS_EVERY_MS) {
              reportedAt = t;
              ctx.progress(index, this.copyTotal, { bytesDone: this.cp.bytesDone + blockBytes, bytesTotal: this.bytesTotal, message: `Copying ${nameOf(item.rel)} (${index + 1} of ${this.copyTotal})` });
            }
          },
          yieldNow,
        );
        await writer.finish(item.mtimeMs);
      } catch (err) {
        await writer.abort().catch(() => undefined);
        await dst.ops.removeTemp(tmp);
        throw err;
      }
      if (read.bytes !== item.size) {
        await dst.ops.removeTemp(tmp);
        return { k: 'retry', reason: `The file came back with another size than the list said.` };
      }
      // The first drive's copy must still be the one it was: the phone's checksum, or its own recorded one.
      if (item.sha256 !== null && read.sha256 !== item.sha256) {
        await dst.ops.removeTemp(tmp);
        addMirrorProblem(deps.db, item.srcRowId, MIRROR_DAMAGED_PROBLEM, this.now());
        return { k: 'damaged' };
      }
      const placed = await adoptVerifiedTemp({ tmp, final: dstFinal, size: item.size, expectedSha256: read.sha256, yieldNow, ops: dst.ops });
      if (!placed.ok) {
        if (placed.reason === 'short') return { k: 'retry', reason: 'The file was written shorter than it is.' };
        if (placed.reason === 'mismatch') return { k: 'retry', reason: `The copy did not read back the same from ${pair.dstLabel}.` };
        if (placed.reason === 'exists') return this.differs(item);
        return { k: 'fail', reason: 'This name is inside the Backup Hub own-files folder, which is never written to.' };
      }
      recordMirrorCopy(deps.db, { ...record, sha256: read.sha256, now: this.now() });
      ctx.log('info', `${nameOf(item.rel)}: copied and checked (SHA-256 ${read.sha256.slice(0, 12)}...)${item.expected ? '' : ' with the first drive\'s own checksum'}`);
      return { k: 'copied' };
    } catch (err) {
      if (err instanceof JobAborted || ctx.signal.aborted) throw err;
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOSPC') return { k: 'fail', reason: `${pair.dstLabel} is full.` };
      if (err instanceof Error && err.name === 'DriveWriteProtectedError') return { k: 'fail', reason: err.message };
      if (DRIVE_TROUBLE.has(code) || /not plugged in/i.test((err as Error).message)) return { k: 'drive_gone' };
      throw err;
    }
  }

  private differs(item: MirrorItem): Attempt {
    addMirrorProblem(this.deps.db, item.srcRowId, MIRROR_DIFFERS_PROBLEM, this.now());
    return { k: 'differs' };
  }

  /** The backup_runs row of a pair, made when its first file is handled. */
  private runId(b: number): number {
    const have = this.cp.runIds[String(b)];
    if (have !== undefined) return have;
    const pair = this.run.pairs[b]!;
    const id = startRun(this.deps.db, pair.backupId, pair.dstPlaceId, pair.dstRoot, this.now());
    this.cp.runIds[String(b)] = id;
    this.ctx.checkpoint(this.cp);
    return id;
  }

  // ---- the end -----------------------------------------------------------------------------------------------------------------

  private async finish(): Promise<MirrorReport> {
    const { deps, run, cp, ctx } = this;
    const finishedAt = this.now();
    const listPaths: string[] = [];
    let listProblem: string | null = null;
    const where: string[] = [];
    const backups: MirrorReportBackup[] = [];
    for (const [b, pair] of run.pairs.entries()) {
      const per = cp.per[b]!;
      const runId = cp.runIds[String(b)];
      if (runId === undefined) continue;
      backups.push({ backupId: pair.backupId, backupName: pair.backupName, targetLabel: pair.dstLabel, copied: { files: per.copied, bytes: per.bytes }, linked: per.linked, damaged: per.damaged, different: per.different, failed: per.failed });
      if (per.copied + per.linked > 0) where.push(`${pair.dstLabel}: ${pair.dstRoot.split('/').join('\\')}`);
      try {
        const found = await deps.drivesFor(pair.srcPlaceId, pair.dstPlaceId);
        if (!found.dst) throw new Error(`${pair.dstLabel} is not plugged in`);
        const pause = (): Promise<void> => ctx.yield();
        const rows = await finishSliced(listRowsSteps(deps.db, runId), pause);
        listPaths.push(await found.dst.writeList(`${cleanSegment(pair.backupName)}/${runDate(new Date(finishedAt))}.csv`, await finishSliced(listCsvSteps(rows), pause)));
      } catch (err) {
        if (err instanceof JobAborted || ctx.signal.aborted) throw err;
        listProblem = `The list of this run could not be written to the drive (${(err as Error).message}). The copies themselves are fine.`;
        ctx.warn(listProblem);
      }
      const bad = per.failed + per.damaged + per.different;
      finishRun(deps.db, runId, bad === 0 ? 'done' : per.copied + per.linked > 0 ? 'done_warnings' : 'failed', per.copied, per.bytes, '[]', finishedAt);
    }
    const sum = (f: (p: PerBackup) => number): number => cp.per.reduce((s, p) => s + f(p), 0);
    const report: MirrorReport = {
      jobId: this.jobId,
      startedAt: cp.startedAt,
      finishedAt,
      backups,
      copied: { files: sum((p) => p.copied), bytes: sum((p) => p.bytes) },
      linked: sum((p) => p.linked),
      damaged: sum((p) => p.damaged),
      different: sum((p) => p.different),
      ownChecksums: cp.ownChecksums,
      skipped: lines(cp.skipped),
      failed: lines(cp.failed),
      where,
      listPaths,
      listProblem,
      usbPauses: cp.usbPauses,
    };
    ctx.log('info', `Copied and checked ${report.copied.files} files (${mb(report.copied.bytes)}); ${report.linked} already there and the same; ${report.damaged} damaged on the first drive; ${report.different} different on the second.`);
    return report;
  }
}
