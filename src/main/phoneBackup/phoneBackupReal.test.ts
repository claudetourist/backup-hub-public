import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobService } from '../jobs/jobService';
import { FakeBackupAdb, FakeCtx } from '../look/harness/phoneBackupWorld.testutil';
import { sha256Of } from '../look/harness/fakeDrive.testutil';
import { makeRig, World, type Rig } from '../look/harness/world.testutil';
import { realBackupDrive } from './backupDrive';
import { PhoneBackupRun } from './runEngine';
import { PhoneBackupService } from './phoneBackupService';
import { loadConfirmed, saveConfirmed, type ConfirmedRun } from './runStore';
import { planPhoneBackup } from './planJob';
import type { PhoneBackupDeps } from './phoneBackupTypes';
import { runPreviewTool } from './previewTool';
import { PHONE_BACKUP_JOB_KIND, PHONE_LOOK_JOB_KIND } from '../../shared/phoneBackup';
import { listsFolder } from '../places/appFolders';
import type { CopyIo } from '../localCopy/verifiedCopy';

/**
 * The phone backup against a REAL folder as the drive (real files, the real safe-copy pieces: temp folder, flush, cache-free read-back,
 * link that cannot replace) with the fake phone, and through the real job service: look and plan, preview, confirm, run, report.
 */
let rig: Rig;
let w: World;
let root: string;
let adb: FakeBackupAdb;
let drivesIo: CopyIo | undefined;

const waitFor = async (cond: () => boolean, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};

function deps(): PhoneBackupDeps {
  return {
    db: rig.db,
    adb,
    log: { info: () => undefined, warn: () => undefined },
    now: () => w.nowMs,
    driveFor: async (placeId) => (placeId === w.destinations[0]!.placeId ? { drive: realBackupDrive(root, drivesIo ? { io: drivesIo } : {}), label: 'Real T7' } : null),
    sleep: async () => undefined,
  };
}

beforeEach(() => {
  rig = makeRig();
  w = new World(rig, { seed: 21 });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-phonebackup-drive-'));
  adb = new FakeBackupAdb(w.phone, w.shell);
  adb.sink = (local, data, mtimeSec) => {
    fs.writeFileSync(local, data); // adb writes to the temp name; its folder must exist already
    fs.utimesSync(local, mtimeSec, mtimeSec);
  };
  drivesIo = undefined;
  w.tick(60);
});
afterEach(() => {
  w.dispose();
  rig.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const filesUnder = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)) : []);

describe('a real folder as the drive, through the job service', () => {
  it('look and plan, preview, confirm with an untick, run, report, list on the drive; the second run copies nothing', async () => {
    const jobs = new JobService({ db: rig.db });
    const service = new PhoneBackupService(deps(), jobs);
    for (const h of service.handlers()) jobs.register(h);
    jobs.start();
    for (let i = 0; i < 5; i += 1) w.createFile(`/sdcard/DCIM/Camera/IMG_${i}.jpg`, `real ${i} ${'z'.repeat(i * 100)}`);
    w.createFile("/sdcard/Documents/Mom's notes.txt", 'apostrophe');
    w.createFile('/sdcard/DCIM/.thumbnails/t.jpg', 'thumb');

    const started = service.startLook(w.profileId);
    expect(started.ok).toBe(true);
    await waitFor(() => jobs.get(started.jobId!)?.state === 'done');
    const preview = service.preview(started.jobId!);
    expect(preview?.ok).toBe(true);
    if (!preview?.ok) return;
    const plan = preview.plan;
    expect(plan.totals.files).toBe(6);
    expect(plan.leftOut.map((g) => g.filter)).toEqual(['cache_folder']);
    expect(adb.killed).toBeGreaterThan(0); // the phone is let go after the look

    // A wrong hash is refused; the right one with one file unticked starts the copy of the other five.
    expect(service.confirm({ planId: plan.planId, hash: 'nope', unticked: [], untickedFolders: [], included: [] }).ok).toBe(false);
    const confirmed = service.confirm({ planId: plan.planId, hash: plan.hash, unticked: ['/sdcard/DCIM/Camera/IMG_0.jpg'], untickedFolders: [], included: [] });
    expect(confirmed.ok).toBe(true);
    // The Activity title names the backup (what the person called it), not the phone's model.
    expect(jobs.get(confirmed.jobId!)?.title).toBe(`Back up ${plan.backupName} now (5 files, 0 MB)`);
    expect(jobs.get(confirmed.jobId!)?.title).not.toContain(plan.phoneName);
    await waitFor(() => ['done', 'done_warnings', 'failed'].includes(jobs.get(confirmed.jobId!)?.state ?? ''));
    expect(jobs.get(confirmed.jobId!)?.state).toBe('done');
    const report = service.report(confirmed.jobId!);
    expect(report?.copied.files).toBe(5);
    expect(report?.failed).toEqual([]);
    expect(report?.listPath).toContain('lists');

    const copied = filesUnder(path.join(root, 'MyData', 'POCO'));
    expect(copied).toHaveLength(5);
    expect(copied.some((f) => f.endsWith("Mom's notes.txt"))).toBe(true);
    expect(copied.some((f) => f.endsWith('IMG_0.jpg'))).toBe(false);
    for (const f of copied) expect(sha256Of(fs.readFileSync(f))).toBeTruthy();
    // The run list names every copy, the temp folder is empty.
    const list = fs.readFileSync(report!.listPath!, 'utf8');
    expect(list).toContain("Mom's notes.txt");
    expect(list).toContain(sha256Of(fs.readFileSync(copied.find((f) => f.endsWith('IMG_1.jpg'))!)));
    expect(filesUnder(listsFolder(root))).toHaveLength(1);
    const tmpLeft = filesUnder(path.dirname(path.dirname(listsFolder(root)))).filter((f) => f.endsWith('.bhtmp'));
    expect(tmpLeft).toEqual([]);

    // The unticked file is still waiting: the next plan offers exactly that one; the finished ones are not offered again.
    const again = service.startLook(w.profileId);
    await waitFor(() => jobs.get(again.jobId!)?.state === 'done');
    const next = service.preview(again.jobId!);
    expect(next?.ok && next.plan.totals.files).toBe(1);
    expect(next?.ok && next.plan.rows[0]?.path).toBe('/sdcard/DCIM/Camera/IMG_0.jpg');
    expect(next?.ok && next.plan.alreadyBackedUp).toBe(5);
    jobs.shutdown();
  });

  it('left-out groups are included only when chosen, and an unticked folder takes all its files out', async () => {
    const jobs = new JobService({ db: rig.db });
    const service = new PhoneBackupService(deps(), jobs);
    for (const h of service.handlers()) jobs.register(h);
    jobs.start();
    w.createFile('/sdcard/DCIM/Camera/a.jpg', 'a');
    w.createFile('/sdcard/DCIM/.thumbnails/t1.jpg', 't1');
    w.createFile('/sdcard/DCIM/.thumbnails/t2.jpg', 't2');
    w.createFile('/sdcard/Documents/Work/x.txt', 'x');
    w.createFile('/sdcard/Documents/Work/y.txt', 'y');
    const started = service.startLook(w.profileId);
    await waitFor(() => jobs.get(started.jobId!)?.state === 'done');
    const preview = service.preview(started.jobId!);
    if (!preview?.ok) throw new Error('plan');
    const group = preview.plan.leftOut.find((g) => g.filter === 'cache_folder')!;
    expect(group).toMatchObject({ files: 2, canInclude: true });
    const result = service.confirm({ planId: preview.plan.planId, hash: preview.plan.hash, unticked: [], untickedFolders: ['/sdcard/Documents'], included: [group.key] });
    expect(result.ok).toBe(true);
    const run = loadConfirmed(rig.db, preview.plan.planId)!;
    expect(run.items.map((i) => i.path).toSorted()).toEqual(['/sdcard/DCIM/.thumbnails/t1.jpg', '/sdcard/DCIM/.thumbnails/t2.jpg', '/sdcard/DCIM/Camera/a.jpg']);
    expect(run.leftOut).toEqual({ files: 0, bytes: 0 });
    // The plan was used once.
    expect(service.confirm({ planId: preview.plan.planId, hash: preview.plan.hash, unticked: [], untickedFolders: [], included: [] }).ok).toBe(false);
    jobs.shutdown();
  });

  it('two clicks on Confirm at once (the sliced confirm gives the window turns) start one backup, not two', async () => {
    const jobs = new JobService({ db: rig.db });
    const service = new PhoneBackupService(deps(), jobs);
    for (const h of service.handlers()) jobs.register(h);
    jobs.start();
    for (let i = 0; i < 4; i += 1) w.createFile(`/sdcard/DCIM/Camera/p${i}.jpg`, `p${i}`);
    const started = service.startLook(w.profileId);
    await waitFor(() => jobs.get(started.jobId!)?.state === 'done');
    const preview = service.preview(started.jobId!);
    if (!preview?.ok) throw new Error('plan');
    const selection = { planId: preview.plan.planId, hash: preview.plan.hash, unticked: [], untickedFolders: [], included: [] };
    const [a, b] = await Promise.all([service.confirmSliced(selection), service.confirmSliced(selection)]);
    expect([a.ok, b.ok].toSorted()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)!.message).toMatch(/already being started|not known any more|already waiting/);
    expect(jobs.list({ states: ['queued', 'running'] }).filter((j) => j.kind === PHONE_BACKUP_JOB_KIND)).toHaveLength(1);
    await waitFor(() => ['done', 'done_warnings', 'failed'].includes(jobs.get([a, b].find((r) => r.ok)!.jobId!)?.state ?? ''));
    expect(rig.db.prepare("SELECT count(*) FROM meta WHERE key LIKE 'phoneBackup.run.%'").pluck().get()).toBe(0); // the stored list and its pieces are taken away when the run ends
    jobs.shutdown();
  });

  it('refuses a second backup while one is waiting, and a plan is used once', async () => {
    const jobs = new JobService({ db: rig.db });
    const service = new PhoneBackupService(deps(), jobs);
    for (const h of service.handlers()) jobs.register(h);
    w.createFile('/sdcard/DCIM/Camera/a.jpg', 'a');
    expect(service.startLook(w.profileId).ok).toBe(true); // not started: the queue is not running, the job waits
    expect(service.startLook(w.profileId).ok).toBe(false);
    expect(jobs.list({ states: ['queued'] }).some((j) => j.kind === PHONE_LOOK_JOB_KIND)).toBe(true);
    expect(jobs.list({ states: ['queued'] }).some((j) => j.kind === PHONE_BACKUP_JOB_KIND)).toBe(false);
    jobs.shutdown();
  });
});

describe('the real safe copy under an unkind drive', () => {
  const run = async (items: ConfirmedRun['items'], ctx: FakeCtx, resume = null as never): Promise<void> => {
    const base = (await planPhoneBackup(deps(), { backupId: w.profileId }, new FakeCtx())).stored!;
    const confirmed: ConfirmedRun = { ...base.base, items, relinks: [], leftOut: { files: 0, bytes: 0 } };
    saveConfirmed(rig.db, confirmed.planId, confirmed);
    await new PhoneBackupRun(deps(), ctx, confirmed, 1, resume).execute();
  };

  it('a flush that fails after the link keeps both names; the next run settles it and copies nothing again', async () => {
    const path1 = '/sdcard/DCIM/Camera/one.jpg';
    w.createFile(path1, 'one one one');
    const plan = (await planPhoneBackup(deps(), { backupId: w.profileId }, new FakeCtx())).stored!;
    const item = plan.items[0]!;
    const items = [{ path: item.path, size: item.size, mtimeSec: item.mtimeSec, destRel: item.destRel, rowId: item.rowId }];
    let fail = true;
    drivesIo = {
      syncFinal: async (file) => {
        if (fail && !file.endsWith('.bhtmp')) throw Object.assign(new Error('the drive dropped off'), { code: 'EIO' });
      },
    };
    const ctx = new FakeCtx();
    // The drive drops off at the final flush: the run asks the person to plug it in; here the "person" fixes it.
    ctx.onAsk = () => {
      fail = false;
    };
    await run(items, ctx);
    expect(ctx.questions.length).toBeGreaterThan(0);
    const final = path.join(root, ...item.destRel.split('/'));
    expect(fs.readFileSync(final, 'utf8')).toBe('one one one');
    expect(adb.pulls.length).toBe(1); // settled, not pulled again
    expect(rig.db.prepare("SELECT count(*) FROM files WHERE verified_how = 'read_both'").pluck().get()).toBe(1);
  });

  it('a file already at the final name with other content is never replaced', async () => {
    w.createFile('/sdcard/DCIM/Camera/two.jpg', 'two two');
    const plan = (await planPhoneBackup(deps(), { backupId: w.profileId }, new FakeCtx())).stored!;
    const item = plan.items[0]!;
    const final = path.join(root, ...item.destRel.split('/'));
    fs.mkdirSync(path.dirname(final), { recursive: true });
    fs.writeFileSync(final, 'not yours');
    const ctx = new FakeCtx();
    await run([{ path: item.path, size: item.size, mtimeSec: item.mtimeSec, destRel: item.destRel, rowId: item.rowId }], ctx);
    expect(fs.readFileSync(final, 'utf8')).toBe('not yours');
    expect(ctx.warnings.join(' ')).toMatch(/different file is already at this name/);
    expect(rig.db.prepare('SELECT count(*) FROM files WHERE backup_run_id IS NOT NULL AND origin_file_id IS NOT NULL AND verified_how = ? AND place_id = ?').pluck().get('read_both', w.destinations[0]!.placeId)).toBe(0);
  });
});

describe('the preview helper (scripts/r12-preview.mjs)', () => {
  it('prints the list to copy and what is left out, and writes nothing (not even the phone rows)', async () => {
    w.createFile('/sdcard/DCIM/Camera/a.jpg', 'aaa');
    w.createFile('/sdcard/DCIM/.thumbnails/t.jpg', 'ttt');
    w.createFile('/sdcard/Download/b.pdf', 'bbbb');
    const before = JSON.stringify(rig.db.prepare('SELECT * FROM files ORDER BY id').all());
    const lines: string[] = [];
    const code = await runPreviewTool({ dbPath: path.join(rig.dir, 'test.db'), print: (l) => lines.push(l), adb });
    const text = lines.join('\n');
    expect(code).toBe(0);
    expect(text).toMatch(/TO COPY: 2 files/);
    expect(text).toMatch(/LEFT OUT: 1 files.*Cache and thumbnail folders/);
    expect(text).toContain('/sdcard/DCIM/Camera/a.jpg|3|');
    expect(text).toContain('/sdcard/Download/b.pdf|4|');
    expect(JSON.stringify(rig.db.prepare('SELECT * FROM files ORDER BY id').all())).toBe(before);
    expect(adb.pulls).toEqual([]);
    expect(adb.shaReads).toEqual([]);
  });
});
