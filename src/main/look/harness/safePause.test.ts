import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Of, TMP_DIR } from './fakeDrive.testutil';
import { FolderWorld } from './folderWorld.testutil';
import { checkAll, invariant1, invariant2 } from './invariants.testutil';
import { buildInput, runCheck, seedImported } from './checkOldWorld.testutil';
import { MirrorWorld } from './mirrorWorld.testutil';
import { FakeCtx, pauseSim, ProductWorld } from './phoneBackupWorld.testutil';
import { makeRig, World, type Rig } from './world.testutil';

/**
 * Safe pause in the fake world: a Pause asked for while a file is on its way lets that file finish (copied, checked, recorded, checkpoint written) and
 * the job holds only at the next safe point; the app is then closed (the fake drives lose whatever was not flushed) and Continue carries on from the
 * saved place: nothing is repeated and no temp file is left. `FakeCtx` simulates the job service: `turn` (inside a file) never holds, `yield` (between files) does.
 */
let rig: Rig;
let w: World;
afterEach(() => {
  pauseSim.off();
  w.dispose();
  rig.close();
});

const tmpLeft = (i: number): string[] => w.drives[i]!.onDrive().filter((f) => f.path.startsWith(TMP_DIR)).map((f) => f.path);

describe('phone backup', () => {
  let p: ProductWorld;
  beforeEach(() => {
    rig = makeRig();
    w = new World(rig, { seed: 11, drives: [{ caseInsensitive: true, tornWrites: true }, { caseInsensitive: true }] });
    p = new ProductWorld(w);
    w.tick(60);
    for (let i = 0; i < 6; i += 1) w.createFile(`/sdcard/DCIM/Camera/IMG_${i}.jpg`, `photo ${i} ${'x'.repeat(10 + i)}`);
  });

  it('Pause in the middle of a file: that file is finished and recorded, the checkpoint says so, then it holds; Continue copies the rest and nothing twice', async () => {
    pauseSim.atTurn = 1; // the first time the run is in the middle of a file
    pauseSim.skip = 1; // the plan's own context
    const first = await p.backup();
    pauseSim.off();
    expect(first.ctx.heldAt).not.toBeNull(); // it held (at a safe point)
    expect(first.ctx.turnsAfterPause).toBeGreaterThan(0); // the pause was asked in the middle of a file, which went on
    expect(first.crashed).toBe(true); // the app closed while paused
    expect(first.copied).toBe(1); // that file was recorded
    expect(first.checkpoint?.next).toBe(1); // and its place saved
    expect(tmpLeft(0)).toEqual([]);
    expect(w.drives[0]!.durableSha('MyData/POCO/' + (await sessionOf(w)) + '/DCIM/Camera/IMG_0.jpg')).toBe(sha256Of(w.phone.read('/sdcard/DCIM/Camera/IMG_0.jpg')));
    const pullsBefore = p.adb.pulls.length;
    const second = await p.continueRun({}, first);
    expect(second.crashed).toBe(false);
    expect(w.copyLog).toHaveLength(6);
    expect(p.adb.pulls.length - pullsBefore).toBe(5); // the file done before the pause is not pulled again
    expect([...checkAll(w), ...invariant1(w), ...invariant2(w)]).toEqual([]);
  });
});

/** The dated folder of the backup on the drive (the one folder the first run made). */
async function sessionOf(world: World): Promise<string> {
  const names = new Set(world.drives[0]!.onDrive().map((f) => f.path.split('/')[2]).filter((n): n is string => n !== undefined && n.startsWith('POCO-')));
  return [...names][0] ?? '';
}

describe('folder backup', () => {
  it('Pause in the middle of a file: the file is finished and recorded, the checkpoint says so, then it holds; Continue copies the rest', async () => {
    rig = makeRig();
    w = new World(rig, { seed: 21, drives: [{ caseInsensitive: true }] });
    const f = new FolderWorld(w);
    for (let i = 0; i < 5; i += 1) f.put(`d/file${i}.txt`, `content number ${i}`);
    const before = f.durable();
    pauseSim.atTurn = 1;
    pauseSim.skip = 1; // the plan's own context
    const first = await f.backup();
    pauseSim.off();
    expect(first.ctx.heldAt).not.toBeNull();
    expect(first.ctx.turnsAfterPause).toBeGreaterThan(0);
    expect(first.crashed).toBe(true);
    expect(first.checkpoint?.next).toBe(1);
    expect(w.db.prepare('SELECT count(*) FROM files WHERE backup_run_id IS NOT NULL').pluck().get()).toBe(1);
    expect([...f.durable().keys()]).toHaveLength(1);
    expect(tmpLeft(0)).toEqual([]);
    const second = await f.continueRun(first);
    expect(second.crashed).toBe(false);
    expect(second.report?.copied.files).toBe(5); // the report counts the whole copy, both parts
    expect(new Set(f.src.reads).size).toBe(f.src.reads.length); // no file was read from the folder twice: the first one is not copied again
    expect([...f.durable().keys()]).toHaveLength(5);
    expect(f.violations(before)).toEqual([]);
    expect(tmpLeft(0)).toEqual([]);
  });
});

describe('second drive (mirror)', () => {
  it('Pause in the middle of a file: the file is finished, checked and recorded on the second drive, then it holds; Continue does the rest and nothing twice', async () => {
    rig = makeRig();
    w = new World(rig, { seed: 31 });
    const mw = new MirrorWorld(w);
    for (let i = 0; i < 5; i += 1) mw.seed(`S1/f${i}.jpg`, `content ${i} ${'z'.repeat(i)}`);
    pauseSim.atTurn = 1;
    pauseSim.skip = 1; // the plan's own context
    const first = await mw.mirror();
    pauseSim.off();
    expect(first.ctx.heldAt).not.toBeNull();
    expect(first.ctx.turnsAfterPause).toBeGreaterThan(0);
    expect(first.crashed).toBe(true);
    expect(first.checkpoint?.next).toBe(1);
    expect(mw.seagateDurable().size).toBe(1);
    expect(tmpLeft(1)).toEqual([]);
    const second = await mw.continueRun(first);
    expect(second.crashed).toBe(false);
    expect(second.report?.copied.files).toBe(5); // the report counts the whole copy, both parts
    expect(new Set(mw.reads.t7).size).toBe(mw.reads.t7.length); // no T7 file was read twice
    expect(mw.seagateDurable().size).toBe(5);
    expect(w.drives[1]!.overwrites).toEqual([]);
    expect(tmpLeft(1)).toEqual([]);
  });

  it('Pause during Check old copies: what was proven so far is written and the place saved before it holds; Continue checks the rest only', async () => {
    rig = makeRig();
    w = new World(rig, { seed: 52 });
    const mw = new MirrorWorld(w);
    for (let i = 0; i < 6; i += 1) {
      mw.seed(`S1/DCIM/Camera/f${i}.jpg`, `same content ${i}`);
      mw.seedSeagate(`S1/DCIM/Camera/f${i}.jpg`, `same content ${i}`);
    }
    const proven = (): number => rig.db.prepare("SELECT count(*) FROM files WHERE place_id = ? AND verified_how = 'read_both'").pluck().get(w.destinations[1]!.placeId) as number;
    pauseSim.atTurn = 1;
    const first = await mw.check();
    pauseSim.off();
    expect(first.ctx.heldAt).not.toBeNull();
    expect(first.crashed).toBe(true); // the app closed while paused: rows that were only in memory would be lost
    const next = first.checkpoint?.next ?? 0;
    expect(next).toBeGreaterThanOrEqual(1);
    expect(proven()).toBe(next); // every file the checkpoint counts is in the index
    const second = await mw.continueCheck(first);
    expect(second.report).toMatchObject({ complete: true });
    expect(proven()).toBe(6);
    expect(w.drives[1]!.overwrites).toEqual([]);
  });
});

describe('check old copies of a phone backup', () => {
  it('Pause during a batch: the batch is finished and its checkpoint saved, then it holds; Continue checks the rest only', async () => {
    rig = makeRig();
    w = new World(rig, { seed: 21, drives: [{ caseInsensitive: true, tornWrites: true }, { caseInsensitive: true }] });
    const p = new ProductWorld(w);
    w.tick(60);
    const paths: string[] = [];
    for (let i = 0; i < 45; i += 1) {
      paths.push(`/sdcard/DCIM/Camera/IMG_${i}.jpg`);
      w.createFile(paths[i]!, `photo ${i} ${'x'.repeat(10 + (i % 7))}`);
    }
    await w.look();
    for (const path of paths) seedImported(w, path);
    const verified = (): number => w.db.prepare("SELECT count(*) FROM files WHERE place_id = ? AND verified_how = 'read_both'").pluck().get(w.destinations[0]!.placeId) as number;
    pauseSim.atTurn = 1;
    const ctx = new FakeCtx();
    pauseSim.off();
    const input = buildInput(w); // the confirmed list: the same one is used again by Continue
    const first = await runCheck(p, input, { ctx });
    expect(ctx.heldAt).not.toBeNull();
    expect(ctx.turnsAfterPause).toBeGreaterThan(1); // the batch went on after the Pause was asked
    expect(first.checkpoint?.next).toBe(40); // one whole batch (40 files) was finished and its place saved
    expect(verified()).toBe(40);
    const second = await runCheck(p, input, { resume: first.checkpoint });
    expect(second.error).toBeNull();
    expect(verified()).toBe(45);
  });
});
