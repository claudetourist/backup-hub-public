import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openDatabase, runMigrations } from '../db';
import { BackupProfileStore } from '../backupProfiles/profileStore';
import { addPlace, makeRig, type Rig } from '../backupProfiles/fixtures.testutil';
import { COPY_EXCLUSIONS_SQL } from '../db/migrations/0023_backup_rules';
import { pythonExt } from '../phoneBackup/filterModel';
import { draftCovers, draftProblem, fileExtension, NOT_COVERED_ITEMS, patternExtension, ruleWords, type BackupRule, type RuleChoice, type RuleScope } from '../../shared/rules';
import { effectSteps } from './effect';
import { compileRules, isLeftOut } from './ruleMatcher';
import { RulesService, type EffectSource } from './rulesService';
import { RulesStore } from './rulesStore';
import { finishSync } from '../sliceWork';

const rule = (id: number, scope: RuleScope, pattern: string, choice: RuleChoice, extra: Partial<BackupRule> = {}): BackupRule => ({ id, backupId: 1, scope, pattern, choice, destination: null, note: null, createdAt: 0, ...extra });

describe('migration 0023 (your choices)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-rules-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is version 23 (R1.6 takes the next free number)', () => {
    expect(MIGRATIONS[22]).toMatchObject({ version: 23, name: 'backup_rules' });
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it('a fresh database has the two tables and no choices', () => {
    const rig = makeRig();
    try {
      const tables = (rig.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
      expect(tables).toEqual(expect.arrayContaining(['backup_rules', 'backup_checklist', 'backup_exclusions']));
      expect(rig.db.prepare('SELECT count(*) FROM backup_rules').pluck().get()).toBe(0);
      expect(() => rig.db.prepare("INSERT INTO backup_rules (scope, pattern, choice, created_at) VALUES ('glob', 'x', 'leave_out', 1)").run()).toThrow(/CHECK/);
      expect(() => rig.db.prepare("INSERT INTO backup_rules (scope, pattern, choice, created_at) VALUES ('file', 'x', 'maybe', 1)").run()).toThrow(/CHECK/);
    } finally {
      rig.close();
    }
  });

  it('copies every old exclusion in as a leave_out choice, keeps backup_exclusions as it was, and a second copy adds nothing', () => {
    const db = openDatabase(path.join(dir, 'old.db'));
    try {
      runMigrations(db, MIGRATIONS.slice(0, 22));
      const profile = db.prepare("INSERT INTO backup_profiles (person_id, name, source_kind, folder_prefix, change_rule, created_at) VALUES (1, ?, 'phone', ?, 'size_and_date', 1)");
      profile.run('One', 'ONE');
      profile.run('Two', 'TWO');
      const ins = db.prepare('INSERT INTO backup_exclusions (backup_profile_id, source_path, added_at) VALUES (?, ?, ?)');
      ins.run(1, '/sdcard/Download/never.pdf', 111);
      ins.run(1, '/sdcard/Games/', 222);
      ins.run(2, '/sdcard/Download/never.pdf', 333);
      ins.run(2, '/', 444);
      const before = db.prepare('SELECT * FROM backup_exclusions ORDER BY backup_profile_id, source_path').all();
      expect(runMigrations(db)).toMatchObject({ from: 22, to: MIGRATIONS.length });
      expect(db.prepare('SELECT * FROM backup_exclusions ORDER BY backup_profile_id, source_path').all()).toEqual(before);
      const rules = db.prepare('SELECT backup_id, scope, pattern, choice, destination, created_at FROM backup_rules ORDER BY backup_id, pattern').all();
      expect(rules).toEqual([
        { backup_id: 1, scope: 'file', pattern: '/sdcard/Download/never.pdf', choice: 'leave_out', destination: null, created_at: 111 },
        { backup_id: 1, scope: 'folder', pattern: '/sdcard/Games', choice: 'leave_out', destination: null, created_at: 222 },
        { backup_id: 2, scope: 'file', pattern: '/sdcard/Download/never.pdf', choice: 'leave_out', destination: null, created_at: 333 },
      ]);
      db.exec(COPY_EXCLUSIONS_SQL);
      db.exec(COPY_EXCLUSIONS_SQL);
      expect(db.prepare('SELECT count(*) FROM backup_rules').pluck().get()).toBe(3);
    } finally {
      db.close();
    }
  });

  it('a database with no exclusions gets no choices; the unique index refuses a repeat', () => {
    const db = openDatabase(path.join(dir, 'empty.db'));
    try {
      runMigrations(db);
      expect(db.prepare('SELECT count(*) FROM backup_rules').pluck().get()).toBe(0);
      const ins = db.prepare("INSERT INTO backup_rules (backup_id, scope, pattern, choice, created_at) VALUES (?, 'file', '/sdcard/a', 'leave_out', 1)");
      ins.run(null);
      expect(() => ins.run(null)).toThrow(/UNIQUE/);
      ins.run(1);
    } finally {
      db.close();
    }
  });
});

describe('the matcher: which choice applies to a phone path', () => {
  const FILE_INC = rule(1, 'file', '/sdcard/A/B/keep.jpg', 'include');
  const DEEP = rule(2, 'folder', '/sdcard/A/B', 'include');
  const SHALLOW = rule(3, 'folder', '/sdcard/A', 'leave_out');
  const KIND = rule(4, 'pattern', '*.JPG', 'leave_out');
  const OTHER_KIND = rule(5, 'pattern', '*.mp4', 'include');
  const m = compileRules([FILE_INC, DEEP, SHALLOW, KIND, OTHER_KIND]);

  it('precedence: file, then the deepest folder, then a shallower folder, then a kind of file', () => {
    const table: [string, number | null][] = [
      ['/sdcard/A/B/keep.jpg', 1], // a file beats everything
      ['/sdcard/A/B/other.jpg', 2], // the deeper folder beats the shallower one and the kind
      ['/sdcard/A/B/C/deep.txt', 2], // a subfolder is inside
      ['/sdcard/A/x.txt', 3],
      ['/sdcard/A/x.jpg', 3], // a folder beats a kind of file
      ['/sdcard/Z/y.JpG', 4], // a kind of file is matched in any case
      ['/sdcard/Z/y.jpg', 4],
      ['/sdcard/Z/clip.MP4', 5],
      ['/sdcard/Z/y.png', null],
      ['/sdcard/AB/x.txt', null], // the folder boundary: "A" is not "AB"
      ['/sdcard/a/x.txt', null], // phone paths are case-sensitive
      ['/sdcard/Z/.nomedia', null], // no extension
    ];
    for (const [p, id] of table) expect(m.match(p)?.id ?? null, p).toBe(id);
  });

  it('on a tie include wins, and among equals the older choice; the order of the list never matters', () => {
    const a = rule(7, 'folder', '/sdcard/T', 'leave_out');
    const b = rule(8, 'folder', '/sdcard/T/', 'include', { backupId: null });
    expect(compileRules([a, b]).match('/sdcard/T/x')?.id).toBe(8);
    expect(compileRules([b, a]).match('/sdcard/T/x')?.id).toBe(8);
    const c = rule(9, 'pattern', '*.txt', 'leave_out');
    const d = rule(6, 'pattern', '*.TXT', 'leave_out');
    expect(compileRules([c, d]).match('/sdcard/q.txt')?.id).toBe(6);
    expect(compileRules([d, c]).match('/sdcard/q.txt')?.id).toBe(6);
  });

  it('a choice for one destination is not used yet, and only "*.ext" is a kind of file', () => {
    const only = compileRules([rule(1, 'file', '/sdcard/a.jpg', 'leave_out', { destination: 'google' }), rule(2, 'pattern', '*.j*', 'leave_out'), rule(3, 'pattern', 'jpg', 'leave_out')]);
    expect(only.count).toBe(0);
    expect(only.match('/sdcard/a.jpg')).toBeNull();
  });

  it('one rule of "left out": the person decides when a choice applies, else the built-in filter', () => {
    expect(isLeftOut(null, () => 'cache_folder')).toBe(true);
    expect(isLeftOut(null, () => null)).toBe(false);
    expect(isLeftOut(rule(1, 'file', '/sdcard/a', 'include'), () => 'cache_folder')).toBe(false);
    expect(isLeftOut(rule(1, 'file', '/sdcard/a', 'leave_out'), () => null)).toBe(true);
  });

  it('is fast: 60,000 paths against 200 choices under 200 ms', () => {
    const rules: BackupRule[] = [];
    for (let i = 0; i < 100; i += 1) rules.push(rule(i + 1, 'folder', `/sdcard/Android/media/com.app${i}/files`, i % 2 === 0 ? 'leave_out' : 'include'));
    for (let i = 0; i < 50; i += 1) rules.push(rule(101 + i, 'file', `/sdcard/DCIM/Camera/IMG_${i}.jpg`, 'leave_out'));
    for (let i = 0; i < 50; i += 1) rules.push(rule(151 + i, 'pattern', `*.x${i}`, 'leave_out'));
    const paths: string[] = [];
    for (let i = 0; i < 60_000; i += 1) paths.push(i % 3 === 0 ? `/sdcard/Android/media/com.app${i % 130}/files/sub${i % 7}/f${i}.bin` : i % 3 === 1 ? `/sdcard/DCIM/Camera/IMG_${i}.jpg` : `/sdcard/Download/deep/er/est/f${i}.x${i % 60}`);
    // The best of three runs: a busy machine (the whole suite runs in parallel) can slow one run, not all three.
    let best = Infinity;
    let hits = 0;
    for (let run = 0; run < 3; run += 1) {
      const t0 = performance.now();
      const compiled = compileRules(rules);
      hits = 0;
      for (const p of paths) if (compiled.match(p) !== null) hits += 1;
      best = Math.min(best, performance.now() - t0);
    }
    expect(hits).toBeGreaterThan(10_000);
    expect(best).toBeLessThan(200);
  });

  it('the extension of the matcher is the extension of the old filters', () => {
    for (const p of ['/sdcard/a/b.JPG', '/sdcard/DCIM/.nomedia', '/sdcard/a/..x', '/sdcard/a/x.tar.gz', '/sdcard/a/noext', '/sdcard/a/.x.mp4']) expect(fileExtension(p)).toBe(pythonExt(p).toLowerCase());
    expect(patternExtension('*.JPG')).toBe('.jpg');
    expect(patternExtension('*.')).toBeNull();
    expect(patternExtension('*.a-b')).toBeNull();
  });
});

describe('what may be saved', () => {
  it('a file or a folder below /sdcard, or a kind of file; nothing wider, nothing odd', () => {
    const ok = (scope: RuleScope, pattern: string): string | null => draftProblem({ scope, pattern, choice: 'leave_out' });
    expect(ok('file', '/sdcard/DCIM/a.jpg')).toBeNull();
    expect(ok('folder', '/sdcard/DCIM/Camera/')).toBeNull();
    expect(ok('pattern', '*.jpg')).toBeNull();
    expect(ok('folder', '/sdcard')).toMatch(/whole phone/);
    expect(ok('folder', '/sdcard/')).toMatch(/whole phone/);
    expect(ok('folder', '/storage/x')).not.toBeNull();
    expect(ok('file', '/sdcard/DCIM/')).not.toBeNull();
    expect(ok('file', '/etc/passwd')).not.toBeNull();
    expect(ok('file', '/sdcard/../etc/x')).not.toBeNull();
    expect(ok('file', '/sdcard/a\0b')).not.toBeNull();
    expect(ok('file', '')).not.toBeNull();
    expect(ok('pattern', '*')).not.toBeNull();
    expect(ok('pattern', '*.j*')).not.toBeNull();
    expect(ok('pattern', '/sdcard/x.jpg')).not.toBeNull();
    expect(draftProblem({ scope: 'file', pattern: '/sdcard/a', choice: 'delete' as RuleChoice })).not.toBeNull();
    expect(draftProblem({ scope: 'regex' as RuleScope, pattern: '/sdcard/a', choice: 'include' })).not.toBeNull();
  });

  it('says what a choice names, in plain words', () => {
    expect(ruleWords(rule(1, 'folder', '/sdcard/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/.Statuses', 'leave_out'))).toBe('Never back up: Android/media/com.whatsapp.w4b/WhatsApp Business/Media/.Statuses (folder)');
    expect(ruleWords(rule(1, 'file', '/sdcard/DCIM/a.jpg', 'leave_out'))).toBe('Never back up: DCIM/a.jpg (file)');
    expect(ruleWords(rule(1, 'pattern', '*.JPG', 'include'))).toBe('Always include: .jpg files (this kind of file)');
    for (const r of [rule(1, 'folder', '/sdcard/a', 'leave_out'), rule(1, 'pattern', '*.a', 'include')]) expect(ruleWords(r)).not.toMatch(/rule|pattern|scope|profile|destination/i);
  });

  it('a draft names the same files the matcher would', () => {
    expect(draftCovers({ scope: 'folder', pattern: '/sdcard/A', choice: 'leave_out' }, '/sdcard/A/x')).toBe(true);
    expect(draftCovers({ scope: 'folder', pattern: '/sdcard/A', choice: 'leave_out' }, '/sdcard/AB/x')).toBe(false);
    expect(draftCovers({ scope: 'pattern', pattern: '*.JPG', choice: 'leave_out' }, '/sdcard/x.jpg')).toBe(true);
    expect(draftCovers({ scope: 'file', pattern: '/sdcard/x.jpg', choice: 'leave_out' }, '/sdcard/x.jpg')).toBe(true);
  });
});

describe('the store of choices and of things no backup can copy', () => {
  let rig: Rig;
  let store: RulesStore;
  beforeEach(() => {
    rig = makeRig();
    store = new RulesStore(rig.db, () => 5000);
  });
  afterEach(() => rig.close());

  it('saves, repeats without change, refuses the opposite for the same thing, lists with the ones for every backup, and removes', () => {
    const a = store.add(1, { scope: 'folder', pattern: '/sdcard/Games/', choice: 'leave_out' });
    expect(a).toMatchObject({ ok: true, added: true, rule: { scope: 'folder', pattern: '/sdcard/Games', choice: 'leave_out', backupId: 1, destination: null, createdAt: 5000 } });
    expect(store.add(1, { scope: 'folder', pattern: '/sdcard/Games', choice: 'leave_out' })).toMatchObject({ ok: true, added: false });
    expect(store.add(1, { scope: 'folder', pattern: '/sdcard/Games', choice: 'include' })).toMatchObject({ ok: false, message: expect.stringMatching(/the other way/) });
    expect(store.add(1, { scope: 'pattern', pattern: '*.TMP', choice: 'leave_out' })).toMatchObject({ ok: true, rule: { pattern: '*.tmp' } });
    expect(store.add(1, { scope: 'folder', pattern: '/sdcard', choice: 'leave_out' })).toMatchObject({ ok: false });
    rig.db.prepare("INSERT INTO backup_rules (backup_id, scope, pattern, choice, created_at) VALUES (NULL, 'file', '/sdcard/g.bin', 'leave_out', 1)").run();
    expect(store.list(1)).toHaveLength(3);
    expect(store.list(2)).toHaveLength(1); // only the one for every backup
    expect(store.count(1)).toBe(3);
    expect(store.compiled(1).match('/sdcard/Games/x.bin')?.pattern).toBe('/sdcard/Games');
    expect(store.remove(a.ok ? a.rule.id : 0)).toBe(true);
    expect(store.remove(9999)).toBe(false);
    expect(store.count(1)).toBe(2);
    // removing a choice touches no file row
    expect(rig.db.prepare('SELECT count(*) FROM files').pluck().get()).toBe(0);
  });

  it('keeps the ticks per backup; an unknown item is refused; an untick is remembered', () => {
    expect(store.setTick(1, 'signal', true)).toBe(true);
    expect(store.setTick(1, 'whatsapp', true)).toBe(true);
    expect(store.setTick(2, 'signal', true)).toBe(true);
    expect(store.setTick(1, 'telegram', true)).toBe(false);
    expect([...store.ticks(1).keys()].toSorted()).toEqual(['signal', 'whatsapp']);
    expect(store.setTick(1, 'signal', false)).toBe(true);
    expect([...store.ticks(1).keys()]).toEqual(['whatsapp']);
    expect([...store.ticks(2).keys()]).toEqual(['signal']);
    expect(rig.db.prepare('SELECT ticked_at FROM backup_checklist WHERE backup_id = 1 AND item = ?').pluck().get('signal')).toBeNull();
    // a second Backup Hub start (a new store on the same file) sees the same ticks
    expect([...new RulesStore(rig.db).ticks(1).keys()]).toEqual(['whatsapp']);
    expect(NOT_COVERED_ITEMS.map((i) => i.id)).toEqual(['authenticator', 'contacts_messages', 'whatsapp', 'signal', 'app_logins']);
  });

  it('the old never-back-up list still reaches the plan: addExclusion keeps a choice, removeExclusion takes it away, a deleted backup takes its choices', () => {
    addPlace(rig.db, 't7', 'drive', 'T7');
    const profiles = new BackupProfileStore(rig.db);
    const made = profiles.create({ name: 'A', sourceKind: 'phone', folderPrefix: 'A' });
    if (!made.ok) throw new Error('create');
    expect(profiles.addExclusion(made.id, '/sdcard/a.jpg')).toEqual({ ok: true, added: true });
    expect(profiles.addExclusion(made.id, '/sdcard/a.jpg')).toEqual({ ok: true, added: false });
    expect(store.list(made.id)).toMatchObject([{ scope: 'file', pattern: '/sdcard/a.jpg', choice: 'leave_out' }]);
    expect(profiles.removeExclusion(made.id, '/sdcard/a.jpg')).toEqual({ ok: true });
    expect(store.list(made.id)).toEqual([]);
    profiles.addExclusion(made.id, '/sdcard/z');
    store.add(made.id, { scope: 'pattern', pattern: '*.tmp', choice: 'leave_out' });
    store.setTick(made.id, 'signal', true);
    expect(profiles.remove(made.id)).toEqual({ ok: true, how: 'deleted' });
    expect(rig.db.prepare('SELECT count(*) FROM backup_rules WHERE backup_id = ?').pluck().get(made.id)).toBe(0);
    expect(rig.db.prepare('SELECT count(*) FROM backup_checklist WHERE backup_id = ?').pluck().get(made.id)).toBe(0);
  });
});

describe('the effect of a change', () => {
  const files = [
    { path: '/sdcard/DCIM/a.jpg', size: 10, builtin: null },
    { path: '/sdcard/DCIM/b.jpg', size: 20, builtin: null },
    { path: '/sdcard/Games/g.bin', size: 400, builtin: null },
    { path: '/sdcard/Download/x.tmp', size: 5, builtin: 'temporary_file' },
    { path: '/sdcard/Download/y.tmp', size: 6, builtin: 'temporary_file' },
  ];
  const run = (before: BackupRule[], after: BackupRule[]) => finishSync(effectSteps(files, compileRules(before), compileRules(after)));

  it('counts files that would be left out and files that would be brought back, each once', () => {
    expect(run([], [rule(1, 'pattern', '*.jpg', 'leave_out')])).toEqual({ leavesOut: { files: 2, bytes: 30 }, bringsBack: { files: 0, bytes: 0 } });
    expect(run([], [rule(1, 'folder', '/sdcard/Download', 'include')])).toEqual({ leavesOut: { files: 0, bytes: 0 }, bringsBack: { files: 2, bytes: 11 } });
    // removal is the same count the other way round
    const never = rule(1, 'folder', '/sdcard/Games', 'leave_out');
    expect(run([never], [])).toEqual({ leavesOut: { files: 0, bytes: 0 }, bringsBack: { files: 1, bytes: 400 } });
    // a file already left out by a choice is not counted again; a more specific include brings it back
    expect(run([never], [never, rule(2, 'pattern', '*.bin', 'leave_out')])).toEqual({ leavesOut: { files: 0, bytes: 0 }, bringsBack: { files: 0, bytes: 0 } });
    expect(run([never], [never, rule(2, 'file', '/sdcard/Games/g.bin', 'include')])).toEqual({ leavesOut: { files: 0, bytes: 0 }, bringsBack: { files: 1, bytes: 400 } });
    // nothing changes: nothing counted
    expect(run([never], [never])).toEqual({ leavesOut: { files: 0, bytes: 0 }, bringsBack: { files: 0, bytes: 0 } });
  });
});

describe('the service: refusals and the plain answers', () => {
  let rig: Rig;
  let service: RulesService;
  let held: { backupName: string; files: { path: string; size: number; builtin: string | null }[] } | null;
  let phoneId: number;
  let folderId: number;
  const plans: EffectSource = { effectFiles: (id) => (id === phoneId ? held : null) };

  beforeEach(() => {
    rig = makeRig();
    addPlace(rig.db, 't7', 'drive', 'T7');
    const profiles = new BackupProfileStore(rig.db);
    const p = profiles.create({ name: 'Sam phone', sourceKind: 'phone', folderPrefix: 'S' });
    const f = profiles.create({ name: 'Docs', sourceKind: 'folder', folderPrefix: 'D', sourceRoot: 'C:\\Docs' });
    if (!p.ok || !f.ok) throw new Error('create');
    phoneId = p.id;
    folderId = f.id;
    held = null;
    service = new RulesService({ db: rig.db, plans, now: () => 7000, pause: async () => undefined });
  });
  afterEach(() => rig.close());

  it('refuses bad ids, an unknown backup, a folder backup, a bad draft, an unknown item and an unconfirmed removal; nothing changes', async () => {
    for (const bad of [0, -1, 1.5, '1', null, undefined, NaN]) {
      expect(service.list(bad)).toMatchObject({ ok: false });
      expect(service.notCovered(bad)).toMatchObject({ ok: false });
    }
    expect(service.list(9999)).toMatchObject({ ok: false, message: 'That backup does not exist.' });
    // A folder backup has choices too, in the form of its own paths ("/source/..."); a phone path is refused for it.
    expect(service.list(folderId)).toMatchObject({ ok: true, rules: [] });
    expect(service.add({ backupId: folderId, scope: 'file', pattern: '/sdcard/a', choice: 'leave_out' })).toMatchObject({ ok: false });
    expect(service.add({ backupId: folderId, scope: 'folder', pattern: '/source', choice: 'leave_out' })).toMatchObject({ ok: false, message: expect.stringMatching(/whole folder/) });
    expect(service.add({ backupId: phoneId, scope: 'folder', pattern: '/sdcard', choice: 'leave_out' })).toMatchObject({ ok: false, message: expect.stringMatching(/Nothing was changed/) });
    expect(service.add({ backupId: phoneId, scope: 'file', pattern: '/etc/hosts', choice: 'leave_out' })).toMatchObject({ ok: false });
    expect(service.add({ backupId: 9999, scope: 'file', pattern: '/sdcard/a', choice: 'leave_out' })).toMatchObject({ ok: false });
    expect(service.tick({ backupId: phoneId, item: 'telegram', ticked: true })).toMatchObject({ ok: false });
    expect(service.tick({ backupId: phoneId, item: 'signal', ticked: 'yes' as unknown as boolean })).toMatchObject({ ok: false });
    expect(await service.effect({ backupId: 9999, change: { kind: 'remove', ruleId: 1 } })).toMatchObject({ ok: false });
    expect(await service.effect({ backupId: phoneId, change: { kind: 'remove', ruleId: 77 } })).toMatchObject({ ok: false });
    expect(await service.effect({ backupId: phoneId, change: { kind: 'add', draft: { scope: 'folder', pattern: '/sdcard', choice: 'leave_out' } } })).toMatchObject({ ok: false });
    expect(rig.db.prepare('SELECT count(*) FROM backup_rules').pluck().get()).toBe(0);
    expect(rig.db.prepare('SELECT count(*) FROM backup_checklist').pluck().get()).toBe(0);

    const saved = service.add({ backupId: phoneId, scope: 'file', pattern: '/sdcard/a.jpg', choice: 'leave_out' });
    if (!saved.ok) throw new Error('add');
    expect(service.remove({ backupId: phoneId, ruleId: saved.rule.id, confirmed: false })).toMatchObject({ ok: false, message: expect.stringMatching(/Please confirm/) });
    expect(service.remove({ backupId: phoneId, ruleId: saved.rule.id, confirmed: 'true' as unknown as boolean })).toMatchObject({ ok: false });
    expect(service.remove({ backupId: folderId, ruleId: saved.rule.id, confirmed: true })).toMatchObject({ ok: false });
    expect(service.count(phoneId)).toBe(1);
    expect(service.remove({ backupId: phoneId, ruleId: saved.rule.id, confirmed: true })).toEqual({ ok: true, message: 'Removed. Nothing was deleted.', count: 0 });
    expect(service.remove({ backupId: phoneId, ruleId: saved.rule.id, confirmed: true })).toMatchObject({ ok: false });
  });

  it('another backup\'s choice cannot be removed through this backup', () => {
    const profiles = new BackupProfileStore(rig.db);
    const other = profiles.create({ name: 'Other', sourceKind: 'phone', folderPrefix: 'O' });
    if (!other.ok) throw new Error('create');
    const saved = service.add({ backupId: other.id, scope: 'file', pattern: '/sdcard/a.jpg', choice: 'leave_out' });
    if (!saved.ok) throw new Error('add');
    expect(service.remove({ backupId: phoneId, ruleId: saved.rule.id, confirmed: true })).toMatchObject({ ok: false });
    expect(service.count(other.id)).toBe(1);
  });

  it('the effect: numbers over the plan held, only the plain line without a plan', async () => {
    held = {
      backupName: 'Sam phone',
      files: [
        { path: '/sdcard/Android/media/com.whatsapp/WhatsApp/Media/.Statuses/1.jpg', size: 100, builtin: null },
        { path: '/sdcard/Android/media/com.whatsapp/WhatsApp/Media/.Statuses/2.mp4', size: 900, builtin: null },
        { path: '/sdcard/DCIM/a.jpg', size: 5, builtin: null },
        { path: '/sdcard/DCIM/.thumbnails/t.jpg', size: 7, builtin: 'cache_folder' },
      ],
    };
    const folder = { scope: 'folder' as const, pattern: '/sdcard/Android/media/com.whatsapp/WhatsApp/Media/.Statuses', choice: 'leave_out' as const };
    expect(await service.effect({ backupId: phoneId, change: { kind: 'add', draft: folder } })).toEqual({ ok: true, backupName: 'Sam phone', hasPlan: true, leavesOut: { files: 2, bytes: 1000 }, bringsBack: { files: 0, bytes: 0 } });
    expect(await service.effect({ backupId: phoneId, change: { kind: 'add', draft: { scope: 'folder', pattern: '/sdcard/DCIM/.thumbnails', choice: 'include' } } })).toMatchObject({ ok: true, leavesOut: { files: 0 }, bringsBack: { files: 1, bytes: 7 } });
    // nothing is written by asking
    expect(rig.db.prepare('SELECT count(*) FROM backup_rules').pluck().get()).toBe(0);
    const saved = service.add({ backupId: phoneId, ...folder });
    if (!saved.ok) throw new Error('add');
    expect(saved).toMatchObject({ added: true, count: 1, message: 'Saved. Every later backup of Sam phone will leave this out.' });
    // the opposite choice for the same folder is refused, in the effect too
    expect(await service.effect({ backupId: phoneId, change: { kind: 'add', draft: { ...folder, choice: 'include' } } })).toMatchObject({ ok: false });
    // removing: those two files would come back
    expect(await service.effect({ backupId: phoneId, change: { kind: 'remove', ruleId: saved.rule.id } })).toMatchObject({ ok: true, hasPlan: true, leavesOut: { files: 0 }, bringsBack: { files: 2, bytes: 1000 } });
    held = null;
    expect(await service.effect({ backupId: phoneId, change: { kind: 'remove', ruleId: saved.rule.id } })).toEqual({ ok: true, backupName: 'Sam phone', hasPlan: false, leavesOut: { files: 0, bytes: 0 }, bringsBack: { files: 0, bytes: 0 } });
  });

  it('the checklist: five items, ticks remembered per backup, an untick remembered', () => {
    const first = service.notCovered(phoneId);
    expect(first).toMatchObject({ ok: true, done: 0, total: 5, backupName: 'Sam phone' });
    service.tick({ backupId: phoneId, item: 'authenticator', ticked: true });
    const second = service.tick({ backupId: phoneId, item: 'signal', ticked: true });
    expect(second).toMatchObject({ ok: true, done: 2, total: 5 });
    if (!second.ok) return;
    expect(second.items.filter((i) => i.ticked).map((i) => [i.id, i.tickedAt])).toEqual([['authenticator', 7000], ['signal', 7000]]);
    expect(service.tick({ backupId: phoneId, item: 'signal', ticked: false })).toMatchObject({ ok: true, done: 1 });
    // a service made later on the same database still knows
    expect(new RulesService({ db: rig.db, plans }).notCovered(phoneId)).toMatchObject({ done: 1 });
    for (const i of NOT_COVERED_ITEMS) expect(`${i.title} ${i.howTo}`).not.toMatch(/\b(rule|pattern|scope|profile|destination)\b/i);
  });
});
