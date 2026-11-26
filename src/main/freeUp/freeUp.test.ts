import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BIG_VIDEO_BYTES, FREEUP_GROUPS, FREEUP_MAX_PUT_BACK, type FreeUpRemoveJobParams, type FreeUpResultView } from '../../shared/freeUp';
import { JobAborted, JobFailure } from '../jobs/jobService';
import { PUT_BACK_JOB_KIND } from '../../shared/cleanup';
import { putBackHandler } from '../cleanup/phoneCleanJob';
import { diskSizeFor } from '../cleanup/diskAccess';
import { scanMediaCommands } from '../cleanup/adbClean';
import { freeUpCheckHandler } from './freeUpCheck';
import { freeUpRemoveHandler } from './freeUpRemove';
import { FreeUpService } from './freeUpService';
import { KeepStore } from './keepStore';
import { compareForList, copyIsInPlace, groupOf, neverOfferedPath, phoneKindOf } from './freeUpRules';
import { CleanupService } from '../cleanup/cleanupService';
import { ctxFor, FreeUpWorld, PHONE_MTIME_MS, ROOT, silent, sha } from './freeUpWorld.testutil';

let w: FreeUpWorld;
beforeEach(() => {
  w = new FreeUpWorld();
});
afterEach(() => w.dispose());

const KB = 1024;

async function check(options: { abortAfterYields?: number; mode?: 'quick' | 'full' } = {}): Promise<{ view: FreeUpResultView; message: string }> {
  const { abortAfterYields, mode } = options;
  const { ctx } = ctxFor(mode ? { backupId: w.backupId, mode } : { backupId: w.backupId }, { jobId: 11, ...(abortAfterYields !== undefined ? { abortAfterYields } : {}) });
  const message = (await freeUpCheckHandler(w.deps()).run(ctx)) as string;
  const stored = w.results.get(11);
  if (!stored) throw new Error('no result kept');
  return { view: stored.view, message };
}

const readyPaths = (): string[] => w.results.get(11)!.ready.map((r) => r.path);
const notReadyOf = (name: string): string[] => w.results.get(11)!.notReady.find((r) => r.name === name)?.missing ?? [];

describe('the rules (pure)', () => {
  it('offers only photo and video kinds; a video over 100 MB is always first, biggest first; then camera, WhatsApp, other videos, screenshots, photos', () => {
    expect(groupOf('video-camera', BIG_VIDEO_BYTES)).toBe('big-videos');
    expect(groupOf('video-whatsapp', BIG_VIDEO_BYTES + 1)).toBe('big-videos');
    expect(groupOf('video-other', BIG_VIDEO_BYTES * 2)).toBe('big-videos');
    expect(groupOf('video-camera', BIG_VIDEO_BYTES - 1)).toBe('camera-videos');
    expect(groupOf('photo-camera', BIG_VIDEO_BYTES * 3)).toBe('camera-photos');
    for (const kind of ['documents', 'google-docs', 'archives', 'audio-music', 'audio-recording', 'empty', 'other']) expect(groupOf(kind, 5_000_000)).toBeNull();
    const rows = [
      { group: groupOf('photo-other', 9)!, size: 9, path: '/a' },
      { group: groupOf('photo-camera', 50)!, size: 50, path: '/b' },
      { group: groupOf('photo-whatsapp', 10)!, size: 10, path: '/c' },
      { group: groupOf('photo-screenshot', 70)!, size: 70, path: '/d' },
      { group: groupOf('video-other', 5)!, size: 5, path: '/e' },
      { group: groupOf('video-whatsapp', 60)!, size: 60, path: '/f' },
      { group: groupOf('video-camera', 40)!, size: 40, path: '/g' },
      { group: groupOf('video-camera', 30)!, size: 30, path: '/h' },
      { group: groupOf('video-other', 300_000_000)!, size: 300_000_000, path: '/i' },
      { group: groupOf('video-camera', 200_000_000)!, size: 200_000_000, path: '/j' },
    ];
    expect(rows.toSorted(compareForList).map((r) => r.path)).toEqual(['/i', '/j', '/g', '/h', '/f', '/e', '/d', '/b', '/c', '/a']);
    expect(FREEUP_GROUPS[0]).toBe('big-videos');
  });

  it('never offers app data, WhatsApp databases and backups', () => {
    for (const p of ['/sdcard/Android/media/com.whatsapp/WhatsApp/Media/a.jpg', '/storage/emulated/0/Android/data/x/a.jpg', '/sdcard/WhatsApp/Databases/msgstore.db.crypt14', '/sdcard/WhatsApp/Backups/chat.zip', '/sdcard/Android/media/com.whatsapp/WhatsApp/Databases/x']) expect(neverOfferedPath(p), p).not.toBeNull();
    for (const p of ['/sdcard/DCIM/Camera/IMG_1.jpg', '/sdcard/WhatsApp/Media/WhatsApp Images/IMG-1-WA0001.jpg', '/sdcard/Pictures/Screenshots/a.png']) expect(neverOfferedPath(p), p).toBeNull();
  });

  it('works out the kind from the path when the classify job has not yet', () => {
    expect(phoneKindOf('/sdcard/DCIM/Camera/VID_20240101_101010.mp4', 5000, null)).toBe('video-camera');
    expect(phoneKindOf('/sdcard/WhatsApp/Media/WhatsApp Video/VID-20240101-WA0001.mp4', 5000, null)).toBe('video-whatsapp');
    expect(phoneKindOf('/sdcard/Pictures/Screenshots/Screenshot_1.png', 5000, null)).toBe('photo-screenshot');
    expect(phoneKindOf('/sdcard/x/a.jpg', 5000, 'photo-camera')).toBe('photo-camera');
  });

  it('a copy counts only inside the backup folder and not in old versions, damaged or half copied', () => {
    expect(copyIsInPlace('MyData/POCO/DCIM/a.jpg', 'MyData/POCO')).toBe(true);
    expect(copyIsInPlace('mydata/poco/DCIM/a.jpg', 'MyData/POCO')).toBe(true);
    expect(copyIsInPlace('MyData/Other/DCIM/a.jpg', 'MyData/POCO')).toBe(false);
    expect(copyIsInPlace('MyData/POCO/_old-versions/a.jpg', 'MyData/POCO')).toBe(false);
    expect(copyIsInPlace('MyData/POCO/_damaged/a.jpg', 'MyData/POCO')).toBe(false);
    expect(copyIsInPlace('MyData/POCO/a.jpg.bhpart', 'MyData/POCO')).toBe(false);
  });
});

describe('the check: a quick look (nothing read in full; the removal reads all three)', () => {
  it('offers a file that is on the phone and has a checked copy on the T7, the Seagate and in Google; one phone listing, no file read', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.make('IMG_20240101_000002.jpg', 4 * KB);
    const { view } = await check();
    expect(view.blocked).toEqual([]);
    expect(view.readyFiles).toBe(2);
    expect(view.groups).toEqual([{ id: 'camera-photos', label: 'Camera photos', files: 2, bytes: 7 * KB }]);
    expect(w.adb.listCalls).toEqual([['/sdcard/DCIM/Camera']]);
    expect(w.adb.batches).toHaveLength(0);
    expect(w.adb.shaCalls).toBe(0);
    expect(w.reads).toEqual([]);
    expect(w.adb.killed).toBe(1);
    expect(view.places).toEqual(['T7', 'Seagate2TB', 'Google']);
  });

  it("finds Google's copy by the drive copy's checksum when the phone's own row has none (real phone rows are not hashed)", async () => {
    w.make('VID_20260817_102914.mp4', 6 * KB, { remote: '/sdcard/DCIM/Camera/VID_20260817_102914.mp4', phoneSha: false });
    const { view } = await check();
    expect(view.blocked).toEqual([]);
    expect(view.notReady.files).toBe(0);
    expect(view.readyFiles).toBe(1);
  });

  it('puts the kinds in the agreed order: videos first (biggest first), then WhatsApp videos, screenshots and photos', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.make('Screenshot_1.png', 2 * KB, { remote: '/sdcard/Pictures/Screenshots/Screenshot_1.png' });
    w.make('IMG-20240101-WA0001.jpg', 4 * KB, { remote: '/sdcard/WhatsApp/Media/WhatsApp Images/IMG-20240101-WA0001.jpg' });
    w.make('VID-20240101-WA0001.mp4', 9 * KB, { remote: '/sdcard/WhatsApp/Media/WhatsApp Video/VID-20240101-WA0001.mp4' });
    w.make('VID_20240101_000001.mp4', 6 * KB);
    w.make('VID_20240101_000002.mp4', 8 * KB);
    const { view } = await check();
    expect(readyPaths().map((p) => p.slice(p.lastIndexOf('/') + 1))).toEqual(['VID_20240101_000002.mp4', 'VID_20240101_000001.mp4', 'VID-20240101-WA0001.mp4', 'Screenshot_1.png', 'IMG_20240101_000001.jpg', 'IMG-20240101-WA0001.jpg']);
    expect(view.groups.map((g) => g.id)).toEqual(['camera-videos', 'whatsapp-videos', 'screenshots', 'camera-photos', 'whatsapp-photos']);
  });

  it('a missing copy blocks the file and says which one is missing (each of the three)', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB, { t7: 'none' });
    w.make('IMG_20240101_000002.jpg', 3 * KB, { sea: 'none' });
    w.make('IMG_20240101_000003.jpg', 3 * KB, { google: 'none' });
    w.make('IMG_20240101_000004.jpg', 3 * KB, { sea: 'none', google: 'none' });
    w.make('IMG_20240101_000005.jpg', 3 * KB);
    const { view } = await check();
    expect(readyPaths()).toEqual(['/sdcard/DCIM/Camera/IMG_20240101_000005.jpg']);
    expect(notReadyOf('IMG_20240101_000001.jpg')).toEqual(['No copy on T7']);
    expect(notReadyOf('IMG_20240101_000002.jpg')).toEqual(['No copy on Seagate2TB']);
    expect(notReadyOf('IMG_20240101_000003.jpg')).toEqual(['No checked copy in Google']);
    expect(notReadyOf('IMG_20240101_000004.jpg')).toEqual(['No copy on Seagate2TB', 'No checked copy in Google']);
    expect(view.notReady.files).toBe(4);
    expect(view.notReady.reasons.find((r) => r.what === 'No copy on Seagate2TB')?.files).toBe(2);
    expect(w.reads).toEqual([]);
  });

  it('imported, name-and-size and unchecked copies never count', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB, { t7: 'imported' });
    w.make('IMG_20240101_000002.jpg', 3 * KB, { sea: 'namesize' });
    w.make('IMG_20240101_000003.jpg', 3 * KB, { google: 'unverified' });
    const { view } = await check();
    expect(view.readyFiles).toBe(0);
    // An imported copy has no link to the phone row (and the phone row no checksum), so it is not found at all.
    expect(notReadyOf('IMG_20240101_000001.jpg')).toEqual(['No copy on T7']);
    expect(notReadyOf('IMG_20240101_000002.jpg')).toEqual(['The copy on Seagate2TB is not checked yet']);
    expect(notReadyOf('IMG_20240101_000003.jpg')).toEqual(['No checked copy in Google']);
  });

  it('a file that changed on the phone after the backup is not offered', async () => {
    const m = w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.make('IMG_20240101_000002.jpg', 3 * KB);
    fs.writeFileSync(w.adb.local(m.remote), Buffer.from('edited on the phone since the backup'));
    await check();
    expect(readyPaths()).toEqual(['/sdcard/DCIM/Camera/IMG_20240101_000002.jpg']);
    expect(notReadyOf('IMG_20240101_000001.jpg')).toEqual(['It changed on the phone after the backup']);
  });

  it('a drive copy that is gone or has another size is not offered; a same-size damaged copy is left to the removal, which reads it', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const b = w.make('IMG_20240101_000002.jpg', 3 * KB);
    const bytes = Buffer.from(a.data);
    bytes[0] = (bytes[0]! + 1) % 256;
    fs.writeFileSync(a.seaAbs, bytes);
    fs.rmSync(b.t7Abs);
    const c = w.make('IMG_20240101_000003.jpg', 3 * KB);
    fs.writeFileSync(c.seaAbs, Buffer.from('short'));
    await check();
    expect(readyPaths()).toEqual([a.remote]);
    expect(notReadyOf('IMG_20240101_000002.jpg')).toEqual(['The copy on T7 is not on the drive']);
    expect(notReadyOf('IMG_20240101_000003.jpg')).toEqual(['The copy on Seagate2TB has another size now']);
  });

  it('a file that is not on the phone any more is not offered', async () => {
    const m = w.make('IMG_20240101_000001.jpg', 3 * KB);
    fs.rmSync(w.adb.local(m.remote));
    await check();
    expect(notReadyOf('IMG_20240101_000001.jpg')).toEqual(['It is not on the phone any more']);
  });

  it('with the T7 or the Seagate unplugged, nothing is offered and the screen says what is missing', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.plugged.t7 = false;
    let r = await check();
    expect(r.view.blocked).toEqual(['T7 is not plugged in.']);
    expect(r.view.groups).toEqual([]);
    expect(r.view.readyFiles).toBe(0);
    expect(r.message).toMatch(/Nothing can be offered/);
    expect(w.results.get(11)!.ready).toEqual([]);
    w.plugged = { t7: true, sea: false };
    r = await check();
    expect(r.view.blocked).toEqual(['Seagate2TB is not plugged in.']);
    w.plugged = { t7: false, sea: false };
    r = await check();
    expect(r.view.blocked).toHaveLength(2);
    expect(w.reads).toEqual([]);
  });

  it('with Google out of reach, nothing is offered and the screen says so', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.googleDown = true;
    const r = await check();
    expect(r.view.blocked.join(' ')).toMatch(/Google cannot be reached/);
    expect(r.view.readyFiles).toBe(0);
    expect(w.reads).toEqual([]);
  });

  it('with Google gone down while the files are being checked, nothing is offered', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.make('IMG_20240101_000002.jpg', 3 * KB);
    const list = w.adb.listFiles.bind(w.adb);
    w.adb.listFiles = (...args) => {
      w.googleDown = true; // after the first reach test, before the files are asked
      return list(...args);
    };
    const r = await check();
    expect(r.view.blocked.join(' ')).toMatch(/Google could not be asked/);
    expect(r.view.readyFiles).toBe(0);
    expect(r.view.groups).toEqual([]);
    expect(w.results.get(11)!.notReady.every((n) => n.missing.includes('Google could not be asked'))).toBe(true);
  });

  it("Google's own answer counts: its MD5 must be the MD5 of the T7 copy, and the file must still be there", async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const b = w.make('IMG_20240101_000002.jpg', 3 * KB);
    const c = w.make('IMG_20240101_000003.jpg', 3 * KB);
    w.make('IMG_20240101_000004.jpg', 3 * KB);
    w.account.put({ id: a.googleId, md5Checksum: 'f'.repeat(32) }); // Google now says another checksum
    w.account.remove(b.googleId); // gone from Google
    w.account.put({ id: c.googleId, size: '9' }); // another size
    await check();
    expect(readyPaths()).toEqual(['/sdcard/DCIM/Camera/IMG_20240101_000004.jpg']);
    expect(notReadyOf('IMG_20240101_000001.jpg')).toEqual(['Google says its copy is different']);
    expect(notReadyOf('IMG_20240101_000002.jpg')).toEqual(['Google does not have the copy any more']);
    expect(notReadyOf('IMG_20240101_000003.jpg')).toEqual(['Google says its copy is different']);
  });

  it("Google's MD5 now must equal the MD5 the index holds for its copy (proved against the T7 when it was sent)", async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.db.prepare("UPDATE files SET md5 = ? WHERE place_id = 'g1' AND ext_id = ?").run('0'.repeat(32), a.googleId);
    await check();
    expect(notReadyOf('IMG_20240101_000001.jpg')).toEqual(['Google says its copy is different']);
  });

  it('never offers documents, downloads, audio, archives, Android folders or WhatsApp databases, even with three copies; counts what that keeps locked', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.make('report.pdf', 5 * KB, { remote: '/sdcard/Documents/report.pdf' });
    w.make('setup.zip', 6 * KB, { remote: '/sdcard/Download/setup.zip' });
    w.make('song.mp3', 7 * KB, { remote: '/sdcard/Music/song.mp3' });
    w.make('IMG_1.jpg', 8 * KB, { remote: '/sdcard/Android/media/com.x/IMG_1.jpg' });
    w.make('msgstore.jpg', 9 * KB, { remote: '/sdcard/WhatsApp/Databases/msgstore.jpg' });
    w.make('chat.mp4', 10 * KB, { remote: '/sdcard/WhatsApp/Backups/chat.mp4' });
    const { view } = await check();
    expect(readyPaths()).toEqual(['/sdcard/DCIM/Camera/IMG_20240101_000001.jpg']);
    expect(view.locked.otherFiles).toBe(6);
    expect(view.locked.otherBytes).toBe((5 + 6 + 7 + 8 + 9 + 10) * KB);
  });

  it('Keep on the phone: a file or a folder is never offered; the screen counts the space it keeps', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.make('IMG_20240101_000002.jpg', 4 * KB);
    w.make('a.jpg', 5 * KB, { remote: '/sdcard/Pictures/Family/a.jpg' });
    w.make('b.jpg', 6 * KB, { remote: '/sdcard/Pictures/Family/Trip/b.jpg' });
    const keep = new KeepStore(w.db);
    expect(keep.add(w.backupId, 'file', '/sdcard/DCIM/Camera/IMG_20240101_000001.jpg')).toBe(true);
    expect(keep.add(w.backupId, 'folder', '/sdcard/Pictures/Family/')).toBe(true);
    expect(keep.add(w.backupId, 'folder', "/sdcard/it's")).toBe(false);
    const { view } = await check();
    expect(readyPaths()).toEqual(['/sdcard/DCIM/Camera/IMG_20240101_000002.jpg']);
    expect(view.locked.keepFiles).toBe(3);
    expect(view.locked.keepBytes).toBe((3 + 5 + 6) * KB);
  });

  it("a kind left out of Google is never offered, and the screen counts the space it keeps locked", async () => {
    w.make('VID_20240101_000001.mp4', 8 * KB);
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.db.prepare("INSERT INTO backup_rules (backup_id, scope, pattern, choice, destination, created_at) VALUES (?, 'pattern', 'kind:video-camera', 'leave_out', 'google', 1)").run(w.backupId);
    const { view } = await check();
    expect(readyPaths()).toEqual(['/sdcard/DCIM/Camera/IMG_20240101_000001.jpg']);
    expect(view.locked.googleKinds).toEqual([{ label: 'Camera videos', files: 1, bytes: 8 * KB }]);
  });

  it('stopping the check keeps no result', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.make('IMG_20240101_000002.jpg', 3 * KB);
    const { ctx } = ctxFor({ backupId: w.backupId }, { jobId: 11, abortAfterYields: 3 });
    await expect(freeUpCheckHandler(w.deps()).run(ctx)).rejects.toBeInstanceOf(JobAborted);
    expect(w.results.get(11)).toBeNull();
    expect(w.adb.killed).toBe(1);
  });

  it('a phone that is not connected stops the check with a plain message', async () => {
    w.adb.devicesList = [];
    const { ctx } = ctxFor({ backupId: w.backupId }, { jobId: 11 });
    await expect(freeUpCheckHandler(w.deps()).run(ctx)).rejects.toThrow(/not connected or not unlocked/);
  });

  it('works with the real unbuffered read of a drive file too', async () => {
    w.make('IMG_20240101_000001.jpg', 5 * KB);
    const { ctx } = ctxFor({ backupId: w.backupId }, { jobId: 11 });
    const deps = w.deps();
    delete (deps as { hashFile?: unknown }).hashFile;
    await freeUpCheckHandler(deps).run(ctx);
    expect(w.results.get(11)!.ready).toHaveLength(1);
  });
});

describe('the check: what it did (steps and mode)', () => {
  it('quick is the default, and says per step how many files passed and how many did not', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    const b = w.make('IMG_20240101_000002.jpg', 3 * KB);
    const c = w.make('IMG_20240101_000003.jpg', 3 * KB);
    w.make('IMG_20240101_000004.jpg', 3 * KB);
    fs.writeFileSync(w.adb.local(b.remote), Buffer.from('edited on the phone since the backup'));
    w.account.put({ id: c.googleId, md5Checksum: 'f'.repeat(32) });
    const { view, message } = await check();
    expect(view.mode).toBe('quick');
    expect(message).toMatch(/^Quick check: 2 files/);
    expect(view.steps).toEqual([
      { what: 'Phone: file still there with the same size and date as at the backup', passed: 3, failed: 1 },
      { what: 'T7: copy there at the right size (its checksum was proved when it was copied)', passed: 3, failed: 0 },
      { what: 'Seagate2TB: copy there at the right size (its checksum was proved when it was copied)', passed: 3, failed: 0 },
      { what: 'T7 and Seagate2TB copies have the same checksum', passed: 3, failed: 0 },
      { what: 'Google: asked now, its checksum and size match', passed: 2, failed: 1 },
    ]);
  });

  it('a drive copy that is gone counts as a failed step for that drive only', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.make('IMG_20240101_000002.jpg', 3 * KB);
    fs.rmSync(a.seaAbs);
    const { view } = await check({ mode: 'quick' });
    expect(view.steps.map((s) => [s.passed, s.failed])).toEqual([[2, 0], [2, 0], [1, 1], [1, 0], [1, 0]]);
  });
});

describe('the full check: every file read (the phone, both drives), Google against the T7 read', () => {
  it('reads the phone in one batch and both drive copies in full; the T7 read also gives the MD5', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    const b = w.make('IMG_20240101_000002.jpg', 4 * KB);
    const { view, message } = await check({ mode: 'full' });
    expect(view.mode).toBe('full');
    expect(message).toMatch(/^Full check: 2 files/);
    expect(view.blocked).toEqual([]);
    expect(view.readyFiles).toBe(2);
    expect(w.adb.batches).toEqual([['/sdcard/DCIM/Camera/IMG_20240101_000002.jpg', '/sdcard/DCIM/Camera/IMG_20240101_000001.jpg']]);
    expect(w.adb.listCalls).toEqual([]);
    expect(w.reads.toSorted()).toEqual([a1(), b.t7Abs, b.seaAbs, a2()].toSorted());
    expect(w.results.get(11)!.ready[0]!.sha256).toBe(sha(b.data));
    expect(view.steps).toEqual([
      { what: 'Phone: checksum read on the phone now', passed: 2, failed: 0 },
      { what: 'T7: read in full now, same checksum as the phone', passed: 2, failed: 0 },
      { what: 'Seagate2TB: read in full now, same checksum as the phone', passed: 2, failed: 0 },
      { what: 'Google: asked now, its checksum matches the T7 copy just read', passed: 2, failed: 0 },
    ]);
    function a1(): string {
      return path.join(w.t7, 'MyData', 'POCO', 'DCIM', 'Camera', 'IMG_20240101_000001.jpg');
    }
    function a2(): string {
      return path.join(w.sea, 'MyData', 'POCO', 'DCIM', 'Camera', 'IMG_20240101_000001.jpg');
    }
  });

  it('a file changed on the phone with the SAME size and date is caught by the phone checksum', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.make('IMG_20240101_000002.jpg', 3 * KB);
    const edited = Buffer.from(a.data);
    edited[0] = (edited[0]! + 1) % 256;
    fs.writeFileSync(w.adb.local(a.remote), edited);
    fs.utimesSync(w.adb.local(a.remote), 1_700_000_000, 1_700_000_000);
    await check({ mode: 'full' });
    expect(readyPaths()).toEqual(['/sdcard/DCIM/Camera/IMG_20240101_000002.jpg']);
    expect(notReadyOf('IMG_20240101_000001.jpg')).toEqual(["The phone's file is different from the copy on T7", "The phone's file is different from the copy on Seagate2TB"]);
  });

  it('a same-size damaged copy on a drive is caught (the quick check cannot see it)', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const bytes = Buffer.from(a.data);
    bytes[0] = (bytes[0]! + 1) % 256;
    fs.writeFileSync(a.seaAbs, bytes);
    await check({ mode: 'full' });
    expect(readyPaths()).toEqual([]);
    expect(notReadyOf('IMG_20240101_000001.jpg')).toEqual(["The phone's file is different from the copy on Seagate2TB"]);
  });

  it('a drive copy that is gone or has another size is not offered', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const b = w.make('IMG_20240101_000002.jpg', 3 * KB);
    fs.rmSync(a.t7Abs);
    fs.writeFileSync(b.seaAbs, Buffer.from('short'));
    await check({ mode: 'full' });
    expect(readyPaths()).toEqual([]);
    expect(notReadyOf('IMG_20240101_000001.jpg').join(' ')).toMatch(/T7 could not be read|T7 is not plugged in/);
    expect(notReadyOf('IMG_20240101_000002.jpg')).toEqual(['The copy on Seagate2TB has another size now']);
  });

  it("the index's Google MD5 must equal the T7 MD5 read now; Google's own answer must match it and the size; a gone file is not offered", async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const b = w.make('IMG_20240101_000002.jpg', 3 * KB);
    const c = w.make('IMG_20240101_000003.jpg', 3 * KB);
    const d = w.make('IMG_20240101_000004.jpg', 3 * KB);
    w.make('IMG_20240101_000005.jpg', 3 * KB);
    fs.rmSync(w.adb.local(d.remote));
    w.db.prepare("UPDATE files SET md5 = ? WHERE place_id = 'g1' AND ext_id = ?").run('0'.repeat(32), a.googleId);
    w.account.put({ id: b.googleId, md5Checksum: 'f'.repeat(32) });
    w.account.remove(c.googleId);
    const { view } = await check({ mode: 'full' });
    expect(readyPaths()).toEqual(['/sdcard/DCIM/Camera/IMG_20240101_000005.jpg']);
    expect(notReadyOf('IMG_20240101_000001.jpg')).toEqual(['The copy in Google is not the same as the copy on T7']);
    expect(notReadyOf('IMG_20240101_000002.jpg')).toEqual(['Google says its copy is different']);
    expect(notReadyOf('IMG_20240101_000003.jpg')).toEqual(['Google does not have the copy any more']);
    expect(notReadyOf('IMG_20240101_000004.jpg')).toEqual(['It is not on the phone any more']);
    expect(view.steps[3]).toMatchObject({ passed: 1, failed: 3 });
  });

  it('puts the phone first in a batch: the biggest videos are read first', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.make('VID_20240101_000001.mp4', 9 * KB);
    await check({ mode: 'full' });
    expect(readyPaths()).toEqual(['/sdcard/DCIM/Camera/VID_20240101_000001.mp4', '/sdcard/DCIM/Camera/IMG_20240101_000001.jpg']);
  });

  it('with Google gone down while the files are read, nothing is offered and the Google step counts them as not passed', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.make('IMG_20240101_000002.jpg', 3 * KB);
    const batch = w.adb.sha256Many.bind(w.adb);
    w.adb.sha256Many = (...args) => {
      w.googleDown = true;
      return batch(...args);
    };
    const { view } = await check({ mode: 'full' });
    expect(view.blocked.join(' ')).toMatch(/Google could not be asked/);
    expect(view.readyFiles).toBe(0);
    expect(view.steps[3]).toEqual({ what: expect.any(String), passed: 0, failed: 2 });
  });

  it('with a drive unplugged nothing is read and nothing is offered', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.plugged.sea = false;
    const { view } = await check({ mode: 'full' });
    expect(view.blocked).toEqual(['Seagate2TB is not plugged in.']);
    expect(w.reads).toEqual([]);
    expect(w.adb.batches).toEqual([]);
  });
});

// ---- the removal --------------------------------------------------------------------------------------------------------------------

interface Prepared {
  svc: FreeUpService;
  created: { kind: string; params: unknown }[];
}

function service(): Prepared {
  const created: Prepared['created'] = [];
  const svc = new FreeUpService({
    db: w.db,
    results: w.results,
    jobs: {
      create: (kind, _t, params) => {
        created.push({ kind, params });
        return 100 + created.length;
      },
      list: () => [],
    },
    putBack: () => ({ ok: true, jobId: 999 }),
  });
  return { svc, created };
}

/** Check, tick the groups, confirm, and run the removal job the way the app would. */
async function removeAll(groups: string[] = [...FREEUP_GROUPS], hooks: { afterPrepare?: () => void } = {}, removeMode?: 'quick' | 'full'): Promise<{ run: ReturnType<typeof ctxFor>; message: string | Error; params: FreeUpRemoveJobParams }> {
  await check();
  const { svc, created } = service();
  const prep = svc.prepare({ checkId: 11, groups });
  if (!prep.ok) throw new Error(prep.message);
  hooks.afterPrepare?.();
  const started = svc.start({ checkId: 11, groups, hash: prep.prepare.hash, expectFiles: prep.prepare.files, expectBytes: prep.prepare.bytes, confirmed: true, ...(removeMode ? { removeMode } : {}) });
  if (!started.ok) throw new Error(started.message);
  const params = created[0]!.params as FreeUpRemoveJobParams;
  const run = ctxFor(params, { jobId: 21 });
  let message: string | Error;
  try {
    message = (await freeUpRemoveHandler(w.deps()).run(run.ctx)) as string;
  } catch (err) {
    message = err as Error;
  }
  return { run, message, params };
}

describe('the removal', () => {
  it('removes the confirmed files through the guarded path, logs each one, locks the copies, refreshes the gallery and says so', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const b = w.make('VID_20240101_000001.mp4', 5 * KB);
    const keepOnPhone = w.make('IMG_20240101_000009.jpg', 3 * KB, { google: 'none' });
    const r = await removeAll();
    expect(r.message).toMatch(/Removed 2 files/);
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(false);
    expect(fs.existsSync(w.adb.local(b.remote))).toBe(false);
    expect(fs.existsSync(w.adb.local(keepOnPhone.remote))).toBe(true);
    expect(w.adb.removed).toEqual([b.remote, a.remote]);
    // The copies are untouched.
    for (const m of [a, b]) {
      expect(fs.existsSync(m.t7Abs)).toBe(true);
      expect(fs.existsSync(m.seaAbs)).toBe(true);
    }
    // danger_log: one 'done' adb-rm row per file with three proofs; removal_log and locks written.
    const danger = w.db.prepare("SELECT action, outcome, target, proof_json FROM danger_log WHERE list_id LIKE 'freeup-%' ORDER BY id").all() as { action: string; outcome: string; target: string; proof_json: string }[];
    expect(danger.map((d) => [d.action, d.outcome])).toEqual([
      ['adb-rm', 'done'],
      ['adb-rm', 'done'],
    ]);
    expect(JSON.parse(danger[0]!.proof_json)).toHaveLength(3);
    const log = w.db.prepare("SELECT path, device, vouchers_json FROM removal_log WHERE kind = 'phone' ORDER BY id").all() as { path: string; device: string; vouchers_json: string }[];
    expect(log.map((l) => l.path)).toEqual([b.remote, a.remote]);
    expect(log[0]!.device).toBe('POCO F4');
    expect((JSON.parse(log[0]!.vouchers_json) as { placeLabel: string }[]).map((v) => v.placeLabel)).toEqual(['T7', 'Seagate2TB', 'Google']);
    expect(w.db.prepare('SELECT count(*) FROM clean_locks').pluck().get()).toBe(6);
    // The gallery was asked, once for the removed paths; the phone rows say why they are gone.
    expect(w.adb.scanned.toSorted()).toEqual([a.remote, b.remote].toSorted());
    expect(w.db.prepare("SELECT gone_reason FROM files WHERE place_id = 'ph' AND rel_path = ?").pluck().get(a.remote.slice(1))).toBe('phone_cleaned'); // the index keeps phone rows without the leading slash
    expect(w.adb.killed).toBeGreaterThanOrEqual(2);
  });

  it('only the ticked groups go', async () => {
    const photo = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const video = w.make('VID_20240101_000001.mp4', 5 * KB);
    const r = await removeAll(['camera-videos']);
    expect(r.message).toMatch(/Removed 1 file /);
    expect(fs.existsSync(w.adb.local(video.remote))).toBe(false);
    expect(fs.existsSync(w.adb.local(photo.remote))).toBe(true);
  });

  it('re-checks the phone right before the removal: a file that changed after the check is skipped and stays', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const b = w.make('IMG_20240101_000002.jpg', 3 * KB);
    const r = await removeAll(undefined, {
      afterPrepare: () => fs.writeFileSync(w.adb.local(a.remote), Buffer.from('changed after the check, same place')),
    });
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(true);
    expect(fs.existsSync(w.adb.local(b.remote))).toBe(false);
    expect(r.run.warns.join(' ')).toMatch(/IMG_20240101_000001.jpg: skipped/);
    expect(w.adb.removed).toEqual([b.remote]);
  });

  it('a file that changes on the phone WHILE its copies are re-read is caught by the last phone read before the remove command', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    await check();
    const { svc, created } = service();
    const prep = svc.prepare({ checkId: 11, groups: [...FREEUP_GROUPS] });
    if (!prep.ok) throw new Error(prep.message);
    svc.start({ checkId: 11, groups: [...FREEUP_GROUPS], hash: prep.prepare.hash, expectFiles: 1, expectBytes: 3 * KB, confirmed: true });
    // The change happens during the drive read the guarded path does first.
    w.onRead = () => fs.writeFileSync(w.adb.local(a.remote), Buffer.from('written during the read of the drive copy!'));
    const run = ctxFor(created[0]!.params, { jobId: 21 });
    await expect(freeUpRemoveHandler(w.deps()).run(run.ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(true);
    expect(w.adb.removed).toEqual([]);
    expect(run.warns.join(' ')).toMatch(/changed on the phone just before the removal/);
    expect(w.db.prepare("SELECT count(*) FROM removal_log WHERE kind = 'phone'").pluck().get()).toBe(0);
    expect(w.db.prepare("SELECT outcome FROM danger_log WHERE list_id LIKE 'freeup-%'").pluck().get()).toBe('failed');
  });

  it('a drive copy that went bad after the check refuses the removal (all three are read fresh)', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const r = await removeAll(undefined, { afterPrepare: () => fs.writeFileSync(a.seaAbs, Buffer.from('damaged in between')) });
    expect(r.message).toBeInstanceOf(JobFailure);
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(true);
    expect(w.db.prepare("SELECT outcome FROM danger_log WHERE list_id LIKE 'freeup-%'").pluck().get()).toBe('refused');
    expect(w.db.prepare("SELECT count(*) FROM removal_log WHERE kind = 'phone'").pluck().get()).toBe(0);
  });

  it("Google's copy changing after the check refuses the removal", async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const r = await removeAll(undefined, { afterPrepare: () => w.account.put({ id: a.googleId, md5Checksum: 'e'.repeat(32) }) });
    expect(r.message).toBeInstanceOf(JobFailure);
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(true);
    expect(w.db.prepare("SELECT outcome FROM danger_log WHERE list_id LIKE 'freeup-%'").pluck().get()).toBe('refused');
  });

  it('with Google unreachable at removal time nothing is removed', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const r = await removeAll(undefined, { afterPrepare: () => void (w.googleDown = true) });
    expect(r.message).toBeInstanceOf(JobFailure);
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(true);
  });

  it('a Keep rule saved after the check leaves the file out of the removal', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const b = w.make('IMG_20240101_000002.jpg', 3 * KB);
    await check();
    const { svc, created } = service();
    const prep = svc.prepare({ checkId: 11, groups: [...FREEUP_GROUPS] });
    if (!prep.ok) throw new Error(prep.message);
    svc.start({ checkId: 11, groups: [...FREEUP_GROUPS], hash: prep.prepare.hash, expectFiles: 2, expectBytes: 6 * KB, confirmed: true });
    new KeepStore(w.db).add(w.backupId, 'file', a.remote); // saved after the list was confirmed
    const run = ctxFor(created[0]!.params, { jobId: 21 });
    await freeUpRemoveHandler(w.deps()).run(run.ctx);
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(true);
    expect(fs.existsSync(w.adb.local(b.remote))).toBe(false);
    expect(run.warns.join(' ')).toMatch(/Keep on the phone/);
  });

  it('the gallery refresh failing removes nothing and only warns', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.adb.failScan = true;
    const r = await removeAll();
    expect(r.message).toMatch(/Removed 1 file /);
    expect(r.run.warns.join(' ')).toMatch(/gallery on the phone could not be refreshed/);
  });

  it('a list that is not the confirmed one, or no longer kept, removes nothing', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    await check();
    const { svc, created } = service();
    const prep = svc.prepare({ checkId: 11, groups: [...FREEUP_GROUPS] });
    if (!prep.ok) throw new Error(prep.message);
    svc.start({ checkId: 11, groups: [...FREEUP_GROUPS], hash: prep.prepare.hash, expectFiles: 1, expectBytes: 3 * KB, confirmed: true });
    const params = created[0]!.params as FreeUpRemoveJobParams;
    await expect(freeUpRemoveHandler(w.deps()).run(ctxFor({ ...params, listHash: 'a'.repeat(64) }).ctx)).rejects.toThrow(/not the one that was confirmed/);
    // The list was taken by the first run; a second run has nothing.
    await expect(freeUpRemoveHandler(w.deps()).run(ctxFor(params).ctx)).rejects.toThrow(/not kept any more/);
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(true);
  });

  it('the removal mode is full unless the person chose quick, and the message and the log say which', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    const r = await removeAll();
    expect((r.params as FreeUpRemoveJobParams).removeMode).toBe('full');
    expect(r.message).toMatch(/Removed 1 file \(.*every file read in full again/);
    expect(r.run.logs.join(' ')).toMatch(/read in full on T7, Seagate2TB, Google/);
  });
});

describe('the removal, quick mode (nothing is read again: copies there at their size, Google asked, the phone size)', () => {
  it('removes a file whose three copies are there; no drive file is read and the phone checksum is not read again', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    await check();
    const reads = w.reads.length;
    const shaBefore = w.adb.batches.length + w.adb.shaCalls;
    const r = await removeAll(undefined, {}, 'quick');
    expect((r.params as FreeUpRemoveJobParams).removeMode).toBe('quick');
    expect(r.message).toMatch(/Removed 1 file \(.*checked quickly/);
    expect(r.run.logs.join(' ')).toMatch(/checked quickly: copies there at their size on T7, Seagate2TB, Google/);
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(false);
    expect(w.reads.length).toBe(reads);
    expect(w.adb.batches.length + w.adb.shaCalls).toBe(shaBefore);
    expect(w.db.prepare("SELECT outcome FROM danger_log WHERE list_id LIKE 'freeup-%'").pluck().get()).toBe('done');
    expect(w.db.prepare("SELECT count(*) FROM removal_log WHERE kind = 'phone'").pluck().get()).toBe(1);
    expect(w.db.prepare('SELECT count(*) FROM clean_locks').pluck().get()).toBe(3);
  });

  it('DOCUMENTED: a same-size damaged drive copy, or a same-size change on the phone, is NOT seen in quick mode and the file is removed (full mode refuses it)', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const b = w.make('IMG_20240101_000002.jpg', 3 * KB);
    const r = await removeAll(undefined, {
      afterPrepare: () => {
        fs.writeFileSync(a.seaAbs, Buffer.alloc(3 * KB, 7)); // same size, other bytes
        fs.writeFileSync(w.adb.local(b.remote), Buffer.alloc(3 * KB, 9)); // same size, other bytes
      },
    }, 'quick');
    expect(r.message).toMatch(/Removed 2 files/);
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(false);
    expect(fs.existsSync(w.adb.local(b.remote))).toBe(false);
  });

  it('a drive copy that is gone refuses the file', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const r = await removeAll(undefined, { afterPrepare: () => fs.rmSync(a.t7Abs) }, 'quick');
    expect(r.message).toBeInstanceOf(JobFailure);
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(true);
    expect(w.db.prepare("SELECT outcome FROM danger_log WHERE list_id LIKE 'freeup-%'").pluck().get()).toBe('refused');
    expect(w.db.prepare("SELECT count(*) FROM removal_log WHERE kind = 'phone'").pluck().get()).toBe(0);
  });

  it('a drive copy with another size refuses the file', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const r = await removeAll(undefined, { afterPrepare: () => fs.writeFileSync(a.seaAbs, Buffer.from('short')) }, 'quick');
    expect(r.message).toBeInstanceOf(JobFailure);
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(true);
  });

  it('Google saying something different, or not having the file, refuses it', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const b = w.make('IMG_20240101_000002.jpg', 3 * KB);
    const c = w.make('IMG_20240101_000003.jpg', 3 * KB);
    const r = await removeAll(undefined, {
      afterPrepare: () => {
        w.account.put({ id: a.googleId, md5Checksum: 'e'.repeat(32) });
        w.account.put({ id: b.googleId, size: '9' });
        w.account.remove(c.googleId);
      },
    }, 'quick');
    expect(r.message).toBeInstanceOf(JobFailure);
    for (const m of [a, b, c]) expect(fs.existsSync(w.adb.local(m.remote))).toBe(true);
    expect(w.adb.removed).toEqual([]);
  });

  it('a phone file whose size changed refuses that file only', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const b = w.make('IMG_20240101_000002.jpg', 3 * KB);
    const r = await removeAll(undefined, { afterPrepare: () => fs.writeFileSync(w.adb.local(a.remote), Buffer.from('another size')) }, 'quick');
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(true);
    expect(fs.existsSync(w.adb.local(b.remote))).toBe(false);
    expect(r.run.warns.join(' ')).toMatch(/IMG_20240101_000001.jpg: skipped \(its size on the phone changed\)/);
  });

  it('a size change between the guard and the remove command is caught by the last size look', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    await check();
    const { svc, created } = service();
    const prep = svc.prepare({ checkId: 11, groups: [...FREEUP_GROUPS] });
    if (!prep.ok) throw new Error(prep.message);
    svc.start({ checkId: 11, groups: [...FREEUP_GROUPS], hash: prep.prepare.hash, expectFiles: 1, expectBytes: 3 * KB, confirmed: true, removeMode: 'quick' });
    // The file grows after the guard has proved the copies, right before the phone's own size look that sits in front of its remove command.
    w.adb.beforeRemove = (remote) => {
      if (remote === a.remote) fs.writeFileSync(w.adb.local(a.remote), Buffer.from('grew while the copies were looked at'));
    };
    const run = ctxFor(created[0]!.params, { jobId: 21 });
    await expect(freeUpRemoveHandler(w.deps()).run(run.ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(w.adb.removed).toEqual([]);
    expect(run.warns.join(' ')).toMatch(/size changed on the phone just before the removal/);
  });

  /** Starts a removal of everything ready (the check was run) and runs the job with these deps; the job's yields are counted. */
  async function startAndRun(mode: 'quick' | 'full', files: number, over: Parameters<typeof w.deps>[0] = {}): Promise<{ yields: number; message: string; run: ReturnType<typeof ctxFor> }> {
    const { svc, created } = service();
    const prep = svc.prepare({ checkId: 11, groups: [...FREEUP_GROUPS] });
    if (!prep.ok) throw new Error(prep.message);
    const started = svc.start({ checkId: 11, groups: [...FREEUP_GROUPS], hash: prep.prepare.hash, expectFiles: files, expectBytes: prep.prepare.bytes, confirmed: true, removeMode: mode });
    if (!started.ok) throw new Error(started.message);
    const run = ctxFor(created[0]!.params, { jobId: 21 });
    let yields = 0;
    const yieldOnce = run.ctx.yield.bind(run.ctx);
    run.ctx.yield = () => ((yields += 1), yieldOnce());
    w.adb.adbCalls = [];
    const message = (await freeUpRemoveHandler(w.deps(over)).run(run.ctx)) as string;
    return { yields, message, run };
  }
  const NAMES = (n: number): string[] => Array.from({ length: n }, (_, k) => `IMG_20240101_${String(k + 1).padStart(6, '0')}.jpg`);

  it('quick: 60 files take well under one adb call per file (sizes, removes and the gallery go in batches), and every file still has its own proof and log rows', async () => {
    const made = NAMES(60).map((n, k) => w.make(n, 3 * KB + k));
    await check({ mode: 'quick' });
    const r = await startAndRun('quick', 60);
    expect(r.message).toMatch(/Removed 60 files/);
    for (const m of made) expect(fs.existsSync(w.adb.local(m.remote))).toBe(false);
    const calls = w.adb.adbCalls;
    expect(calls.filter((c) => c === 'statSize' || c === 'remove' || c === 'sha256' || c === 'sha256Many')).toEqual([]); // no per-file calls, quick reads nothing in full
    expect(calls.filter((c) => c === 'removeMany')).toHaveLength(3); // 25 + 25 + 10
    expect(calls.filter((c) => c === 'statSizes')).toHaveLength(3);
    expect(calls.filter((c) => c === 'scanMedia')).toHaveLength(3);
    console.log(`[free up remove, quick] 60 files, ${calls.length} adb calls (${(calls.length / 60).toFixed(2)} per file)`);
    expect(calls.length / 60).toBeLessThan(0.25);
    // The pause point is between batches, not between files.
    expect(r.yields).toBe(3);
    // Per file: a danger row with three proofs, a removal row, three locks; the gallery was asked for every removed path.
    const danger = w.db.prepare("SELECT outcome, proof_json FROM danger_log WHERE list_id LIKE 'freeup-%'").all() as { outcome: string; proof_json: string }[];
    expect(danger).toHaveLength(60);
    for (const d of danger) {
      expect(d.outcome).toBe('done');
      expect(JSON.parse(d.proof_json)).toHaveLength(3);
    }
    expect(w.db.prepare("SELECT count(*) FROM removal_log WHERE kind = 'phone'").pluck().get()).toBe(60);
    expect(w.db.prepare('SELECT count(*) FROM clean_locks').pluck().get()).toBe(180);
    expect(w.adb.scanned).toHaveLength(60);
  });

  it('a file whose size changes right before the batch remove is left alone; the others of the same batch go', async () => {
    const made = NAMES(5).map((n, k) => w.make(n, 3 * KB + k));
    await check({ mode: 'quick' });
    w.adb.beforeRemove = (remote) => {
      if (remote === made[2]!.remote) fs.writeFileSync(w.adb.local(remote), Buffer.from('another size, written just before the remove'));
    };
    const r = await startAndRun('quick', 5);
    expect(r.message).toMatch(/Removed 4 files/);
    expect(w.adb.adbCalls.filter((c) => c === 'removeMany')).toHaveLength(1);
    expect(fs.existsSync(w.adb.local(made[2]!.remote))).toBe(true);
    for (const k of [0, 1, 3, 4]) expect(fs.existsSync(w.adb.local(made[k]!.remote))).toBe(false);
    expect(r.run.warns.join(' ')).toMatch(/IMG_20240101_000003.jpg: skipped \(its size changed on the phone just before the removal/);
    expect(w.db.prepare("SELECT count(*) FROM removal_log WHERE kind = 'phone'").pluck().get()).toBe(4); // the left-alone file has no removal row
    expect(w.db.prepare("SELECT count(*) FROM danger_log WHERE list_id LIKE 'freeup-%' AND outcome = 'failed'").pluck().get()).toBe(1);
  });

  it('Google is asked for several files at once (at most 6), each file still needs its own matching answer', async () => {
    const made = NAMES(14).map((n, k) => w.make(n, 3 * KB + k));
    await check({ mode: 'quick' });
    const real = w.google();
    let now = 0;
    let most = 0;
    const slow: typeof real = Object.assign(Object.create(real) as typeof real, {
      ask: async (...args: Parameters<typeof real.ask>) => {
        now += 1;
        most = Math.max(most, now);
        await new Promise((resolve) => setTimeout(resolve, 15));
        try {
          return await real.ask(...args);
        } finally {
          now -= 1;
        }
      },
    });
    w.account.put({ id: made[7]!.googleId, md5Checksum: 'e'.repeat(32) }); // Google says something else for one file: only that one stays
    const r = await startAndRun('quick', 14, { google: slow });
    expect(r.message).toMatch(/Removed 13 files/);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(6);
    expect(fs.existsSync(w.adb.local(made[7]!.remote))).toBe(true);
  });

  it('full: the batch is read in full on both drives, the phone checksum is read once more for the batch, then one remove call', async () => {
    const made = NAMES(8).map((n, k) => w.make(n, 3 * KB + k));
    await check({ mode: 'full' });
    const r = await startAndRun('full', 8);
    expect(r.message).toMatch(/Removed 8 files/);
    for (const m of made) expect(fs.existsSync(w.adb.local(m.remote))).toBe(false);
    const calls = w.adb.adbCalls;
    expect(calls.filter((c) => c === 'statSize' || c === 'remove' || c === 'sha256')).toEqual([]);
    expect(calls.filter((c) => c === 'removeMany')).toHaveLength(2); // 6 + 2 (a full batch is small: every file is read in full first)
    expect(calls.filter((c) => c === 'sha256Many')).toHaveLength(2); // the phone's own checksum, once per batch, right before its remove call
    expect(w.db.prepare("SELECT count(*) FROM removal_log WHERE kind = 'phone'").pluck().get()).toBe(8);
  });

  it('per-file ticks: Show files lists every file of the group biggest first in pages of 100; unticked files stay on the phone, the confirm numbers and the removal follow the ticks', async () => {
    const made = NAMES(105).map((n, k) => w.make(n, 3 * KB + k));
    await check({ mode: 'quick' });
    const { svc, created } = service();
    // All 105 files of the group, biggest first, 100 a page, all ticked.
    const p1 = svc.files({ checkId: 11, list: 'camera-photos', offset: 0 });
    const p2 = svc.files({ checkId: 11, list: 'camera-photos', offset: 100 });
    if (!p1.ok || !p2.ok) throw new Error('no page');
    expect([p1.total, p1.rows.length, p2.rows.length]).toEqual([105, 100, 5]);
    expect(p1.rows[0]!.size).toBe(3 * KB + 104);
    expect(p2.rows.at(-1)!.size).toBe(3 * KB);
    expect(p1.rows.every((r) => r.ticked === true)).toBe(true);
    // Untick two (one on each page) and nothing from another group or an unknown path.
    const stay = [p1.rows[0]!.path, p2.rows[4]!.path];
    expect(svc.tick({ checkId: 11, list: 'camera-photos', ticked: false, paths: [...stay, '/sdcard/nowhere.jpg'] })).toEqual({ ok: true, files: 103, bytes: 3 * KB * 103 + (104 * 105) / 2 - 104 - 0, leftOut: 2 });
    expect(svc.tick({ checkId: 11, list: 'camera-videos', ticked: false, paths: [stay[0]!] })).toMatchObject({ ok: true, files: 0, leftOut: 0 }); // not a file of that group: nothing happens
    const again = svc.files({ checkId: 11, list: 'camera-photos', offset: 0 });
    expect(again.ok && again.rows[0]!.ticked).toBe(false);
    const result = svc.result(11);
    expect(result.ok && result.result.groups[0]).toMatchObject({ id: 'camera-photos', files: 103, leftOutFiles: 2 });
    // The confirm numbers follow.
    const prep = svc.prepare({ checkId: 11, groups: [...FREEUP_GROUPS] });
    if (!prep.ok) throw new Error(prep.message);
    expect(prep.prepare.files).toBe(103);
    const started = svc.start({ checkId: 11, groups: [...FREEUP_GROUPS], hash: prep.prepare.hash, expectFiles: 103, expectBytes: prep.prepare.bytes, confirmed: true, removeMode: 'quick' });
    expect(started.ok).toBe(true);
    // A list made before the ticks changed is refused.
    expect(svc.start({ checkId: 11, groups: [...FREEUP_GROUPS], hash: prep.prepare.hash, expectFiles: 105, expectBytes: prep.prepare.bytes, confirmed: true }).ok).toBe(false);
    const run = ctxFor(created[0]!.params, { jobId: 21 });
    const message = (await freeUpRemoveHandler(w.deps()).run(run.ctx)) as string;
    expect(message).toMatch(/Removed 103 files/);
    for (const m of made) expect(fs.existsSync(w.adb.local(m.remote))).toBe(stay.includes(m.remote)); // the unticked two are still on the phone
    expect(w.db.prepare("SELECT count(*) FROM removal_log WHERE kind = 'phone'").pluck().get()).toBe(103);
  });

  it('per-file ticks: Untick all, Tick all, and a change of the ticks after prepare is caught by the hash', async () => {
    NAMES(6).forEach((n, k) => w.make(n, 3 * KB + k));
    await check({ mode: 'quick' });
    const { svc } = service();
    expect(svc.tick({ checkId: 11, list: 'camera-photos', ticked: false, all: true })).toEqual({ ok: true, files: 0, bytes: 0, leftOut: 6 });
    const none = svc.prepare({ checkId: 11, groups: ['camera-photos'] });
    expect(none).toMatchObject({ ok: false });
    expect(svc.tick({ checkId: 11, list: 'camera-photos', ticked: true, all: true })).toMatchObject({ ok: true, files: 6, leftOut: 0 });
    const prep = svc.prepare({ checkId: 11, groups: ['camera-photos'] });
    if (!prep.ok) throw new Error(prep.message);
    const page = svc.files({ checkId: 11, list: 'camera-photos', offset: 0 });
    if (!page.ok) throw new Error('no page');
    svc.tick({ checkId: 11, list: 'camera-photos', ticked: false, paths: [page.rows[0]!.path] });
    const refused = svc.start({ checkId: 11, groups: ['camera-photos'], hash: prep.prepare.hash, expectFiles: 6, expectBytes: prep.prepare.bytes, confirmed: true });
    expect(refused).toMatchObject({ ok: false });
    expect(svc.tick({ checkId: 99, list: 'camera-photos', ticked: true, all: true })).toMatchObject({ ok: false });
    expect(svc.tick({ checkId: 11, list: 'notAGroup', ticked: true, all: true })).toMatchObject({ ok: false });
    // "Keep on the phone" is a different thing: a kept file is never offered, ticked or not.
    svc.keep({ backupId: w.backupId, scope: 'file', path: page.rows[1]!.path });
    const after = svc.files({ checkId: 11, list: 'camera-photos', offset: 0 });
    expect(after.ok && after.total).toBe(5);
  });

  it('a Keep rule saved after the check still leaves the file out', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const b = w.make('IMG_20240101_000002.jpg', 3 * KB);
    await check();
    const { svc, created } = service();
    const prep = svc.prepare({ checkId: 11, groups: [...FREEUP_GROUPS] });
    if (!prep.ok) throw new Error(prep.message);
    svc.start({ checkId: 11, groups: [...FREEUP_GROUPS], hash: prep.prepare.hash, expectFiles: 2, expectBytes: 6 * KB, confirmed: true, removeMode: 'quick' });
    new KeepStore(w.db).add(w.backupId, 'file', a.remote);
    await freeUpRemoveHandler(w.deps()).run(ctxFor(created[0]!.params, { jobId: 21 }).ctx);
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(true);
    expect(fs.existsSync(w.adb.local(b.remote))).toBe(false);
  });

  it('a quick removal after a full check works', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const b = w.make('IMG_20240101_000002.jpg', 3 * KB);
    const r = await removeAllFrom('full', 'quick');
    expect(r.message).toMatch(/Removed 2 files/);
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(false);
    expect(fs.existsSync(w.adb.local(b.remote))).toBe(false);
  });

  async function removeAllFrom(checkMode: 'quick' | 'full', removeMode: 'quick' | 'full'): Promise<{ message: string | Error }> {
    await check({ mode: checkMode });
    const { svc, created } = service();
    const prep = svc.prepare({ checkId: 11, groups: [...FREEUP_GROUPS] });
    if (!prep.ok) throw new Error(prep.message);
    const started = svc.start({ checkId: 11, groups: [...FREEUP_GROUPS], hash: prep.prepare.hash, expectFiles: prep.prepare.files, expectBytes: prep.prepare.bytes, confirmed: true, removeMode });
    if (!started.ok) throw new Error(started.message);
    return { message: (await freeUpRemoveHandler(w.deps()).run(ctxFor(created[0]!.params, { jobId: 21 }).ctx)) as string };
  }

  it('a full removal after a quick check works too (the checksums the quick check kept are the drive copies)', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const r = await removeAllFrom('quick', 'full');
    expect(r.message).toMatch(/Removed 1 file /);
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(false);
  });
});

describe('the removal, extra', () => {
  it('Put back restores a removed file from the T7 to its old place and checks it on the phone', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    await removeAll();
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(false);
    const { svc } = service();
    const overview = await svc.overview(w.backupId);
    if (!overview.ok) throw new Error(overview.message);
    expect(overview.removedTotal).toEqual({ files: 1, bytes: 3 * KB });
    const page = await svc.removedPage({ backupId: w.backupId, offset: 0, limit: 100 });
    if (!page.ok) throw new Error(page.message);
    expect(page.rows.map((r) => r.path)).toEqual([a.remote]);
    expect(page.rows[0]!.takenSec).toBe(Math.floor(PHONE_MTIME_MS / 1000));
    const handler = putBackHandler({ db: w.db, log: silent, adb: w.adb, baseOf: w.baseOf, diskSize: diskSizeFor(w.db, w.baseOf) });
    const run = ctxFor({ serial: 'S1', removalIds: page.rows.map((r) => r.id) });
    await handler.run(run.ctx);
    expect(fs.existsSync(w.adb.local(a.remote))).toBe(true);
    expect(sha(fs.readFileSync(w.adb.local(a.remote)))).toBe(sha(a.data));
    expect(w.adb.pushed).toEqual([a.remote]);
    const again = await svc.overview(w.backupId);
    expect(again.ok && again.removedTotal).toEqual({ files: 0, bytes: 0 });
    expect(await svc.removedPage({ backupId: w.backupId, offset: 0, limit: 100 })).toMatchObject({ ok: true, total: 0, rows: [] });
  });

  /** A removal log line as the removal writes it: first voucher = the first drive's copy. */
  const logLine = (i: number, o: { place?: string; root?: string; undone?: boolean; kind?: string; size?: number } = {}): void => {
    const vouchers = [{ placeId: o.place ?? 't7', placeLabel: 'T7', placeKind: 'drive', relPath: `${o.root ?? ROOT}/DCIM/Camera/IMG_${i}.jpg`, size: 1, sha256: 'a', md5: null }];
    w.db.prepare('INSERT INTO removal_log (run_id, kind, place_id, device, path, size, sha256, vouchers_json, quarantine_path, removed_at, undone_at) VALUES (1, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?)').run(o.kind ?? 'phone', 'POCO F4', `/sdcard/DCIM/Camera/IMG_${i}.jpg`, o.size ?? 10, 'a'.repeat(64), JSON.stringify(vouchers), 1_700_000_000_000 + i * 1000, o.undone ? 5 : null);
  };

  it('the put-back list is paged newest first with the total and size; Tick all gets every id with its size; other backups, put-back and laptop lines are left out', async () => {
    for (let i = 1; i <= 250; i += 1) logLine(i, { size: i });
    logLine(900, { place: 'sea' }); // another place's first voucher
    logLine(901, { root: 'MyData/Other' }); // another backup's folder
    logLine(902, { undone: true }); // already put back
    logLine(903, { kind: 'laptop' });
    const { svc } = service();
    const first = await svc.removedPage({ backupId: w.backupId, offset: 0, limit: 100 });
    if (!first.ok) throw new Error(first.message);
    expect(first.total).toBe(250);
    expect(first.totalBytes).toBe((250 * 251) / 2);
    expect(first.rows).toHaveLength(100);
    expect(first.rows.map((r) => r.path.slice(r.path.lastIndexOf('_') + 1, -4)).slice(0, 2)).toEqual(['250', '249']);
    expect(first.rows[0]!.takenSec).toBe(0); // no phone row for this path: the window shows the removed date
    const last = await svc.removedPage({ backupId: w.backupId, offset: 200, limit: 100 });
    expect(last.ok && last.rows).toHaveLength(50);
    const big = await svc.removedPage({ backupId: w.backupId, offset: 0, limit: 5000 });
    expect(big.ok && big.rows).toHaveLength(100); // never more than a page
    const ids = await svc.removedIds({ backupId: w.backupId });
    if (!ids.ok) throw new Error(ids.message);
    expect(ids.total).toBe(250);
    expect(ids.ids).toHaveLength(250);
    expect(ids.sizes.reduce((n, s) => n + s, 0)).toBe(ids.totalBytes);
    expect(ids.ids.slice(0, 100)).toEqual(first.rows.map((r) => r.id));
    expect((await svc.removedPage({ backupId: w.backupId, offset: -1, limit: 10 })).ok).toBe(false);
    expect((await svc.removedPage({ backupId: 9999, offset: 0, limit: 10 })).ok).toBe(false);
    expect((await svc.removedIds({ backupId: 9999 })).ok).toBe(false);
  });

  it('Put back takes 422 ticked ids at once (and more than 5,000), checks each is a removed phone file, and refuses a put-back one', () => {
    for (let i = 1; i <= 422; i += 1) logLine(i);
    const ids = w.db.prepare('SELECT id FROM removal_log ORDER BY id').pluck().all() as number[];
    const created: { kind: string; params: unknown }[] = [];
    const jobs = { create: (kind: string, _t: string, params: unknown) => (created.push({ kind, params }), 8), list: () => [] };
    const cleanup = new CleanupService({ db: w.db, phone: {} as never, laptop: {} as never, jobs });
    const svc = new FreeUpService({ db: w.db, results: w.results, jobs, putBack: (request) => cleanup.putBack(request) });
    expect(svc.putBack({ backupId: w.backupId, removalIds: ids, confirmed: true })).toEqual({ ok: true, jobId: 8 });
    expect((created[0]!.params as { removalIds: number[] }).removalIds).toHaveLength(422);
    w.db.prepare('UPDATE removal_log SET undone_at = 5 WHERE id = ?').run(ids[7]);
    expect(svc.putBack({ backupId: w.backupId, removalIds: ids, confirmed: true }).ok).toBe(false);
    expect(svc.putBack({ backupId: w.backupId, removalIds: ids, confirmed: false }).ok).toBe(false);
    const many = Array.from({ length: 6000 }, (_, i) => ids[(i % 400) + 8]!); // (the one put back above is left out)
    expect(svc.putBack({ backupId: w.backupId, removalIds: many, confirmed: true }).ok).toBe(true); // repeats count once; the cap is 50,000
    expect(FREEUP_MAX_PUT_BACK).toBe(50_000);
  });

  it('after a removal the check stays, minus the files handed over: the other groups are still offered, and removing them works the same way', async () => {
    const photo = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const video = w.make('VID_20240101_000002.mp4', 8 * KB);
    await check();
    expect(w.results.get(11)!.view.groups.map((g) => g.id).toSorted()).toEqual(['camera-photos', 'camera-videos']);
    const { svc, created } = service();
    const prep = svc.prepare({ checkId: 11, groups: ['camera-videos'] });
    if (!prep.ok) throw new Error(prep.message);
    expect(svc.start({ checkId: 11, groups: ['camera-videos'], hash: prep.prepare.hash, expectFiles: 1, expectBytes: 8 * KB, confirmed: true }).ok).toBe(true);
    const kept = w.results.get(11)!;
    expect(kept.view.groups.map((g) => g.id)).toEqual(['camera-photos']);
    expect([kept.view.readyFiles, kept.view.readyBytes]).toEqual([1, 3 * KB]);
    expect(kept.ready.map((r) => r.path)).toEqual([photo.remote]);
    expect(await svc.overview(w.backupId)).toMatchObject({ ok: true, checkId: 11 });
    expect(svc.result(11)).toMatchObject({ ok: true, result: { readyFiles: 1 } });
    // The removal runs for what it was handed; the rest is offered again, and a second removal goes through the same checks.
    expect(String(await freeUpRemoveHandler(w.deps()).run(ctxFor(created[0]!.params, { jobId: 21 }).ctx))).toMatch(/Removed 1 file /);
    expect(fs.existsSync(w.adb.local(video.remote))).toBe(false);
    expect(svc.prepare({ checkId: 11, groups: ['camera-videos'] }).ok).toBe(false); // nothing left in that group
    const prep2 = svc.prepare({ checkId: 11, groups: ['camera-photos'] });
    if (!prep2.ok) throw new Error(prep2.message);
    expect(prep2.prepare.files).toBe(1);
    expect(svc.start({ checkId: 11, groups: ['camera-photos'], hash: prep2.prepare.hash, expectFiles: 1, expectBytes: 3 * KB, confirmed: true }).ok).toBe(true);
    expect(w.results.get(11)!.view.groups).toEqual([]);
    expect(String(await freeUpRemoveHandler(w.deps()).run(ctxFor(created[1]!.params, { jobId: 22 }).ctx))).toMatch(/Removed 1 file /);
    expect(fs.existsSync(w.adb.local(photo.remote))).toBe(false);
  });

  it('a kept check is still refused when it is more than 30 minutes old', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.make('VID_20240101_000002.mp4', 8 * KB);
    await check();
    let now = w.results.get(11)!.at;
    const created: unknown[] = [];
    const svc = new FreeUpService({ db: w.db, results: w.results, now: () => now, jobs: { create: (...a) => (created.push(a), 5), list: () => [] }, putBack: () => ({ ok: true, jobId: 1 }) });
    const prep = svc.prepare({ checkId: 11, groups: ['camera-videos'] });
    if (!prep.ok) throw new Error(prep.message);
    expect(svc.start({ checkId: 11, groups: ['camera-videos'], hash: prep.prepare.hash, expectFiles: 1, expectBytes: 8 * KB, confirmed: true }).ok).toBe(true);
    now += 31 * 60 * 1000;
    expect(await svc.overview(w.backupId)).toMatchObject({ ok: true, checkId: null }); // too old to be offered again
    const prep2 = svc.prepare({ checkId: 11, groups: ['camera-photos'] });
    if (!prep2.ok) throw new Error(prep2.message);
    expect(svc.start({ checkId: 11, groups: ['camera-photos'], hash: prep2.prepare.hash, expectFiles: 1, expectBytes: 3 * KB, confirmed: true })).toMatchObject({ ok: false, message: expect.stringContaining('more than 30 minutes') });
  });
});

describe('the service', () => {
  it('refuses a removal without the confirm, with another hash, another count, or an old result', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    await check();
    let now = w.results.get(11)!.at;
    const created: unknown[] = [];
    const svc = new FreeUpService({ db: w.db, results: w.results, now: () => now, jobs: { create: (...a) => (created.push(a), 5), list: () => [] }, putBack: () => ({ ok: true, jobId: 1 }) });
    const prep = svc.prepare({ checkId: 11, groups: ['camera-photos'] });
    if (!prep.ok) throw new Error(prep.message);
    const good = { checkId: 11, groups: ['camera-photos'], hash: prep.prepare.hash, expectFiles: 1, expectBytes: 3 * KB, confirmed: true };
    expect(svc.start({ ...good, confirmed: false }).ok).toBe(false);
    expect(svc.start({ ...good, hash: 'x'.repeat(64) })).toMatchObject({ ok: false, message: expect.stringContaining('not the list Backup Hub made') });
    expect(svc.start({ ...good, expectFiles: 2 })).toMatchObject({ ok: false, message: expect.stringContaining('The list changed') });
    expect(svc.start({ ...good, expectBytes: 4 * KB }).ok).toBe(false);
    expect(svc.start({ ...good, groups: [] }).ok).toBe(false);
    now += 31 * 60 * 1000;
    expect(svc.start(good)).toMatchObject({ ok: false, message: expect.stringContaining('more than 30 minutes') });
    expect(created).toEqual([]);
  });

  it('refuses while another phone job runs, and while something is missing', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    await check();
    const prepSvc = service().svc;
    const prep = prepSvc.prepare({ checkId: 11, groups: ['camera-photos'] });
    if (!prep.ok) throw new Error(prep.message);
    const busy = new FreeUpService({ db: w.db, results: w.results, jobs: { create: () => 1, list: () => [{ kind: 'phone.backup', state: 'running' } as never] }, putBack: () => ({ ok: true, jobId: 1 }) });
    expect(busy.start({ checkId: 11, groups: ['camera-photos'], hash: prep.prepare.hash, expectFiles: 1, expectBytes: 3 * KB, confirmed: true })).toMatchObject({ ok: false, message: expect.stringContaining('busy') });
    expect(busy.startCheck(w.backupId)).toMatchObject({ ok: false });
    // A blocked result offers nothing to prepare.
    w.plugged.t7 = false;
    const { ctx } = ctxFor({ backupId: w.backupId }, { jobId: 12 });
    await freeUpCheckHandler(w.deps()).run(ctx);
    expect(prepSvc.prepare({ checkId: 12, groups: ['camera-photos'] }).ok).toBe(false);
  });

  it('pages the names of a group and of the files that are not ready', async () => {
    for (let i = 0; i < 3; i += 1) w.make(`IMG_20240101_00000${i}.jpg`, (3 + i) * KB);
    w.make('IMG_20240101_000009.jpg', 3 * KB, { sea: 'none' });
    await check();
    const { svc } = service();
    const g = svc.files({ checkId: 11, list: 'camera-photos', offset: 0 });
    expect(g.ok && g.total).toBe(3);
    expect(g.ok && g.rows.map((r) => r.size)).toEqual([5 * KB, 4 * KB, 3 * KB]);
    const n = svc.files({ checkId: 11, list: 'notReady', offset: 0 });
    expect(n.ok && n.rows).toEqual([{ path: '/sdcard/DCIM/Camera/IMG_20240101_000009.jpg', name: 'IMG_20240101_000009.jpg', folder: '/sdcard/DCIM/Camera', size: 3 * KB, mtimeSec: 1_700_000_000, missing: ['No copy on Seagate2TB'], hasCopy: true }]);
  });

  it('Keep on the phone updates the held result at once and lists the rules; Undo removes one', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    w.make('IMG_20240101_000002.jpg', 4 * KB);
    w.make('IMG_20240101_000003.jpg', 5 * KB, { sea: 'none' });
    await check();
    const { svc } = service();
    const k = svc.keep({ backupId: w.backupId, scope: 'folder', path: '/sdcard/DCIM/Camera' });
    expect(k).toMatchObject({ ok: true });
    const view = svc.result(11);
    expect(view.ok && view.result.readyFiles).toBe(0);
    expect(view.ok && view.result.locked.keepFiles).toBe(3);
    expect(view.ok && view.result.notReady.files).toBe(0);
    expect(svc.keep({ backupId: w.backupId, scope: 'file', path: "/sdcard/a'b" }).ok).toBe(false);
    const rule = k.ok ? k.keep[0]! : null;
    expect(svc.unkeep({ backupId: w.backupId, id: rule!.id })).toEqual({ ok: true, keep: [] });
  });

  it('the overview gives the kept rules and the newest fresh check', async () => {
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    await check();
    const { svc } = service();
    const o = await svc.overview(w.backupId);
    expect(o).toMatchObject({ ok: true, serial: 'S1', checkId: 11, keep: [], removedTotal: { files: 0, bytes: 0 } });
    expect((await svc.overview(9999)).ok).toBe(false);
    expect(svc.startCheck(w.backupId)).toEqual({ ok: true, jobId: 101 });
  });

  it('starts the check quick unless the window says full, and keeps the mode in the job; the removal is full unless quick is asked for', async () => {
    const created: { kind: string; params: unknown }[] = [];
    const svc = new FreeUpService({ db: w.db, results: w.results, jobs: { create: (kind, _t, params) => (created.push({ kind, params }), 5), list: () => [] }, putBack: () => ({ ok: true, jobId: 1 }) });
    svc.startCheck(w.backupId);
    svc.startCheck(w.backupId, 'full');
    svc.startCheck(w.backupId, 'odd');
    expect(created.map((c) => c.params)).toEqual([
      { backupId: w.backupId, mode: 'quick' },
      { backupId: w.backupId, mode: 'full' },
      { backupId: w.backupId, mode: 'quick' },
    ]);
    w.make('IMG_20240101_000001.jpg', 3 * KB);
    await check();
    const prep = svc.prepare({ checkId: 11, groups: ['camera-photos'] });
    if (!prep.ok) throw new Error(prep.message);
    const base = { checkId: 11, groups: ['camera-photos'], hash: prep.prepare.hash, expectFiles: 1, expectBytes: 3 * KB, confirmed: true };
    svc.start({ ...base, removeMode: 'quick' });
    expect((created[3]!.params as FreeUpRemoveJobParams).removeMode).toBe('quick');
    await check();
    svc.start({ ...base, removeMode: 'weird' });
    expect((created[4]!.params as FreeUpRemoveJobParams).removeMode).toBe('full');
  });

  it('Show in folder: the first drive copy of a ready file or of a not-ready file that has one; a message when there is none, the drive is out or the file is gone', async () => {
    const a = w.make('IMG_20240101_000001.jpg', 3 * KB);
    const b = w.make('IMG_20240101_000002.jpg', 3 * KB, { sea: 'none' });
    const c = w.make('IMG_20240101_000003.jpg', 3 * KB, { t7: 'none' });
    await check();
    const svc = new FreeUpService({ db: w.db, results: w.results, baseOf: w.baseOf, jobs: { create: () => 1, list: () => [] }, putBack: () => ({ ok: true, jobId: 1 }) });
    expect(await svc.copyPath({ checkId: 11, path: a.remote })).toEqual({ ok: true, abs: a.t7Abs });
    expect(await svc.copyPath({ checkId: 11, path: b.remote })).toEqual({ ok: true, abs: b.t7Abs });
    expect(await svc.copyPath({ checkId: 11, path: c.remote })).toMatchObject({ ok: false, message: expect.stringContaining('no copy on the first drive') });
    const rows = svc.files({ checkId: 11, list: 'notReady', offset: 0 });
    expect(rows.ok && rows.rows.map((r) => [r.name, r.hasCopy])).toEqual([['IMG_20240101_000002.jpg', true], ['IMG_20240101_000003.jpg', false]]);
    expect(await svc.copyPath({ checkId: 11, path: '/sdcard/nothing.jpg' })).toMatchObject({ ok: false });
    expect(await svc.copyPath({ checkId: 99, path: a.remote })).toMatchObject({ ok: false, message: expect.stringContaining('not kept') });
    w.plugged.t7 = false;
    expect(await svc.copyPath({ checkId: 11, path: a.remote })).toEqual({ ok: false, message: 'T7 is not plugged in.' });
    w.plugged.t7 = true;
    fs.rmSync(a.t7Abs);
    expect(await svc.copyPath({ checkId: 11, path: a.remote })).toEqual({ ok: false, message: 'The copy is not on T7 any more.' });
    const noDrives = new FreeUpService({ db: w.db, results: w.results, jobs: { create: () => 1, list: () => [] }, putBack: () => ({ ok: true, jobId: 1 }) });
    expect((await noDrives.copyPath({ checkId: 11, path: b.remote })).ok).toBe(false);
  });

  it('Put back goes through the clean-up job with the phone of the backup', () => {
    const asked: unknown[] = [];
    const svc = new FreeUpService({ db: w.db, results: w.results, jobs: { create: () => 1, list: () => [] }, putBack: (r) => (asked.push(r), { ok: true, jobId: 5 }) });
    expect(svc.putBack({ backupId: w.backupId, removalIds: [3], confirmed: false }).ok).toBe(false);
    expect(svc.putBack({ backupId: w.backupId, removalIds: [3], confirmed: true })).toEqual({ ok: true, jobId: 5 });
    expect(asked).toEqual([{ confirmed: true, serial: 'S1', removalIds: [3] }]);
    expect(PUT_BACK_JOB_KIND).toBe('clean.putBack');
  });
});

describe('the gallery refresh command', () => {
  it('is one fixed broadcast per removed path, up to 20 to a shell line, and refuses an unsafe path', () => {
    const paths = Array.from({ length: 45 }, (_, i) => `/sdcard/DCIM/Camera/IMG ${i}.jpg`);
    const lines = scanMediaCommands(paths);
    expect(lines).toHaveLength(3);
    expect(lines[0]!.split('; ')).toHaveLength(20);
    expect(lines[0]).toContain("am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d 'file:///sdcard/DCIM/Camera/IMG%200.jpg'");
    expect(() => scanMediaCommands(["/sdcard/a'; reboot; '.jpg"])).toThrow(/safe phone path/);
    expect(() => scanMediaCommands(['/etc/passwd'])).toThrow(/safe phone path/);
    expect(lines.join('')).not.toMatch(/\brm\b/);
  });
});

void path;
