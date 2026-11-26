import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RulesStore } from '../../rules/rulesStore';
import { JobService } from '../../jobs/jobService';
import { checkOldCountsOf, classifyPhoneFiles, loadPhoneBackup, uncheckedFolders } from '../../phoneBackup/checkOld';
import { PhoneBackupService } from '../../phoneBackup/phoneBackupService';
import { phoneFolderGroup } from '../../../shared/phoneBackup';
import { copyRow, seedImported } from './checkOldWorld.testutil';
import { ProductWorld } from './phoneBackupWorld.testutil';
import { makeRig, World, type Rig } from './world.testutil';

/** The numbers on the backup's card: counted from the index alone, the same way the plan decides what is backed up. */
describe('the counts of "Check old copies"', () => {
  let rig: Rig;
  let w: World;
  let p: ProductWorld;
  let jobs: JobService;
  let service: PhoneBackupService;

  beforeEach(() => {
    rig = makeRig();
    w = new World(rig, { seed: 31, drives: [{ caseInsensitive: true }, { caseInsensitive: true }] });
    p = new ProductWorld(w);
    jobs = new JobService({ db: rig.db });
    service = new PhoneBackupService(p.deps, jobs);
    w.tick(60);
  });
  afterEach(() => {
    jobs.shutdown();
    w.dispose();
    rig.close();
  });

  it('groups files like the preview does: two folders below /sdcard, or one, or "Phone storage"', () => {
    expect(phoneFolderGroup('/sdcard/DCIM/Camera/a.jpg')).toBe('DCIM/Camera');
    expect(phoneFolderGroup('/sdcard/DCIM/Camera/2026/a.jpg')).toBe('DCIM/Camera');
    expect(phoneFolderGroup('/sdcard/Download/a.pdf')).toBe('Download');
    expect(phoneFolderGroup('/sdcard/notes.txt')).toBe('Phone storage');
    expect(phoneFolderGroup('/sdcard/Android/media/com.whatsapp/x.jpg')).toBe('Android/media');
  });

  it('counts each phone file once: checked copy, unchecked copy, no copy, left out on purpose; sizes add up; a different or gone copy is no copy', async () => {
    const make = (path: string, content: string): void => w.createFile(path, content);
    make('/sdcard/DCIM/Camera/checked.jpg', 'c'.repeat(10));
    make('/sdcard/DCIM/Camera/old.jpg', 'o'.repeat(20));
    make('/sdcard/DCIM/Camera/new.jpg', 'n'.repeat(30));
    make('/sdcard/DCIM/Camera/differs.jpg', 'd'.repeat(40));
    make('/sdcard/DCIM/Camera/vanished.jpg', 'v'.repeat(50));
    make('/sdcard/DCIM/.thumbnails/t.jpg', 't'.repeat(60));
    make('/sdcard/Documents/excluded.txt', 'e'.repeat(70));
    make('/sdcard/Documents/plain.txt', 'p'.repeat(80));
    await w.look();
    const checked = seedImported(w, '/sdcard/DCIM/Camera/checked.jpg');
    w.db.prepare("UPDATE files SET verified_how = 'read_both' WHERE id = ?").run(checked.copyId);
    seedImported(w, '/sdcard/DCIM/Camera/old.jpg');
    const differs = seedImported(w, '/sdcard/DCIM/Camera/differs.jpg');
    w.db.prepare("UPDATE files SET verified_how = 'differs' WHERE id = ?").run(differs.copyId);
    const vanished = seedImported(w, '/sdcard/DCIM/Camera/vanished.jpg', { how: 'name_size' });
    w.db.prepare("UPDATE files SET gone_at = 1, gone_reason = 'missing_on_drive' WHERE id = ?").run(vanished.copyId);
    // The person's own choice (since R1.2b the plan and the counts read `backup_rules`, not the old exclusions list).
    new RulesStore(w.db).add(w.profileId, { scope: 'file', pattern: '/sdcard/Documents/excluded.txt', choice: 'leave_out' });

    const counts = await service.checkOldCounts(w.profileId);
    if (!counts.ok) throw new Error(counts.message);
    expect(counts.driveLabel).toBe(w.db.prepare('SELECT label FROM places WHERE id = ?').pluck().get(w.destinations[0]!.placeId));
    expect(counts.lookedAt).toBe(w.nowMs);
    expect(counts.total).toEqual({
      onPhone: { files: 8, bytes: 360 },
      checked: { files: 1, bytes: 10 },
      unchecked: { files: 1, bytes: 20 },
      noCopy: { files: 4, bytes: 30 + 40 + 50 + 80 },
      leftOut: { files: 2, bytes: 60 + 70 },
    });
    const byFolder = new Map(counts.folders.map((f) => [f.folder, f]));
    expect([...byFolder.keys()].toSorted()).toEqual(['DCIM/.thumbnails', 'DCIM/Camera', 'Documents']);
    expect(byFolder.get('DCIM/Camera')).toMatchObject({ onPhone: { files: 5, bytes: 150 }, checked: { files: 1 }, unchecked: { files: 1 }, noCopy: { files: 3 }, leftOut: { files: 0 } });
    expect(byFolder.get('Documents')).toMatchObject({ onPhone: { files: 2, bytes: 150 }, noCopy: { files: 1, bytes: 80 }, leftOut: { files: 1, bytes: 70 } });
    // Largest folder first.
    expect(counts.folders[0]!.onPhone.bytes).toBeGreaterThanOrEqual(counts.folders[1]!.onPhone.bytes);
    // Every file is counted in exactly one of the four.
    for (const f of [counts.total, ...counts.folders]) expect(f.checked.files + f.unchecked.files + f.noCopy.files + f.leftOut.files).toBe(f.onPhone.files);
    // The preview of the check lists only the folder with an unchecked copy.
    const loaded = loadPhoneBackup(w.db, w.profileId);
    if (!loaded.ok) throw new Error('no backup');
    expect(uncheckedFolders(classifyPhoneFiles(w.db, loaded.backup, loaded.dest))).toEqual([{ folder: 'DCIM/Camera', files: 1, bytes: 20 }]);
    // Nothing was written by counting.
    expect(copyRow(w, checked.copyId).verified_how).toBe('read_both');
    expect(await service.checkOldCounts('x')).toEqual({ ok: false, message: 'That backup is not valid.' });
    expect(await service.checkOldCounts(424_242)).toEqual({ ok: false, message: 'That backup does not exist.' });
  });

  it('a phone file that is gone from the phone is not on the phone any more and is not counted', async () => {
    w.createFile('/sdcard/DCIM/Camera/a.jpg', 'aaa');
    w.createFile('/sdcard/DCIM/Camera/b.jpg', 'bbbb');
    await w.look();
    seedImported(w, '/sdcard/DCIM/Camera/a.jpg');
    w.phone.remove('/sdcard/DCIM/Camera/a.jpg');
    w.tick(10);
    await w.look(['look_mass_change']);
    const counts = await service.checkOldCounts(w.profileId);
    expect(counts.ok && counts.total.onPhone.files).toBe(1);
  });

  it('keeps the last answer: a fresh one comes back as it is, an old one at once marked stale while a new count runs', async () => {
    w.createFile('/sdcard/DCIM/Camera/a.jpg', 'aaa');
    await w.look();
    const first = await service.checkOldCounts(w.profileId);
    expect(first.ok && first.total.onPhone.files).toBe(1);
    expect(first.ok && first.stale).toBeUndefined();
    w.createFile('/sdcard/DCIM/Camera/b.jpg', 'bbbb');
    w.tick(10);
    await w.look();
    // The look went through the helper, not a job: tell the service as the job wrapper does.
    expect((await service.checkOldCounts(w.profileId)) as unknown).toEqual(first);
    service.countsChanged();
    const old = await service.checkOldCounts(w.profileId);
    expect(old.ok && old.stale).toBe(true);
    expect(old.ok && old.total.onPhone.files).toBe(1);
    let fresh = await service.checkOldCounts(w.profileId);
    for (let i = 0; i < 100 && fresh.ok && fresh.stale === true; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      fresh = await service.checkOldCounts(w.profileId);
    }
    expect(fresh.ok && fresh.stale).toBeUndefined();
    expect(fresh.ok && fresh.total.onPhone.files).toBe(2);
  });

  it('answers a 100,000 file phone backup in under a second', () => {
    const phone = w.placeId;
    const drive = w.destinations[0]!.placeId;
    const insert = w.db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, origin_file_id, verified_how) VALUES (?, ?, ?, ?, 1, 1, ?, ?)');
    const folders = ['DCIM/Camera', 'Pictures/Screenshots', 'Download', 'Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images', 'WhatsApp/Media/WhatsApp Video', 'Documents', 'Movies', 'Music'];
    const hows = [null, 'imported', 'name_size', 'read_both', 'differs'];
    w.db.transaction(() => {
      for (let i = 0; i < 100_000; i += 1) {
        const rel = `sdcard/${folders[i % folders.length]!}/file_${String(i).padStart(6, '0')}.jpg`;
        const size = 1000 + (i % 5000);
        const mtime = 1_700_000_000_000 + i * 1000;
        const id = Number(insert.run(phone, rel, size, mtime, null, null).lastInsertRowid);
        if (i % 10 < 7) insert.run(drive, `MyData/POCO/old/${rel}`, size, mtime, id, hows[i % hows.length]!);
      }
    })();
    // One run under a second is the claim. The whole suite runs in parallel and stretches the clock, so a slow run is tried again (up to 8 times);
    // a real slowdown makes every run slow.
    // (The service keeps its last answer, so the timed runs call the count itself, which the worker thread runs.)
    let took = Infinity;
    let counts = checkOldCountsOf(w.db, w.profileId);
    for (let i = 0; i < 8 && took >= 1000; i += 1) {
      const started = performance.now();
      counts = checkOldCountsOf(w.db, w.profileId);
      took = Math.min(took, performance.now() - started);
    }
    if (!counts.ok) throw new Error(counts.message);
    expect(counts.total.onPhone.files).toBe(100_000);
    const t = counts.total;
    expect(t.checked.files + t.unchecked.files + t.noCopy.files + t.leftOut.files).toBe(100_000);
    expect(t.checked.files).toBeGreaterThanOrEqual(10_000);
    expect(t.unchecked.files).toBeGreaterThan(20_000);
    expect(counts.folders).toHaveLength(folders.length);
    expect(took).toBeLessThan(1000);
  }, 60_000);
});
