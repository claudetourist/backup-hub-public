import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RulesStore } from '../../rules/rulesStore';
import { ONLINE_ONLY_REASON } from '../../../shared/folderBackup';
import { KEEP_SYNC_PARTS } from '../../../shared/appFolders';
import { FolderWorld } from './folderWorld.testutil';
import { sha256Of } from './fakeDrive.testutil';
import { makeRig, World, type Rig } from './world.testutil';

/**
 * R2.1 Folder backups in the fake world (PLAN section 8): the real look, plan and run against an unkind T7 and a folder whose files can be
 * locked or online only. Every test ends with the invariants of PLAN 3c: nothing overwritten, nothing deleted, no index row without its file.
 */
let rig: Rig;
let w: World;
beforeEach(() => {
  rig = makeRig();
  w = new World(rig, { seed: 21, drives: [{ caseInsensitive: true }] });
});
afterEach(() => {
  w.dispose();
  rig.close();
});

const paths = (rows: { path: string }[]): string[] => rows.map((r) => r.path).toSorted();

describe('what is new or changed (size OR date)', () => {
  it('copies new files and files whose size or date differ, and leaves files that are already in the backup alone', async () => {
    const f = new FolderWorld(w);
    const T = w.nowSec - 1000;
    f.put('Docs/same.txt', 'same-content', T);
    f.seedCopy('Docs/same.txt', 'same-content', { mtimeSec: T });
    f.put('Docs/bigger.txt', 'new-longer-content', T);
    f.seedCopy('Docs/bigger.txt', 'old', { mtimeSec: T });
    f.put('Docs/touched.txt', 'abcdeg', T + 60);
    f.seedCopy('Docs/touched.txt', 'abcdef', { mtimeSec: T });
    f.put('Docs/near.txt', 'near-same', T + 1);
    f.seedCopy('Docs/near.txt', 'near-same', { mtimeSec: T });
    f.put('New/fresh.txt', 'fresh');
    const before = f.durable();

    const { outcome } = await f.plan();
    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) return;
    const plan = outcome.result.plan;
    expect(paths(plan.rows)).toEqual(['/source/Docs/bigger.txt', '/source/Docs/touched.txt', '/source/New/fresh.txt']);
    expect(plan.rows.find((r) => r.path.endsWith('bigger.txt'))!.kind).toBe('changed');
    expect(plan.rows.find((r) => r.path.endsWith('touched.txt'))!.kind).toBe('changed');
    expect(plan.rows.find((r) => r.path.endsWith('fresh.txt'))!.kind).toBe('new');
    expect(plan.alreadyBackedUp).toBe(2);
    expect(plan.layout).toBe('dated');
    expect(outcome.stored!.items.every((i) => i.destRel.startsWith(`${f.root}/${f.sessionFolder}/`))).toBe(true);

    const run = await f.backup();
    expect(run.report!.copied.files).toBe(3);
    expect(f.src.reads.toSorted()).toEqual(['Docs/bigger.txt', 'Docs/touched.txt', 'New/fresh.txt']);
    const after = f.durable();
    expect(after.get(`${f.root}/${f.sessionFolder}/New/fresh.txt`)).toBe(sha256Of('fresh'));
    expect(after.get(`${f.root}/${f.sessionFolder}/Docs/bigger.txt`)).toBe(sha256Of('new-longer-content'));
    expect(f.violations(before)).toEqual([]);
    // The old copies are still there, with their old content.
    expect(after.get(`${f.root}/OneDrive-05Jul26/Docs/bigger.txt`)).toBe(sha256Of('old'));
  });

  it('a second run right after a finished run copies nothing', async () => {
    const f = new FolderWorld(w);
    f.put('a/one.txt', '111');
    f.put('b/two.txt', '2222');
    expect((await f.backup()).report!.copied.files).toBe(2);
    const again = await f.backup();
    expect(again.plan.result.ok && again.plan.result.plan.totals.files).toBe(0);
    expect(again.plan.result.ok && again.plan.result.plan.alreadyBackedUp).toBe(2);
  });

  it('a date off by exact whole hours is confirmed by the checksum: the same content is linked, other content is copied', async () => {
    const f = new FolderWorld(w);
    const T = w.nowSec - 5000;
    f.put('h/same.txt', '12345', T + 3600);
    const sameCopy = f.seedCopy('h/same.txt', '12345', { mtimeSec: T, sha: false });
    f.put('h/diff.txt', '12346', T + 3600);
    f.seedCopy('h/diff.txt', '12345', { mtimeSec: T });
    const before = f.durable();
    const run = await f.backup();
    expect(run.plan.result.ok && run.plan.result.plan.rows).toHaveLength(2);
    expect(run.report!.copied.files).toBe(1);
    expect(run.report!.linked).toBe(1);
    expect(f.violations(before)).toEqual([]);
    // The older copy now points at the folder's file; nothing about it changed.
    const copy = w.db.prepare('SELECT origin_file_id, size FROM files WHERE id = ?').get(sameCopy) as { origin_file_id: number | null; size: number };
    expect(copy.origin_file_id).toBe(f.rowOf('h/same.txt'));
    expect(copy.size).toBe(5);
  });
});

describe('the same content under another name is linked, not copied', () => {
  it('found by the checksum the file list knows (plan time): already backed up, the copy is linked to its file', async () => {
    const f = new FolderWorld(w);
    f.put('p/photo.jpg', 'JPEG-bytes');
    await f.src.look();
    w.db.prepare('UPDATE files SET sha256 = ? WHERE id = ?').run(sha256Of('JPEG-bytes'), f.rowOf('p/photo.jpg'));
    const old = f.seedCopy('whatever.jpg', 'JPEG-bytes', { session: 'OneDrive-01Jan25', origin: null });
    const before = f.durable();
    const run = await f.backup();
    expect(run.plan.result.ok && run.plan.result.plan.totals.files).toBe(0);
    expect(run.plan.result.ok && run.plan.result.plan.sameContentElsewhere).toBe(1);
    expect(run.plan.stored!.relinks).toHaveLength(1);
    expect(run.report!.copied.files).toBe(0);
    expect(w.db.prepare('SELECT origin_file_id FROM files WHERE id = ?').pluck().get(old)).toBe(f.rowOf('p/photo.jpg'));
    expect(f.violations(before)).toEqual([]);
  });

  it('found after the file was read once (no checksum known): the copy is dropped, nothing new lands on the drive, and the next plan knows', async () => {
    const f = new FolderWorld(w);
    f.put('p/photo.jpg', 'JPEG-bytes');
    f.seedCopy('whatever.jpg', 'JPEG-bytes', { session: 'OneDrive-01Jan25', origin: null });
    const before = f.durable();
    const run = await f.backup();
    expect(run.plan.result.ok && run.plan.result.plan.totals.files).toBe(1);
    expect(run.report!.copied.files).toBe(0);
    expect(run.report!.linked).toBe(1);
    expect(f.durable()).toEqual(before);
    expect(f.violations(before)).toEqual([]);
    const next = await f.plan();
    expect(next.outcome.result.ok && next.outcome.result.plan.totals.files).toBe(0);
    expect(next.outcome.result.ok && next.outcome.result.plan.alreadyBackedUp).toBe(1);
  });
});

describe('files in use', () => {
  it('a locked file is skipped, listed in the report, and copied by the next run once it is free', async () => {
    const f = new FolderWorld(w);
    f.put('ok/a.txt', 'aaa');
    f.put('lock/outlook.pst', 'locked-data', undefined, { locked: true });
    f.put('ok/b.txt', 'bbbb');
    const before = f.durable();
    const run = await f.backup();
    expect(run.report!.copied.files).toBe(2);
    expect(run.report!.inUseCount).toBe(1);
    expect(run.report!.inUse[0]!.examples).toEqual(['lock/outlook.pst']);
    expect(run.report!.failed).toEqual([]);
    expect(w.db.prepare('SELECT count(*) FROM files WHERE place_id = ? AND rel_path LIKE ?').pluck().get(f.drivePlace, '%outlook%')).toBe(0);
    expect(f.violations(before)).toEqual([]);
    // Tried again next time.
    f.src.files.get('lock/outlook.pst')!.locked = false;
    const second = await f.backup();
    expect(second.plan.result.ok && second.plan.result.plan.rows.map((r) => r.path)).toEqual(['/source/lock/outlook.pst']);
    expect(second.report!.copied.files).toBe(1);
    expect(second.report!.inUseCount).toBe(0);
  });
});

describe('OneDrive files that are online only are never read', () => {
  it('are counted and listed, not in the copy list, and no content is ever read', async () => {
    const f = new FolderWorld(w, { cloudAware: true });
    f.put('d/local.txt', 'on this pc');
    f.put('d/online1.docx', 'cloud-1', undefined, { cloud: true });
    f.put('d/online2.docx', 'cloud-22', undefined, { cloud: true });
    const run = await f.backup();
    const plan = run.plan.result.ok ? run.plan.result.plan : null;
    expect(plan!.rows.map((r) => r.path)).toEqual(['/source/d/local.txt']);
    expect(plan!.onlineOnly.files).toBe(2);
    expect(plan!.onlineOnly.bytes).toBe(15);
    expect(plan!.onlineOnly.examples.toSorted()).toEqual(['d/online1.docx', 'd/online2.docx']);
    expect(run.report!.onlineOnly.files).toBe(2);
    expect(f.src.cloudReads).toEqual([]);
    expect(f.src.reads).toEqual(['d/local.txt']);
  });

  it('the index flag counts a file without asking Windows; a file Windows cannot answer for counts as online only', async () => {
    const f = new FolderWorld(w, { cloudAware: true });
    f.src.flagCloudInIndex = true;
    f.put('d/flagged.docx', 'flagged', undefined, { cloud: true });
    f.put('d/unsure.docx', 'unsure');
    f.src.unknown.add('d/unsure.docx');
    f.put('d/fine.txt', 'fine');
    const { outcome } = await f.plan();
    const plan = outcome.result.ok ? outcome.result.plan : null;
    expect(plan!.onlineOnly.files).toBe(2);
    expect(f.src.cloudAsked).not.toContain('d/flagged.docx');
    expect(plan!.rows.map((r) => r.path)).toEqual(['/source/d/fine.txt']);
  });

  it('a file that went online only after the list was made is skipped at the last moment, never opened', async () => {
    const f = new FolderWorld(w, { cloudAware: true });
    f.put('d/a.txt', 'aaaa');
    f.put('d/b.txt', 'bbbb');
    const planned = await f.plan();
    expect(planned.outcome.result.ok && planned.outcome.result.plan.totals.files).toBe(2);
    // OneDrive hands the space back after the list was made: Windows is asked again before each file is opened.
    f.src.files.get('d/b.txt')!.cloud = true;
    const run = await f.backup({ plan: planned.outcome });
    expect(run.report!.copied.files).toBe(1);
    expect(run.report!.onlineOnly.files).toBe(1);
    expect(run.report!.skipped.map((l) => l.reason)).toEqual([ONLINE_ONLY_REASON]);
    expect(f.src.cloudReads).toEqual([]);
    expect(f.src.reads).toEqual(['d/a.txt']);
  });
});

describe('the drive and the app can fail anywhere', () => {
  it('the drive unplugged in the middle of the copy: the run asks for Continue, carries on, and copies nothing twice', async () => {
    const f = new FolderWorld(w);
    for (let i = 0; i < 6; i += 1) f.put(`d/f${i}.bin`, `content-${i}-${'x'.repeat(3000)}`);
    const before = f.durable();
    const run = await f.backup({ unplugAfter: 25, onAsk: () => w.drives[0]!.plug() });
    expect(run.report).not.toBeNull();
    expect(run.ctx.questions.length).toBeGreaterThan(0);
    expect(run.report!.copied.files + run.report!.linked).toBe(6);
    expect(f.violations(before)).toEqual([]);
    expect([...f.durable().keys()].filter((p) => p.includes('/d/f'))).toHaveLength(6);
  });

  it('killed at every one of its steps, then Continue: every file ends up copied once, nothing overwritten or lost', async () => {
    const make = (): FolderWorld => {
      const f = new FolderWorld(w);
      f.put('a/one.txt', 'one-' + 'x'.repeat(2500));
      f.put('a/two.txt', 'two-' + 'y'.repeat(1500));
      f.put('b/three.txt', 'three');
      return f;
    };
    // A full run first, to know how many steps it takes.
    const probe = make();
    const full = await probe.backup();
    expect(full.report!.copied.files).toBe(3);
    w.dispose();
    rig.close();
    let killedPoints = 0;
    for (let at = 1; at <= 60; at += 3) {
      rig = makeRig();
      w = new World(rig, { seed: 21 + at, drives: [{ caseInsensitive: true }, { caseInsensitive: true }] });
      const f = make();
      f.seedCopy('old/keep.txt', 'older copy', { session: 'OneDrive-05Jul26' });
      const before = f.durable();
      const first = await f.backup({ crashAfter: at });
      if (first.crashed) killedPoints += 1;
      let last = first;
      if (first.crashed) last = (await f.continueRun(first)) as typeof first;
      expect(last.report, `crash after ${at}`).not.toBeNull();
      expect(f.violations(before), `crash after ${at}`).toEqual([]);
      const durable = f.durable();
      for (const name of ['a/one.txt', 'a/two.txt', 'b/three.txt']) expect([...durable.keys()].some((p) => p.endsWith('/' + name)), `${name} after crash ${at}`).toBe(true);
      const again = await f.plan();
      expect(again.outcome.result.ok && again.outcome.result.plan.totals.files, `nothing left after crash ${at}`).toBe(0);
      w.dispose();
      rig.close();
    }
    expect(killedPoints).toBeGreaterThan(5);
    rig = makeRig();
    w = new World(rig, { seed: 1, drives: [{ caseInsensitive: true }] });
  }, 60_000);
});

describe('never overwrite, never delete', () => {
  it('a different file that is already at the name is never replaced: it is a problem in the report', async () => {
    const f = new FolderWorld(w);
    f.put('x/a.txt', 'the new content');
    const planned = await f.plan();
    // After the list was made, a different file lands exactly where the copy would go.
    const path = `${f.root}/${f.sessionFolder}/x/a.txt`;
    w.drives[0]!.write(path, 'somebody else', w.nowSec);
    w.drives[0]!.flush(path);
    f.everContent.add(sha256Of('somebody else'));
    const before = f.durable();
    const run = await f.backup({ plan: planned.outcome });
    expect(run.report!.copied.files).toBe(0);
    expect(run.report!.failed[0]!.reason).toContain('A different file is already at this name');
    expect(f.durable().get(path)).toBe(sha256Of('somebody else'));
    expect(f.violations(before)).toEqual([]);
  });

  it('a file that changed in the folder after the list was made is left for the next backup', async () => {
    const f = new FolderWorld(w);
    f.put('x/a.txt', 'first version');
    const planned = await f.plan();
    expect(planned.outcome.result.ok).toBe(true);
    f.put('x/a.txt', 'second version is longer');
    const { report } = await f.backup({ plan: planned.outcome });
    expect(report!.copied.files).toBe(0);
    expect(report!.skipped[0]!.reason).toContain('changed after the list was made');
    expect(w.drives[0]!.onDrive().filter((d) => d.path.includes('/x/'))).toHaveLength(0);
  });
});

describe('look first: a look that did not finish plans nothing', () => {
  it('an incomplete look of the folder', async () => {
    const f = new FolderWorld(w);
    f.put('a.txt', 'a');
    f.src.lookResult = { complete: false, rootMissing: false, message: 'EIO: a folder could not be read' };
    const { outcome } = await f.plan();
    expect(outcome.result.ok).toBe(false);
    expect(!outcome.result.ok && outcome.result.message).toContain('Nothing was planned');
    expect(outcome.stored).toBeNull();
  });

  it('a folder that is missing (OneDrive signed out)', async () => {
    const f = new FolderWorld(w);
    f.src.lookResult = { complete: false, rootMissing: true, message: null };
    const { outcome } = await f.plan();
    expect(!outcome.result.ok && outcome.result.message).toContain('could not be found');
  });

  it('a folder that looks empty where files were before', async () => {
    const f = new FolderWorld(w);
    f.put('a.txt', 'a');
    await f.src.look();
    f.src.files.clear();
    const { outcome } = await f.plan();
    expect(!outcome.result.ok && outcome.result.message).toContain('looks empty');
  });

  it('a drive that is not plugged in', async () => {
    const f = new FolderWorld(w);
    f.put('a.txt', 'a');
    w.drives[0]!.unplug();
    const { outcome } = await f.plan();
    expect(!outcome.result.ok && outcome.result.message).toContain('not plugged in');
  });
});

describe('your exclusions', () => {
  it('a folder, a file and a kind the person never wants backed up are left out with their own group and never copied', async () => {
    const f = new FolderWorld(w);
    f.put('Docs/keep.txt', 'keep');
    f.put('Docs/drop.tmp', 'tmp');
    f.put('Games/save.dat', 'save');
    f.put('Games/deep/more.dat', 'more');
    f.put('Mail/inbox.pst', 'pst');
    const rules = new RulesStore(w.db);
    expect(rules.add(f.backupId, { scope: 'folder', pattern: '/source/Games', choice: 'leave_out' }).ok).toBe(true);
    expect(rules.add(f.backupId, { scope: 'pattern', pattern: '*.tmp', choice: 'leave_out' }).ok).toBe(true);
    expect(rules.add(f.backupId, { scope: 'file', pattern: '/source/Mail/inbox.pst', choice: 'leave_out' }).ok).toBe(true);
    const run = await f.backup();
    const plan = run.plan.result.ok ? run.plan.result.plan : null;
    expect(plan!.rows.map((r) => r.path)).toEqual(['/source/Docs/keep.txt']);
    expect(plan!.leftOut.map((g) => g.files).toSorted()).toEqual([1, 1, 2]);
    expect(plan!.leftOut.every((g) => g.filter === 'your_rule' && g.rule !== undefined)).toBe(true);
    expect(f.src.reads).toEqual(['Docs/keep.txt']);
  });

  it('only a path of the right form can be saved for a folder backup', () => {
    const f = new FolderWorld(w);
    const rules = new RulesStore(w.db);
    expect(rules.add(f.backupId, { scope: 'file', pattern: '/sdcard/DCIM/a.jpg', choice: 'leave_out' }).ok).toBe(false);
    expect(rules.add(f.backupId, { scope: 'folder', pattern: '/source', choice: 'leave_out' }).ok).toBe(false);
    expect(rules.add(f.backupId, { scope: 'folder', pattern: '/source/Photos', choice: 'leave_out' }).ok).toBe(true);
  });
});

describe('the Google Keep notes: a flat, add-only copy', () => {
  const KEEP = KEEP_SYNC_PARTS.join('/');

  it('copies the files that are missing, skips the same name and size, leaves another size alone, and never deletes when a source file is gone', async () => {
    const f = new FolderWorld(w, { flat: true, root: KEEP });
    f.put('keep-20260101-000000.jsonl.gz', 'aaa');
    f.seedCopy('keep-20260101-000000.jsonl.gz', 'aaa');
    f.put('keep-20260102-000000.jsonl.gz', 'bbbb');
    f.put('keep-20260103-000000.jsonl.gz', 'cccccc');
    f.seedCopy('keep-20260103-000000.jsonl.gz', 'xx');
    f.put('20260105-101010/keep.txt', 'dddd');
    const before = f.durable();
    const run = await f.backup();
    const plan = run.plan.result.ok ? run.plan.result.plan : null;
    expect(plan!.layout).toBe('flat');
    expect(plan!.rows.map((r) => r.path).toSorted()).toEqual(['/source/20260102-101010'.replace('20260102', '20260105') + '/keep.txt', '/source/keep-20260102-000000.jsonl.gz']);
    expect(plan!.alreadyBackedUp).toBe(1);
    expect(plan!.differentOnDrive).toBe(1);
    expect(run.report!.copied.files).toBe(2);
    const after = f.durable();
    expect(after.get(`${KEEP}/keep-20260102-000000.jsonl.gz`)).toBe(sha256Of('bbbb'));
    expect(after.get(`${KEEP}/20260105-101010/keep.txt`)).toBe(sha256Of('dddd'));
    // The file with another size is untouched.
    expect(after.get(`${KEEP}/keep-20260103-000000.jsonl.gz`)).toBe(sha256Of('xx'));
    expect(f.violations(before)).toEqual([]);

    // keep-sync thins its own snapshots: a source file disappears, the copy stays.
    f.src.files.delete('keep-20260102-000000.jsonl.gz');
    const second = await f.backup();
    expect(second.plan.result.ok && second.plan.result.plan.totals.files).toBe(0);
    expect(f.durable().get(`${KEEP}/keep-20260102-000000.jsonl.gz`)).toBe(sha256Of('bbbb'));
    expect(f.violations(f.durable())).toEqual([]);
  });

  it('keeps no row in the file list for the notes themselves', async () => {
    const f = new FolderWorld(w, { flat: true, root: KEEP });
    f.put('keep-20260101-000000.jsonl.gz', 'aaa');
    expect((await f.backup()).report!.copied.files).toBe(1);
    expect(w.db.prepare('SELECT origin_file_id FROM files WHERE place_id = ? AND rel_path LIKE ?').pluck().get(f.drivePlace, '%keep-2026%')).toBeNull();
    // The notes' names never get a row of their own in the file list (no Files search, no "Why?").
    expect(w.db.prepare('SELECT count(*) FROM files WHERE place_id = ?').pluck().get(f.laptopPlace)).toBe(0);
  });
});
