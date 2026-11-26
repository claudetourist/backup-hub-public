import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobService } from '../../jobs/jobService';
import { PhoneBackupService } from '../../phoneBackup/phoneBackupService';
import { RulesService } from '../../rules/rulesService';
import { RulesStore } from '../../rules/rulesStore';
import type { RuleDraft } from '../../../shared/rules';
import { ProductWorld } from './phoneBackupWorld.testutil';
import { makeRig, World, type Rig } from './world.testutil';

/**
 * "Your choices" through the real plan, the real service and the real run in the fake world (R1.2b part 1): the person's choices come
 * before the built-in filters, the most specific one wins, a file left out by a choice is shown as its own group and never silently gone,
 * and a choice never removes a file from the phone or the drive.
 */
describe('your choices in the plan and the copy', () => {
  let rig: Rig;
  let w: World;
  let p: ProductWorld;
  let jobs: JobService;
  let service: PhoneBackupService;
  let rules: RulesService;
  let store: RulesStore;

  const waitFor = async (cond: () => boolean, ms = 20_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  beforeEach(() => {
    rig = makeRig();
    w = new World(rig, { seed: 21, drives: [{ caseInsensitive: true, tornWrites: true }, { caseInsensitive: true }] });
    p = new ProductWorld(w);
    jobs = new JobService({ db: rig.db });
    service = new PhoneBackupService(p.deps, jobs);
    for (const h of service.handlers()) jobs.register(h);
    jobs.start();
    rules = new RulesService({ db: rig.db, plans: service, pause: async () => undefined });
    store = new RulesStore(rig.db);
    w.tick(60);
    for (const [path, text] of [
      ['/sdcard/DCIM/Camera/a.jpg', 'photo a'],
      ['/sdcard/DCIM/Camera/b.jpg', 'photo b is a bit longer'],
      ['/sdcard/DCIM/Camera/c.JPG', 'photo c'],
      ['/sdcard/DCIM/Camera/d.txt', 'notes d'],
      ['/sdcard/WhatsApp/Media/.Statuses/s1.jpg', 'status one'],
      ['/sdcard/WhatsApp/Media/.Statuses/s2.mp4', 'status two'],
      ['/sdcard/Download/x.tmp', 'temporary x'],
      ['/sdcard/Download/never.pdf', 'never pdf'],
      ['/sdcard/Android/data/com.x/files/a.bin', 'app data'],
    ] as const)
      w.createFile(path, text);
  });
  afterEach(() => {
    jobs.shutdown();
    w.dispose();
    rig.close();
  });

  const add = (draft: RuleDraft): void => {
    const r = store.add(w.profileId, draft);
    if (!r.ok) throw new Error(r.message);
  };
  const look = async (): Promise<Extract<NonNullable<ReturnType<PhoneBackupService['preview']>>, { ok: true }>> => {
    const started = service.startLook(w.profileId);
    await waitFor(() => jobs.get(started.jobId!)?.state === 'done');
    const preview = service.preview(started.jobId!);
    if (!preview?.ok) throw new Error('no plan');
    return preview;
  };

  it('without any choice only the built-in filters leave files out', async () => {
    const { outcome } = await p.plan();
    const s = outcome.stored!;
    expect(s.items.map((i) => i.path).toSorted()).toEqual(['/sdcard/DCIM/Camera/a.jpg', '/sdcard/DCIM/Camera/b.jpg', '/sdcard/DCIM/Camera/c.JPG', '/sdcard/DCIM/Camera/d.txt', '/sdcard/Download/never.pdf', '/sdcard/WhatsApp/Media/.Statuses/s1.jpg', '/sdcard/WhatsApp/Media/.Statuses/s2.mp4']);
    expect(s.buckets.map((b) => [b.filter, b.rule, b.files.length]).toSorted()).toEqual([['android_data', null, 1], ['temporary_file', null, 1]]);
    expect(s.ruledBuiltin.size).toBe(0);
  });

  it('choices come before the filters, the most specific wins, and every left-out file is shown in a group of its own', async () => {
    add({ scope: 'folder', pattern: '/sdcard/WhatsApp/Media/.Statuses', choice: 'leave_out' });
    add({ scope: 'pattern', pattern: '*.jpg', choice: 'leave_out' });
    add({ scope: 'file', pattern: '/sdcard/DCIM/Camera/b.jpg', choice: 'include' }); // a file beats a kind of file
    add({ scope: 'folder', pattern: '/sdcard/Download', choice: 'include' }); // brings x.tmp back from the filters
    add({ scope: 'file', pattern: '/sdcard/Download/never.pdf', choice: 'leave_out' }); // a file beats a folder
    add({ scope: 'folder', pattern: '/sdcard/Android/data/com.x', choice: 'include' }); // brings the app data back

    const { outcome } = await p.plan();
    const s = outcome.stored!;
    expect(s.items.map((i) => i.path).toSorted()).toEqual(['/sdcard/Android/data/com.x/files/a.bin', '/sdcard/DCIM/Camera/b.jpg', '/sdcard/DCIM/Camera/d.txt', '/sdcard/Download/x.tmp']);
    // the files a filter would have dropped are remembered as such (so a later change can be counted)
    expect(s.ruledBuiltin.get('/sdcard/Download/x.tmp')).toBe('temporary_file');
    expect(s.ruledBuiltin.get('/sdcard/Android/data/com.x/files/a.bin')).toBe('android_data');
    expect(s.ruledBuiltin.get('/sdcard/DCIM/Camera/b.jpg')).toBeNull();
    // one group per choice, with the choice's plain words; none can be included for this run (they are changed in Your choices)
    const view = outcome.result.ok ? outcome.result.plan : null;
    expect(view).not.toBeNull();
    const groups = view!.leftOut.map((g) => ({ files: g.files, words: g.rule?.words ?? null, canInclude: g.canInclude, filter: g.filter }));
    expect(groups.toSorted((a, b) => (a.words! < b.words! ? -1 : 1))).toEqual([
      { files: 2, words: 'Never back up: .jpg files (this kind of file)', canInclude: false, filter: 'your_rule' },
      { files: 1, words: 'Never back up: Download/never.pdf (file)', canInclude: false, filter: 'your_rule' },
      { files: 2, words: 'Never back up: WhatsApp/Media/.Statuses (folder)', canInclude: false, filter: 'your_rule' },
    ]);
    expect(view!.leftOut.every((g) => g.key.startsWith('rule:'))).toBe(true);
    // left out on purpose is kept apart from to copy: 4 to copy, 5 left out, the 4 listed above plus nothing silently gone
    expect(view!.totals.files).toBe(4);
    expect(view!.leftOut.reduce((n, g) => n + g.files, 0)).toBe(5);
    expect(view!.rows.map((r) => r.path)).toEqual(expect.not.arrayContaining(['/sdcard/DCIM/Camera/a.jpg', '/sdcard/Download/never.pdf']));
  });

  it('a choice saved after the plan is still kept in force when the copy is confirmed, and nothing is removed anywhere', async () => {
    const preview = await look();
    expect(preview.plan.rows.map((r) => r.path)).toContain('/sdcard/DCIM/Camera/d.txt');
    // "Never back up .txt files" is saved while the list is open; the window did not untick anything
    add({ scope: 'pattern', pattern: '*.txt', choice: 'leave_out' });
    const started = service.confirm({ planId: preview.plan.planId, hash: preview.plan.hash, unticked: [], untickedFolders: [], included: [] });
    expect(started.ok).toBe(true);
    await waitFor(() => ['done', 'done_warnings', 'failed'].includes(jobs.get(started.jobId!)?.state ?? ''));
    const copied = service.copied(started.jobId!)!.files.map((f) => f.path);
    expect(copied).not.toContain('/sdcard/DCIM/Camera/d.txt');
    expect(copied).toContain('/sdcard/DCIM/Camera/a.jpg');
    expect(copied).toHaveLength(preview.plan.totals.files - 1);
    // the phone still has every file, the drive's old files are untouched (nothing was deleted or replaced)
    for (const f of w.phone.walk()) expect(w.phone.read(f.path).length).toBeGreaterThan(0);
    expect(w.phone.walk().map((f) => f.path)).toContain('/sdcard/DCIM/Camera/d.txt');
    expect(w.removals).toEqual([]);
  });

  it('an excluded file is dropped at confirm even if the window still ticks it; undone before the confirm, it is copied in the same run', async () => {
    const preview = await look();
    const every = preview.plan.rows.map((r) => r.path);
    expect(every).toContain('/sdcard/DCIM/Camera/d.txt');
    // Exclude two files while the list is open; the window sends them ticked on purpose.
    add({ scope: 'file', pattern: '/sdcard/DCIM/Camera/d.txt', choice: 'leave_out' });
    add({ scope: 'file', pattern: '/sdcard/DCIM/Camera/a.jpg', choice: 'leave_out' });
    // Undo of the second one (rules.remove with confirmed, as the Undo button does) before the confirm.
    const listed = rules.list(w.profileId);
    if (!listed.ok) throw new Error(listed.message);
    const second = listed.rules.find((r) => r.pattern === '/sdcard/DCIM/Camera/a.jpg')!;
    expect(rules.remove({ backupId: w.profileId, ruleId: second.id, confirmed: true }).ok).toBe(true);
    const started = service.confirm({ planId: preview.plan.planId, hash: preview.plan.hash, unticked: [], untickedFolders: [], included: [] });
    expect(started.ok).toBe(true);
    await waitFor(() => ['done', 'done_warnings', 'failed'].includes(jobs.get(started.jobId!)?.state ?? ''));
    const copied = service.copied(started.jobId!)!.files.map((f) => f.path);
    expect(copied).not.toContain('/sdcard/DCIM/Camera/d.txt');
    expect(copied).toContain('/sdcard/DCIM/Camera/a.jpg');
    expect(copied).toHaveLength(every.length - 1);
    // The count on the Backups row is the real number of exclusions.
    expect(store.countLeftOut(w.profileId)).toBe(1);
  });

  it('the effect is counted over the plan the service holds: leaves out, brings back, and the plain line without a plan', async () => {
    expect(await rules.effect({ backupId: w.profileId, change: { kind: 'add', draft: { scope: 'folder', pattern: '/sdcard/DCIM', choice: 'leave_out' } } })).toMatchObject({ ok: true, hasPlan: false });
    const preview = await look();
    // only the files under DCIM are left out by this choice
    const dcim = preview.plan.rows.filter((r) => r.path.startsWith('/sdcard/DCIM/'));
    const bytes = dcim.reduce((n, r) => n + r.size, 0);
    expect(dcim.length).toBeGreaterThan(0);
    expect(await rules.effect({ backupId: w.profileId, planId: preview.plan.planId, change: { kind: 'add', draft: { scope: 'folder', pattern: '/sdcard/DCIM', choice: 'leave_out' } } })).toMatchObject({ ok: true, hasPlan: true, backupName: preview.plan.backupName, leavesOut: { files: dcim.length, bytes }, bringsBack: { files: 0, bytes: 0 } });
    // the filters' own groups: "Always include" on the Download group brings the temporary file back
    const download = preview.plan.leftOut.find((g) => g.filter === 'temporary_file')!;
    expect(await rules.effect({ backupId: w.profileId, planId: preview.plan.planId, change: { kind: 'add', draft: { scope: 'folder', pattern: download.folder, choice: 'include' } } })).toMatchObject({ ok: true, leavesOut: { files: 0 }, bringsBack: { files: 1 } });
    // a plan of another backup is never used, and a made-up plan id answers with the plain line only
    expect(await rules.effect({ backupId: w.profileId, planId: 'nope', change: { kind: 'add', draft: { scope: 'folder', pattern: '/sdcard/DCIM', choice: 'leave_out' } } })).toMatchObject({ ok: true, hasPlan: false });
    expect(service.effectFiles(w.profileId + 1)).toBeNull();
  });

  it('the counts of "Check old copies" read the same choices: a file left out by a choice is left out, an included one is not', async () => {
    await look();
    const before = await service.checkOldCounts(w.profileId);
    if (!before.ok) throw new Error(before.message);
    add({ scope: 'folder', pattern: '/sdcard/Download', choice: 'include' }); // x.tmp is wanted now
    add({ scope: 'file', pattern: '/sdcard/Download/never.pdf', choice: 'leave_out' });
    add({ scope: 'pattern', pattern: '*.bin', choice: 'include' }); // a choice comes before the filters, so the app data is wanted
    service.countsChanged(); // what the rules handler does
    let after = await service.checkOldCounts(w.profileId);
    for (let i = 0; i < 100 && after.ok && after.stale === true; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      after = await service.checkOldCounts(w.profileId);
    }
    if (!after.ok) throw new Error(after.message);
    expect(before.total.onPhone).toEqual(after.total.onPhone);
    // before: x.tmp and a.bin left out by filters; after: never.pdf left out by a choice, the other two wanted
    expect(before.total.leftOut.files).toBe(2);
    expect(after.total.leftOut.files).toBe(1);
    expect(after.total.leftOut.bytes).toBe('never pdf'.length);
  });
});
