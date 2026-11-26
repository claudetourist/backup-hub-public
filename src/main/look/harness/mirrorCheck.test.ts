import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listNeedsDecision } from '../../decisions/needsDecision';
import { CHECK_BATCH } from '../../mirror/mirrorCheckRun';
import { MIRROR_DIFFERS_PROBLEM } from '../../../shared/mirror';
import { checkGroupOf } from '../../../shared/mirrorCheck';
import { sha256Of } from './fakeDrive.testutil';
import { MirrorWorld, ROOT, type CheckRunResult } from './mirrorWorld.testutil';
import { makeRig, World, type Rig } from './world.testutil';

/**
 * "Check old copies" (R1.3b) in the fake world: the files already on the Seagate with the same size are proven in a job of their own. Same checksum: a
 * verified copy in the index; different: never replaced, a decision; the T7 is read only when its checksum is not known; photos and videos first; killed
 * at every point then Continue gives the same result; nothing is ever written to either drive.
 */
let rig: Rig;
let w: World;
let mw: MirrorWorld;

beforeEach(() => {
  rig = makeRig();
  w = new World(rig, { seed: 52 });
  mw = new MirrorWorld(w);
});
afterEach(() => {
  w.dispose();
  rig.close();
});

const dstRow = (rel: string): Record<string, unknown> => rig.db.prepare('SELECT * FROM files WHERE place_id = ? AND rel_path = ?').get(w.destinations[1]!.placeId, `${ROOT}/${rel}`) as Record<string, unknown>;
const srcRow = (rel: string): Record<string, unknown> => rig.db.prepare('SELECT * FROM files WHERE place_id = ? AND rel_path = ?').get(w.destinations[0]!.placeId, `${ROOT}/${rel}`) as Record<string, unknown>;
const problems = (): number => rig.db.prepare("SELECT count(*) FROM file_problems WHERE kind = ? AND state = 'open'").pluck().get(MIRROR_DIFFERS_PROBLEM) as number;
/** The same file on both drives (the old tool's copy). */
const both = (rel: string, t7: string, sea: string = t7, options: { expected?: boolean; sha?: string | null } = {}): void => {
  mw.seed(rel, t7, options);
  mw.seedSeagate(rel, sea);
};
const noWrites = (): void => {
  expect(w.drives[0]!.overwrites).toEqual([]);
  expect(w.drives[1]!.overwrites).toEqual([]);
};

describe('what is checked', () => {
  it('groups: photos and videos (folders and endings), documents, the rest', () => {
    expect(checkGroupOf('Poco/DCIM/Camera/IMG_1.jpg')).toBe('photos');
    expect(checkGroupOf('Poco/DCIM/Camera/IMG_1.json')).toBe('photos');
    expect(checkGroupOf('Poco/Pictures/x.webp')).toBe('photos');
    expect(checkGroupOf('Poco/WhatsApp Images/x.bin')).toBe('photos');
    expect(checkGroupOf('Poco/WhatsApp Video/v')).toBe('photos');
    expect(checkGroupOf('Poco/random/clip.MP4')).toBe('photos');
    expect(checkGroupOf('Poco/random/a.HEIC')).toBe('photos');
    expect(checkGroupOf('Poco/random/a.mov')).toBe('photos');
    expect(checkGroupOf('Poco/random/a.png')).toBe('photos');
    expect(checkGroupOf('Poco/Documents/notes')).toBe('documents');
    expect(checkGroupOf('Poco/x/form.pdf')).toBe('documents');
    expect(checkGroupOf('Poco/x/sheet.XLSX')).toBe('documents');
    expect(checkGroupOf('Poco/x/data.bin')).toBe('other');
    expect(checkGroupOf('top.bin')).toBe('other');
  });

  it('the list holds only same-size files not proven yet, in the order photos, documents, rest, and says how many need one read or two', () => {
    both('S1/Documents/a.pdf', 'doc one');
    both('S1/DCIM/Camera/b.jpg', 'photo b', 'photo b', { expected: false }); // no checksum known: two reads
    both('S1/other/c.bin', 'rest c');
    both('S1/DCIM/Camera/a.jpg', 'photo a');
    both('S1/size.jpg', 'T7 version', 'a longer one on the Seagate'); // another size: not in this list
    mw.seed('S1/missing.jpg', 'only on the T7');
    mw.seedSeagate('S1/only-sea.jpg', 'only on the Seagate');
    const plan = mw.checkPlan();
    expect(plan.items.map((i) => i.rel)).toEqual(['S1/DCIM/Camera/a.jpg', 'S1/DCIM/Camera/b.jpg', 'S1/Documents/a.pdf', 'S1/other/c.bin']);
    expect(plan.view.groups.map((g) => [g.group, g.files])).toEqual([['photos', 2], ['documents', 1], ['other', 1]]);
    expect(plan.view.oneRead.files).toBe(3);
    expect(plan.view.twoReads.files).toBe(1);
    expect(plan.view.totals.files).toBe(4);
    expect(plan.view.estimateSeconds).toBeGreaterThan(0);
    // The list is made from the file list alone: no drive was read.
    expect(mw.reads).toEqual({ t7: [], sea: [] });
  });

  it('a Seagate file that is already a verified copy is not listed again', async () => {
    both('S1/a.jpg', 'aaaa');
    both('S1/b.jpg', 'bbbb');
    expect(mw.checkPlan().items).toHaveLength(2);
    await mw.check();
    expect(mw.checkPlan().items).toHaveLength(0);
    expect(mw.checkPlan().view.alreadyChecked).toBe(2);
  });
});

describe('the check', () => {
  it('same checksum: the Seagate file becomes a verified copy that points at the phone file; different: never replaced, a decision; nothing is written', async () => {
    both('S1/same.jpg', 'same-content');
    both('S1/diff.jpg', 'T7-version!', 'Sea-version');
    const before = mw.seagateDurable();
    const r = await mw.check();
    expect(r.report).toMatchObject({ verified: 1, differs: 1, complete: true });
    const row = dstRow('S1/same.jpg');
    expect(row).toMatchObject({ verified_how: 'read_both', sha256: sha256Of('same-content'), expected_sha256: sha256Of('same-content') });
    expect(row['origin_file_id']).toBe(srcRow('S1/same.jpg')['origin_file_id']);
    expect(row['verified_at']).not.toBeNull();
    // The different one is untouched in the index and on the drive, and is a case.
    expect(dstRow('S1/diff.jpg')['verified_how']).toBeNull();
    expect(mw.seagateDurable()).toEqual(before);
    expect(problems()).toBe(1);
    expect(listNeedsDecision(rig.db, {}).cases.map((c) => c.headline)).toEqual(['diff.jpg: a different file is already on Seagate2TB']);
    noWrites();
    expect(w.drives[1]!.onDrive().filter((f) => f.path.includes('.bhtmp'))).toEqual([]);
  });

  it('the T7 checksum is known (the phone\'s): ONE read, of the Seagate file only', async () => {
    both('S1/a.jpg', 'aaaa');
    both('S1/b.jpg', 'bbbb');
    const r = await mw.check();
    expect(mw.reads.t7).toEqual([]);
    expect(mw.reads.sea.toSorted()).toEqual([`${ROOT}/S1/a.jpg`, `${ROOT}/S1/b.jpg`]);
    expect(r.report).toMatchObject({ oneRead: 2, twoReads: 0, verified: 2 });
  });

  it('a checksum proven earlier (verified_how read_both, no phone checksum) also needs only one read; a recorded but never proven one does not', async () => {
    both('S1/proven.jpg', 'proven content', 'proven content', { expected: false });
    rig.db.prepare("UPDATE files SET verified_how = 'read_both', verified_at = 5 WHERE place_id = ? AND rel_path = ?").run(w.destinations[0]!.placeId, `${ROOT}/S1/proven.jpg`);
    both('S1/recorded.jpg', 'recorded content', 'recorded content', { expected: false });
    const r = await mw.check();
    expect(mw.reads.t7).toEqual([`${ROOT}/S1/recorded.jpg`]);
    expect(r.report).toMatchObject({ oneRead: 1, twoReads: 1, verified: 2 });
  });

  it('the T7 checksum is not known: TWO reads, and the T7 row learns its checksum', async () => {
    mw.seed('S1/own.jpg', 'own content', { expected: false, sha: null });
    mw.seedSeagate('S1/own.jpg', 'own content');
    const r = await mw.check();
    expect(mw.reads.t7).toEqual([`${ROOT}/S1/own.jpg`]);
    expect(mw.reads.sea).toEqual([`${ROOT}/S1/own.jpg`]);
    expect(r.report).toMatchObject({ oneRead: 0, twoReads: 1, verified: 1 });
    expect(srcRow('S1/own.jpg')['sha256']).toBe(sha256Of('own content'));
    expect(dstRow('S1/own.jpg')['verified_how']).toBe('read_both');
  });

  it('two reads that differ: a decision, nothing replaced', async () => {
    mw.seed('S1/own.jpg', 'own content', { expected: false, sha: null });
    mw.seedSeagate('S1/own.jpg', 'xxx content');
    const r = await mw.check();
    expect(r.report).toMatchObject({ verified: 0, differs: 1, twoReads: 1 });
    expect(problems()).toBe(1);
    noWrites();
  });

  it('photos and videos are read first, then documents, then the rest', async () => {
    both('S1/other/z.bin', 'zz');
    both('S1/Documents/d.pdf', 'dd');
    both('S1/DCIM/Camera/p.jpg', 'pp');
    both('S1/a-first-by-name.bin', 'aa');
    both('S1/clip.mp4', 'cc');
    await mw.check();
    expect(mw.reads.sea.map((p) => p.slice(ROOT.length + 1))).toEqual(['S1/DCIM/Camera/p.jpg', 'S1/clip.mp4', 'S1/Documents/d.pdf', 'S1/a-first-by-name.bin', 'S1/other/z.bin']);
  });

  it('says how far it is: "Checked so far: photos and videos 1 of 2 ..."', async () => {
    both('S1/a.jpg', 'aa');
    both('S1/b.jpg', 'bb');
    both('S1/c.bin', 'cc');
    const messages: string[] = [];
    const ctx = (await import('./phoneBackupWorld.testutil')).FakeCtx.prototype;
    const orig = ctx.progress;
    ctx.progress = function (done, total, extras) {
      if (extras?.message) messages.push(extras.message);
      return orig.call(this, done, total, extras);
    };
    try {
      await mw.check();
    } finally {
      ctx.progress = orig;
    }
    expect(messages[0]).toBe('Checked so far: photos and videos 0 of 2 · other files 0 of 1');
    expect(messages.at(-1)).toBe('Checked so far: photos and videos 2 of 2 · other files 1 of 1');
  });

  it('a file gone from the Seagate or changed since the list is skipped with a reason, never a decision', async () => {
    both('S1/gone.jpg', 'gone');
    both('S1/changed.jpg', 'chang');
    both('S1/fine.jpg', 'fine');
    const plan = mw.checkPlan();
    w.drives[1]!.discard(`${ROOT}/S1/gone.jpg`);
    w.drives[1]!.write(`${ROOT}/S1/changed.jpg`, 'changed now!', w.nowSec - 50);
    w.drives[1]!.flush(`${ROOT}/S1/changed.jpg`);
    const r = await mw.check({ plan });
    expect(r.report).toMatchObject({ verified: 1, differs: 0 });
    expect(r.report?.skipped.map((s) => s.count)).toEqual([1, 1].slice(0, r.report!.skipped.length));
    expect(r.report?.skipped.flatMap((s) => s.examples).toSorted()).toEqual(['S1/changed.jpg', 'S1/gone.jpg']);
    expect(problems()).toBe(0);
  });

  it('the Seagate unplugged in the middle: waits for Continue, then goes on without checking anything twice', async () => {
    for (let i = 0; i < 4; i += 1) both(`S1/f${i}.bin`, `content ${i}`);
    let pulled = false;
    const orig = mw.sea.readFile;
    mw.sea.readFile = async (rel, onBlock, y) => {
      if (!pulled && rel.endsWith('f1.bin')) {
        pulled = true;
        w.drives[1]!.unplug();
      }
      return orig(rel, onBlock, y);
    };
    const asked: string[] = [];
    const r = await mw.check({ onAsk: (m) => { asked.push(m); w.drives[1]!.plug(); } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Seagate2TB was unplugged');
    expect(asked[0]).toContain('the check carries on where it stopped');
    expect(r.report).toMatchObject({ verified: 4, complete: true });
  });

  it('USB trouble pauses with a plain message', async () => {
    both('S1/a.bin', 'aaaa');
    mw.usb.add(w.destinations[1]!.placeId);
    const asked: string[] = [];
    const r = await mw.check({ onAsk: (m) => asked.push(m) });
    expect(asked).toEqual(['Seagate2TB had a USB problem. Plug it straight into the laptop, not a hub, then press Continue. Nothing is lost; the check carries on where it stopped.']);
    expect(r.report).toMatchObject({ usbPauses: 1, verified: 1 });
  });

  it('Stop keeps what was proven (written before it ends), says it is not complete, and the next list has only the rest', async () => {
    for (let i = 0; i < 6; i += 1) both(`S1/f${i}.jpg`, `content ${i}`);
    const r = await mw.check({ stopAfterYields: 3 });
    expect(r.stopped).toBe(true);
    expect(r.report?.complete).toBe(false);
    const done = r.report!.verified;
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThan(6);
    const proven = rig.db.prepare("SELECT count(*) FROM files WHERE place_id = ? AND verified_how = 'read_both'").pluck().get(w.destinations[1]!.placeId) as number;
    expect(proven).toBe(done);
    expect(mw.checkPlan().items).toHaveLength(6 - done);
  });

  it('batches: rows are written every ' + CHECK_BATCH + ' files or in the end, and the checkpoint only names files whose rows are written', async () => {
    for (let i = 0; i < 12; i += 1) both(`S1/f${String(i).padStart(2, '0')}.bin`, `content number ${i}`);
    w.nowMs += 0;
    const r = await mw.check();
    expect(r.checkpoint?.next).toBe(12);
    const provenAtCheckpoint = rig.db.prepare("SELECT count(*) FROM files WHERE place_id = ? AND verified_how = 'read_both'").pluck().get(w.destinations[1]!.placeId) as number;
    expect(provenAtCheckpoint).toBe(12);
  });

  it('killed at every point, then Continue: the same result as an undisturbed run, never a file proven that was not equal', async () => {
    const make = (): void => {
      both('S1/DCIM/a.jpg', 'aaaa-aaaa');
      both('S1/DCIM/b.jpg', 'bbbbbb-b', 'xxxxxx-x'); // different
      both('S1/c.pdf', 'cc', 'cc', { expected: false, sha: null }); // two reads
      both('S1/d.bin', 'dddd');
    };
    make();
    const clean = await mw.check();
    const want = JSON.stringify(rig.db.prepare("SELECT rel_path, verified_how, sha256 FROM files WHERE place_id = ? ORDER BY rel_path").all(w.destinations[1]!.placeId));
    expect(clean.report).toMatchObject({ verified: 3, differs: 1 });
    let points = 0;
    for (let at = 1; at < 60; at += 1) {
      rig.close();
      rig = makeRig();
      w = new World(rig, { seed: 52 });
      mw = new MirrorWorld(w);
      make();
      const first = await mw.check({ crashAfter: at });
      if (!first.crashed) break;
      points += 1;
      let resume: CheckRunResult = first;
      for (let n = 0; n < 6 && resume.crashed; n += 1) resume = await mw.continueCheck(resume);
      expect(resume.crashed, `finished after a kill at step ${at}`).toBe(false);
      expect(resume.report, `kill at step ${at}`).toMatchObject({ verified: 3, differs: 1, complete: true });
      expect(JSON.stringify(rig.db.prepare('SELECT rel_path, verified_how, sha256 FROM files WHERE place_id = ? ORDER BY rel_path').all(w.destinations[1]!.placeId))).toBe(want);
      expect(problems()).toBe(1);
      noWrites();
    }
    expect(points).toBeGreaterThan(4);
  }, 60_000);
});
