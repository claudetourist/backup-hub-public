import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionService } from '../../decisions/decisionService';
import { listNeedsDecision } from '../../decisions/needsDecision';
import { acknowledgeMirror } from '../../mirror/mirrorStore';
import { behindOf } from '../../mirror/mirrorScan';
import { pairOf } from '../../mirror/mirrorPairs';
import { MIRROR_DAMAGED_PROBLEM, MIRROR_DIFFERS_PROBLEM } from '../../../shared/mirror';
import { sha256Of, TMP_DIR } from './fakeDrive.testutil';
import { MirrorWorld, ROOT, type MirrorRunResult } from './mirrorWorld.testutil';
import { makeRig, World, type Rig } from './world.testutil';
import { FakeCtx } from './phoneBackupWorld.testutil';

/**
 * The second drive (R1.3) in the fake world: a T7 that has the backup and a Seagate that is behind. The real look, plan and run; unkind fake drives.
 * Invariants checked after every scenario: nothing was ever written over a file at a final name, nothing is torn at a final name, no temp file is left
 * behind, a file on the Seagate is exactly a file of the T7 (or one that was there before), and nothing on the T7 was changed.
 */
let rig: Rig;
let w: World;
let mw: MirrorWorld;

beforeEach(() => {
  rig = makeRig();
  w = new World(rig, { seed: 31 });
  mw = new MirrorWorld(w);
});
afterEach(() => {
  w.dispose();
  rig.close();
});

const sea = (rel: string): string | undefined => mw.seagateDurable().get(rel);
const problems = (kind: string): number => rig.db.prepare("SELECT count(*) FROM file_problems WHERE kind = ? AND state = 'open'").pluck().get(kind) as number;
const tmpLeft = (i: number): string[] => w.drives[i]!.onDrive().filter((f) => f.path.startsWith(TMP_DIR)).map((f) => f.path);

/** The invariants of the mirror. `before`: what was on the Seagate before the run (never changed). */
function invariants(before: Map<string, string> = new Map()): void {
  expect(w.drives[1]!.overwrites).toEqual([]);
  expect(w.drives[0]!.overwrites).toEqual([]);
  for (const [rel, sha] of before) expect(mw.seagateDurable().get(rel)).toBe(sha);
  const t7 = new Map(w.drives[0]!.onDrive().filter((f) => f.path.startsWith(ROOT + '/')).map((f) => [f.path.slice(ROOT.length + 1), f.sha256]));
  for (const [rel, sha] of mw.seagateDurable()) if (!before.has(rel)) expect(t7.get(rel), `${rel} on the Seagate is a T7 file`).toBe(sha);
}

describe('the plan', () => {
  it('lists what the Seagate lacks, largest first, with the checks and the different ones, and writes nothing to either drive', async () => {
    mw.seed('Poco-F4-24Nov26/DCIM/big.mp4', 'b'.repeat(900));
    mw.seed('Poco-F4-24Nov26/DCIM/small.jpg', 's'.repeat(10), { expected: false });
    mw.seed('Poco-F4-24Nov26/DCIM/same.jpg', 'same-content');
    mw.seed('Poco-F4-24Nov26/DCIM/other.jpg', 'T7-version');
    mw.seedSeagate('Poco-F4-24Nov26/DCIM/same.jpg', 'same-content');
    mw.seedSeagate('Poco-F4-24Nov26/DCIM/other.jpg', 'a longer different one');
    const before = w.drives.map((d) => d.onDrive().length);
    const { outcome } = await mw.plan();
    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) return;
    const plan = outcome.result.plan;
    expect(plan.rows.map((r) => r.path)).toEqual(['Poco-F4-24Nov26/DCIM/big.mp4', 'Poco-F4-24Nov26/DCIM/small.jpg']);
    expect(plan.totals).toEqual({ files: 2, bytes: 910 });
    expect(plan.ownChecksums).toBe(1);
    expect(plan.rows[1]!.ownChecksum).toBe(true);
    expect(plan.toCheck).toEqual({ files: 1, bytes: 12 }); // same.jpg: counted, never read by the copy
    expect(plan.different).toEqual({ files: 1, examples: ['Poco-F4-24Nov26/DCIM/other.jpg'] });
    expect(plan.backups[0]).toMatchObject({ sourceLabel: 'T7', targetLabel: 'Seagate2TB', folderWords: 'MyData\\POCO' });
    expect(w.drives.map((d) => d.onDrive().length)).toEqual(before);
    expect(problems(MIRROR_DIFFERS_PROBLEM)).toBe(0); // the look records nothing about problems
  });

  it('says plainly to plug in the T7 when only the Seagate is here, and plans nothing', async () => {
    mw.seed('a/x.txt', 'x');
    w.drives[0]!.unplug();
    const { outcome } = await mw.plan();
    expect(outcome.result).toMatchObject({ ok: false, reason: 'source_missing', message: 'Plug in the T7 to bring the Seagate2TB up to date.' });
    expect(outcome.stored).toBeNull();
  });

  it('refuses when the Seagate is not here', async () => {
    mw.seed('a/x.txt', 'x');
    w.drives[1]!.unplug();
    const { outcome } = await mw.plan();
    expect(outcome.result).toMatchObject({ ok: false, reason: 'target_missing' });
  });

  it('blocks when the list will not fit', async () => {
    mw.seed('a/x.txt', 'x'.repeat(100));
    mw.sea.freeBytes = async () => 150;
    const { outcome } = await mw.plan();
    expect(outcome.result.ok && outcome.result.plan.blocked).toContain('not enough room on Seagate2TB');
  });
});

describe('the copy', () => {
  it('copies everything, checked, with index rows that point at the phone file, a list on the Seagate and nothing left over', async () => {
    mw.seed('S1/a.jpg', 'aaaa-1');
    mw.seed('S1/sub/b.jpg', 'bbbb-22');
    mw.seed('S2/own.bin', 'no phone checksum here', { expected: false });
    const r = await mw.mirror();
    expect(r.report?.copied.files).toBe(3);
    expect(r.report?.ownChecksums).toBe(1);
    expect(sea('S1/a.jpg')).toBe(sha256Of('aaaa-1'));
    expect(sea('S2/own.bin')).toBe(sha256Of('no phone checksum here'));
    const row = rig.db.prepare('SELECT * FROM files WHERE place_id = ? AND rel_path = ?').get(w.destinations[1]!.placeId, `${ROOT}/S1/a.jpg`) as Record<string, unknown>;
    expect(row).toMatchObject({ verified_how: 'read_both', expected_sha256: sha256Of('aaaa-1'), sha256: sha256Of('aaaa-1') });
    const t7 = rig.db.prepare('SELECT id, origin_file_id FROM files WHERE place_id = ? AND rel_path = ?').get(w.destinations[0]!.placeId, `${ROOT}/S1/a.jpg`) as { origin_file_id: number };
    expect(row['origin_file_id']).toBe(t7.origin_file_id);
    // The T7 file with no phone checksum learned its own.
    expect(rig.db.prepare('SELECT sha256, expected_sha256 FROM files WHERE place_id = ? AND rel_path = ?').get(w.destinations[0]!.placeId, `${ROOT}/S2/own.bin`)).toMatchObject({ expected_sha256: null });
    expect(r.report?.listPaths).toHaveLength(1);
    expect(r.report?.listPaths[0]).toContain('lists');
    expect(tmpLeft(1)).toEqual([]);
    invariants();
    // The second run has nothing to copy: the Seagate is level.
    const again = await mw.mirror();
    expect(again.plan.result.ok && again.plan.result.plan.totals.files).toBe(0);
    expect(behindOf(rig.db, pairOf(rig.db, w.profileId)!)).toEqual({ files: 0, bytes: 0 });
  });

  it('a damaged T7 file is not copied: it becomes "This T7 copy looks damaged", and is not offered again after "Leave it as it is"', async () => {
    mw.seed('S1/good.jpg', 'good file');
    mw.seed('S1/bad.jpg', 'bad file!!', { sha: sha256Of('what it used to be') });
    const r = await mw.mirror();
    expect(r.report).toMatchObject({ damaged: 1 });
    expect(r.report?.copied.files).toBe(1);
    expect(sea('S1/bad.jpg')).toBeUndefined();
    expect(sea('S1/good.jpg')).toBe(sha256Of('good file'));
    expect(problems(MIRROR_DAMAGED_PROBLEM)).toBe(1);
    expect(tmpLeft(1)).toEqual([]);
    const list = listNeedsDecision(rig.db, {});
    const c = list.cases.find((x) => x.source === 'mirror');
    expect(c?.headline).toContain('bad.jpg');
    expect(c?.headline).toContain('looks damaged');
    expect(c?.backupId).toBe(w.profileId);
    expect(c?.choices.map((x) => x.id)).toEqual(['leave_as_is', 'show_file']);
    expect(list.total).toBe(1);
    // Answer, then the next list does not offer it again and the Seagate is still without it.
    const id = Number(c!.key.split(':')[1]);
    expect(acknowledgeMirror(rig.db, id)).toBe(1);
    const next = await mw.plan();
    expect(next.outcome.result.ok && next.outcome.result.plan.rows).toEqual([]);
    expect(next.outcome.result.ok && next.outcome.result.plan.knownProblems).toBe(1);
    expect(listNeedsDecision(rig.db, {}).total).toBe(0);
    invariants();
  });

  it('the copy never reads a file that is already on the Seagate with the same size; one with another size is never replaced and becomes a decision', async () => {
    mw.seed('S1/same.jpg', 'same-content');
    mw.seed('S1/diff.jpg', 'T7-version!');
    mw.seed('S1/size.jpg', 'short');
    mw.seed('S1/new.jpg', 'brand new');
    mw.seedSeagate('S1/same.jpg', 'same-content');
    mw.seedSeagate('S1/diff.jpg', 'Sea-version'); // same size, other content: only the check job can tell
    mw.seedSeagate('S1/size.jpg', 'a different length');
    const before = mw.seagateDurable();
    const r = await mw.mirror();
    expect(r.report).toMatchObject({ linked: 0, different: 1 });
    expect(r.report?.copied.files).toBe(1);
    // Not one read of the same-size files, on either drive.
    expect(mw.reads.sea).toEqual([]);
    expect(mw.reads.t7).toEqual([`${ROOT}/S1/new.jpg`]);
    expect(sea('S1/diff.jpg')).toBe(sha256Of('Sea-version'));
    expect(sea('S1/size.jpg')).toBe(sha256Of('a different length'));
    expect(sea('S1/new.jpg')).toBe(sha256Of('brand new'));
    expect(w.drives[1]!.overwrites).toEqual([]);
    expect(problems(MIRROR_DIFFERS_PROBLEM)).toBe(1);
    const heads = listNeedsDecision(rig.db, {}).cases.map((c) => c.headline).toSorted();
    expect(heads).toEqual(['size.jpg: a different file is already on Seagate2TB']);
    invariants(before);
  });

  it('progress and time left of the copy count only the files to copy', async () => {
    mw.seed('S1/same.jpg', 'same-content');
    mw.seedSeagate('S1/same.jpg', 'same-content');
    mw.seed('S1/new1.jpg', 'brand new');
    mw.seed('S1/new2.jpg', 'brand new two');
    mw.seed('S1/size.jpg', 'short');
    mw.seedSeagate('S1/size.jpg', 'a different length');
    const seen: { done: number; total: number; bytesTotal: number | undefined }[] = [];
    const orig = FakeCtx.prototype.progress;
    FakeCtx.prototype.progress = function (done, total, extras) {
      seen.push({ done: done ?? 0, total: total ?? 0, bytesTotal: extras?.bytesTotal });
      return orig.call(this, done, total, extras);
    };
    try {
      await mw.mirror();
    } finally {
      FakeCtx.prototype.progress = orig;
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const p of seen.filter((s) => s.total > 0)) {
      expect(p.total).toBe(2);
      expect(p.bytesTotal).toBe(Buffer.byteLength('brand new') + Buffer.byteLength('brand new two'));
      expect(p.done).toBeLessThanOrEqual(2);
    }
  });

  it('an untick is not copied', async () => {
    mw.seed('S1/a.jpg', 'aaa');
    mw.seed('S1/b.jpg', 'bbb');
    const r = await mw.mirror({ untick: (i) => i.rel === 'S1/b.jpg' });
    expect(r.report?.copied.files).toBe(1);
    expect(sea('S1/b.jpg')).toBeUndefined();
  });

  it('the Seagate unplugged in the middle: the run waits for Continue, nothing half-written, nothing copied twice', async () => {
    for (let i = 0; i < 4; i += 1) mw.seed(`S1/f${i}.bin`, `content number ${i} ${'x'.repeat(i * 7)}`);
    // The cable is pulled while the first temp file is written.
    let pulled = false;
    const orig = mw.sea.openTemp;
    mw.sea.openTemp = async (tmp) => {
      const writer = await orig(tmp);
      if (!pulled) {
        pulled = true;
        w.drives[1]!.unplug();
      }
      return writer;
    };
    const asked: string[] = [];
    const r = await mw.mirror({
      onAsk: (m) => {
        asked.push(m);
        w.drives[1]!.plug();
      },
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('Seagate2TB was unplugged');
    expect(r.report?.copied.files).toBe(4);
    for (let i = 0; i < 4; i += 1) expect(sea(`S1/f${i}.bin`)).toBe(sha256Of(`content number ${i} ${'x'.repeat(i * 7)}`));
    expect(tmpLeft(1)).toEqual([]);
    invariants();
  });

  it('the T7 unplugged in the middle asks to plug it in, then goes on', async () => {
    mw.seed('S1/a.bin', 'aaaa');
    mw.seed('S1/b.bin', 'bbbbb');
    let pulled = false;
    const orig = mw.t7.readFile;
    mw.t7.readFile = async (rel, onBlock, yieldNow) => {
      if (!pulled) {
        pulled = true;
        w.drives[0]!.unplug();
      }
      return orig(rel, onBlock, yieldNow);
    };
    const asked: string[] = [];
    const r = await mw.mirror({ onAsk: (m) => { asked.push(m); w.drives[0]!.plug(); } });
    expect(asked[0]).toContain('T7 was unplugged');
    expect(r.report?.copied.files).toBe(2);
    invariants();
  });

  it('USB trouble pauses with the plain message, once, and a Continue is not asked again for the same event', async () => {
    mw.seed('S1/a.bin', 'aaaa');
    mw.seed('S1/b.bin', 'bbbbb');
    mw.usb.add(w.destinations[1]!.placeId);
    const asked: string[] = [];
    const r = await mw.mirror({ onAsk: (m) => asked.push(m) });
    expect(asked).toEqual(['Seagate2TB had a USB problem. Plug it straight into the laptop, not a hub, then press Continue. Nothing is lost; the copy carries on where it stopped.']);
    expect(r.report?.usbPauses).toBe(1);
    expect(r.report?.copied.files).toBe(2);
    invariants();
  });

  it('killed at every point, then Continue: the same result as an undisturbed run, nothing recopied over a verified file', async () => {
    const make = (): void => {
      mw.seed('S1/a.bin', 'aaaa-aaaa');
      mw.seed('S1/b.bin', 'bbbbbb-b');
      mw.seed('S1/c.bin', 'cc', { expected: false });
      mw.seedSeagate('S1/c-old.bin', 'old one');
    };
    make();
    const clean = await mw.mirror();
    const want = mw.seagateDurable();
    expect(clean.report?.copied.files).toBe(3);
    let points = 0;
    for (let at = 1; at < 60; at += 1) {
      rig.close();
      rig = makeRig();
      w = new World(rig, { seed: 31 });
      mw = new MirrorWorld(w);
      make();
      const first = await mw.mirror({ crashAfter: at });
      if (!first.crashed) break;
      points += 1;
      let resume: MirrorRunResult = first;
      for (let n = 0; n < 6 && resume.crashed; n += 1) resume = await mw.continueRun(resume);
      expect(resume.crashed, `finished after a kill at step ${at}`).toBe(false);
      expect(mw.seagateDurable(), `kill at step ${at}`).toEqual(want);
      expect(tmpLeft(1)).toEqual([]);
      invariants(new Map([['S1/c-old.bin', sha256Of('old one')]]));
    }
    expect(points).toBeGreaterThan(10);
  }, 60_000);
});

describe('the answer to a mirror case', () => {
  it('"Leave it as it is" marks the case as seen once, through the decision service; a wrong answer or an unknown case changes nothing', async () => {
    mw.seed('S1/bad.jpg', 'bad file!!', { sha: sha256Of('what it used to be') });
    mw.seed('S1/diff.jpg', 'T7-version!');
    mw.seedSeagate('S1/diff.jpg', 'sea-version!');
    await mw.mirror();
    const service = new DecisionService({ db: rig.db, places: { driveDecisions: () => [], answerDriveDecision: () => ({ ok: false, message: 'x' }) } as never, phoneBackup: { startLook: () => ({ ok: false, message: 'x', jobId: null }) } });
    const cases = service.list({ backupId: w.profileId }).cases.filter((c) => c.source === 'mirror');
    expect(cases).toHaveLength(2);
    expect(service.answer({ key: cases[0]!.key, choice: 'copy_again' })).toMatchObject({ ok: false });
    expect(service.answer({ key: 'mirror:99999', choice: 'leave_as_is' })).toMatchObject({ ok: false });
    expect(service.answer({ key: cases[0]!.key, choice: 'leave_as_is' })).toMatchObject({ ok: true });
    expect(service.answer({ key: cases[0]!.key, choice: 'leave_as_is' })).toMatchObject({ ok: false }); // no longer open
    expect(service.list({}).cases.filter((c) => c.source === 'mirror')).toHaveLength(1);
    expect(service.list({ backupId: 12345 }).cases).toHaveLength(0);
    invariants(new Map([['S1/diff.jpg', sha256Of('sea-version!')]]));
  });
});

describe('status', () => {
  it('counts what the Seagate lacks (not there or another size) from the file list', async () => {
    mw.seed('S1/a.bin', 'aaaa');
    mw.seed('S1/b.bin', 'bbbbb');
    mw.seed('S1/c.bin', 'cccccc');
    mw.seedSeagate('S1/a.bin', 'aaaa');
    mw.seedSeagate('S1/b.bin', 'different size');
    await mw.plan(); // brings the index up to date, like a look
    expect(behindOf(rig.db, pairOf(rig.db, w.profileId)!)).toEqual({ files: 2, bytes: 11 });
  });
});
