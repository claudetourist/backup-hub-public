import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobService } from '../../jobs/jobService';
import { PhoneBackupService } from '../../phoneBackup/phoneBackupService';
import { PhoneBackupRun } from '../../phoneBackup/runEngine';
import { saveConfirmed, type ConfirmedRun } from '../../phoneBackup/runStore';
import type { PhoneBackupProgress } from '../../../shared/phoneBackup';
import { FakeCtx, ProductWorld } from './phoneBackupWorld.testutil';
import { makeRig, World, type Rig } from './world.testutil';

/**
 * What the window sees while a phone backup copies: the file now, the files still waiting in copy order, the ones done and the ones not
 * copied with their reason, through the real plan and the real run in the fake world (R1.2a fix).
 */
describe('the live progress of a phone backup in the fake world', () => {
  let rig: Rig;
  let w: World;
  let p: ProductWorld;

  const seed = (n: number): void => {
    for (let i = 0; i < n; i += 1) w.createFile(`/sdcard/DCIM/Camera/IMG_${i}.jpg`, `photo ${i} ${'x'.repeat(10 + i)}`);
  };

  beforeEach(() => {
    rig = makeRig();
    w = new World(rig, { seed: 11, drives: [{ caseInsensitive: true, tornWrites: true }, { caseInsensitive: true }] });
    p = new ProductWorld(w);
    w.tick(60);
  });
  afterEach(() => {
    w.dispose();
    rig.close();
  });

  it('shows the current file, the waiting files in order, the done files and the failed one with its reason', async () => {
    seed(5);
    const { outcome } = await p.plan();
    expect(outcome.result.ok).toBe(true);
    const s = outcome.stored!;
    const items = s.items.map((i) => ({ path: i.path, size: i.size, mtimeSec: i.mtimeSec, destRel: i.destRel, rowId: i.rowId }));
    const run: ConfirmedRun = { ...s.base, items, relinks: s.relinks, leftOut: { files: 0, bytes: 0 } };
    saveConfirmed(rig.db, run.planId, run);
    // The first file comes back wrong three times (the pull is tried again twice), so it is not copied.
    p.adb.pullFaults.push('corrupt', 'corrupt', 'corrupt');
    const seen: PhoneBackupProgress[] = [];
    const ctx = new (class extends FakeCtx {
      override progress(_done?: number, _total?: number, extras?: { message?: string }): void {
        if (extras?.message?.startsWith('Copying ')) seen.push(runner.progress.snapshot(7));
      }
    })();
    const runner = new PhoneBackupRun(p.deps, ctx, run, 7, null);
    expect(runner.progress.snapshot(7)).toMatchObject({ total: 5, waiting: 5, current: null, finished: false });
    await runner.execute();

    // While the first file was being copied it was the current one and the other four waited, in path order.
    const first = seen[0]!;
    expect(first.current?.path).toBe(items[0]!.path);
    expect(first.next.map((f) => f.path)).toEqual(items.slice(1).map((i) => i.path));
    expect(first).toMatchObject({ done: 0, waiting: 4, total: 5 });
    // Later it moved on: never more done, never more waiting.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]!.done + seen[i]!.failedCount).toBeGreaterThanOrEqual(seen[i - 1]!.done + seen[i - 1]!.failedCount);
      expect(seen[i]!.waiting).toBeLessThanOrEqual(seen[i - 1]!.waiting);
    }
    expect(seen.some((x) => x.current?.path === items[3]!.path && x.waiting === 1 && x.done === 2 && x.failedCount === 1)).toBe(true);

    const end = runner.progress.snapshot(7);
    expect(end).toMatchObject({ done: 4, failedCount: 1, waiting: 0, current: null, finished: true, next: [] });
    expect(end.failed).toHaveLength(1);
    expect(end.failed[0]).toMatchObject({ path: items[0]!.path, reason: "The copy did not match the phone's checksum." });
    expect(end.recent.map((f) => f.path)).toEqual(items.slice(1).map((i) => i.path).toReversed());
  });

  it('a file that is already on the drive or changed on the phone is shown as not copied, with the reason', async () => {
    seed(3);
    const { outcome } = await p.plan();
    const s = outcome.stored!;
    const items = s.items.map((i) => ({ path: i.path, size: i.size, mtimeSec: i.mtimeSec, destRel: i.destRel, rowId: i.rowId }));
    const run: ConfirmedRun = { ...s.base, items, relinks: s.relinks, leftOut: { files: 0, bytes: 0 } };
    saveConfirmed(rig.db, run.planId, run);
    w.editFile(items[1]!.path, ' edited after the preview');
    const runner = new PhoneBackupRun(p.deps, new FakeCtx(), run, 8, null);
    await runner.execute();
    const end = runner.progress.snapshot(8);
    expect(end).toMatchObject({ done: 2, failedCount: 1, finished: true });
    expect(end.failed[0]).toMatchObject({ path: items[1]!.path, reason: 'It changed on the phone after the preview. The next backup picks it up.' });
  });
});

describe('the progress answer of the phone backup service', () => {
  let rig: Rig;
  let w: World;
  let p: ProductWorld;
  let jobs: JobService;
  let service: PhoneBackupService;

  const waitFor = async (cond: () => boolean, ms = 20_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeEach(() => {
    rig = makeRig();
    w = new World(rig, { seed: 5, drives: [{ caseInsensitive: true, tornWrites: true }, { caseInsensitive: true }] });
    p = new ProductWorld(w);
    jobs = new JobService({ db: rig.db });
    service = new PhoneBackupService(p.deps, jobs);
    for (const h of service.handlers()) jobs.register(h);
    jobs.start();
    w.tick(60);
  });
  afterEach(() => {
    jobs.shutdown();
    w.dispose();
    rig.close();
  });

  const backupAll = async (): Promise<number> => {
    const look = service.startLook(w.profileId);
    await waitFor(() => jobs.get(look.jobId!)?.state === 'done');
    const preview = service.preview(look.jobId!);
    if (!preview?.ok) throw new Error('no plan');
    const started = service.confirm({ planId: preview.plan.planId, hash: preview.plan.hash, unticked: [], untickedFolders: [], included: [] });
    expect(started.ok).toBe(true);
    await waitFor(() => ['done', 'done_warnings', 'failed'].includes(jobs.get(started.jobId!)?.state ?? ''));
    return started.jobId!;
  };

  it('answers for the running job, ends as finished, lists the copied files, and keeps only the last two runs', async () => {
    for (let i = 0; i < 4; i += 1) w.createFile(`/sdcard/DCIM/Camera/A_${i}.jpg`, `a ${i} ${'y'.repeat(i)}`);
    expect(service.progress(999)).toBeNull();
    expect(service.progress('x')).toBeNull();
    const first = await backupAll();
    const done = service.progress(first)!;
    expect(done).toMatchObject({ jobId: first, total: 4, done: 4, waiting: 0, failedCount: 0, current: null, finished: true });
    expect(done.recent).toHaveLength(4);
    const copied = service.copied(first)!;
    expect(copied.total).toBe(4);
    expect(copied.files.map((f) => f.path).toSorted()).toEqual([0, 1, 2, 3].map((i) => `/sdcard/DCIM/Camera/A_${i}.jpg`));
    expect(service.copied(999)).toBeNull();

    w.createFile('/sdcard/DCIM/Camera/B_0.jpg', 'b0');
    const second = await backupAll();
    w.createFile('/sdcard/DCIM/Camera/C_0.jpg', 'c0');
    const third = await backupAll();
    expect(service.progress(third)?.total).toBe(1);
    expect(service.progress(second)?.total).toBe(1);
    expect(service.progress(first)).toBeNull();
  });
});
