import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkAll, invariant1, invariant2, invariant3, invariant4, invariant5, snapshotIndex } from './invariants.testutil';
import { runScenario } from './scenario.testutil';
import { makeRig, World, type Rig } from './world.testutil';

/**
 * Checks that are never red prove nothing: here each invariant is shown to NOTICE the thing it guards against, by breaking a world on
 * purpose. Also the reference backup's safe-copy order, and the "free up phone space" proof, against unkind drives.
 */
describe('the invariants have teeth', () => {
  let rig: Rig;
  let n = 100;
  beforeAll(() => {
    rig = makeRig();
  });
  afterAll(() => rig.close());

  async function backedUpWorld(): Promise<World> {
    n += 1;
    const w = new World(rig, { seed: n });
    for (let i = 0; i < 6; i += 1) w.createFile(`/sdcard/DCIM/Camera/f${i}.jpg`, `file number ${i}`);
    w.tick(10);
    const r = await w.backup();
    expect(r.copied).toBe(12); // 6 files x 2 drives
    expect(checkAll(w)).toEqual([]);
    return w;
  }

  it('1: a backed-up file that vanishes from a drive is noticed', async () => {
    const w = await backedUpWorld();
    try {
      w.drives[0]!.discard(w.copyLog[0]!.path);
      expect(invariant1(w).join()).toMatch(/no longer on the drive/);
    } finally {
      w.dispose();
    }
  });

  it('1 and 2: a final name whose content was changed is noticed (not the content that was verified, not a content the phone had)', async () => {
    const w = await backedUpWorld();
    try {
      const c = w.copyLog[1]!;
      w.drives[c.drive]!.write(c.path, 'tampered', 1);
      w.drives[c.drive]!.flush(c.path);
      expect(invariant1(w).join()).toMatch(/other content/);
      expect(invariant2(w).join()).toMatch(/overwrote|replaced the file at the final name/);
      expect(invariant2(w).join()).toMatch(/never had/);
    } finally {
      w.dispose();
    }
  });

  it('2: a half-written file at a final name is noticed', async () => {
    const w = await backedUpWorld();
    try {
      w.drives[0]!.write('MyData/POCO/POCO-d1/torn.jpg', 'half of a fi', 1);
      w.drives[0]!.flush('MyData/POCO/POCO-d1/torn.jpg');
      expect(invariant2(w).join()).toMatch(/torn or invented/);
      w.drives[0]!.discard('MyData/POCO/POCO-d1/torn.jpg');
      expect(invariant2(w)).toEqual([]);
    } finally {
      w.dispose();
    }
  });

  it('1: recording a copy before it was flushed is caught as soon as the drive is unplugged (why the flush comes first)', () => {
    n += 1;
    const w = new World(rig, { seed: n });
    try {
      const d = w.drives[0]!;
      d.write('MyData/POCO/POCO-d1/x.jpg', 'content', 1);
      w.copyLog.push({ drive: 0, path: 'MyData/POCO/POCO-d1/x.jpg', sha256: 'whatever', size: 7, phoneRel: 'sdcard/x.jpg' });
      d.unplug();
      d.plug();
      expect(invariant1(w).join()).toMatch(/no longer on the drive/);
    } finally {
      w.dispose();
    }
  });

  it('3: an index that disagrees with the phone after a look is noticed; so is a look that was refused but changed something', async () => {
    const w = await backedUpWorld();
    try {
      const before = snapshotIndex(w);
      const report = await w.look();
      expect(invariant3(w, before, report)).toEqual([]);
      const row = w.phoneRows()[0]!;
      w.db.prepare('UPDATE files SET gone_at = 1, gone_reason = ? WHERE id = ?').run('gone_from_source', row.id);
      expect(invariant3(w, before, report).join()).toMatch(/phone has .* but the index has no live row/);
      w.db.prepare('UPDATE files SET gone_at = NULL, gone_reason = NULL, size = size + 1000, mtime = mtime + 100000 WHERE id = ?').run(row.id);
      expect(invariant3(w, before, report).join()).toMatch(/differs from the phone/);
      w.db.prepare('UPDATE files SET size = size - 1000, mtime = mtime - 100000 WHERE id = ?').run(row.id);
      w.db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
      // a refused look must leave the index as it was
      expect(invariant3(w, snapshotIndex(w), { outcome: { ok: false }, look: { unreadable: [] } })).toEqual([]);
      w.db.prepare("UPDATE files SET gone_at = 7, gone_reason = 'gone_from_source' WHERE place_id = ?").run(w.placeId);
      expect(invariant3(w, before, { outcome: { ok: false }, look: { unreadable: [] } }).join()).toMatch(/not accepted changed the index/);
    } finally {
      w.dispose();
    }
  });

  it('4: a second run that copies something, or still finds changes, is noticed', () => {
    expect(invariant4({ copied: 5 }, { copied: 0, report: { recorded: { added: 0, changed: 0, cameBack: 0, markedGone: 0 } } })).toEqual([]);
    expect(invariant4({ copied: 5 }, { copied: 2, report: { recorded: null } }).join()).toMatch(/second run copied 2/);
    expect(invariant4({ copied: 5 }, { copied: 0, report: { recorded: { added: 1, changed: 0, cameBack: 0, markedGone: 0 } } }).join()).toMatch(/still found changes/);
  });

  it('4: a real second run copies nothing (and the first copied something)', async () => {
    const w = await backedUpWorld();
    try {
      w.createFile('/sdcard/DCIM/new.jpg', 'brand new');
      const first = await w.backup();
      const second = await w.backup();
      expect(first.copied).toBe(2);
      expect(invariant4(first, second)).toEqual([]);
      expect(second.copied).toBe(0);
    } finally {
      w.dispose();
    }
  });

  it('5: leaving the phone needs a proof from every destination, read from the drive now', async () => {
    const w = await backedUpWorld();
    try {
      expect(w.cleanPhoneFile('/sdcard/DCIM/Camera/f0.jpg')).toBe(true);
      expect(w.phone.exists('/sdcard/DCIM/Camera/f0.jpg')).toBe(false);
      expect(w.removals[0]!.proofs).toHaveLength(2);
      expect(invariant5(w)).toEqual([]);
      // a drive that is not plugged in: nothing is offered
      w.drives[1]!.unplug();
      expect(w.cleanPhoneFile('/sdcard/DCIM/Camera/f1.jpg')).toBe(false);
      expect(w.phone.exists('/sdcard/DCIM/Camera/f1.jpg')).toBe(true);
      w.drives[1]!.plug();
      // a copy that is damaged on a drive: nothing is offered
      const c = w.copyLog.find((x) => x.drive === 1 && x.phoneRel.endsWith('f2.jpg'))!;
      w.drives[1]!.discard(c.path);
      w.drives[1]!.write(c.path, 'damaged', 1);
      w.drives[1]!.flush(c.path);
      expect(w.cleanPhoneFile('/sdcard/DCIM/Camera/f2.jpg')).toBe(false);
      // an unverified copy is not enough
      w.db.prepare("UPDATE files SET verified_how = 'imported' WHERE place_id = ? AND rel_path LIKE '%f3.jpg'").run(w.destinations[0]!.placeId);
      expect(w.cleanPhoneFile('/sdcard/DCIM/Camera/f3.jpg')).toBe(false);
      expect(invariant5(w)).toEqual([]);
    } finally {
      w.dispose();
    }
  });

  it('5: a removal without its proofs, or with a proof that is not the content, is noticed', async () => {
    const w = await backedUpWorld();
    try {
      w.removals.push({ path: '/sdcard/x', sha256: 'aa', proofs: [] });
      w.removals.push({ path: '/sdcard/y', sha256: 'aa', proofs: [{ drive: 0, path: 'nowhere', sha256: 'bb' }, { drive: 1, path: 'nowhere', sha256: 'aa' }] });
      const found = invariant5(w).join('\n');
      expect(found).toMatch(/0 of 2 copies proven/);
      expect(found).toMatch(/not the same content/);
      expect(found).toMatch(/not on the drive/);
    } finally {
      w.dispose();
    }
  });

  it('the reference backup killed at any step leaves complete files only and loses nothing it had recorded', async () => {
    n += 1;
    const w = new World(rig, { seed: n });
    try {
      for (let i = 0; i < 5; i += 1) w.createFile(`/sdcard/DCIM/Camera/g${i}.jpg`, `g number ${i}`);
      for (let crash = 1; crash <= 12; crash += 1) {
        const r = await w.backup({ crashAfter: crash });
        expect(r.crashed || r.copied > 0).toBe(true);
        expect(checkAll(w)).toEqual([]);
      }
      await w.backup();
      expect(checkAll(w)).toEqual([]);
    } finally {
      w.dispose();
    }
  });

  it('a scenario whose drive loses a file is reported by the run itself', async () => {
    let done = false;
    const result = await runScenario(rig, 9001, {
      length: 5,
      after: (w) => {
        if (!done && w.copyLog.length > 0 && w.drives[0]!.plugged) {
          w.drives[0]!.discard(w.copyLog[0]!.path);
          done = true;
        }
      },
    });
    expect(done).toBe(true);
    expect(result.violations.join('\n')).toMatch(/no longer on the drive/);
  });
});
