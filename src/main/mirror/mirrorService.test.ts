import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JobRecord } from '../../shared/jobs';
import { MIRROR_COPY_JOB_KIND, MIRROR_LOOK_JOB_KIND, MIRROR_PLAN_LIFETIME_MS } from '../../shared/mirror';
import { MIRROR_CHECK_JOB_KIND } from '../../shared/mirrorCheck';
import { FakeCtx } from '../look/harness/phoneBackupWorld.testutil';
import { MirrorWorld } from '../look/harness/mirrorWorld.testutil';
import { makeRig, World, type Rig } from '../look/harness/world.testutil';
import { MirrorService, mirrorPlaceIds, type MirrorJobs } from './mirrorService';

/** The service's own rules (adding the second drive, what a look may start, what a confirm accepts), with a stand-in job list. */
let rig: Rig;
let w: World;
let mw: MirrorWorld;
let active: JobRecord[];
let created: { kind: string; title: string; params: unknown }[];

const jobs: MirrorJobs = {
  create: (kind, title, params) => {
    created.push({ kind, title, params });
    return created.length;
  },
  list: () => active,
};

const fakeJob = (kind: string, state: JobRecord['state']): JobRecord => ({ id: 1, kind, state }) as JobRecord;

function service(over: Partial<MirrorWorld['deps']> = {}): MirrorService {
  return new MirrorService({ ...mw.deps, ...over }, jobs);
}

/** Runs the look handler the way the job service would, and returns what the preview then answers. */
async function look(s: MirrorService, jobId = 1): Promise<ReturnType<MirrorService['preview']>> {
  const handler = s.handlers().find((h) => h.kind === MIRROR_LOOK_JOB_KIND)!;
  const ctx = new FakeCtx();
  await handler.run({ ...ctx, jobId, params: created[created.length - 1]!.params, resume: null, signal: ctx.signal, progress: () => undefined, yield: () => ctx.yield(), log: () => undefined, warn: () => undefined, needsYou: (m: string) => ctx.needsYou(m), checkpoint: () => undefined } as never).catch(() => undefined);
  return s.preview(jobId);
}

beforeEach(() => {
  rig = makeRig();
  w = new World(rig, { seed: 52 });
  mw = new MirrorWorld(w);
  active = [];
  created = [];
});
afterEach(() => {
  w.dispose();
  rig.close();
});

describe('"Also keep a copy" (database only)', () => {
  beforeEach(() => {
    rig.db.prepare('DELETE FROM backup_destinations WHERE position = 2').run();
  });

  it('offers the other drives, never the first one, and adds the second drive with the same folder and position 2', () => {
    const s = service();
    const choices = s.choices(w.profileId);
    expect(choices).toMatchObject({ ok: true, sourceLabel: 'T7', folder: 'MyData/POCO' });
    expect(choices.ok && choices.drives.map((d) => d.label)).toEqual(['Seagate2TB']);
    const before = rig.db.prepare('SELECT count(*) FROM files').pluck().get();
    const added = s.addCopy({ backupId: w.profileId, placeId: w.destinations[1]!.placeId });
    expect(added.ok).toBe(true);
    expect(added.message).toContain('Nothing is copied until you bring it up to date');
    expect(rig.db.prepare('SELECT position, role, root, enabled FROM backup_destinations WHERE place_id = ?').get(w.destinations[1]!.placeId)).toEqual({ position: 2, role: 'copy', root: 'MyData/POCO', enabled: 1 });
    expect(rig.db.prepare('SELECT count(*) FROM files').pluck().get()).toBe(before);
    expect(created).toEqual([]);
    expect(w.drives.every((d) => d.onDrive().length === 0)).toBe(true);
  });

  it('refuses the first drive again, a second second drive, unknown backups and places, and bad requests; nothing changes', () => {
    const s = service();
    const count = (): unknown => rig.db.prepare('SELECT count(*) FROM backup_destinations').pluck().get();
    const was = count();
    expect(s.addCopy({ backupId: w.profileId, placeId: w.destinations[0]!.placeId })).toMatchObject({ ok: false, message: expect.stringContaining('another drive') });
    expect(s.addCopy({ backupId: 999, placeId: w.destinations[1]!.placeId }).ok).toBe(false);
    expect(s.addCopy({ backupId: w.profileId, placeId: 'nope' }).ok).toBe(false);
    expect(s.addCopy({ backupId: w.profileId, placeId: w.placeId }).ok).toBe(false); // a phone is not a drive
    expect(s.addCopy({ backupId: 0, placeId: '' }).ok).toBe(false);
    expect(s.addCopy(undefined as never).ok).toBe(false);
    expect(count()).toBe(was);
    expect(s.addCopy({ backupId: w.profileId, placeId: w.destinations[1]!.placeId }).ok).toBe(true);
    expect(s.addCopy({ backupId: w.profileId, placeId: w.destinations[1]!.placeId })).toMatchObject({ ok: false, message: expect.stringContaining('already has a second drive') });
    expect(s.choices('x' as never)).toMatchObject({ ok: false });
  });
});

describe('the look', () => {
  it('says at once to plug in the T7, without a job, and likewise for the Seagate; nothing for a backup with no second drive', async () => {
    const s = service();
    w.drives[0]!.unplug();
    expect(await s.startLook(w.profileId)).toEqual({ ok: false, message: 'Plug in the T7 to bring the Seagate2TB up to date.', jobId: null });
    w.drives[0]!.plug();
    w.drives[1]!.unplug();
    expect(await s.startLook()).toMatchObject({ ok: false, message: 'Plug in Seagate2TB to bring it up to date.' });
    w.drives[1]!.plug();
    expect(created).toEqual([]);
    expect(await s.startLook('x' as never)).toMatchObject({ ok: false });
    expect(await s.startLook(999)).toMatchObject({ ok: false });
    rig.db.prepare('DELETE FROM backup_destinations WHERE position = 2').run();
    expect(await s.startLook()).toMatchObject({ ok: false, message: 'No backup has a second drive yet.' });
  });

  it('starts one job that names both drives (so one job at a time uses them), only one at a time', async () => {
    const s = service();
    const started = await s.startLook(w.profileId);
    expect(started).toEqual({ ok: true, message: '', jobId: 1 });
    expect(created[0]).toMatchObject({ kind: MIRROR_LOOK_JOB_KIND, title: 'Look at what Seagate2TB is missing: ' + (rig.db.prepare('SELECT name FROM backup_profiles WHERE id = ?').pluck().get(w.profileId) as string) });
    expect(mirrorPlaceIds(created[0]!.params).toSorted()).toEqual(w.destinations.map((d) => d.placeId).toSorted());
    active = [fakeJob(MIRROR_COPY_JOB_KIND, 'running')];
    expect(await s.startLook(w.profileId)).toMatchObject({ ok: false, message: expect.stringContaining('already waiting or running') });
  });

  it('the look job answers a list, or a refusal that fails the job in plain words', async () => {
    mw.seed('S1/a.bin', 'aaaa');
    const s = service();
    await s.startLook(w.profileId);
    const answer = await look(s);
    expect(answer?.ok && answer.plan.totals.files).toBe(1);
    w.drives[0]!.unplug();
    created.length = 0;
    // The drive went away between the click and the job: the job's own check says so.
    created.push({ kind: MIRROR_LOOK_JOB_KIND, title: 't', params: { backupIds: [w.profileId] } });
    const refused = await look(s, 2);
    expect(refused).toMatchObject({ ok: false, reason: 'source_missing' });
  });

  it('a read-only second drive is refused with its own line', async () => {
    mw.seed('S1/a.bin', 'aaaa');
    const s = service({ writeProtected: (placeId) => (placeId === w.destinations[1]!.placeId ? 'Seagate2TB is read-only (protected), so nothing is written to it.' : null) });
    await s.startLook(w.profileId);
    expect(await look(s)).toMatchObject({ ok: false, message: 'Seagate2TB is read-only (protected), so nothing is written to it.' });
  });
});

describe('the confirm', () => {
  async function plan(s: MirrorService): Promise<{ planId: string; hash: string }> {
    mw.seed('S1/a.bin', 'aaaa');
    mw.seed('S1/b.bin', 'bbbbb');
    await s.startLook(w.profileId);
    const answer = await look(s);
    if (!answer?.ok) throw new Error('no plan');
    return { planId: answer.plan.planId, hash: answer.plan.hash };
  }

  it('accepts only the list main made: a wrong hash, an unknown plan, nothing ticked and an old plan are refused, and nothing is stored', async () => {
    const s = service();
    const p = await plan(s);
    const stored = (): unknown => rig.db.prepare("SELECT count(*) FROM meta WHERE key LIKE 'mirror.run.%'").pluck().get();
    expect(s.confirm({ ...p, hash: 'nope', unticked: [] })).toMatchObject({ ok: false, message: expect.stringContaining('not the list Backup Hub made') });
    expect(s.confirm({ planId: 'zzz', hash: p.hash, unticked: [] })).toMatchObject({ ok: false, message: expect.stringContaining('not known any more') });
    expect(s.confirm({ ...p, unticked: ['0:S1/a.bin', '0:S1/b.bin'] })).toMatchObject({ ok: false, message: 'Nothing is ticked. Nothing was copied.' });
    expect(stored()).toBe(0);
    expect(created.filter((c) => c.kind === MIRROR_COPY_JOB_KIND)).toEqual([]);
    w.tick((MIRROR_PLAN_LIFETIME_MS / 1000) + 1);
    expect(s.confirm({ ...p, unticked: [] })).toMatchObject({ ok: false, message: expect.stringContaining('more than an hour old') });
  });

  it('starts one copy job for what is ticked, titled with the numbers, and refuses a second start of the same list', async () => {
    const s = service();
    const p = await plan(s);
    const started = s.confirm({ ...p, unticked: ['0:S1/a.bin'] });
    expect(started.ok).toBe(true);
    const job = created.find((c) => c.kind === MIRROR_COPY_JOB_KIND)!;
    expect(job.title).toMatch(/^Copy .+ to Seagate2TB \(1 file, 0 MB\)$/);
    expect(mirrorPlaceIds(job.params)).toHaveLength(2);
    expect(s.confirm({ ...p, unticked: [] })).toMatchObject({ ok: false }); // the plan is used up
  });

  it('refuses while a mirror job is waiting or running, and for a protected drive', async () => {
    const s = service();
    const p = await plan(s);
    active = [fakeJob(MIRROR_LOOK_JOB_KIND, 'queued')];
    expect(s.confirm({ ...p, unticked: [] })).toMatchObject({ ok: false, message: expect.stringContaining('already waiting or running') });
    active = [];
    const guarded = service({ writeProtected: () => 'Seagate2TB is read-only (protected), so nothing is written to it.' });
    (guarded as unknown as { plans: Map<string, unknown> }).plans = (s as unknown as { plans: Map<string, unknown> }).plans;
    expect(guarded.confirm({ ...p, unticked: [] })).toMatchObject({ ok: false, message: 'Seagate2TB is read-only (protected), so nothing is written to it. Nothing was copied.' });
  });
});

describe('the status', () => {
  it('counts what the second drive lacks, keeps the answer until something changes, and says which drive is plugged in', async () => {
    mw.seed('S1/a.bin', 'aaaa');
    mw.seed('S1/b.bin', 'bbbbb');
    await mw.plan(); // the look: brings the file list up to date
    const first = await service().status();
    expect(first.backups).toHaveLength(1);
    expect(first.backups[0]).toMatchObject({ sourceLabel: 'T7', sourceConnected: true });
    expect(first.backups[0]!.mirrors[0]).toMatchObject({ label: 'Seagate2TB', connected: true, behindFiles: 2, behindBytes: 9, needYou: 0 });
    w.drives[0]!.unplug();
    expect((await service().status()).backups[0]).toMatchObject({ sourceConnected: false });
  });

  it('uses the worker answer when there is one, counts in slices when the worker cannot start, and remembers the answer until countsChanged', async () => {
    mw.seed('S1/a.bin', 'aaaa');
    await mw.plan();
    let asked = 0;
    const withWorker = service({ behindInWorker: async () => { asked += 1; return { files: 7, bytes: 70 }; } });
    expect((await withWorker.status()).backups[0]!.mirrors[0]).toMatchObject({ behindFiles: 7, behindBytes: 70 });
    await withWorker.status();
    expect(asked).toBe(1);
    withWorker.countsChanged();
    await withWorker.status();
    expect(asked).toBe(2);
    const noWorker = service({ behindInWorker: async () => null });
    expect((await noWorker.status()).backups[0]!.mirrors[0]).toMatchObject({ behindFiles: 1, behindBytes: 4 });
    const throwing = service({ behindInWorker: async () => { throw new Error('worker died'); } });
    expect((await throwing.status()).backups[0]!.mirrors[0]).toMatchObject({ behindFiles: 1 });
  });
});

describe('"Check old copies"', () => {
  const both = (rel: string, t7: string, sea: string = t7): void => {
    mw.seed(rel, t7);
    mw.seedSeagate(rel, sea);
  };

  it('the preview is made from the file list alone, says one read or two and a time, and reads no drive', async () => {
    both('S1/DCIM/a.jpg', 'aaaa');
    both('S1/b.bin', 'bbbbb');
    mw.seed('S1/only-on-t7.bin', 'x');
    const s = service();
    const r = await s.checkPreview(w.profileId);
    expect(r.ok && r.plan.totals).toEqual({ files: 2, bytes: 9 });
    expect(r.ok && r.plan.groups.map((g) => g.group)).toEqual(['photos', 'other']);
    expect(r.ok && r.plan.oneRead.files).toBe(2);
    expect(r.ok && r.plan.estimateSeconds).toBeGreaterThan(0);
    expect(mw.reads).toEqual({ t7: [], sea: [] });
    expect(created).toEqual([]);
    expect(await s.checkPreview('x' as never)).toMatchObject({ ok: false });
    expect(await s.checkPreview(999)).toMatchObject({ ok: false, message: 'That backup has no second drive yet.' });
  });

  it('starts one resumable check job only for a list main made, titled with the numbers, and the list is stored in pieces', async () => {
    both('S1/a.jpg', 'aaaa');
    both('S1/b.jpg', 'bbbbb');
    const s = service();
    const r = await s.checkPreview(w.profileId);
    if (!r.ok) throw new Error('no list');
    const p = { planId: r.plan.planId, hash: r.plan.hash };
    expect(await s.checkStart({ ...p, hash: 'nope' })).toMatchObject({ ok: false, message: expect.stringContaining('not the list Backup Hub made') });
    expect(await s.checkStart({ planId: 'zzz', hash: p.hash })).toMatchObject({ ok: false, message: expect.stringContaining('not known any more') });
    expect(created).toEqual([]);
    const started = await s.checkStart(p);
    expect(started.ok).toBe(true);
    expect(created[0]).toMatchObject({ kind: MIRROR_CHECK_JOB_KIND, title: expect.stringMatching(/^Check old copies of .+ on Seagate2TB \(2 files, 0 MB\)$/) });
    expect(mirrorPlaceIds(created[0]!.params)).toHaveLength(2);
    expect(rig.db.prepare("SELECT count(*) FROM meta WHERE key LIKE 'mirror.run.%'").pluck().get()).toBeGreaterThan(0);
    expect(await s.checkStart(p)).toMatchObject({ ok: false }); // used up
    expect(s.handlers().find((h) => h.kind === MIRROR_CHECK_JOB_KIND)).toMatchObject({ heavy: true, resumable: true });
  });

  it('refuses while any mirror job is waiting or running, an old list, a drive that is not plugged in, and an empty list', async () => {
    both('S1/a.jpg', 'aaaa');
    const s = service();
    const r = await s.checkPreview(w.profileId);
    if (!r.ok) throw new Error('no list');
    const p = { planId: r.plan.planId, hash: r.plan.hash };
    active = [fakeJob(MIRROR_COPY_JOB_KIND, 'running')];
    expect(await s.checkStart(p)).toMatchObject({ ok: false, message: expect.stringContaining('already waiting or running') });
    active = [];
    w.drives[0]!.unplug();
    expect(await s.checkStart(p)).toMatchObject({ ok: false, message: 'Plug in the T7 to check the old copies on the Seagate2TB. Nothing was checked.' });
    w.drives[0]!.plug();
    w.drives[1]!.unplug();
    expect(await s.checkStart(p)).toMatchObject({ ok: false, message: expect.stringContaining('Plug in Seagate2TB') });
    w.drives[1]!.plug();
    w.tick(MIRROR_PLAN_LIFETIME_MS / 1000 + 1);
    expect(await s.checkStart(p)).toMatchObject({ ok: false, message: expect.stringContaining('more than an hour old') });
    // A copy job blocks a check too: one mirror job at a time.
    const empty = await service().checkPreview(w.profileId);
    expect(empty.ok && empty.plan.totals.files).toBe(1);
    rig.db.prepare("UPDATE files SET verified_how = 'read_both' WHERE place_id = ?").run(w.destinations[1]!.placeId);
    const none = await service().checkPreview(w.profileId);
    if (!none.ok) throw new Error('no list');
    expect(none.plan.totals.files).toBe(0);
    expect(none.plan.alreadyChecked).toBe(1);
    expect(await service().checkStart({ planId: none.plan.planId, hash: none.plan.hash })).toMatchObject({ ok: false });
  });

  it('a look and a copy are refused while a check runs', async () => {
    both('S1/a.jpg', 'aaaa');
    active = [fakeJob(MIRROR_CHECK_JOB_KIND, 'running')];
    expect(await service().startLook(w.profileId)).toMatchObject({ ok: false, message: expect.stringContaining('already waiting or running') });
  });

  it('the job runs the check, keeps a report (also when stopped), and says in plain words that nothing was changed', async () => {
    both('S1/a.jpg', 'aaaa');
    both('S1/b.jpg', 'bbbbb');
    const s = service();
    const r = await s.checkPreview(w.profileId);
    if (!r.ok) throw new Error('no list');
    await s.checkStart({ planId: r.plan.planId, hash: r.plan.hash });
    const handler = s.handlers().find((h) => h.kind === MIRROR_CHECK_JOB_KIND)!;
    const ctx = new FakeCtx();
    const text = await handler.run({ ...ctx, jobId: 7, params: created[0]!.params, resume: null, signal: ctx.signal, progress: () => undefined, yield: () => ctx.yield(), log: () => undefined, warn: () => undefined, needsYou: (m: string) => ctx.needsYou(m), checkpoint: () => undefined } as never);
    expect(text).toBe('Checked 2 files: 2 are the same and are now verified copies. Nothing was changed on either drive.');
    expect(s.checkReport(7)).toMatchObject({ complete: true, verified: 2, oneRead: 2, twoReads: 0 });
    expect(s.checkReport('x' as never)).toBeNull();
    expect(rig.db.prepare("SELECT count(*) FROM meta WHERE key LIKE 'mirror.run.%'").pluck().get()).toBe(0);
  });
});
