import { upsertFiles } from '../../listing/fileStore';
import { fakeBackupDrive, FakeCtx, midFileTurn } from './phoneBackupWorld.testutil';
import { DriveGoneError, sha256Of, type FakeDrive } from './fakeDrive.testutil';
import { Crash, type World } from './world.testutil';
import { JobAborted } from '../../jobs/jobService';
import { planMirror, type MirrorPlanOutcome } from '../../mirror/mirrorLook';
import { MirrorRun, type MirrorCheckpoint } from '../../mirror/mirrorRun';
import { MirrorCheckRun, type CheckCheckpoint } from '../../mirror/mirrorCheckRun';
import { checkPlanSteps } from '../../mirror/mirrorCheckPlan';
import { pairOf } from '../../mirror/mirrorPairs';
import { finishSync } from '../../sliceWork';
import type { MirrorCheckReport } from '../../../shared/mirrorCheck';
import type { ConfirmedMirror } from '../../mirror/mirrorStore';
import type { MirrorDeps, MirrorDrive, MirrorItem, StoredCheckPlan, StoredMirrorPlan } from '../../mirror/mirrorTypes';
import type { MirrorReport } from '../../../shared/mirror';

/**
 * The mirror (R1.3) against the fake world of R1.0a: drive 0 is the T7 (the backup is on it), drive 1 the Seagate. The product code is the real look,
 * plan and run; only the two drives are fakes (unflushed writes lost on unplug, cached versus uncached reads, a link that cannot replace). The fake
 * drive's `look` does what the listing's quick look does: it brings the index up to date from what the drive lists.
 */
export const ROOT = 'MyData/POCO';

/** One drive of the pair over a FakeDrive. `step` is where "the app was killed" can strike. */
export function fakeMirrorDrive(w: World, index: number, label: string, step: () => void, onRead: (rel: string) => void = () => undefined): MirrorDrive {
  const drive: FakeDrive = w.drives[index]!;
  const placeId = w.destinations[index]!.placeId;
  const base = fakeBackupDrive(drive, step);
  return {
    ...base,
    placeId,
    label,
    async look(folderRel) {
      const found = drive.list(folderRel + '/');
      upsertFiles(w.db, placeId, found.map((f) => ({ relPath: f.path, size: f.size, mtimeMs: f.mtimeSec * 1000, cloudOnly: false })), w.nowMs, true);
      const seen = new Set(found.map((f) => f.path));
      const rows = w.db.prepare('SELECT id, rel_path FROM files WHERE place_id = ? AND substr(rel_path, 1, ?) = ? AND gone_at IS NULL').all(placeId, folderRel.length + 1, folderRel + '/') as { id: number; rel_path: string }[];
      for (const r of rows) if (!seen.has(r.rel_path)) w.db.prepare("UPDATE files SET gone_at = ?, gone_reason = 'gone_from_source' WHERE id = ?").run(w.nowMs, r.id);
      return { complete: true, rootMissing: false, message: null };
    },
    async readFile(rel, onBlock, yieldNow) {
      step();
      onRead(rel);
      const data = drive.readUncached(rel);
      for (let at = 0; at < data.length; at += 1024) await onBlock(data.subarray(at, at + 1024));
      await midFileTurn(yieldNow);
      return { sha256: sha256Of(data), bytes: data.length };
    },
    async openTemp(tmp) {
      const chunks: Buffer[] = [];
      return {
        write: async (block) => {
          step();
          chunks.push(Buffer.from(block));
        },
        finish: async (mtimeMs) => {
          drive.write(tmp, Buffer.concat(chunks), mtimeMs / 1000);
        },
        abort: async () => undefined,
      };
    },
  };
}

export interface MirrorRunResult {
  report: MirrorReport | null;
  crashed: boolean;
  ctx: FakeCtx;
  checkpoint: MirrorCheckpoint | null;
}

export interface CheckRunResult {
  report: MirrorCheckReport | null;
  crashed: boolean;
  stopped: boolean;
  ctx: FakeCtx;
  checkpoint: CheckCheckpoint | null;
}

export class MirrorWorld {
  readonly deps: MirrorDeps;
  readonly t7: MirrorDrive;
  readonly sea: MirrorDrive;
  /** Drives the next `usbTrouble` answers true for (once per entry). */
  readonly usb = new Set<string>();
  usbAsked = 0;
  /** Every file read from each drive's file (by path inside the backup folder's parent), in order: how many reads a job needed. */
  readonly reads: { t7: string[]; sea: string[] } = { t7: [], sea: [] };
  wakes = 0;
  private steps = 0;
  private crashAt: number | null = null;
  private lastRun: ConfirmedMirror | null = null;
  private jobSeq = 0;
  private fileSeq = 0;

  constructor(readonly w: World) {
    const step = (): void => this.step();
    this.t7 = fakeMirrorDrive(w, 0, 'T7', step, (rel) => this.reads.t7.push(rel));
    this.sea = fakeMirrorDrive(w, 1, 'Seagate2TB', step, (rel) => this.reads.sea.push(rel));
    w.db.prepare('UPDATE places SET label = ? WHERE id = ?').run('T7', w.destinations[0]!.placeId);
    w.db.prepare('UPDATE places SET label = ? WHERE id = ?').run('Seagate2TB', w.destinations[1]!.placeId);
    this.deps = {
      db: w.db,
      log: { info: () => undefined, warn: () => undefined },
      now: () => w.nowMs,
      drivesFor: async () => ({ src: w.drives[0]!.plugged ? this.t7 : null, dst: w.drives[1]!.plugged ? this.sea : null }),
      pluggedPlaces: async () => new Set(w.drives.flatMap((d, i) => (d.plugged ? [w.destinations[i]!.placeId] : []))),
      usbTrouble: async (placeId) => {
        this.usbAsked += 1;
        return this.usb.delete(placeId);
      },
      wakeCount: () => this.wakes,
      sleep: async () => undefined,
      usbEveryMs: 0,
    };
  }

  /** A file of the backup on the T7 (written, flushed, in the index). `expected`: the index knows the phone's checksum for it. `sha`: the checksum the index holds (default: the content's). */
  seed(rel: string, content: string, options: { expected?: boolean; sha?: string | null; mtimeSec?: number } = {}): number {
    const path = `${ROOT}/${rel}`;
    const mtimeSec = options.mtimeSec ?? this.w.nowSec - 100;
    const drive = this.w.drives[0]!;
    drive.write(path, content, mtimeSec);
    drive.flush(path);
    const place = this.w.destinations[0]!.placeId;
    const sha = options.sha === undefined ? sha256Of(content) : options.sha;
    const phoneRow = Number(
      this.w.db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 1, 1)").run(this.w.placeId, `sdcard/DCIM/f${(this.fileSeq += 1)}.bin`, Buffer.byteLength(content), mtimeSec * 1000).lastInsertRowid,
    );
    this.w.db
      .prepare('INSERT INTO files (place_id, rel_path, size, mtime, sha256, first_seen_at, last_seen_at, origin_file_id, expected_sha256, verified_how, hashed_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 1)')
      .run(place, path, Buffer.byteLength(content), mtimeSec * 1000, sha, options.expected === false ? null : phoneRow, options.expected === false ? null : sha, options.expected === false ? null : 'read_both');
    return Number(this.w.db.prepare('SELECT id FROM files WHERE place_id = ? AND rel_path = ?').pluck().get(place, path));
  }

  /** A file that is already on the Seagate (an older tool's copy): on the drive and in the index. */
  seedSeagate(rel: string, content: string, mtimeSec = this.w.nowSec - 100): void {
    const path = `${ROOT}/${rel}`;
    const drive = this.w.drives[1]!;
    drive.write(path, content, mtimeSec);
    drive.flush(path);
    upsertFiles(this.w.db, this.w.destinations[1]!.placeId, [{ relPath: path, size: Buffer.byteLength(content), mtimeMs: mtimeSec * 1000, cloudOnly: false }], this.w.nowMs, true);
  }

  async plan(): Promise<{ outcome: MirrorPlanOutcome; ctx: FakeCtx }> {
    const ctx = new FakeCtx();
    return { outcome: await planMirror(this.deps, { backupIds: [this.w.profileId] }, ctx), ctx };
  }

  /** The items a confirm would send: every copy not unticked, the checks, the different. */
  itemsOf(stored: StoredMirrorPlan, options: { untick?: (i: MirrorItem) => boolean } = {}): MirrorItem[] {
    return [...stored.copy.filter((i) => !options.untick?.(i)), ...stored.different];
  }

  /** Plan, confirm everything, run. `crashAfter` kills the run after that many steps (the drives lose what they had not flushed). */
  async mirror(options: { crashAfter?: number; resume?: MirrorCheckpoint | null; onAsk?: (m: string) => void; untick?: (i: MirrorItem) => boolean } = {}): Promise<MirrorRunResult & { plan: MirrorPlanOutcome }> {
    const { outcome } = await this.plan();
    const ctx = new FakeCtx();
    ctx.onAsk = options.onAsk ?? null;
    if (!outcome.result.ok || outcome.stored === null) return { report: null, crashed: false, ctx, checkpoint: null, plan: outcome };
    const run: ConfirmedMirror = { planId: outcome.stored.planId, pairs: outcome.stored.pairs, items: this.itemsOf(outcome.stored, options) };
    return { ...(await this.execute(run, ctx, options)), plan: outcome };
  }

  /** Runs an already confirmed list again (Continue after a kill): the same list, the checkpoint the first run left. */
  async continueRun(from: MirrorRunResult, options: { crashAfter?: number; onAsk?: (m: string) => void } = {}): Promise<MirrorRunResult> {
    const ctx = new FakeCtx();
    ctx.onAsk = options.onAsk ?? null;
    return this.execute(this.lastRun!, ctx, { ...options, resume: from.checkpoint });
  }

  private async execute(run: ConfirmedMirror, ctx: FakeCtx, options: { crashAfter?: number; resume?: MirrorCheckpoint | null }): Promise<MirrorRunResult> {
    this.lastRun = run;
    this.steps = 0;
    this.crashAt = options.crashAfter ?? null;
    let report: MirrorReport | null = null;
    let crashed = false;
    try {
      report = await new MirrorRun(this.deps, ctx, run, (this.jobSeq += 1), options.resume ?? null).execute();
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
    return { report, crashed, ctx, checkpoint: ctx.last as MirrorCheckpoint | null };
  }

  private step(): void {
    this.steps += 1;
    if (this.crashAt !== null && this.steps >= this.crashAt) throw new Crash();
  }

  // ---- "Check old copies" -----------------------------------------------------------------------------------------------------------

  /** The list the check preview makes (from the file list alone). */
  checkPlan(): StoredCheckPlan {
    return finishSync(checkPlanSteps(this.w.db, [pairOf(this.w.db, this.w.profileId)!], this.w.nowMs));
  }

  /** Plans and runs the check. `crashAfter` kills it after that many steps; `stopAfter` stops it (like Stop) after that many files are started. */
  async check(options: { crashAfter?: number; resume?: CheckCheckpoint | null; onAsk?: (m: string) => void; stopAfterYields?: number; plan?: StoredCheckPlan } = {}): Promise<CheckRunResult> {
    const plan = options.plan ?? this.checkPlan();
    const run: ConfirmedMirror = { planId: plan.planId, pairs: plan.pairs, items: plan.items };
    return this.executeCheck(run, options);
  }

  async continueCheck(from: CheckRunResult, options: { crashAfter?: number; onAsk?: (m: string) => void } = {}): Promise<CheckRunResult> {
    return this.executeCheck(this.lastCheck!, { ...options, resume: from.checkpoint });
  }

  private lastCheck: ConfirmedMirror | null = null;

  private async executeCheck(run: ConfirmedMirror, options: { crashAfter?: number; resume?: CheckCheckpoint | null; onAsk?: (m: string) => void; stopAfterYields?: number }): Promise<CheckRunResult> {
    this.lastCheck = run;
    this.steps = 0;
    this.crashAt = options.crashAfter ?? null;
    const ctx = new FakeCtx();
    ctx.onAsk = options.onAsk ?? null;
    if (options.stopAfterYields !== undefined) {
      const limit = options.stopAfterYields;
      const orig = ctx.yield.bind(ctx);
      ctx.yield = async () => {
        await orig();
        if (ctx.yields >= limit) throw new JobAborted('stopped');
      };
    }
    const runner = new MirrorCheckRun(this.deps, ctx, run, (this.jobSeq += 1), options.resume ?? null);
    let report: MirrorCheckReport | null = null;
    let crashed = false;
    let stopped = false;
    try {
      report = await runner.execute();
    } catch (err) {
      if (err instanceof JobAborted) {
        stopped = true;
        report = runner.partialReport();
      } else if (err instanceof Crash) {
        crashed = true;
        for (const d of this.w.drives) {
          const was = d.plugged;
          d.unplug();
          if (was) d.plug();
        }
      } else throw err;
    }
    this.crashAt = null;
    return { report, crashed, stopped, ctx, checkpoint: ctx.last as CheckCheckpoint | null };
  }

  /** What is on the Seagate for good: path (below the root) -> content checksum. */
  seagateDurable(): Map<string, string> {
    return new Map(this.w.drives[1]!.onDrive().filter((f) => f.path.startsWith(ROOT + '/')).map((f) => [f.path.slice(ROOT.length + 1), f.sha256]));
  }
}

export { DriveGoneError };
