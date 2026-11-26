import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobService } from '../jobs/jobService';
import { inlineQuickWalkRunner } from '../listing/quickWalkRunner';
import { sha256Of } from '../look/harness/fakeDrive.testutil';
import { makeRig, World, type Rig } from '../look/harness/world.testutil';
import { realMirrorDrive } from '../mirror/mirrorDrive';
import { listsFolder } from '../places/appFolders';
import { sessionFolderName } from '../phoneBackup/pathMap';
import { FOLDER_BACKUP_JOB_KIND, FOLDER_LOOK_JOB_KIND, ONLINE_ONLY_REASON } from '../../shared/folderBackup';
import { RulesStore } from '../rules/rulesStore';
import { normalizeRoot } from '../listing/roots';
import { FolderBackupService } from './folderBackupService';
import { realSourceFor } from './folderSource';

/**
 * A folder backup against REAL folders (a real folder as the backed-up folder, another as the T7), through the real job service, the real quick look of
 * the listing, the real unbuffered read and the real safe-copy pieces: look, list, confirm, copy, report, the list on the drive, a second look that finds
 * nothing, a changed file that gets its own new dated folder next to the old one, and OneDrive files that are online only (never read).
 */
let rig: Rig;
let w: World;
let source: string;
let t7: string;
let laptop: string;

const waitFor = async (cond: () => boolean, ms = 30_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
};
const finished = (state: string | undefined): boolean => ['done', 'done_warnings', 'failed'].includes(state ?? '');

beforeEach(() => {
  rig = makeRig();
  w = new World(rig, { seed: 55, drives: [{ caseInsensitive: true }] });
  rig.db.prepare('UPDATE places SET label = ? WHERE id = ?').run('T7', w.destinations[0]!.placeId);
  source = normalizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'zz-folder-src-')));
  t7 = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-folder-t7-'));
  laptop = 'laptop-real';
  rig.db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES (?, 1, 'laptop', 'Laptop', '{}', 1)").run(laptop);
  w.tick(60);
});
afterEach(() => {
  w.dispose();
  rig.close();
  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(t7, { recursive: true, force: true });
});

const put = (rel: string, content: string, mtimeSec = 1_700_000_000): void => {
  const file = path.join(source, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, mtimeSec, mtimeSec);
};
const filesUnder = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)) : []);

function makeBackup(): number {
  const id = Number(
    rig.db
      .prepare("INSERT INTO backup_profiles (person_id, name, source_kind, source_root, folder_prefix, change_rule, created_at) VALUES (1, 'Real folder', 'folder', ?, 'Real', 'size_or_date', 1)")
      .run(source).lastInsertRowid,
  );
  rig.db.prepare('INSERT INTO backup_destinations (backup_profile_id, place_id, root, role, enabled, position) VALUES (?, ?, ?, ?, 1, 1)').run(id, w.destinations[0]!.placeId, 'MyData/RealBackup', 'primary');
  return id;
}

function service(options: { checkCloud?: (paths: readonly string[]) => Promise<Map<string, 'cloud' | 'local' | 'missing' | 'unknown'>> } = {}): { s: FolderBackupService; jobs: JobService } {
  const quickRunner = inlineQuickWalkRunner(rig.db);
  const jobs = new JobService({ db: rig.db });
  const placeId = w.destinations[0]!.placeId;
  const s = new FolderBackupService(
    {
      db: rig.db,
      log: { info: () => undefined, warn: () => undefined },
      now: () => w.nowMs,
      pluggedPlaces: async () => new Set([placeId]),
      driveFor: async (id) => (id === placeId ? { drive: realMirrorDrive({ db: rig.db, placeId, label: 'T7', root: t7, quickRunner }), label: 'T7' } : null),
      sourceFor: realSourceFor({ db: rig.db, quickRunner, ...(options.checkCloud ? { checkCloud: (paths) => options.checkCloud!(paths) } : {}) }),
      sleep: async () => undefined,
    },
    jobs,
  );
  for (const h of s.handlers()) jobs.register(h);
  jobs.start();
  return { s, jobs };
}

describe('a real folder, through the job service', () => {
  it('look, list, confirm, copy, report; a second look finds nothing; a changed file gets a new dated folder next to the old one', async () => {
    const id = makeBackup();
    const { s, jobs } = service();
    put('Docs/one.txt', 'first file', 1_700_000_001);
    put('Docs/deep/two.txt', 'second file is longer', 1_700_000_002);
    put('three.bin', 'x'.repeat(5000), 1_700_000_003);
    const session = sessionFolderName('Real', new Date(w.nowMs));

    const look = s.startLook(id);
    expect(look.ok).toBe(true);
    expect(jobs.get(look.jobId!)?.kind).toBe(FOLDER_LOOK_JOB_KIND);
    expect(s.startLook(id).ok).toBe(false); // one at a time
    await waitFor(() => finished(jobs.get(look.jobId!)?.state));
    const preview = s.preview(look.jobId!);
    expect(preview?.ok).toBe(true);
    if (!preview?.ok) return;
    const plan = preview.plan;
    expect(plan.rows.map((r) => r.path).toSorted()).toEqual(['/source/Docs/deep/two.txt', '/source/Docs/one.txt', '/source/three.bin']);
    expect(plan.folderWords).toBe(`MyData\\RealBackup\\${session}`);
    // Nothing was copied by the look.
    expect(filesUnder(path.join(t7, 'MyData', 'RealBackup'))).toEqual([]);

    expect((await s.confirmSliced({ planId: plan.planId, hash: 'nope', unticked: [], untickedFolders: [], included: [] })).ok).toBe(false);
    const started = await s.confirmSliced({ planId: plan.planId, hash: plan.hash, unticked: ['/source/three.bin'], untickedFolders: [], included: [] });
    expect(started.ok).toBe(true);
    expect(jobs.get(started.jobId!)?.kind).toBe(FOLDER_BACKUP_JOB_KIND);
    expect(jobs.get(started.jobId!)?.title).toBe('Back up Real folder now (2 files, 0 MB)');
    await waitFor(() => finished(jobs.get(started.jobId!)?.state));
    expect(jobs.get(started.jobId!)?.state).toBe('done');
    const report = s.report(started.jobId!);
    expect(report).toMatchObject({ copied: { files: 2 }, inUseCount: 0, failed: [], layout: 'dated' });
    const base = path.join(t7, 'MyData', 'RealBackup', session);
    expect(fs.readFileSync(path.join(base, 'Docs', 'one.txt'), 'utf8')).toBe('first file');
    expect(fs.readFileSync(path.join(base, 'Docs', 'deep', 'two.txt'), 'utf8')).toBe('second file is longer');
    expect(fs.existsSync(path.join(base, 'three.bin'))).toBe(false); // unticked
    expect(Math.round(fs.statSync(path.join(base, 'Docs', 'one.txt')).mtimeMs / 1000)).toBe(1_700_000_001);
    expect(fs.readFileSync(path.join(source, 'Docs', 'one.txt'), 'utf8')).toBe('first file'); // the source is as it was
    // The list is on the drive, in its own files folder; the temp folder is empty.
    const list = filesUnder(listsFolder(t7));
    expect(list).toHaveLength(1);
    expect(list[0]).toBe(report!.listPath);
    expect(fs.readFileSync(list[0]!, 'utf8')).toContain('Docs/one.txt');
    expect(filesUnder(path.join(t7, 'MyData')).filter((f) => f.endsWith('.bhtmp'))).toEqual([]);
    expect(s.copied(started.jobId!)).toMatchObject({ total: 2, files: [{ path: '/source/Docs/deep/two.txt' }, { path: '/source/Docs/one.txt' }] });
    // The row of a copy points at the file's own row, with the checksum both sides agreed on.
    const row = rig.db.prepare('SELECT origin_file_id, verified_how, sha256 FROM files WHERE place_id = ? AND rel_path = ?').get(w.destinations[0]!.placeId, `MyData/RealBackup/${session}/Docs/one.txt`) as { origin_file_id: number; verified_how: string; sha256: string };
    expect(row).toMatchObject({ verified_how: 'read_both', sha256: sha256Of('first file') });
    expect(rig.db.prepare('SELECT rel_path FROM files WHERE id = ?').pluck().get(row.origin_file_id)).toBe(`${source.replaceAll('\\', '/')}/Docs/one.txt`);

    // Another look: three.bin is still to do (it was unticked, so it is not backed up); the rest is already there.
    const again = s.startLook(id);
    await waitFor(() => finished(jobs.get(again.jobId!)?.state));
    const second = s.preview(again.jobId!);
    expect(second?.ok && second.plan.rows.map((r) => r.path)).toEqual(['/source/three.bin']);
    expect(second?.ok && second.plan.alreadyBackedUp).toBe(2);

    // A file changes: it is copied into a new dated folder (same day: the same folder, under a time name), and the old copy is never touched.
    put('Docs/one.txt', 'first file, edited', 1_700_000_100);
    const third = s.startLook(id);
    await waitFor(() => finished(jobs.get(third.jobId!)?.state));
    const changed = s.preview(third.jobId!);
    expect(changed?.ok && changed.plan.rows.find((r) => r.path.endsWith('one.txt'))?.kind).toBe('changed');
    if (!changed?.ok) return;
    const go = await s.confirmSliced({ planId: changed.plan.planId, hash: changed.plan.hash, unticked: [], untickedFolders: [], included: [] });
    await waitFor(() => finished(jobs.get(go.jobId!)?.state));
    expect(fs.readFileSync(path.join(base, 'Docs', 'one.txt'), 'utf8')).toBe('first file');
    const copies = filesUnder(path.join(t7, 'MyData', 'RealBackup')).filter((f) => path.basename(f).startsWith('one'));
    expect(copies).toHaveLength(2);
    expect(copies.map((f) => fs.readFileSync(f, 'utf8')).toSorted()).toEqual(['first file', 'first file, edited']);
  }, 60_000);

  it('files the person excluded are left out and never read or copied', async () => {
    const id = makeBackup();
    const { s, jobs } = service();
    put('Docs/keep.txt', 'keep');
    put('Games/save.dat', 'save');
    put('Docs/skip.tmp', 'tmp');
    new RulesStore(rig.db).add(id, { scope: 'folder', pattern: '/source/Games', choice: 'leave_out' });
    new RulesStore(rig.db).add(id, { scope: 'pattern', pattern: '*.tmp', choice: 'leave_out' });
    const look = s.startLook(id);
    await waitFor(() => finished(jobs.get(look.jobId!)?.state));
    const preview = s.preview(look.jobId!);
    expect(preview?.ok && preview.plan.rows.map((r) => r.path)).toEqual(['/source/Docs/keep.txt']);
    expect(preview?.ok && preview.plan.leftOut.map((g) => g.files).toSorted()).toEqual([1, 1]);
    // An exclusion saved AFTER the list was made still counts when it is confirmed.
    if (!preview?.ok) return;
    new RulesStore(rig.db).add(id, { scope: 'file', pattern: '/source/Docs/keep.txt', choice: 'leave_out' });
    const started = await s.confirmSliced({ planId: preview.plan.planId, hash: preview.plan.hash, unticked: [], untickedFolders: [], included: [] });
    expect(started).toMatchObject({ ok: false, message: 'Nothing is ticked. Nothing was copied.' });
  });
});

describe('a folder renamed on disk (R1.6)', () => {
  it('after it was backed up: the next look finds the same files under the new name, the plan says nothing to copy, and nothing is read or copied again', async () => {
    const id = makeBackup();
    const { s, jobs } = service();
    for (let i = 0; i < 12; i += 1) put(`Trip/d${i % 3}/p${i}.jpg`, `photo number ${i}`, 1_700_000_000 + i);
    put('Other/keep.txt', 'unrelated file', 1_700_000_100);
    const first = s.startLook(id);
    await waitFor(() => finished(jobs.get(first.jobId!)?.state));
    const preview = s.preview(first.jobId!);
    if (!preview?.ok) throw new Error('no plan');
    const go = await s.confirmSliced({ planId: preview.plan.planId, hash: preview.plan.hash, unticked: [], untickedFolders: [], included: [] });
    await waitFor(() => finished(jobs.get(go.jobId!)?.state));
    expect(s.report(go.jobId!)).toMatchObject({ copied: { files: 13 } });
    const onDrive = filesUnder(path.join(t7, 'MyData', 'RealBackup')).toSorted();
    const rowIds = rig.db.prepare('SELECT id FROM files WHERE place_id = ? ORDER BY id').pluck().all(laptop) as number[];
    expect(rowIds).toHaveLength(13);

    // Rename the folder in Explorer.
    fs.renameSync(path.join(source, 'Trip'), path.join(source, 'Goa 2026'));
    const again = s.startLook(id);
    await waitFor(() => finished(jobs.get(again.jobId!)?.state));
    const second = s.preview(again.jobId!);
    expect(second?.ok).toBe(true);
    if (!second?.ok) return;
    expect(second.plan.rows).toEqual([]);
    expect(second.plan.totals.files).toBe(0);
    expect(second.plan.alreadyBackedUp).toBe(13);
    expect(second.plan.moved).toEqual([{ kind: 'folder_renamed', from: 'Trip', to: 'Goa 2026', files: 12 }]);
    expect(second.plan.movedFiles).toBe(12);
    // The same 13 rows (no new rows, none gone), the old paths kept as history, and the drive is exactly as it was.
    expect(rig.db.prepare('SELECT id FROM files WHERE place_id = ? ORDER BY id').pluck().all(laptop)).toEqual(rowIds);
    expect(rig.db.prepare('SELECT count(*) FROM files WHERE place_id = ? AND gone_at IS NULL').pluck().get(laptop)).toBe(13);
    expect(rig.db.prepare('SELECT count(*) FROM file_paths').pluck().get()).toBe(24);
    expect(filesUnder(path.join(t7, 'MyData', 'RealBackup')).toSorted()).toEqual(onDrive);
    expect(fs.existsSync(path.join(source, 'Goa 2026', 'd0', 'p0.jpg'))).toBe(true);
  }, 60_000);
});

describe('OneDrive: files that are online only are never opened', () => {
  it('are counted and listed in the preview and the report, and the real source never reads them', async () => {
    rig.db.prepare("UPDATE places SET kind = 'onedrive', identity_json = ? WHERE id = ?").run(JSON.stringify({ userFolder: source }), laptop);
    const id = makeBackup();
    put('d/local.txt', 'on this pc');
    put('d/online.docx', 'cloud-only-content');
    const asked: string[] = [];
    const { s, jobs } = service({
      checkCloud: async (paths) => {
        asked.push(...paths);
        return new Map(paths.map((p) => [p, p.endsWith('online.docx') ? ('cloud' as const) : ('local' as const)]));
      },
    });
    const look = s.startLook(id);
    await waitFor(() => finished(jobs.get(look.jobId!)?.state));
    const preview = s.preview(look.jobId!);
    expect(preview?.ok && preview.plan.rows.map((r) => r.path)).toEqual(['/source/d/local.txt']);
    expect(preview?.ok && preview.plan.onlineOnly).toMatchObject({ files: 1, bytes: 18, examples: ['d/online.docx'] });
    expect(asked.some((p) => p.endsWith('online.docx'))).toBe(true);
    if (!preview?.ok) return;
    const started = await s.confirmSliced({ planId: preview.plan.planId, hash: preview.plan.hash, unticked: [], untickedFolders: [], included: [] });
    await waitFor(() => finished(jobs.get(started.jobId!)?.state));
    const report = s.report(started.jobId!);
    expect(report?.onlineOnly.files).toBe(1);
    expect(report?.copied.files).toBe(1);
    expect(filesUnder(path.join(t7, 'MyData', 'RealBackup')).map((f) => path.basename(f))).toEqual(['local.txt']);
    void ONLINE_ONLY_REASON;
  }, 30_000);
});
