import { createHash } from 'node:crypto';
import type { OtherSpace, PhoneBackupAdb } from '../../adb/adbPort';
import { lookPhone, type PhoneLook, type ShellRunner } from '../../adb/phoneLook';
import { parseSha256Many, sha256ManyCommand, type Sha256Batch } from '../../adb/phoneModel';
import type { PhoneDevice } from '../../../shared/phone';
import type { BackupDrive, SettleResult } from '../../phoneBackup/backupDrive';
import type { PhoneBackupDeps, RunCtx } from '../../phoneBackup/phoneBackupTypes';
import { PhoneBackupRun, type RunCheckpoint } from '../../phoneBackup/runEngine';
import { planPhoneBackup, type PlanOutcome } from '../../phoneBackup/planJob';
import { saveConfirmed, type ConfirmedRun } from '../../phoneBackup/runStore';
import { JobAborted } from '../../jobs/jobService';
import type { DriveOps } from '../../localCopy/verifiedCopy';
import { CARD_FOLDER } from '../../../shared/appFolders';
import { DriveGoneError, FakeDrive, sha256Of, TMP_DIR } from './fakeDrive.testutil';
import type { FakeAdbShell, FakePhone } from './fakePhone.testutil';
import { Crash, World } from './world.testutil';

/**
 * The phone backup (R1.2a) against the fake world of R1.0a: the fake phone, an unkind fake drive (unflushed writes lost on unplug, cached
 * versus uncached reads, a link that cannot replace), and the SAME invariants. The product code is the real plan and the real run; only the
 * adb port and the drive are fakes. Faults are armed per call and consumed in order.
 */
export type PullFault = 'short' | 'corrupt' | 'throw' | 'phone_gone' | 'no_space';

export class FakeBackupAdb implements PhoneBackupAdb {
  plugged = true;
  readonly pullFaults: PullFault[] = [];
  readonly pulls: string[] = [];
  readonly shaReads: string[] = [];
  /** The asked-about paths of each batch call ("Check old copies"), and the shell line each one would have sent. */
  readonly shaBatches: string[][] = [];
  readonly shaCommands: string[] = [];
  /** Runs once, just before the n-th batch call starts (n counts from 1), to pull a cable at a precise moment. */
  beforeShaMany: ((n: number) => void) | null = null;
  killed = 0;
  spaces: OtherSpace[] = [];
  /** Where a pull writes (the fake drive, by the name the run gave). */
  sink: (local: string, data: Buffer, mtimeSec: number) => void = () => undefined;
  /** Runs once, just before the n-th pull starts (n counts from 1 within this adb), to pull a cable at a precise moment. */
  beforePull: ((n: number) => void) | null = null;

  constructor(
    private readonly phone: FakePhone,
    private readonly shell: FakeAdbShell,
  ) {}

  async devices(): Promise<PhoneDevice[]> {
    return this.plugged ? [{ serial: this.phone.serial, model: 'Fake phone', state: 'device' }] : [];
  }

  listRunner(): ShellRunner {
    return async (serial, command, signal) => (this.plugged ? this.shell.run(serial, command, signal) : { exitCode: 1, stdout: '', stderr: `adb: device '${serial}' not found\n`, error: 'adb failed' });
  }

  async lookFiles(serial: string, folders: readonly string[], signal?: AbortSignal, options: { allowRoot?: boolean } = {}): Promise<PhoneLook> {
    return lookPhone(this.listRunner(), serial, folders, { signal, allowRoot: options.allowRoot });
  }

  async sha256(_serial: string, remotePath: string): Promise<string | null> {
    if (!this.plugged) return null;
    this.shaReads.push(remotePath);
    try {
      return sha256Of(this.phone.read(remotePath));
    } catch {
      return null;
    }
  }

  /** Answers the way the phone's `sha256sum` does (lines on stdout, one message per unreadable file on stderr) through the real parser. */
  async sha256Many(serial: string, remotePaths: readonly string[]): Promise<Sha256Batch> {
    this.shaBatches.push([...remotePaths]);
    this.shaCommands.push(sha256ManyCommand(remotePaths));
    this.beforeShaMany?.(this.shaBatches.length);
    if (!this.plugged) return parseSha256Many(remotePaths, { exitCode: 1, stdout: '', stderr: `adb: device '${serial}' not found\n`, error: 'adb failed' });
    let stdout = '';
    let stderr = '';
    for (const p of remotePaths) {
      this.shaReads.push(p);
      try {
        stdout += `${sha256Of(this.phone.read(p))}  ${p}\n`;
      } catch {
        stderr += `sha256sum: ${p}: No such file or directory\n`;
      }
    }
    return parseSha256Many(remotePaths, { exitCode: stderr === '' ? 0 : 1, stdout, stderr });
  }

  async pull(_serial: string, remotePath: string, localPath: string): Promise<void> {
    this.pulls.push(remotePath);
    this.beforePull?.(this.pulls.length);
    if (!this.plugged) throw new Error('adb: device not found');
    const fault = this.pullFaults.shift();
    if (fault === 'throw') throw new Error('adb: error: connection reset');
    if (fault === 'no_space') throw new Error('adb: error: write failed: No space left on device');
    if (fault === 'phone_gone') {
      this.plugged = false;
      throw new Error('adb: device offline');
    }
    let data = this.phone.read(remotePath);
    const mtime = this.phone.walk().find((f) => f.path === remotePath)!.mtimeSec;
    if (fault === 'short') data = data.subarray(0, Math.max(0, data.length - 1));
    if (fault === 'corrupt') data = Buffer.concat([Buffer.from('X'), data.subarray(1)]);
    this.sink(localPath, data, mtime);
  }

  async otherSpaces(): Promise<OtherSpace[]> {
    return this.spaces;
  }

  async killServer(): Promise<void> {
    this.killed += 1;
  }
}

/** The real reads give the job a turn at every block; a fake read gives one only while a Pause is simulated (so the crash points of the other tests do not move). */
export async function midFileTurn(yieldNow?: () => Promise<void>): Promise<void> {
  if (pauseSim.atTurn !== null) await yieldNow?.();
}

/** The drive's lists folder (inside the app's own files, like the real one). */
export const LISTS_PREFIX = `${CARD_FOLDER}/lists/`;

const tag = (p: string): string => createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 16);

/** The drive side over a FakeDrive: the same steps the real one takes, on a drive that can be pulled out. */
export function fakeBackupDrive(drive: FakeDrive, step: () => void = () => undefined): BackupDrive {
  const tmpPath = (final: string): string => `${TMP_DIR}${tag(final)}.bhtmp`;
  const ops: DriveOps = {
    guard: () => undefined,
    exists: async (f) => drive.exists(f),
    sizeOf: async (f) => drive.stat(f)?.size ?? null,
    flush: async (f) => {
      step();
      drive.flush(f);
      step();
    },
    hash: async (f, yieldNow) => {
      step();
      const sha = sha256Of(drive.readUncached(f));
      await midFileTurn(yieldNow);
      return sha;
    },
    link: async (a, b) => {
      step();
      drive.linkNoReplace(a, b);
    },
    removeTemp: async (t) => {
      step();
      drive.discard(t);
    },
  };
  return {
    ops,
    finalPath: (rel) => rel,
    tmpPath,
    ensureDir: async () => undefined,
    async settle(final, isExpected): Promise<SettleResult> {
      const tmp = tmpPath(final);
      if (!drive.exists(tmp)) return 'none';
      if (drive.exists(final) && drive.stat(final)!.id === drive.stat(tmp)!.id) {
        if (!(await isExpected())) return 'unexpected';
        drive.flush(final);
        drive.discard(tmp);
        return 'settled';
      }
      drive.discard(tmp);
      return 'cleared';
    },
    freeBytes: async () => null,
    async writeList(rel, text) {
      let n = 1;
      let name = `${LISTS_PREFIX}${rel}`;
      while (drive.exists(name)) name = `${LISTS_PREFIX}${rel}-${(n += 1)}`;
      drive.write(name, text, 0);
      drive.flush(name);
      return name;
    },
  };
}

/** The run stopped at a Pause (the app was closed while the job was held): like a kill, the drives lose what they had not flushed. */
export class Held extends Crash {}

/**
 * Test setting: a FakeCtx made while `atTurn` is set simulates a Pause asked for at that call of `turn` (the Nth time a run is in the middle of a file); `skip` lets that many FakeCtx pass first
 * (the plan's own). Set it, run, then call `pauseSim.off()`.
 */
export const pauseSim = {
  atTurn: null as number | null,
  skip: 0,
  off(): void {
    this.atTurn = null;
    this.skip = 0;
  },
};

export class FakeCtx implements RunCtx {
  readonly signal = new AbortController().signal;
  yields = 0;
  crashAt: number | null = null;
  /** Pause simulation (see `pauseSim`): from the asked turn on, `yield` (a safe point) saves and stops the run with Held; `turn` (the middle of a file) goes on. */
  paused = false;
  calls = 0;
  turns = 0;
  /** Calls of `turn` made after the Pause was asked: the work of the file that was on its way. */
  turnsAfterPause = 0;
  heldAt: number | null = null;
  private readonly pauseAtTurn: number | null = pauseSim.skip > 0 ? (pauseSim.skip -= 1, null) : pauseSim.atTurn;
  private holdSave: (() => void | Promise<void>) | null = null;
  readonly questions: string[] = [];
  readonly warnings: string[] = [];
  readonly logs: string[] = [];
  last: unknown = null;
  /** What to fix in the world when the run asks the person to Continue (plug the phone or the drive back in). */
  onAsk: ((message: string) => void) | null = null;
  private beat(): void {
    this.calls += 1;
    this.yields += 1;
    if (this.crashAt !== null && this.yields >= this.crashAt) throw new Crash();
  }
  async yield(): Promise<void> {
    this.beat();
    if (this.paused) {
      await this.holdSave?.(); // what the job service does before it holds a job
      this.heldAt = this.calls;
      throw new Held();
    }
  }
  async turn(): Promise<void> {
    this.beat();
    this.turns += 1;
    if (this.pauseAtTurn !== null && this.turns === this.pauseAtTurn) this.paused = true;
    if (this.paused) this.turnsAfterPause += 1;
  }
  beforeHold(save: () => void | Promise<void>): void {
    this.holdSave = save;
  }
  progress(_done?: number, _total?: number, _extras?: { bytesDone?: number; bytesTotal?: number; message?: string }): void {}
  log(_level: string, text: string): void {
    this.logs.push(text);
  }
  warn(text: string): void {
    this.warnings.push(text);
  }
  async needsYou(message: string): Promise<string> {
    this.questions.push(message);
    if (this.questions.length > 60) throw new JobAborted('asked too many times');
    this.onAsk?.(message);
    return 'Continue';
  }
  checkpoint(resume: unknown): void {
    this.last = JSON.parse(JSON.stringify(resume));
  }
}

export interface ProductRun {
  plan: PlanOutcome;
  copied: number;
  crashed: boolean;
  ctx: FakeCtx;
  checkpoint: RunCheckpoint | null;
}

/** The fake world plus the product's plan and run. Drive 1 (position 1) is the one the backup goes to. */
export class ProductWorld {
  readonly adb: FakeBackupAdb;
  readonly drive: BackupDrive;
  readonly deps: PhoneBackupDeps;
  wakes = 0;
  private steps = 0;
  private crashAt: number | null = null;
  private lastRun: ConfirmedRun | null = null;
  private jobSeq = 0;

  constructor(readonly w: World) {
    this.adb = new FakeBackupAdb(w.phone, w.shell);
    this.adb.sink = (local, data, mtime) => {
      this.step();
      w.drives[0]!.write(local, data, mtime);
    };
    this.drive = fakeBackupDrive(w.drives[0]!, () => this.step());
    this.deps = {
      db: w.db,
      adb: this.adb,
      log: { info: () => undefined, warn: () => undefined },
      now: () => w.nowMs,
      driveFor: async (placeId) => (placeId === w.destinations[0]!.placeId && w.drives[0]!.plugged ? { drive: this.drive, label: 'Fake T7' } : null),
      wakeCount: () => this.wakes,
      sleep: async () => undefined,
    };
  }

  /** Makes the plan (look, filters, candidates) and returns it. Everything in it is what the person would see. */
  async plan(accept: ('look_empty' | 'look_mass_change')[] = []): Promise<{ outcome: PlanOutcome; ctx: FakeCtx }> {
    const ctx = new FakeCtx();
    return { outcome: await planPhoneBackup(this.deps, { backupId: this.w.profileId, accept }, ctx), ctx };
  }

  /** Plan, confirm everything, run. `crashAfter` kills the run after that many turns (the drive loses what it had not flushed). */
  async backup(options: { crashAfter?: number; resume?: RunCheckpoint | null; onAsk?: (m: string) => void; untick?: (path: string) => boolean } = {}): Promise<ProductRun> {
    const { outcome } = await this.plan();
    const ctx = new FakeCtx();
    ctx.onAsk = options.onAsk ?? null;
    if (!outcome.result.ok || outcome.stored === null) return { plan: outcome, copied: 0, crashed: false, ctx, checkpoint: null };
    const s = outcome.stored;
    const items = s.items.filter((i) => !options.untick?.(i.path)).map((i) => ({ path: i.path, size: i.size, mtimeSec: i.mtimeSec, destRel: i.destRel, rowId: i.rowId }));
    const run: ConfirmedRun = { ...s.base, items, relinks: s.relinks, leftOut: { files: 0, bytes: 0 } };
    return this.execute(run, ctx, options, outcome);
  }

  /** Runs an already confirmed list again (Continue after a kill): the same list, the checkpoint the first run left. */
  async continueRun(options: { crashAfter?: number; onAsk?: (m: string) => void } = {}, from: ProductRun): Promise<ProductRun> {
    const ctx = new FakeCtx();
    ctx.onAsk = options.onAsk ?? null;
    return this.execute(this.lastRun!, ctx, { ...options, resume: from.checkpoint }, from.plan);
  }

  private async execute(run: ConfirmedRun, ctx: FakeCtx, options: { crashAfter?: number; resume?: RunCheckpoint | null }, plan?: PlanOutcome): Promise<ProductRun> {
    this.lastRun = run;
    saveConfirmed(this.w.db, run.planId, run);
    this.steps = 0;
    this.crashAt = options.crashAfter ?? null;
    const before = this.w.db.prepare('SELECT count(*) FROM files WHERE backup_run_id IS NOT NULL').pluck().get() as number;
    let crashed = false;
    try {
      await new PhoneBackupRun(this.deps, ctx, run, (this.jobSeq += 1), options.resume ?? null).execute();
    } catch (err) {
      if (!(err instanceof Crash)) throw err;
      crashed = true;
      for (const d of this.w.drives) {
        const was = d.plugged;
        d.unplug();
        if (was) d.plug();
      }
    }
    this.crashAt = null;
    this.syncCopyLog();
    const after = this.w.db.prepare('SELECT count(*) FROM files WHERE backup_run_id IS NOT NULL').pluck().get() as number;
    return { plan: plan ?? { result: { ok: false, message: '', decision: null }, stored: null }, copied: after - before, crashed, ctx, checkpoint: ctx.last as RunCheckpoint | null };
  }

  /** One step of the drive or the pull: the place where "the app was killed" can strike. */
  private step(): void {
    this.steps += 1;
    if (this.crashAt !== null && this.steps >= this.crashAt) throw new Crash();
  }

  /** Every copy the index says was made goes into the world's copy log (the invariants read it), once. */
  private syncCopyLog(): void {
    const known = new Set(this.w.copyLog.map((c) => `${c.drive}|${c.path}`));
    const rows = this.w.db
      .prepare(
        `SELECT c.rel_path AS path, c.sha256 AS sha, c.size AS size, p.rel_path AS phoneRel FROM files c JOIN files p ON p.id = c.origin_file_id
         WHERE c.place_id = ? AND c.verified_how = 'read_both' AND c.gone_at IS NULL`,
      )
      .all(this.w.destinations[0]!.placeId) as { path: string; sha: string; size: number; phoneRel: string }[];
    for (const r of rows) if (!known.has(`0|${r.path}`)) this.w.copyLog.push({ drive: 0, path: r.path, sha256: r.sha, size: r.size, phoneRel: r.phoneRel });
  }
}

export { DriveGoneError };
