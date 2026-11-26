import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobService } from '../jobs/jobService';
import { inlineQuickWalkRunner } from '../listing/quickWalkRunner';
import { WINDOWS_DIRECT_FLAG } from '../localCopy/directRead';
import { makeRig, World, type Rig } from '../look/harness/world.testutil';
import { realMirrorDrive } from '../mirror/mirrorDrive';
import { KEEP_SYNC_PARTS } from '../../shared/appFolders';
import { KEEP_SYNC_KEY, KEEP_SYNC_NAME } from '../../shared/folderBackup';
import { FolderBackupService } from './folderBackupService';
import { realSourceFor } from './folderSource';
import { keepSyncPaths } from './keepSync';

/**
 * The Google Keep notes (keep-sync, R2.8). PRIVACY: the snapshots hold all the person's notes unencrypted. The tests prove, on REAL files with a canary text
 * inside them, that nothing but the copy's own read stream ever opens or reads them: not the plan, not the look, not the report, not the log, not the job's
 * events, not a database row, not an answer to the window. Names, sizes and dates only.
 */
const CANARY = 'ZZ-PRIVATE-NOTE-CANARY-7731';
let rig: Rig;
let w: World;
let local: string;
let t7: string;

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
  w = new World(rig, { seed: 66, drives: [{ caseInsensitive: true }] });
  rig.db.prepare('UPDATE places SET label = ? WHERE id = ?').run('T7', w.destinations[0]!.placeId);
  local = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-keep-local-'));
  t7 = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-keep-t7-'));
  w.tick(60);
});
afterEach(() => {
  vi.restoreAllMocks();
  w.dispose();
  rig.close();
  fs.rmSync(local, { recursive: true, force: true });
  fs.rmSync(t7, { recursive: true, force: true });
});

const paths = (): NonNullable<ReturnType<typeof keepSyncPaths>> => keepSyncPaths(local)!;
function writeSnapshot(name: string, content: string, mtimeSec = 1_700_000_000): void {
  const file = path.join(paths().snapshots, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, mtimeSec, mtimeSec);
}
function writeTimestamped(folder: string, content: string): void {
  const file = path.join(paths().backups, folder, 'keep.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function service(log: { info(...a: unknown[]): void; warn(...a: unknown[]): void } = { info: () => undefined, warn: () => undefined }): { s: FolderBackupService; jobs: JobService } {
  const quickRunner = inlineQuickWalkRunner(rig.db);
  const jobs = new JobService({ db: rig.db });
  const placeId = w.destinations[0]!.placeId;
  const s = new FolderBackupService(
    {
      db: rig.db,
      log,
      now: () => w.nowMs,
      localAppData: local,
      pluggedPlaces: async () => new Set([placeId]),
      driveFor: async (id) => (id === placeId ? { drive: realMirrorDrive({ db: rig.db, placeId, label: 'T7', root: t7, quickRunner }), label: 'T7' } : null),
      sourceFor: realSourceFor({ db: rig.db, quickRunner, localAppData: local }),
      sleep: async () => undefined,
    },
    jobs,
  );
  for (const h of s.handlers()) jobs.register(h);
  jobs.start();
  return { s, jobs };
}

describe('where keep-sync keeps its files', () => {
  it('is worked out from %LOCALAPPDATA%, never a typed-in user name', () => {
    expect(keepSyncPaths('C:\\Users\\someone\\AppData\\Local')).toEqual({
      backups: path.join('C:\\Users\\someone\\AppData\\Local', 'keep-sync', 'data', 'backups'),
      snapshots: path.join('C:\\Users\\someone\\AppData\\Local', 'keep-sync', 'data', 'backups', 'snapshots'),
    });
    expect(keepSyncPaths('')).toBeNull();
    const sources = ['keepSync.ts', 'folderBackupService.ts', 'folderSource.ts'].map((f) => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');
    expect(sources).not.toMatch(/C:\\\\Users\\\\[a-z]/i);
  });
});

describe('"Add Google Keep notes backup"', () => {
  it('is offered when the snapshots folder exists; the backup is made only by the click, for You, on the T7 by its name, in the app backups folder', async () => {
    const { s } = service();
    expect((await s.cards()).keepSync).toEqual({ available: false, exists: false });
    writeSnapshot('keep-20260101-000000.jsonl.gz', CANARY);
    expect((await s.cards()).keepSync).toEqual({ available: true, exists: false });
    // Looking at the cards made nothing.
    expect(rig.db.prepare('SELECT count(*) FROM backup_profiles WHERE import_key = ?').pluck().get(KEEP_SYNC_KEY)).toBe(0);
    rig.db.prepare("INSERT INTO profiles (name, color, created_at) VALUES ('Mom', '#e0a', 1)").run();

    const added = await s.addKeepSync();
    expect(added.ok).toBe(true);
    const row = rig.db.prepare('SELECT name, person_id, source_kind, folder_prefix, change_rule, enabled FROM backup_profiles WHERE import_key = ?').get(KEEP_SYNC_KEY) as { name: string; person_id: number; source_kind: string; folder_prefix: string; change_rule: string; enabled: number };
    expect(row).toMatchObject({ name: KEEP_SYNC_NAME, source_kind: 'folder', enabled: 1 });
    expect(rig.db.prepare('SELECT name FROM profiles WHERE id = ?').pluck().get(row.person_id)).toBe('You');
    const dest = rig.db.prepare('SELECT place_id, root, role FROM backup_destinations WHERE backup_profile_id = (SELECT id FROM backup_profiles WHERE import_key = ?)').get(KEEP_SYNC_KEY);
    expect(dest).toEqual({ place_id: w.destinations[0]!.placeId, root: KEEP_SYNC_PARTS.join('/'), role: 'primary' });
    // Inside the app's backups folder, in a folder of its own; nothing loose in MyData.
    expect(KEEP_SYNC_PARTS.slice(0, 2)).toEqual(['MyData', KEEP_SYNC_PARTS[1]]);
    expect(KEEP_SYNC_PARTS).toHaveLength(4);
    expect(KEEP_SYNC_PARTS[3]).toBe('keep-sync');
    expect((await s.cards()).keepSync).toEqual({ available: true, exists: true });
    // Once.
    expect(await s.addKeepSync()).toMatchObject({ ok: false });
    // Nothing was written to any drive and nothing was copied.
    expect(fs.readdirSync(t7)).toEqual([]);
  });

  it('is refused (with a plain reason, nothing changed) without the snapshots folder, or when no drive is named T7', async () => {
    const { s } = service();
    expect(await s.addKeepSync()).toMatchObject({ ok: false, message: 'keep-sync has no snapshots folder on this computer. Nothing was changed.' });
    writeSnapshot('keep-20260101-000000.jsonl.gz', CANARY);
    rig.db.prepare("UPDATE places SET label = 'Other' WHERE id = ?").run(w.destinations[0]!.placeId);
    expect(await s.addKeepSync()).toMatchObject({ ok: false, message: expect.stringContaining('T7') });
    expect(rig.db.prepare('SELECT count(*) FROM backup_profiles WHERE import_key = ?').pluck().get(KEEP_SYNC_KEY)).toBe(0);
  });
});

describe('privacy: nothing reads the notes except the copy stream', () => {
  it('a whole add, look, list, copy and report: the only read of a note is the hashing copy stream, and the text of a note is nowhere', async () => {
    writeSnapshot('keep-20260101-000000.jsonl.gz', `${CANARY} one`);
    writeSnapshot('keep-20260102-000000.jsonl.gz', `${CANARY} two, a little longer`);
    writeTimestamped('20260105-101010', `${CANARY} keep.txt`);
    const logs: string[] = [];
    const log = { info: (...a: unknown[]) => void logs.push(a.map(String).join(' ')), warn: (...a: unknown[]) => void logs.push(a.map(String).join(' ')) };

    // Every way of reading a file by name is watched. A note is anything under the keep-sync folder.
    const isNote = (p: unknown): boolean => typeof p === 'string' && p.toLowerCase().startsWith(local.toLowerCase());
    const reads: string[] = [];
    const opens: { path: string; flags: unknown }[] = [];
    const watch = (obj: Record<string, unknown>, name: string, kind: 'read' | 'open'): void => {
      const original = obj[name] as (...args: unknown[]) => unknown;
      vi.spyOn(obj as never, name as never).mockImplementation(((...args: unknown[]) => {
        if (isNote(args[0])) {
          if (kind === 'read') reads.push(`${name} ${String(args[0])}`);
          else opens.push({ path: String(args[0]), flags: args[1] });
        }
        return original.apply(obj, args);
      }) as never);
    };
    for (const n of ['readFileSync', 'readFile', 'createReadStream']) watch(fs as never, n, 'read');
    watch(fs.promises as never, 'readFile', 'read');
    for (const n of ['openSync', 'open']) watch(fs as never, n, 'open');
    watch(fs.promises as never, 'open', 'open');

    const { s, jobs } = service(log);
    const cards = await s.cards();
    expect(cards.keepSync.available).toBe(true);
    expect((await s.addKeepSync()).ok).toBe(true);
    const backupId = (await s.cards()).cards[0]!.backupId;
    const look = s.startLook(backupId);
    await waitFor(() => finished(jobs.get(look.jobId!)?.state));
    const preview = s.preview(look.jobId!);
    expect(preview?.ok).toBe(true);
    if (!preview?.ok) return;
    expect(preview.plan.layout).toBe('flat');
    expect(preview.plan.rows.map((r) => r.path).toSorted()).toEqual(['/source/20260105-101010/keep.txt', '/source/keep-20260101-000000.jsonl.gz', '/source/keep-20260102-000000.jsonl.gz']);
    // Looking opened nothing.
    expect(opens).toEqual([]);
    expect(reads).toEqual([]);

    const started = await s.confirmSliced({ planId: preview.plan.planId, hash: preview.plan.hash, unticked: [], untickedFolders: [], included: [] });
    expect(started.ok).toBe(true);
    await waitFor(() => finished(jobs.get(started.jobId!)?.state));
    expect(jobs.get(started.jobId!)?.state).toBe('done');
    const report = s.report(started.jobId!);
    expect(report).toMatchObject({ copied: { files: 3 }, layout: 'flat', failed: [] });

    // The notes were copied byte for byte, flat, into the keep-sync folder of the app's backups folder on the T7.
    const target = path.join(t7, ...KEEP_SYNC_PARTS);
    expect(fs.readFileSync(path.join(target, 'keep-20260102-000000.jsonl.gz'), 'utf8')).toBe(`${CANARY} two, a little longer`);
    expect(fs.readFileSync(path.join(target, '20260105-101010', 'keep.txt'), 'utf8')).toBe(`${CANARY} keep.txt`);
    // The source is as it was (nothing changed or deleted there).
    expect(fs.readdirSync(paths().snapshots).toSorted()).toEqual(['keep-20260101-000000.jsonl.gz', 'keep-20260102-000000.jsonl.gz']);

    // Nothing but the copy's stream opened a note: no readFile, no read stream, and every open is the unbuffered one, once per note.
    expect(reads).toEqual([]);
    expect(opens).toHaveLength(3);
    for (const o of opens) expect((o.flags as number) & WINDOWS_DIRECT_FLAG).toBe(WINDOWS_DIRECT_FLAG);

    // The text of a note is nowhere: not in the answers to the window, the log, the job's events, or any row of the database.
    const everything: string[] = [JSON.stringify(cards), JSON.stringify(preview), JSON.stringify(report), JSON.stringify(s.progress(started.jobId!)), JSON.stringify(s.copied(started.jobId!)), ...logs];
    for (const id of [look.jobId!, started.jobId!]) everything.push(JSON.stringify(jobs.events(id)), JSON.stringify(jobs.get(id)));
    const tables = rig.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").pluck().all() as string[];
    for (const t of tables) for (const row of rig.db.prepare(`SELECT * FROM "${t}"`).iterate()) everything.push(JSON.stringify(row));
    for (const piece of everything) expect(piece).not.toContain(CANARY);
    expect(everything.join('')).toContain('keep-20260102-000000.jsonl.gz'); // names are known: that is all that is
    // The notes never got a row in the file list (no Files search, no "Why?"): only the copies on the T7 are listed.
    expect(rig.db.prepare("SELECT count(*) FROM files WHERE place_id NOT IN (SELECT id FROM places WHERE kind = 'drive')").pluck().get()).toBe(0);
    // The list of the run on the drive holds names, sizes and checksums only.
    const lists = fs.readdirSync(t7, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.csv'));
    expect(lists).toHaveLength(1);
    expect(fs.readFileSync(path.join(lists[0]!.parentPath, lists[0]!.name), 'utf8')).not.toContain(CANARY);
  }, 60_000);

  it('add-only: a note that is already on the T7 is not read or copied again, a snapshot keep-sync thinned away stays on the T7, and a different file with the same name is never replaced', async () => {
    writeSnapshot('keep-20260101-000000.jsonl.gz', `${CANARY} one`);
    writeSnapshot('keep-20260102-000000.jsonl.gz', `${CANARY} two`);
    const { s, jobs } = service();
    expect((await s.addKeepSync()).ok).toBe(true);
    const backupId = (await s.cards()).cards[0]!.backupId;
    const run = async (): Promise<{ plan: NonNullable<ReturnType<FolderBackupService['preview']>>; jobId: number | null }> => {
      const look = s.startLook(backupId);
      await waitFor(() => finished(jobs.get(look.jobId!)?.state));
      const plan = s.preview(look.jobId!)!;
      if (!plan.ok || plan.plan.totals.files === 0) return { plan, jobId: null };
      const go = await s.confirmSliced({ planId: plan.plan.planId, hash: plan.plan.hash, unticked: [], untickedFolders: [], included: [] });
      await waitFor(() => finished(jobs.get(go.jobId!)?.state));
      return { plan, jobId: go.jobId };
    };
    expect((await run()).jobId).not.toBeNull();
    const target = path.join(t7, ...KEEP_SYNC_PARTS);
    // keep-sync thins its snapshots: one is gone from its folder. The T7 keeps it.
    fs.rmSync(path.join(paths().snapshots, 'keep-20260101-000000.jsonl.gz'));
    // Another snapshot arrives, and a file of the same name but another size sits on the T7 already (never replaced).
    writeSnapshot('keep-20260103-000000.jsonl.gz', `${CANARY} three`);
    fs.writeFileSync(path.join(target, 'keep-20260103-000000.jsonl.gz'), 'somebody else, other size');
    // The T7's file list learns about it with the next look.
    const second = await run();
    expect(second.plan.ok && second.plan.plan).toMatchObject({ alreadyBackedUp: 1, differentOnDrive: 1, totals: { files: 0 } });
    expect(second.jobId).toBeNull();
    expect(fs.readFileSync(path.join(target, 'keep-20260101-000000.jsonl.gz'), 'utf8')).toBe(`${CANARY} one`);
    expect(fs.readFileSync(path.join(target, 'keep-20260103-000000.jsonl.gz'), 'utf8')).toBe('somebody else, other size');
  }, 60_000);
});
