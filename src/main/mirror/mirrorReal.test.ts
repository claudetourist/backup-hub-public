import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobService } from '../jobs/jobService';
import { sha256Of } from '../look/harness/fakeDrive.testutil';
import { makeRig, World, type Rig } from '../look/harness/world.testutil';
import { listsFolder } from '../places/appFolders';
import { MIRROR_COPY_JOB_KIND, MIRROR_DAMAGED_PROBLEM, MIRROR_LOOK_JOB_KIND } from '../../shared/mirror';
import { MIRROR_CHECK_JOB_KIND } from '../../shared/mirrorCheck';
import { realMirrorDrive } from './mirrorDrive';
import { MirrorService } from './mirrorService';
import type { MirrorDeps } from './mirrorTypes';

/**
 * The mirror against REAL folders as the two drives (real files, the real safe-copy pieces: temp folder, flush, cache-free read of the source and of the
 * read-back, link that cannot replace; the real quick look of the listing), through the real job service: add the second drive, look and list, confirm,
 * copy, report, list on the second drive, a second look that finds nothing to do.
 */
let rig: Rig;
let w: World;
let t7: string;
let seagate: string;

const waitFor = async (cond: () => boolean, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};

const place = (i: number): string => w.destinations[i]!.placeId;

function deps(plugged: () => boolean[]): MirrorDeps {
  const open = (i: number, root: string): ReturnType<typeof realMirrorDrive> | null => (plugged()[i] ? realMirrorDrive({ db: rig.db, placeId: place(i), label: i === 0 ? 'T7' : 'Seagate2TB', root }) : null);
  return {
    db: rig.db,
    log: { info: () => undefined, warn: () => undefined },
    now: () => w.nowMs,
    pluggedPlaces: async () => new Set([0, 1].filter((i) => plugged()[i]).map(place)),
    drivesFor: async () => ({ src: open(0, t7), dst: open(1, seagate) }),
    sleep: async () => undefined,
  };
}

beforeEach(() => {
  rig = makeRig();
  w = new World(rig, { seed: 41 });
  rig.db.prepare('UPDATE places SET label = ? WHERE id = ?').run('T7', place(0));
  rig.db.prepare('UPDATE places SET label = ? WHERE id = ?').run('Seagate2TB', place(1));
  t7 = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-mirror-t7-'));
  seagate = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-mirror-sea-'));
  w.tick(60);
});
afterEach(() => {
  w.dispose();
  rig.close();
  fs.rmSync(t7, { recursive: true, force: true });
  fs.rmSync(seagate, { recursive: true, force: true });
});

const put = (root: string, rel: string, content: string, mtimeSec = 1_700_000_000): void => {
  const file = path.join(root, 'MyData', 'POCO', ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, mtimeSec, mtimeSec);
};
const filesUnder = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)) : []);

describe('real folders as the two drives, through the job service', () => {
  it('look, list, confirm, copy, report; a damaged file is held back; the second look finds nothing', async () => {
    let plugged = [true, true];
    const jobs = new JobService({ db: rig.db });
    const s = new MirrorService(deps(() => plugged), jobs);
    for (const h of s.handlers()) jobs.register(h);
    jobs.start();
    put(t7, 'S1/one.jpg', 'first file', 1_700_000_001);
    put(t7, 'S1/deep/two.jpg', 'second file is longer', 1_700_000_002);
    put(t7, 'S1/damaged.jpg', 'this one rotted!!', 1_700_000_003);
    put(t7, 'S1/already.jpg', 'already there');
    put(seagate, 'S1/already.jpg', 'already there');
    put(seagate, 'S1/other-old-copy.jpg', 'an older tool made this');

    // The second drive is added (database only), once.
    expect(s.choices(w.profileId)).toMatchObject({ ok: true });
    rig.db.prepare('DELETE FROM backup_destinations WHERE position = 2').run();
    const choices = s.choices(w.profileId);
    expect(choices.ok && choices.drives.map((d) => d.label)).toContain('Seagate2TB');
    expect(s.addCopy({ backupId: w.profileId, placeId: place(0) }).ok).toBe(false); // the first drive again
    const added = s.addCopy({ backupId: w.profileId, placeId: place(1) });
    expect(added.ok).toBe(true);
    expect(rig.db.prepare('SELECT position, role, root FROM backup_destinations WHERE backup_profile_id = ? AND place_id = ?').get(w.profileId, place(1))).toEqual({ position: 2, role: 'copy', root: 'MyData/POCO' });
    expect(s.addCopy({ backupId: w.profileId, placeId: place(1) }).ok).toBe(false); // only one second drive

    // The T7 is not plugged in: said at once, no job.
    plugged = [false, true];
    expect(await s.startLook(w.profileId)).toEqual({ ok: false, message: 'Plug in the T7 to bring the Seagate2TB up to date.', jobId: null });
    plugged = [true, true];

    const look = await s.startLook(w.profileId);
    expect(look.ok).toBe(true);
    await waitFor(() => jobs.get(look.jobId!)?.state === 'done');
    const preview = s.preview(look.jobId!);
    expect(preview?.ok).toBe(true);
    if (!preview?.ok) return;
    const plan = preview.plan;
    expect(plan.rows.map((r) => r.path).toSorted()).toEqual(['S1/damaged.jpg', 'S1/deep/two.jpg', 'S1/one.jpg']);
    expect(plan.toCheck.files).toBe(1);
    // The T7's index row of one file holds a checksum it no longer has: it was damaged after it was recorded.
    rig.db.prepare('UPDATE files SET sha256 = ?, expected_sha256 = ? WHERE place_id = ? AND rel_path = ?').run(sha256Of('the content it had'), sha256Of('the content it had'), place(0), 'MyData/POCO/S1/damaged.jpg');
    // The list was made before that edit; a second look would see it. Make a fresh one.
    const look2 = await s.startLook(w.profileId);
    await waitFor(() => jobs.get(look2.jobId!)?.state === 'done');
    const plan2 = (s.preview(look2.jobId!) as { ok: true; plan: typeof plan }).plan;
    expect(plan2.ownChecksums).toBe(2);

    expect((await s.confirmSliced({ planId: plan2.planId, hash: 'nope', unticked: [] })).ok).toBe(false);
    const started = await s.confirmSliced({ planId: plan2.planId, hash: plan2.hash, unticked: [] });
    expect(started.ok).toBe(true);
    expect(jobs.get(started.jobId!)?.kind).toBe(MIRROR_COPY_JOB_KIND);
    expect(jobs.get(started.jobId!)?.title).toMatch(/^Copy .+ to Seagate2TB \(3 files, 0 MB\)$/);
    expect((await s.startLook(w.profileId)).ok).toBe(false); // one at a time
    await waitFor(() => ['done', 'done_warnings', 'failed'].includes(jobs.get(started.jobId!)?.state ?? ''));
    expect(jobs.get(started.jobId!)?.state).toBe('done_warnings');
    const report = s.report(started.jobId!);
    expect(report).toMatchObject({ damaged: 1, linked: 0 }); // already.jpg was on the Seagate: the copy never read it
    expect(report?.copied.files).toBe(2);
    expect(fs.readFileSync(path.join(seagate, 'MyData', 'POCO', 'S1', 'one.jpg'), 'utf8')).toBe('first file');
    expect(fs.readFileSync(path.join(seagate, 'MyData', 'POCO', 'S1', 'deep', 'two.jpg'), 'utf8')).toBe('second file is longer');
    expect(fs.existsSync(path.join(seagate, 'MyData', 'POCO', 'S1', 'damaged.jpg'))).toBe(false);
    expect(fs.readFileSync(path.join(seagate, 'MyData', 'POCO', 'S1', 'other-old-copy.jpg'), 'utf8')).toBe('an older tool made this');
    // The date of the source is kept; the T7 is as it was.
    expect(Math.round(fs.statSync(path.join(seagate, 'MyData', 'POCO', 'S1', 'one.jpg')).mtimeMs / 1000)).toBe(1_700_000_001);
    expect(fs.readFileSync(path.join(t7, 'MyData', 'POCO', 'S1', 'damaged.jpg'), 'utf8')).toBe('this one rotted!!');
    expect(rig.db.prepare("SELECT count(*) FROM file_problems WHERE kind = ? AND state = 'open'").pluck().get(MIRROR_DAMAGED_PROBLEM)).toBe(1);
    // The list is on the Seagate, in its own files folder, never inside a backup folder; the temp folder is empty.
    const list = filesUnder(listsFolder(seagate));
    expect(list).toHaveLength(1);
    expect(list[0]).toBe(report!.listPaths[0]);
    const text = fs.readFileSync(list[0]!, 'utf8');
    expect(text).toContain('MyData/POCO/S1/one.jpg');
    expect(text).not.toContain('damaged.jpg');
    expect(filesUnder(path.join(seagate, 'MyData')).filter((f) => f.endsWith('.bhtmp'))).toEqual([]);
    // "Check old copies": the same-size file that was already there is proven in a job of its own; nothing on either drive changes.
    const checkList = await s.checkPreview(w.profileId);
    expect(checkList.ok && checkList.plan.totals.files).toBe(1);
    if (!checkList.ok) return;
    const checkStarted = await s.checkStart({ planId: checkList.plan.planId, hash: checkList.plan.hash });
    expect(checkStarted.ok).toBe(true);
    expect(jobs.get(checkStarted.jobId!)?.kind).toBe(MIRROR_CHECK_JOB_KIND);
    expect((await s.startLook(w.profileId)).ok).toBe(false); // one at a time
    await waitFor(() => ['done', 'done_warnings', 'failed'].includes(jobs.get(checkStarted.jobId!)?.state ?? ''));
    expect(jobs.get(checkStarted.jobId!)?.state).toBe('done');
    expect(s.checkReport(checkStarted.jobId!)).toMatchObject({ complete: true, verified: 1, differs: 0, twoReads: 1, oneRead: 0 });
    expect(rig.db.prepare('SELECT verified_how, sha256 FROM files WHERE place_id = ? AND rel_path = ?').get(place(1), 'MyData/POCO/S1/already.jpg')).toMatchObject({ verified_how: 'read_both', sha256: sha256Of('already there') });
    expect(fs.readFileSync(path.join(seagate, 'MyData', 'POCO', 'S1', 'already.jpg'), 'utf8')).toBe('already there');
    expect((await s.checkPreview(w.profileId) as { ok: true; plan: { totals: { files: number } } }).plan.totals.files).toBe(0);
    // The status: the one damaged file is still behind, and says so.
    const status = await s.status();
    expect(status.backups[0]!.mirrors[0]).toMatchObject({ label: 'Seagate2TB', connected: true, behindFiles: 1, needYou: 1 });
    // Another look: only the damaged file is left, and it is not offered again.
    const again = await s.startLook(w.profileId);
    await waitFor(() => jobs.get(again.jobId!)?.state === 'done');
    const last = s.preview(again.jobId!);
    expect(last?.ok && last.plan.totals.files).toBe(0);
    expect(last?.ok && last.plan.knownProblems).toBe(1);
    expect(jobs.get(look.jobId!)?.kind).toBe(MIRROR_LOOK_JOB_KIND);
  }, 60_000);
});
