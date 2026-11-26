import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobRecord } from '../../shared/jobs';
import { FOLDER_BACKUP_JOB_KIND, FOLDER_LOOK_JOB_KIND } from '../../shared/folderBackup';
import { FolderWorld } from '../look/harness/folderWorld.testutil';
import { makeRig, World, type Rig } from '../look/harness/world.testutil';
import { FakeCtx } from '../look/harness/phoneBackupWorld.testutil';
import { RulesStore } from '../rules/rulesStore';
import { RulesService } from '../rules/rulesService';
import { FolderBackupService, PLAN_LIFETIME_MS } from './folderBackupService';
import { planFolderBackup } from './folderPlan';
import type { StoredFolderPlan } from './folderTypes';

/** The folder backup service: what a click may start, and what it refuses, with a recording stand-in for the job service. */
let rig: Rig;
let w: World;
let f: FolderWorld;
let created: { kind: string; title: string; params: unknown }[];
let active: JobRecord[];
let now: number;

function make(): FolderBackupService {
  created = [];
  active = [];
  return new FolderBackupService(
    { ...f.deps, now: () => now, pluggedPlaces: async () => new Set(w.drives[0]!.plugged ? [f.drivePlace] : []), localAppData: 'C:\\No\\Such\\Place' },
    {
      create: (kind, title, params) => {
        created.push({ kind, title, params });
        return created.length;
      },
      list: () => active,
    },
  );
}

/** What the look job does, without a job service: plan, and keep the plan in the service the way the handler does. */
async function look(s: FolderBackupService): Promise<{ planId: string; hash: string; stored: StoredFolderPlan }> {
  const outcome = await planFolderBackup(f.deps, { backupId: f.backupId }, new FakeCtx());
  if (!outcome.result.ok || outcome.stored === null) throw new Error('no plan');
  (s as unknown as { plans: Map<string, StoredFolderPlan> }).plans.set(outcome.stored.planId, outcome.stored);
  return { planId: outcome.stored.planId, hash: outcome.stored.hash, stored: outcome.stored };
}

const select = (planId: string, hash: string, unticked: string[] = []) => ({ planId, hash, unticked, untickedFolders: [] as string[], included: [] as string[] });

beforeEach(() => {
  rig = makeRig();
  w = new World(rig, { seed: 71, drives: [{ caseInsensitive: true }] });
  f = new FolderWorld(w);
  now = w.nowMs;
});
afterEach(() => {
  w.dispose();
  rig.close();
});

describe('starting a look', () => {
  it('only for a folder backup that exists, one at a time, titled with the backup name', () => {
    const s = make();
    expect(s.startLook('x')).toMatchObject({ ok: false });
    expect(s.startLook(0)).toMatchObject({ ok: false });
    expect(s.startLook(9999)).toMatchObject({ ok: false, message: 'That folder backup does not exist.' });
    expect(s.startLook(w.profileId)).toMatchObject({ ok: false }); // the phone backup is not a folder backup
    const first = s.startLook(f.backupId);
    expect(first).toMatchObject({ ok: true, jobId: 1 });
    expect(created[0]).toMatchObject({ kind: FOLDER_LOOK_JOB_KIND, title: expect.stringContaining('Look at the folder') });
    active = [{ id: 1, kind: FOLDER_LOOK_JOB_KIND, state: 'running' } as JobRecord];
    expect(s.startLook(f.backupId)).toMatchObject({ ok: false, message: expect.stringContaining('already waiting or running') });
  });
});

describe('confirming a list', () => {
  it('starts the copy only for the plan main made (id and hash), once, and not when it is old or something else is running', async () => {
    const s = make();
    f.put('a/one.txt', 'one');
    f.put('a/two.txt', 'two!');
    const p = await look(s);
    expect((await s.confirmSliced(select('nope', p.hash))).ok).toBe(false);
    expect(await s.confirmSliced(select(p.planId, 'wrong'))).toMatchObject({ ok: false, message: 'The list on screen is not the list Backup Hub made. Nothing was copied.' });
    active = [{ id: 7, kind: FOLDER_BACKUP_JOB_KIND, state: 'running' } as JobRecord];
    expect(await s.confirmSliced(select(p.planId, p.hash))).toMatchObject({ ok: false, message: expect.stringContaining('already waiting or running') });
    active = [];
    const started = await s.confirmSliced(select(p.planId, p.hash, ['/source/a/two.txt']));
    expect(started).toMatchObject({ ok: true });
    const name = w.db.prepare('SELECT name FROM backup_profiles WHERE id = ?').pluck().get(f.backupId) as string;
    expect(created[0]).toMatchObject({ kind: FOLDER_BACKUP_JOB_KIND, title: `Back up ${name} now (1 file, 0 MB)` });
    // The plan is spent: a second click starts nothing.
    expect(await s.confirmSliced(select(p.planId, p.hash))).toMatchObject({ ok: false });
    expect(created).toHaveLength(1);
  });

  it('a plan older than an hour is refused', async () => {
    const s = make();
    f.put('a/one.txt', 'one');
    const p = await look(s);
    now += PLAN_LIFETIME_MS + 1;
    expect(await s.confirmSliced(select(p.planId, p.hash))).toMatchObject({ ok: false, message: 'That plan is more than an hour old. Make a new one. Nothing was copied.' });
  });

  it('nothing ticked starts nothing, and an exclusion saved after the list was made is honoured', async () => {
    const s = make();
    f.put('a/one.txt', 'one');
    f.put('b/two.txt', 'two!');
    const p = await look(s);
    expect(await s.confirmSliced(select(p.planId, p.hash, ['/source/a/one.txt', '/source/b/two.txt']))).toMatchObject({ ok: false, message: 'Nothing is ticked. Nothing was copied.' });
    new RulesStore(w.db).add(f.backupId, { scope: 'folder', pattern: '/source/b', choice: 'leave_out' });
    const started = await s.confirmSliced(select(p.planId, p.hash));
    expect(started.ok).toBe(true);
    expect(created[0]!.title).toContain('(1 file, 0 MB)');
  });

  it('a drive that must not be written to refuses the copy', async () => {
    const s = new FolderBackupService({ ...f.deps, now: () => now, writeProtected: () => 'The T7 is read-only.' }, { create: () => 1, list: () => [] });
    f.put('a/one.txt', 'one');
    const p = await look(s);
    expect(await s.confirmSliced(select(p.planId, p.hash))).toMatchObject({ ok: false, message: 'The T7 is read-only. Nothing was copied.' });
  });
});

describe('the cards and the exclusions', () => {
  it('lists the folder backups that are on, with their drive and whether it is plugged in', async () => {
    const s = make();
    expect((await s.cards()).cards).toEqual([{ backupId: f.backupId, backupName: expect.stringContaining('Folder'), sourceWords: 'C:\\Fake\\OneDrive', driveLabel: expect.any(String), driveConnected: true, layout: 'dated' }]);
    w.drives[0]!.unplug();
    expect((await s.cards()).cards[0]!.driveConnected).toBe(false);
    w.db.prepare('UPDATE backup_profiles SET enabled = 0 WHERE id = ?').run(f.backupId);
    expect((await s.cards()).cards).toEqual([]);
  });

  it('shows what an exclusion would do to the list main holds, through the same rules service as the phone backup', async () => {
    const s = make();
    f.put('Games/a.sav', 'aaaa');
    f.put('Docs/b.txt', 'bb');
    const p = await look(s);
    const rules = new RulesService({ db: w.db, plans: { effectFiles: (id, planId) => s.effectFiles(id, planId) } });
    expect(await rules.effect({ backupId: f.backupId, planId: p.planId, change: { kind: 'add', draft: { scope: 'folder', pattern: '/source/Games', choice: 'leave_out' } } })).toMatchObject({ ok: true, hasPlan: true, leavesOut: { files: 1, bytes: 4 } });
    expect(rules.add({ backupId: f.backupId, scope: 'file', pattern: '/sdcard/DCIM/a.jpg', choice: 'leave_out' })).toMatchObject({ ok: false });
    const saved = rules.add({ backupId: f.backupId, scope: 'folder', pattern: '/source/Games', choice: 'leave_out' });
    expect(saved).toMatchObject({ ok: true, added: true });
    expect(rules.list(f.backupId)).toMatchObject({ ok: true, rules: [{ words: 'Never back up: Games (folder)' }] });
  });
});
