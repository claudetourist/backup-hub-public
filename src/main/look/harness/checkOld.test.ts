import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobService } from '../../jobs/jobService';
import { PhoneBackupService } from '../../phoneBackup/phoneBackupService';
import { checkAll, invariant1, invariant2 } from './invariants.testutil';
import { buildInput, copyRow, runCheck, seedImported, spyOnDriveReads } from './checkOldWorld.testutil';
import { FakeCtx, ProductWorld } from './phoneBackupWorld.testutil';
import { sha256Of } from './fakeDrive.testutil';
import { makeRig, World, type Rig } from './world.testutil';

/**
 * "Check old copies" (R1.4b) through the real check against the fake world: a fake phone, an unkind fake drive (cached and uncached reads,
 * pulled cables) and a real temp database. Only the adb port and the drive are fakes; the index writes, the batches, the waiting for the
 * person and the plan that follows are the product's.
 */
const HOSTILE = ["it's.jpg", 'a b.jpg', '$HOME.txt', 'semi;colon.txt', '-dash.txt', 'tick`s.txt', 'x(1).txt', 'amp&.txt', '[br].txt'];

describe('Check old copies in the fake world', () => {
  let rig: Rig;
  let w: World;
  let p: ProductWorld;

  const photo = (i: number): string => `/sdcard/DCIM/Camera/IMG_${i}.jpg`;
  /** n phone files with an old copy each (equal content), looked at so the index knows them. */
  const seed = async (n: number, from = 0): Promise<string[]> => {
    const paths: string[] = [];
    for (let i = from; i < from + n; i += 1) {
      w.createFile(photo(i), `photo ${i} ${'x'.repeat(10 + (i % 7))}`);
      paths.push(photo(i));
    }
    await w.look();
    for (const path of paths) seedImported(w, path);
    return paths;
  };
  const driveSha = (path: string): string | null => w.drives[0]!.durableSha(`MyData/POCO/OLD-TOOL/${path.replace('/sdcard/', '')}`);
  const copyIdOf = (path: string): number => w.db.prepare("SELECT id FROM files WHERE place_id = ? AND rel_path = ?").pluck().get(w.destinations[0]!.placeId, `MyData/POCO/OLD-TOOL/${path.replace('/sdcard/', '')}`) as number;

  beforeEach(() => {
    rig = makeRig();
    w = new World(rig, { seed: 21, drives: [{ caseInsensitive: true, tornWrites: true }, { caseInsensitive: true }] });
    p = new ProductWorld(w);
    w.tick(60);
  });
  afterEach(() => {
    w.dispose();
    rig.close();
  });

  it('an equal copy becomes a checked copy (read on the phone and on the drive); nothing on the phone or the drive changes', async () => {
    const paths = await seed(3);
    const before = paths.map(driveSha);
    const phoneBefore = w.phone.walk();
    const run = await runCheck(p, buildInput(w));
    expect(run.error).toBeNull();
    expect(run.report).toMatchObject({ asked: 3, differCount: 0, missingCount: 0, noLongerOnPhone: 0, couldNotRead: [] });
    expect(run.report!.verified.files).toBe(3);
    for (const path of paths) {
      const row = copyRow(w, copyIdOf(path));
      expect(row).toMatchObject({ verified_how: 'read_both', verified_at: w.nowMs, expected_sha256: sha256Of(w.phone.read(path)), gone_at: null });
    }
    expect(paths.map(driveSha)).toEqual(before);
    expect(w.phone.walk()).toEqual(phoneBefore);
    expect(w.drives[0]!.overwrites).toEqual([]);
    expect([...checkAll(w), ...invariant1(w), ...invariant2(w)]).toEqual([]);
    // Run again with nothing left to check: nothing is asked of the phone.
    expect(buildInput(w).items).toEqual([]);
  });

  it('a different copy is marked, listed by name, left byte for byte as it was, and the next backup copies the phone file again into a new folder', async () => {
    const good = await seed(2);
    // The old tool recorded the phone's size for both: one damaged copy has the same size and other bytes, one is cut short.
    const [bad, short] = [photo(2), photo(3)] as [string, string];
    w.createFile(bad, 'bad photo number two xxxxxxxx');
    w.createFile(short, 'short photo number three yyyyyyyyyyy');
    await w.look();
    const badCopy = seedImported(w, bad, { driveContent: 'Z'.repeat(w.phone.read(bad).length) });
    const shortCopy = seedImported(w, short, { driveContent: Buffer.from('abc') });
    const badBefore = w.drives[0]!.durableSha(badCopy.driveRel);
    const shortBefore = w.drives[0]!.durableSha(shortCopy.driveRel);

    const run = await runCheck(p, buildInput(w));
    expect(run.report).toMatchObject({ asked: 4, differCount: 2, missingCount: 0 });
    expect(run.report!.verified.files).toBe(2);
    expect(run.report!.differ.map((d) => d.path).toSorted()).toEqual([bad, short].toSorted());
    expect(copyRow(w, badCopy.copyId)).toMatchObject({ verified_how: 'differs', gone_at: null });
    expect(copyRow(w, shortCopy.copyId)).toMatchObject({ verified_how: 'differs', gone_at: null });
    expect(w.db.prepare("SELECT count(*) FROM file_problems WHERE kind = 'copy_differs' AND state = 'open'").pluck().get()).toBe(2);
    expect(good.every((x) => copyRow(w, copyIdOf(x)).verified_how === 'read_both')).toBe(true);
    // The drive's files were not touched.
    expect(w.drives[0]!.durableSha(badCopy.driveRel)).toBe(badBefore);
    expect(w.drives[0]!.durableSha(shortCopy.driveRel)).toBe(shortBefore);
    expect(w.drives[0]!.overwrites).toEqual([]);

    // The next backup offers exactly those two phone files as fresh copies, in a new dated folder.
    const { outcome } = await p.plan();
    expect(outcome.result.ok).toBe(true);
    const items = outcome.stored!.items;
    expect(items.map((i) => i.path).toSorted()).toEqual([bad, short].toSorted());
    for (const i of items) expect(i.destRel.startsWith('MyData/POCO/POCO-')).toBe(true);
    const copied = await p.backup();
    expect(copied.copied).toBe(2);
    expect(copied.ctx.warnings).toEqual([]);
    // Now all four are backed up and checked, and the old damaged files are still there as they were.
    expect(w.drives[0]!.durableSha(badCopy.driveRel)).toBe(badBefore);
    expect(w.drives[0]!.durableSha(shortCopy.driveRel)).toBe(shortBefore);
    const counts = await new PhoneBackupService(p.deps, new JobService({ db: rig.db })).checkOldCounts(w.profileId);
    expect(counts.ok && [counts.total.checked.files, counts.total.unchecked.files, counts.total.noCopy.files]).toEqual([4, 0, 0]);
    expect(w.drives[0]!.overwrites).toEqual([]);
  });

  it('a file missing on the drive is marked gone (the row is kept) and the next backup offers it again', async () => {
    const paths = await seed(3);
    const gone = paths[0]!;
    w.drives[0]!.discard(`MyData/POCO/OLD-TOOL/${gone.replace('/sdcard/', '')}`);
    const run = await runCheck(p, buildInput(w));
    expect(run.report).toMatchObject({ asked: 3, missingCount: 1, differCount: 0 });
    expect(run.report!.missing.map((m) => m.path)).toEqual([gone]);
    expect(copyRow(w, copyIdOf(gone))).toMatchObject({ gone_reason: 'missing_on_drive', verified_how: 'imported' });
    expect(copyRow(w, copyIdOf(gone)).gone_at).not.toBeNull();
    const { outcome } = await p.plan();
    expect(outcome.stored!.items.map((i) => i.path)).toEqual([gone]);
  });

  it('a drive that is not plugged in does not make files "missing": the check waits for the person and carries on with the same file', async () => {
    const paths = await seed(5);
    const reads = spyOnDriveReads(p);
    let yields = 0;
    const ctx = new (class extends FakeCtx {
      override async yield(): Promise<void> {
        yields += 1;
        if (yields === 3) w.drives[0]!.unplug();
        await super.yield();
      }
      // Inside a batch the run takes a turn (no pause hold) instead of a yield: count those too.
      override async turn(): Promise<void> {
        yields += 1;
        if (yields === 3) w.drives[0]!.unplug();
        await super.turn();
      }
    })();
    ctx.onAsk = () => w.drives[0]!.plug();
    const run = await runCheck(p, buildInput(w), { ctx });
    expect(run.error).toBeNull();
    expect(ctx.questions).toHaveLength(1);
    expect(ctx.questions[0]).toMatch(/drive was unplugged/i);
    expect(run.report).toMatchObject({ asked: 5, missingCount: 0, differCount: 0 });
    expect(run.report!.verified.files).toBe(5);
    expect(new Set(reads).size).toBe(5);
    expect(reads).toHaveLength(5);
    expect(paths.every((x) => copyRow(w, copyIdOf(x)).gone_at === null)).toBe(true);
  });

  it('a file that is no longer on the phone is skipped and counted; its copy is left as it was and the drive is not read for it', async () => {
    const paths = await seed(3);
    w.phone.remove(paths[1]!);
    const reads = spyOnDriveReads(p);
    const run = await runCheck(p, buildInput(w));
    expect(run.report).toMatchObject({ asked: 3, noLongerOnPhone: 1, differCount: 0, missingCount: 0 });
    expect(run.report!.verified.files).toBe(2);
    expect(copyRow(w, copyIdOf(paths[1]!))).toMatchObject({ verified_how: 'imported', gone_at: null });
    expect(reads.some((r) => r.endsWith('IMG_1.jpg'))).toBe(false);
  });

  it('a phone that is unplugged between two batches stops the check, asks for Continue, and nothing already read is read again', async () => {
    const paths = await seed(45);
    p.adb.beforeShaMany = (n) => {
      if (n === 2) p.adb.plugged = false;
    };
    const ctx = new FakeCtx();
    ctx.onAsk = () => {
      p.adb.plugged = true;
    };
    const run = await runCheck(p, buildInput(w), { ctx });
    expect(run.error).toBeNull();
    expect(ctx.questions).toHaveLength(1);
    expect(ctx.questions[0]).toMatch(/not plugged in/i);
    expect(run.report!.verified.files).toBe(45);
    expect(p.adb.shaBatches.map((b) => b.length)).toEqual([40, 5, 5]);
    expect(new Set(p.adb.shaReads).size).toBe(45);
    expect(p.adb.shaReads).toHaveLength(45);
    expect(paths.every((x) => copyRow(w, copyIdOf(x)).verified_how === 'read_both')).toBe(true);
    expect(p.adb.killed).toBe(0); // the job handler lets the phone go, not the run
  });

  it('a check killed half way carries on from its checkpoint: the files already settled are not asked of the phone or read from the drive again', async () => {
    const paths = await seed(45);
    const input = buildInput(w);
    const first = new FakeCtx();
    first.crashAt = 45; // inside the second batch, after three of its files were settled
    const dead = await runCheck(p, input, { ctx: first });
    expect(dead.error).toBeInstanceOf(Error);
    expect(dead.checkpoint).toMatchObject({ next: 40 });
    const settled = paths.filter((x) => copyRow(w, copyIdOf(x)).verified_how === 'read_both');
    expect(settled.length).toBeGreaterThanOrEqual(42);
    expect(settled.length).toBeLessThan(45);

    const askedBefore = p.adb.shaBatches.length;
    const reads = spyOnDriveReads(p);
    const again = await runCheck(p, input, { resume: dead.checkpoint });
    expect(again.error).toBeNull();
    // Only the files that were not settled are asked of the phone, once.
    const asked = p.adb.shaBatches.slice(askedBefore).flat();
    expect(asked.toSorted()).toEqual(paths.filter((x) => !settled.includes(x)).toSorted());
    expect(reads).toHaveLength(asked.length);
    expect(again.report!.verified.files).toBe(45);
    expect(again.report).toMatchObject({ asked: 45, differCount: 0, missingCount: 0 });
  });

  it('reads the drive without the cache: a file that looks right in the system memory but is different on the drive is called different, and the opposite', async () => {
    const paths = await seed(2);
    const [a, b] = paths as [string, string];
    const pathA = `MyData/POCO/OLD-TOOL/${a.replace('/sdcard/', '')}`;
    const pathB = `MyData/POCO/OLD-TOOL/${b.replace('/sdcard/', '')}`;
    const sizeA = w.phone.read(a).length;
    // a: the drive really holds other bytes; memory still holds the phone's bytes. b: the drive holds the phone's bytes; memory holds others.
    w.drives[0]!.discard(pathA);
    w.drives[0]!.write(pathA, 'Q'.repeat(sizeA), 1);
    w.drives[0]!.flush(pathA);
    w.drives[0]!.write(pathA, w.phone.read(a), 1);
    w.drives[0]!.write(pathB, 'Q'.repeat(w.phone.read(b).length), 1);
    expect(w.drives[0]!.readCached(pathA).equals(w.phone.read(a))).toBe(true);
    const reads = spyOnDriveReads(p);
    const run = await runCheck(p, buildInput(w));
    expect(reads.toSorted()).toEqual([pathA, pathB].toSorted());
    expect(run.report!.differ.map((d) => d.path)).toEqual([a]);
    expect(copyRow(w, copyIdOf(a)).verified_how).toBe('differs');
    expect(copyRow(w, copyIdOf(b)).verified_how).toBe('read_both');
  });

  it('names a shell would treat as code are asked of the phone as plain names in one batch and checked like any other', async () => {
    const paths: string[] = [];
    for (const [i, name] of HOSTILE.entries()) {
      w.createFile(`/sdcard/Documents/${name}`, `doc ${i} ${name}`);
      paths.push(`/sdcard/Documents/${name}`);
    }
    await w.look();
    for (const path of paths) seedImported(w, path);
    const run = await runCheck(p, buildInput(w));
    expect(run.report!.verified.files).toBe(HOSTILE.length);
    expect(p.adb.shaBatches).toHaveLength(1);
    expect(p.adb.shaBatches[0]!.toSorted()).toEqual(paths.toSorted());
    const command = p.adb.shaCommands[0]!;
    expect(command.startsWith("sha256sum '/sdcard/Documents/")).toBe(true);
    expect(command).toContain(`'/sdcard/Documents/it'\\''s.jpg'`);
    expect(command).toContain("'/sdcard/Documents/$HOME.txt'");
    expect(command).not.toMatch(/[;&|]\s*$/);
  });

  it('a copy that is not on the phone at the backup\'s second drive is left alone: only destination 1 is looked at', async () => {
    const paths = await seed(2);
    // A row at the second drive that came from the same phone file, unchecked: it must never be touched or asked about.
    const second = w.db
      .prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, origin_file_id, verified_how) SELECT ?, 'MyData/POCO/Seagate-copy/IMG_0.jpg', size, mtime, 1, 1, id, 'imported' FROM files WHERE place_id = ? AND rel_path = ?")
      .run(w.destinations[1]!.placeId, w.placeId, paths[0]!.replace(/^\//, '')).lastInsertRowid;
    const input = buildInput(w);
    expect(input.items).toHaveLength(2);
    expect(input.items.every((i) => !i.copyRel.includes('Seagate'))).toBe(true);
    await runCheck(p, input);
    expect(w.db.prepare('SELECT verified_how FROM files WHERE id = ?').pluck().get(second)).toBe('imported');
  });
});

describe('the Check old copies job and its answers', () => {
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
  const finished = (id: number): boolean => ['done', 'done_warnings', 'failed'].includes(jobs.get(id)?.state ?? '');

  beforeEach(() => {
    rig = makeRig();
    w = new World(rig, { seed: 23, drives: [{ caseInsensitive: true }, { caseInsensitive: true }] });
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

  const seedFolders = async (): Promise<void> => {
    for (let i = 0; i < 3; i += 1) w.createFile(`/sdcard/DCIM/Camera/IMG_${i}.jpg`, `photo ${i} ${'x'.repeat(100 * (i + 1))}`);
    for (let i = 0; i < 2; i += 1) w.createFile(`/sdcard/Documents/doc_${i}.txt`, `doc ${i} ${'y'.repeat(50)}`);
    await w.look();
    for (const path of w.phone.walk().map((f) => f.path)) seedImported(w, path);
  };

  it('the preview lists the folders with unchecked copies, largest first; the job checks the ticked ones and keeps a report; the phone is let go', async () => {
    await seedFolders();
    const plan = await service.checkOldPlan(w.profileId);
    expect(plan).toMatchObject({ ok: true, driveLabel: 'Fake T7', totals: { files: 5 } });
    if (!plan.ok) throw new Error('no plan');
    expect(plan.folders.map((f) => [f.folder, f.files])).toEqual([['DCIM/Camera', 3], ['Documents', 2]]);
    expect(plan.folders[0]!.bytes).toBeGreaterThan(plan.folders[1]!.bytes);

    const started = await service.startCheckOld({ backupId: w.profileId, folders: ['DCIM/Camera'] });
    expect(started.ok).toBe(true);
    // One phone job at a time.
    expect((await service.startCheckOld({ backupId: w.profileId, folders: ['Documents'] })).ok).toBe(false);
    await waitFor(() => finished(started.jobId!));
    expect(jobs.get(started.jobId!)?.state).toBe('done');
    expect(jobs.get(started.jobId!)?.title).toMatch(/^Check old copies: Backup \S+ \(3 files/);
    expect(jobs.get(started.jobId!)?.title).not.toContain('Fake phone');
    const report = service.checkOldReport(started.jobId!)!;
    expect(report).toMatchObject({ asked: 3, differCount: 0, missingCount: 0, driveLabel: 'Fake T7' });
    expect(report.verified.files).toBe(3);
    expect(service.checkOldReport(9999)).toBeNull();
    expect(p.adb.killed).toBeGreaterThan(0);
    const counts = await service.checkOldCounts(w.profileId);
    expect(counts.ok && [counts.total.checked.files, counts.total.unchecked.files]).toEqual([3, 2]);
    // The second folder was not ticked: still waiting. A later check finds only it.
    const again = await service.checkOldPlan(w.profileId);
    expect(again.ok && again.folders.map((f) => f.folder)).toEqual(['Documents']);
  });

  it('says in plain words why it cannot start: the phone is not plugged in, the drive is not plugged in, nothing is left, nothing ticked', async () => {
    await seedFolders();
    p.adb.plugged = false;
    const phoneGone = await service.checkOldPlan(w.profileId);
    expect(phoneGone).toMatchObject({ ok: false });
    expect(!phoneGone.ok && phoneGone.message).toMatch(/not plugged in/i);
    expect((await service.startCheckOld({ backupId: w.profileId, folders: ['Documents'] })).message).toMatch(/not plugged in.*Nothing was checked/i);
    p.adb.plugged = true;
    w.drives[0]!.unplug();
    const driveGone = await service.checkOldPlan(w.profileId);
    expect(!driveGone.ok && driveGone.message).toMatch(/drive for this backup is not plugged in/i);
    w.drives[0]!.plug();
    expect((await service.startCheckOld({ backupId: w.profileId, folders: ['Nowhere'] })).message).toMatch(/No old copies are left/);
    expect(await service.checkOldPlan(99_999)).toMatchObject({ ok: false });
    expect(jobs.list({ states: ['queued', 'running', 'needs_you'] })).toHaveLength(0);
  });
});
