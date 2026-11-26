import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyCheckpoint, type RunCheckpoint } from '../../phoneBackup/runEngine';
import { checkAll, invariant1, invariant2 } from './invariants.testutil';
import { sha256Of } from './fakeDrive.testutil';
import { ProductWorld } from './phoneBackupWorld.testutil';
import { makeRig, World, type Rig } from './world.testutil';

/**
 * The phone's checksums of the next files in copy order are read with ONE adb call (R1.2a speed-up: a file cost about 0.4 s of fixed adb time
 * and one call per file for the checksum was half of it). Every safety step stays: each file is pulled to a temp name, flushed, read back
 * from the drive without the cache and compared with the phone's checksum, linked without replacing, flushed, and only then gets its row.
 */
describe('the phone backup reads checksums in batches', () => {
  let rig: Rig;
  let w: World;
  let p: ProductWorld;

  const seed = (n: number, prefix = 'IMG'): string[] => {
    const paths: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const path = `/sdcard/DCIM/Camera/${prefix}_${String(i).padStart(3, '0')}.jpg`;
      w.createFile(path, `photo ${prefix} ${i} ${'x'.repeat(10 + (i % 7))}`);
      paths.push(path);
    }
    return paths;
  };
  /** Checksum calls that asked about one file, and the ones that asked about many. */
  const calls = (): { single: number; batches: number; pulls: number } => {
    const inBatches = p.adb.shaBatches.reduce((s, b) => s + b.length, 0);
    return { single: p.adb.shaReads.length - inBatches, batches: p.adb.shaBatches.length, pulls: p.adb.pulls.length };
  };
  const clean = (): void => {
    expect([...checkAll(w), ...invariant1(w), ...invariant2(w)]).toEqual([]);
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

  it('100 small files: one checksum call per 40 files instead of one per file, every file verified as before', async () => {
    seed(100);
    const run = await p.backup();
    expect(run.copied).toBe(100);
    expect(run.ctx.warnings).toEqual([]);
    const c = calls();
    // Before: 100 checksum calls + 100 pulls = 2.00 adb calls per file. Now: 3 batch calls (40 + 40 + 20) + 100 pulls.
    expect(c).toEqual({ single: 0, batches: 3, pulls: 100 });
    console.log(`ADB CALLS PER FILE: before 2.00 (1 checksum + 1 pull), now ${((c.single + c.batches + c.pulls) / 100).toFixed(2)} (${c.batches} batch calls of at most 40 files, ${c.single} single, ${c.pulls} pulls)`);
    expect(p.adb.shaBatches.map((b) => b.length)).toEqual([40, 40, 20]);
    // Every copy is verified: the index row says both sides were read, and the drive holds exactly the phone's content.
    const rows = rig.db.prepare('SELECT rel_path, sha256, expected_sha256, verified_how FROM files WHERE place_id = ? AND origin_file_id IS NOT NULL').all(w.destinations[0]!.placeId) as { rel_path: string; sha256: string; expected_sha256: string; verified_how: string }[];
    expect(rows).toHaveLength(100);
    for (const r of rows) {
      expect(r.verified_how).toBe('read_both');
      expect(r.expected_sha256).toBe(r.sha256);
      expect(w.drives[0]!.durableSha(r.rel_path)).toBe(r.sha256);
    }
    clean();
  });

  it('a file that changed on the phone after its checksum was read fails the comparison and is tried again with a checksum read alone', async () => {
    const paths = seed(10);
    const victim = paths[6]!;
    const old = w.phone.read(victim);
    const changed = Buffer.from(old.toString().replace('photo', 'PHOTO'));
    expect(changed.length).toBe(old.length);
    const mtime = w.phone.walk().find((f) => f.path === victim)!.mtimeSec;
    // The checksums of all ten were read in one call; then, while the first files are copied, the phone's file changes (same size, same date).
    p.adb.beforePull = (n) => {
      if (n === 2) {
        w.phone.write(victim, changed, mtime);
        w.everContent.add(sha256Of(changed));
      }
    };
    const run = await p.backup();
    expect(run.copied).toBe(10);
    expect(run.ctx.warnings.join(' ')).toBe('');
    expect(run.ctx.logs.join('\n')).toMatch(/did not match the phone's checksum. Trying again/);
    // One batch call for everybody, then one single read for the file that was tried again.
    expect(calls()).toMatchObject({ single: 1, batches: 1, pulls: 11 });
    expect(p.adb.shaReads.filter((x) => x === victim)).toHaveLength(2);
    // What is on the drive is the content the phone holds NOW, verified.
    const row = rig.db.prepare('SELECT rel_path, sha256 FROM files WHERE place_id = ? AND origin_file_id IS NOT NULL AND rel_path LIKE ?').get(w.destinations[0]!.placeId, '%IMG_006.jpg') as { rel_path: string; sha256: string };
    expect(row.sha256).toBe(sha256Of(changed));
    expect(w.drives[0]!.durableSha(row.rel_path)).toBe(sha256Of(changed));
    clean();
  });

  it('a batch call that fails as a whole (adb stopped) only means the files are read one by one, as before', async () => {
    seed(30);
    p.adb.sha256Many = async () => ({ answers: new Map(), adbError: 'adb stopped' });
    const run = await p.backup();
    expect(run.copied).toBe(30);
    expect(run.ctx.warnings).toEqual([]);
    expect(p.adb.shaReads).toHaveLength(30);
    clean();
  });

  it('a file the phone has no answer for in the batch (it vanished) is read alone and fails exactly as it always did; the others are copied', async () => {
    const paths = seed(8);
    p.adb.beforeShaMany = () => w.phone.remove(paths[4]!);
    const run = await p.backup();
    expect(run.copied).toBe(7);
    expect(run.ctx.warnings.join(' ')).toMatch(/IMG_004.jpg/);
    expect(w.drives[0]!.onDrive().some((f) => f.path.includes('IMG_004'))).toBe(false);
    clean();
  });

  it('the phone going away between the batch and the pull: the run asks for Continue, looks again, reads afresh and carries on', async () => {
    const paths = seed(12);
    p.adb.beforePull = (n) => {
      if (n === 3) p.adb.pullFaults.push('phone_gone');
    };
    const run = await p.backup({ onAsk: () => (p.adb.plugged = true) });
    expect(run.ctx.questions.some((q) => /phone/i.test(q))).toBe(true);
    expect(run.copied).toBe(paths.length);
    // After the phone came back the checksums read before are not trusted: a new batch call was made.
    expect(p.adb.shaBatches.length).toBeGreaterThanOrEqual(2);
    clean();
  });

  it('a run paused by the build before this one carries on from its checkpoint (today\'s format): nothing is recopied, nothing is lost', async () => {
    seed(12);
    let first = null as Awaited<ReturnType<ProductWorld['backup']>> | null;
    // Killed part-way, the way the app is closed mid-run.
    first = await p.backup({ crashAfter: 40 });
    expect(first.crashed).toBe(true);
    const made = first.checkpoint as RunCheckpoint;
    // The checkpoint keeps exactly the fields of the current packaged build: the speed-up added none.
    expect(Object.keys(made).toSorted()).toEqual(['alreadyThere', 'bytes', 'bytesDone', 'copied', 'failed', 'failedList', 'linked', 'linkedApplied', 'next', 'runId', 'skipped', 'startedAt']);
    expect(Object.keys(emptyCheckpoint()).toSorted()).toEqual(Object.keys(made).toSorted());
    // A checkpoint as the old build wrote it (a literal, not made by this code), at the same place.
    const literal = JSON.parse(
      JSON.stringify({ runId: made.runId, startedAt: made.startedAt, next: made.next, copied: made.copied, bytes: made.bytes, alreadyThere: made.alreadyThere, linked: made.linked, linkedApplied: made.linkedApplied, bytesDone: made.bytesDone, skipped: {}, failed: {}, failedList: [] }),
    ) as RunCheckpoint;
    const pullsBefore = p.adb.pulls.length;
    const second = await p.continueRun({}, { ...first, checkpoint: literal });
    expect(second.crashed).toBe(false);
    expect(w.copyLog).toHaveLength(12);
    clean();
    // At most the one file that was being copied when the app was killed is pulled again; the files done before the kill are not.
    expect(p.adb.pulls.length - pullsBefore).toBeLessThanOrEqual(12 - made.next + 1);
    expect((await p.backup()).copied).toBe(0);
  });
});
