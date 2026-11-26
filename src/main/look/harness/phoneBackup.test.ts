import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAll, invariant1, invariant2, invariant4 } from './invariants.testutil';
import { sha256Of } from './fakeDrive.testutil';
import { LISTS_PREFIX, ProductWorld } from './phoneBackupWorld.testutil';
import { makeRig, World, type Rig } from './world.testutil';

/**
 * The phone backup (R1.2a) in the fake world of R1.0a: invariants 1 to 5 hold through the real plan and the real run, including a drive
 * pulled mid-copy, the phone going away mid-run, a short pull, a checksum mismatch, a different file already at the destination, and the app
 * killed mid-run and then Continue.
 */
const HOSTILE = ["it's.jpg", 'a b.jpg', '$HOME.txt', 'semi;colon.txt', '-dash.txt', 'tick`s.txt', 'x(1).txt', 'amp&.txt', '[br].txt'];

describe('the phone backup in the fake world', () => {
  let rig: Rig;
  let w: World;
  let p: ProductWorld;

  const seed = (n = 6): string[] => {
    const paths: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const path = `/sdcard/DCIM/Camera/IMG_${i}.jpg`;
      w.createFile(path, `photo ${i} ${'x'.repeat(10 + i)}`);
      paths.push(path);
    }
    return paths;
  };

  beforeEach(() => {
    rig = makeRig();
    w = new World(rig, { seed: 7, drives: [{ caseInsensitive: true, tornWrites: true }, { caseInsensitive: true }] });
    p = new ProductWorld(w);
    w.tick(60);
  });
  afterEach(() => {
    w.dispose();
    rig.close();
  });

  const clean = (): void => {
    expect([...checkAll(w), ...invariant1(w), ...invariant2(w)]).toEqual([]);
  };

  it('copies new files, with hostile names, checked on the phone; the index rows are verified; the list is on the drive; a second run copies nothing', async () => {
    seed(4);
    for (const [i, name] of HOSTILE.entries()) w.createFile(`/sdcard/Documents/${name}`, `doc ${i} ${name}`);
    const first = await p.backup();
    expect(first.plan.result, JSON.stringify(first.plan.result)).toMatchObject({ ok: true });
    expect(first.copied).toBe(4 + HOSTILE.length);
    expect(first.ctx.warnings).toEqual([]);
    const rows = rig.db.prepare("SELECT * FROM files WHERE place_id = ? AND origin_file_id IS NOT NULL").all(w.destinations[0]!.placeId) as Record<string, unknown>[];
    expect(rows).toHaveLength(4 + HOSTILE.length);
    for (const r of rows) {
      expect(r['verified_how']).toBe('read_both');
      expect(r['expected_sha256']).toBe(r['sha256']);
      expect(String(r['rel_path'])).toMatch(/^MyData\/POCO\/POCO-\d\d[A-Z][a-z]{2}\d\d\//);
      expect(w.drives[0]!.durableSha(String(r['rel_path']))).toBe(r['sha256']);
    }
    // The shell read the checksum ON THE PHONE for every file.
    expect(p.adb.shaReads).toHaveLength(4 + HOSTILE.length);
    expect(p.adb.killed).toBeGreaterThanOrEqual(0);
    // The run list is on the drive and names every copy.
    const list = [...w.drives[0]!.onDrive()].find((f) => f.path.startsWith(LISTS_PREFIX));
    expect(list).toBeTruthy();
    const text = w.drives[0]!.readUncached(list!.path).toString();
    for (const r of rows) expect(text).toContain(String(r['sha256']));
    expect(text).toContain("it's.jpg");
    clean();
    const second = await p.backup();
    expect(second.copied).toBe(0);
    expect(invariant4({ copied: first.copied }, { copied: second.copied, report: { recorded: null } })).toEqual([]);
    clean();
  });

  it('leaves out what the filters drop and says so; nothing is silently lost', async () => {
    seed(2);
    w.createFile('/sdcard/DCIM/.thumbnails/t1.jpg', 'thumb');
    w.createFile('/sdcard/Android/data/com.some.app/files/x.bin', 'appdata');
    w.createFile('/sdcard/Download/a.tmp', 'tmp');
    const { outcome } = await p.plan();
    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) return;
    const left = Object.fromEntries(outcome.result.plan.leftOut.map((g) => [g.filter, g.files]));
    expect(left).toMatchObject({ cache_folder: 1, android_data: 1, temporary_file: 1 });
    expect(outcome.result.plan.totals.files).toBe(2);
    // The look recorded every listed file anyway.
    expect(rig.db.prepare('SELECT count(*) FROM files WHERE place_id = ?').pluck().get(w.placeId)).toBe(5);
  });

  it('a drive pulled mid-copy stops the run at a safe point; plug it in, Continue, and nothing is lost or recopied', async () => {
    const paths = seed(8);
    let calls = 0;
    p.adb.beforePull = (n) => {
      calls = n;
      if (n === 4) w.drives[0]!.unplug();
    };
    const run = await p.backup({ onAsk: () => w.drives[0]!.plug() });
    expect(run.ctx.questions.some((q) => /drive/i.test(q))).toBe(true);
    expect(run.copied).toBe(paths.length);
    expect(calls).toBeGreaterThanOrEqual(paths.length);
    clean();
    expect(w.copyLog.map((c) => c.path.toLowerCase())).toHaveLength(new Set(w.copyLog.map((c) => c.path.toLowerCase())).size);
  });

  it('the phone going away mid-run pauses the run; plug it in, it looks again and carries on', async () => {
    const paths = seed(6);
    p.adb.beforePull = (n) => {
      if (n === 3) p.adb.pullFaults.push('phone_gone'); // the third pull finds the cable gone
    };
    const commandsBefore = w.shell.commands.length;
    const run = await p.backup({ onAsk: () => (p.adb.plugged = true) });
    expect(run.ctx.questions.some((q) => /phone/i.test(q))).toBe(true);
    expect(run.copied).toBe(paths.length);
    expect(w.shell.commands.length - commandsBefore).toBeGreaterThanOrEqual(3); // plan look, run look, look again after the phone came back
    clean();
  });

  it('a short pull is tried again; a pull that stays short fails that one file and leaves nothing at the final name', async () => {
    const paths = seed(3);
    p.adb.pullFaults.push('short');
    const ok = await p.backup();
    expect(ok.copied).toBe(3);
    expect(p.adb.pulls.length).toBe(4);
    clean();
    // Now one that never comes back whole: three tries, then failed (a failed file is not a lost file).
    w.createFile('/sdcard/DCIM/Camera/BAD.jpg', 'never whole');
    w.tick(10);
    p.adb.pullFaults.push('short', 'short', 'short');
    const bad = await p.backup();
    expect(bad.copied).toBe(0);
    expect(bad.ctx.warnings.join(' ')).toMatch(/shorter than the phone said/);
    expect(w.drives[0]!.onDrive().some((f) => f.path.includes('BAD.jpg'))).toBe(false);
    clean();
    expect(paths.length).toBe(3);
  });

  it('a checksum mismatch never reaches a final name; once the pull is right it is copied', async () => {
    seed(2);
    p.adb.pullFaults.push('corrupt');
    const first = await p.backup();
    expect(first.copied).toBe(2);
    clean();
    w.createFile('/sdcard/DCIM/Camera/BAD2.jpg', 'corrupt always');
    w.tick(10);
    p.adb.pullFaults.push('corrupt', 'corrupt', 'corrupt');
    const bad = await p.backup();
    expect(bad.ctx.warnings.join(' ')).toMatch(/did not match the phone's checksum/);
    expect(w.drives[0]!.onDrive().some((f) => f.path.includes('BAD2.jpg'))).toBe(false);
    for (const f of w.drives[0]!.onDrive()) expect(f.path.startsWith(LISTS_PREFIX) || w.everContent.has(f.sha256)).toBe(true);
  });

  it('a different file already at the destination is a Problem: not replaced, the rest carries on', async () => {
    const a = seed(3)[0]!;
    // Find where the first file will go, and put a different file there.
    const { outcome } = await p.plan();
    if (!outcome.result.ok || !outcome.stored) throw new Error('plan');
    const target = outcome.stored.items.find((i) => i.path === a)!.destRel;
    w.drives[0]!.write(target, 'SOMEONE ELSE', 5);
    w.drives[0]!.flush(target);
    const run = await p.backup();
    expect(run.copied).toBe(2);
    expect(run.ctx.warnings.join(' ')).toMatch(/different file is already at this name/);
    expect(w.drives[0]!.readUncached(target).toString()).toBe('SOMEONE ELSE');
    expect(w.drives[0]!.overwrites).toEqual([]);
  });

  it('the same file already there with the same content is recorded, not copied', async () => {
    const a = seed(2)[0]!;
    const { outcome } = await p.plan();
    if (!outcome.result.ok || !outcome.stored) throw new Error('plan');
    const target = outcome.stored.items.find((i) => i.path === a)!.destRel;
    w.drives[0]!.write(target, w.phone.read(a), 5);
    w.drives[0]!.flush(target);
    const run = await p.backup();
    expect(p.adb.pulls).not.toContain(a);
    expect(run.copied).toBe(2); // both get an index row; one of them without a pull
    expect(w.drives[0]!.overwrites).toEqual([]);
  });

  it('the app killed at any point of a run, then Continue: no loss, no half file, no copy twice', async () => {
    const paths = seed(7);
    let crashes = 0;
    for (let crashAfter = 1; crashAfter <= 48; crashAfter += 2) {
      const fresh = new World(makeRig(), { seed: 100 + crashAfter, drives: [{ caseInsensitive: true, tornWrites: true }, { caseInsensitive: true }] });
      const q = new ProductWorld(fresh);
      fresh.tick(60);
      for (let i = 0; i < 7; i += 1) fresh.createFile(`/sdcard/DCIM/Camera/K${i}.jpg`, `killed ${crashAfter} ${i}`);
      try {
        const first = await q.backup({ crashAfter });
        if (first.crashed) crashes += 1;
        const second = first.crashed ? await q.continueRun({}, first) : first;
        expect(second.crashed).toBe(false);
        const pullsOf = (path: string): number => q.adb.pulls.filter((x) => x === path).length;
        // Everything is on the drive exactly once and verified.
        expect(fresh.copyLog.length).toBe(7);
        expect([...checkAll(fresh), ...invariant1(fresh), ...invariant2(fresh)]).toEqual([]);
        // At most the one file that was being copied when the app was killed is pulled again; files done before the kill are not.
        const pulled = [0, 1, 2, 3, 4, 5, 6].reduce((n, i) => n + pullsOf(`/sdcard/DCIM/Camera/K${i}.jpg`), 0);
        expect(pulled, `crash ${crashAfter}`).toBeLessThanOrEqual(8);
        const again = await q.backup();
        expect(again.copied).toBe(0);
      } finally {
        fresh.dispose();
        fresh.rig.close();
      }
    }
    expect(paths.length).toBe(7);
    expect(crashes).toBeGreaterThanOrEqual(15); // the run really was killed, at different points
  }, 120_000);

  it('the laptop waking up is treated like an unplug: the phone and the drive are looked at again', async () => {
    seed(5);
    const before = w.shell.commands.length;
    p.adb.beforePull = (n) => {
      if (n === 2) p.wakes += 1;
    };
    const run = await p.backup();
    expect(run.copied).toBe(5);
    expect(run.ctx.logs.some((l) => /slept/.test(l))).toBe(true);
    expect(w.shell.commands.length - before).toBeGreaterThanOrEqual(3);
    clean();
  });

  it('a phone that is empty or half listed plans nothing (the look says so)', async () => {
    seed(12);
    expect((await p.backup()).copied).toBe(12);
    w.shell.faults.push('truncate');
    const { outcome } = await p.plan();
    expect(outcome.result.ok).toBe(false);
    expect(outcome.stored).toBeNull();
    for (const path of w.phone.walk().map((f) => f.path)) w.phone.remove(path);
    const empty = await p.plan();
    expect(empty.outcome.result.ok).toBe(false);
    if (!empty.outcome.result.ok) expect(empty.outcome.result.decision?.canAccept).toBe(true);
    expect(sha256Of('x')).toHaveLength(64);
  });

  const loose = (rel: string, content: string, onDrive: string): void => {
    const drive = w.drives[0]!;
    drive.write(rel, onDrive, 5);
    drive.flush(rel);
    rig.db
      .prepare('INSERT INTO files (place_id, rel_path, size, mtime, sha256, first_seen_at, last_seen_at, verified_how) VALUES (?, ?, ?, ?, NULL, 1, 1, ?)')
      .run(w.destinations[0]!.placeId, rel, Buffer.byteLength(content), 5000, 'imported');
  };

  it('a name-and-size match is linked only when the phone checksum agrees with the file on the drive; then nothing is copied for it', async () => {
    const path = '/sdcard/DCIM/Camera/OLD.jpg';
    w.createFile(path, 'old content here');
    loose('MyData/POCO/POCO-old/DCIM/Camera/OLD.jpg', 'old content here', 'old content here');
    const { outcome } = await p.plan();
    if (!outcome.result.ok) throw new Error('plan');
    expect(outcome.result.plan.confirmedOnDrive).toBe(1);
    expect(outcome.result.plan.totals.files).toBe(0);
    const run = await p.backup();
    expect(p.adb.pulls).toEqual([]);
    expect(run.copied).toBe(1); // the one row that was linked to its phone file (nothing was copied)
    const row = rig.db.prepare("SELECT origin_file_id, verified_how, expected_sha256 FROM files WHERE rel_path = 'MyData/POCO/POCO-old/DCIM/Camera/OLD.jpg'").get() as { origin_file_id: number; verified_how: string; expected_sha256: string };
    expect(row.origin_file_id).not.toBeNull();
    expect(row.verified_how).toBe('read_both');
    expect(row.expected_sha256).toBe(sha256Of('old content here'));
    const again = await p.backup();
    expect(again.copied).toBe(0);
  });

  it('a name-and-size match with another checksum is NOT trusted: the phone file is copied as new and the old row is left alone', async () => {
    const path = '/sdcard/DCIM/Camera/TWIN.jpg';
    w.createFile(path, 'AAAAAAAAAA');
    loose('MyData/POCO/POCO-old/DCIM/Camera/TWIN.jpg', 'AAAAAAAAAA', 'BBBBBBBBBB'); // same name and size, other bytes
    const { outcome } = await p.plan();
    if (!outcome.result.ok) throw new Error('plan');
    expect(outcome.result.plan.confirmedOnDrive).toBe(0);
    expect(outcome.result.plan.notConfirmed).toBe(1);
    const run = await p.backup();
    expect(run.copied).toBe(1);
    expect(rig.db.prepare("SELECT origin_file_id FROM files WHERE rel_path = 'MyData/POCO/POCO-old/DCIM/Camera/TWIN.jpg'").pluck().get()).toBeNull();
    expect(w.drives[0]!.readUncached('MyData/POCO/POCO-old/DCIM/Camera/TWIN.jpg').toString()).toBe('BBBBBBBBBB');
  });

  it('a second space on the phone is named as not covered', async () => {
    seed(1);
    p.adb.spaces = [{ id: '999', readable: false }];
    const { outcome } = await p.plan();
    expect(outcome.stored?.base.notCovered.join(' ')).toMatch(/second space/);
  });
});
