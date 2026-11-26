/**
 * The run of "Check old copies" (job `phone.checkOld`, R1.4b). For copies on the drive that came in from the old tool and were never
 * compared: the checksum is read ON THE PHONE (many files per adb call, every path quoted by `quotePhonePath`), the drive's file is read
 * back WITHOUT the cache (the drive's own `ops.hash`, the same read the copy and the look's candidates use), and the two are compared.
 * Equal: the copy becomes a checked copy. Different, or the drive's file is not there: the copy stops counting, so the next backup copies
 * the file again. The phone's file gone: skipped and counted. Nothing on the phone or on a drive is written, renamed or removed; only the
 * index changes (`checkOldStore`). The phone or the drive going away, or the laptop sleeping, stops the run at a safe point and waits
 * for the person's Continue; what is done is in the index (and in the checkpoint), so nothing is read twice.
 */
import { JobAborted, turnOf } from '../jobs/jobService';
import { type CheckOldNamed, type CheckOldReport, type ReasonLine } from '../../shared/phoneBackup';
import type { Sha256Answer } from '../adb/phoneModel';
import { checkPhone } from './planJob';
import type { BackupDrive } from './backupDrive';
import type { PhoneBackupDeps, RunCtx } from './phoneBackupTypes';
import { copyStates, markDiffers, markMissing, markVerified, saveReport, stillToCheck, type CheckOldInput } from './checkOldStore';

/** One adb call asks about at most this many files, this many bytes (a single bigger file goes alone) and this many characters of paths. */
export const BATCH_FILES = 40;
export const BATCH_BYTES = 512 * 1024 * 1024;
export const BATCH_PATH_CHARS = 12_000;
const MAX_LISTED = 2000;
const MAX_EXAMPLES = 5;
const RECONNECT_LIMIT = 3;
const PHONE_TRIES = 3;
const DRIVE_TROUBLE = new Set(['EIO', 'ENODEV', 'ENXIO', 'ENOENT', 'EBUSY', 'UNKNOWN', 'ENOTCONN']);

type Item = CheckOldInput['items'][number];

/** What is kept after every batch, so a Continue after a restart carries on (the index says which copies are settled). */
export interface CheckOldCheckpoint {
  startedAt: number;
  next: number;
  bytesDone: number;
  verified: { files: number; bytes: number };
  differ: CheckOldNamed[];
  differCount: number;
  missing: CheckOldNamed[];
  missingCount: number;
  noLongerOnPhone: number;
  couldNot: { [reason: string]: { count: number; examples: string[] } };
}

export const emptyCheckOldCheckpoint = (): CheckOldCheckpoint => ({ startedAt: 0, next: 0, bytesDone: 0, verified: { files: 0, bytes: 0 }, differ: [], differCount: 0, missing: [], missingCount: 0, noLongerOnPhone: 0, couldNot: {} });

/** The next files to ask the phone about, starting at `from`: bounded by count, by total size and by the length of the command. */
export function nextBatch(items: readonly { path: string; size: number }[], from: number): number {
  let bytes = 0;
  let chars = 0;
  let n = 0;
  while (from + n < items.length && n < BATCH_FILES) {
    const it = items[from + n]!;
    if (n > 0 && (bytes + it.size > BATCH_BYTES || chars + it.path.length + 3 > BATCH_PATH_CHARS)) break;
    bytes += it.size;
    chars += it.path.length + 3;
    n += 1;
  }
  return n;
}

const gb = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6).toLocaleString('en-US')} MB`);
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** A drive that is not there (or stopped answering) in the middle of a read: the run waits for the person, then goes on with the same file. */
class DriveAway extends Error {}

export class CheckOldRun {
  private cp: CheckOldCheckpoint;
  private drive!: BackupDrive;
  private lastWake: number;
  private readonly now: () => number;
  private readonly bytesTotal: number;

  constructor(
    private readonly deps: PhoneBackupDeps,
    private readonly ctx: RunCtx,
    private readonly input: CheckOldInput,
    private readonly jobId: number,
    resume: Partial<CheckOldCheckpoint> | null,
  ) {
    this.now = deps.now ?? Date.now;
    this.cp = { ...emptyCheckOldCheckpoint(), ...resume };
    this.lastWake = deps.wakeCount?.() ?? 0;
    this.bytesTotal = input.items.reduce((s, i) => s + i.size, 0);
  }

  async execute(): Promise<CheckOldReport> {
    const { deps, ctx, input, cp } = this;
    const release = deps.keepAwake?.();
    try {
      if (cp.startedAt === 0) {
        cp.startedAt = this.now();
        ctx.checkpoint(cp);
      }
      await this.getDrive();
      await this.getPhone();
      if (cp.next > 0) ctx.log('info', `Continuing at file ${Math.min(cp.next + 1, input.items.length)} of ${input.items.length}`);
      while (cp.next < input.items.length) {
        await ctx.yield();
        if ((deps.wakeCount?.() ?? 0) !== this.lastWake) {
          this.lastWake = deps.wakeCount?.() ?? 0;
          ctx.log('info', 'The laptop slept. Looking at the phone and the drive again before going on.');
          await this.getDrive();
          await this.getPhone();
        }
        const batch = input.items.slice(cp.next, cp.next + nextBatch(input.items, cp.next));
        await this.doBatch(batch);
        cp.next += batch.length;
        cp.bytesDone += batch.reduce((s, i) => s + i.size, 0);
        ctx.checkpoint(cp);
        this.show(cp.next, cp.bytesDone, input.items[cp.next]);
      }
      return this.finish();
    } finally {
      release?.();
    }
  }

  private show(done: number, bytesDone: number, current: Item | undefined): void {
    const { input } = this;
    const total = input.items.length;
    this.ctx.progress(done, total, {
      bytesDone,
      bytesTotal: this.bytesTotal,
      message: `Checked ${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} (${gb(bytesDone)} of ${gb(this.bytesTotal)})${current ? `. Now: ${current.group}` : ''}`,
    });
  }

  // ---- the drive and the phone -------------------------------------------------------------------------------------------------

  private async getDrive(): Promise<void> {
    for (;;) {
      const found = await this.deps.driveFor(this.input.destPlaceId);
      if (found) {
        this.drive = found.drive;
        return;
      }
      await this.ctx.needsYou('The drive for this backup is not plugged in. Plug it in, then press Continue. Nothing is lost; the check carries on where it stopped.', ['Continue']);
    }
  }

  private async getPhone(): Promise<void> {
    for (;;) {
      const { problem } = await checkPhone(this.deps, this.input.serial);
      if (problem === null) return;
      await this.ctx.needsYou(`${problem} Then press Continue. Nothing is lost; the check carries on where it stopped.`, ['Continue']);
    }
  }

  // ---- one batch ---------------------------------------------------------------------------------------------------------------

  private async doBatch(batch: readonly Item[]): Promise<void> {
    const { deps, ctx, cp } = this;
    // Copies an earlier, cut-off run already settled are counted from the index and not read again.
    const states = copyStates(deps.db, batch.map((i) => i.copyId));
    const pending = new Set<Item>();
    for (const item of batch) {
      const s = states.get(item.copyId);
      if (stillToCheck(s)) pending.add(item);
      else if (s?.verifiedHow === 'read_both') this.countVerified(item);
      else if (s?.verifiedHow === 'differs') this.countDiffer(item);
      else if (s?.goneAt != null) this.countMissing(item);
    }
    if (pending.size === 0) return;

    const answers = await this.askPhone([...pending]);
    let done = cp.next;
    let bytes = cp.bytesDone;
    for (const item of batch) {
      done += 1;
      bytes += item.size;
      if (!pending.has(item)) continue;
      await turnOf(ctx)(); // inside a batch a Pause does not hold: the batch is finished and its checkpoint saved first
      this.show(done - 1, bytes - item.size, item);
      const answer = answers.get(item.path);
      if (!answer) this.couldNot(item, 'The phone did not give a checksum for this file.');
      else if (answer.kind === 'missing') cp.noLongerOnPhone += 1;
      else if (answer.kind === 'error') this.couldNot(item, answer.reason);
      else await this.compareWithDrive(item, answer.sha256);
    }
  }

  /** The phone's checksums for the pending files, one adb call. A call that fails as a whole (phone away) waits for the person and is made again. */
  private async askPhone(pending: readonly Item[]): Promise<Map<string, Sha256Answer>> {
    const { deps, ctx, input } = this;
    const bytes = pending.reduce((s, i) => s + i.size, 0);
    let tries = 0;
    for (;;) {
      const batch = await deps.adb.sha256Many(input.serial, pending.map((i) => i.path), ctx.signal, bytes);
      if (batch.adbError === null) return batch.answers;
      const { problem } = await checkPhone(deps, input.serial);
      if (problem !== null) {
        await ctx.needsYou(`${problem} Then press Continue. Nothing is lost; the check carries on where it stopped.`, ['Continue']);
        await this.getDrive();
        continue;
      }
      tries += 1;
      if (tries >= PHONE_TRIES) {
        const answers = new Map<string, Sha256Answer>();
        for (const item of pending) answers.set(item.path, { kind: 'error', reason: 'The phone did not answer.' });
        return answers;
      }
      ctx.log('warn', `The phone did not answer (${batch.adbError}). Trying again (${tries} of ${PHONE_TRIES - 1}).`);
      await (deps.sleep ? deps.sleep(1000 * tries) : new Promise<void>((res) => setTimeout(res, 1000 * tries)));
    }
  }

  /** Reads the drive's file without the cache and compares. The drive going away waits for the person and goes on with the same file. */
  private async compareWithDrive(item: Item, phoneSha: string): Promise<void> {
    const { ctx } = this;
    let away = 0;
    for (;;) {
      try {
        await this.compareOnce(item, phoneSha);
        return;
      } catch (err) {
        if (err instanceof JobAborted || ctx.signal.aborted) throw err;
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (err instanceof DriveAway || DRIVE_TROUBLE.has(code) || /not plugged in/i.test((err as Error).message)) {
          away += 1;
          if (away > RECONNECT_LIMIT) return this.couldNot(item, 'The drive kept going away while this file was read.');
          await ctx.needsYou('The drive was unplugged or stopped answering. Plug it in, then press Continue. Nothing is lost; the check carries on where it stopped.', ['Continue']);
          await this.getDrive();
          continue;
        }
        return this.couldNot(item, `The file on the drive could not be read (${(err as Error).message.slice(0, 120)}).`);
      }
    }
  }

  private async compareOnce(item: Item, phoneSha: string): Promise<void> {
    const { deps, ctx, drive, input } = this;
    const file = drive.finalPath(item.copyRel);
    if (!(await drive.ops.exists(file))) {
      // A drive that was pulled out also "has no file": only a drive that is plugged in and readable can say a file is missing.
      if ((await deps.driveFor(input.destPlaceId)) === null) throw new DriveAway('The drive is not plugged in.');
      if (markMissing(deps.db, item.copyId, this.now())) this.countMissing(item);
      return;
    }
    const size = await drive.ops.sizeOf(file);
    if (size === null) throw new DriveAway('The drive did not answer.');
    const same = size === item.size && (await drive.ops.hash(file, turnOf(ctx))) === phoneSha;
    if (same) {
      if (markVerified(deps.db, item.copyId, phoneSha, this.now())) this.countVerified(item);
    } else if (markDiffers(deps.db, item.copyId, this.now())) {
      this.countDiffer(item);
      ctx.warn(`${nameOf(item.path)} is not the same on the drive. It was left as it is; the next backup copies the phone's file again.`);
    }
  }

  // ---- counting ----------------------------------------------------------------------------------------------------------------

  private countVerified(item: Item): void {
    this.cp.verified.files += 1;
    this.cp.verified.bytes += item.size;
  }

  private countDiffer(item: Item): void {
    this.cp.differCount += 1;
    if (this.cp.differ.length < MAX_LISTED) this.cp.differ.push({ path: item.path, size: item.size });
  }

  private countMissing(item: Item): void {
    this.cp.missingCount += 1;
    if (this.cp.missing.length < MAX_LISTED) this.cp.missing.push({ path: item.path, size: item.size });
  }

  private couldNot(item: Item, reason: string): void {
    const r = (this.cp.couldNot[reason] ??= { count: 0, examples: [] });
    r.count += 1;
    if (r.examples.length < MAX_EXAMPLES) r.examples.push(item.path);
    this.ctx.warn(`${nameOf(item.path)}: ${reason}`);
  }

  // ---- the end -----------------------------------------------------------------------------------------------------------------

  private finish(): CheckOldReport {
    const { deps, cp, input, ctx } = this;
    const couldNotRead: ReasonLine[] = Object.entries(cp.couldNot).map(([reason, v]) => ({ reason, count: v.count, examples: v.examples })).toSorted((a, b) => b.count - a.count);
    const report: CheckOldReport = {
      jobId: this.jobId,
      backupName: input.backupName,
      phoneName: input.phoneName,
      driveLabel: input.driveLabel,
      startedAt: cp.startedAt,
      finishedAt: this.now(),
      asked: input.items.length,
      verified: cp.verified,
      differ: cp.differ,
      differCount: cp.differCount,
      missing: cp.missing,
      missingCount: cp.missingCount,
      noLongerOnPhone: cp.noLongerOnPhone,
      couldNotRead,
    };
    saveReport(deps.db, this.jobId, report);
    ctx.log('info', `Checked ${input.items.length} files: ${cp.verified.files} are the same, ${cp.differCount} differ, ${cp.missingCount} are missing on the drive, ${cp.noLongerOnPhone} are no longer on the phone, ${couldNotRead.reduce((s, r) => s + r.count, 0)} could not be read.`);
    return report;
  }
}
