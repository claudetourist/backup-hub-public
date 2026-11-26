import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BackupProfileStore } from '../backupProfiles/profileStore';
import { addPlace, makeRig, type Rig } from '../backupProfiles/fixtures.testutil';
import { rulePathOf } from '../folderBackup/folderPaths';
import type { BackupRule } from '../../shared/rules';
import { isLegacyWindowsPath, legacyToSourcePath, translateLegacyRules } from './legacyPaths';
import { RulesService } from './rulesService';
import { RulesStore } from './rulesStore';

const ROOT = 'C:\\Users\\user\\OneDrive';
const ZIP = 'C:\\Users\\user\\OneDrive\\IMP\\Google_Takeout\\takeout-20250202T053538Z-001.zip';

describe('old full Windows paths in the choices of a folder backup', () => {
  it('knows a full Windows path from a path of ours', () => {
    expect(isLegacyWindowsPath(ZIP)).toBe(true);
    expect(isLegacyWindowsPath('c:/Users/x/a.zip')).toBe(true);
    expect(isLegacyWindowsPath('\\\\server\\share\\a.zip')).toBe(true);
    expect(isLegacyWindowsPath('/source/IMP/a.zip')).toBe(false);
    expect(isLegacyWindowsPath('/sdcard/a.zip')).toBe(false);
    expect(isLegacyWindowsPath('*.zip')).toBe(false);
  });

  it('translates a path under the source folder to /source/<path below>, ignoring case and slash direction', () => {
    expect(legacyToSourcePath(ZIP, ROOT)).toBe('/source/IMP/Google_Takeout/takeout-20250202T053538Z-001.zip');
    expect(legacyToSourcePath(ZIP.toUpperCase(), ROOT.toLowerCase() + '\\')).toBe('/source/IMP/GOOGLE_TAKEOUT/TAKEOUT-20250202T053538Z-001.ZIP');
    expect(legacyToSourcePath('c:/users/USER/onedrive/IMP/a.zip', ROOT)).toBe('/source/IMP/a.zip');
    expect(legacyToSourcePath('\\\\?\\' + ZIP, ROOT)).toBe('/source/IMP/Google_Takeout/takeout-20250202T053538Z-001.zip');
    expect(rulePathOf('IMP/Google_Takeout/takeout-20250202T053538Z-001.zip')).toBe(legacyToSourcePath(ZIP, ROOT));
  });

  it('a path outside the source folder, the folder itself, a sibling with the same start, or a path with ".." gives nothing', () => {
    expect(legacyToSourcePath('D:\\Other\\a.zip', ROOT)).toBeNull();
    expect(legacyToSourcePath(ROOT, ROOT)).toBeNull();
    expect(legacyToSourcePath(ROOT + '\\', ROOT)).toBeNull();
    expect(legacyToSourcePath('C:\\Users\\user\\OneDrive2\\a.zip', ROOT)).toBeNull();
    expect(legacyToSourcePath(ROOT + '\\..\\x.zip', ROOT)).toBeNull();
  });

  const rule = (id: number, scope: BackupRule['scope'], pattern: string): BackupRule => ({ id, backupId: 3, scope, pattern, choice: 'leave_out', destination: null, note: null, createdAt: 0 });

  it('translate: matching drops what is outside, showing keeps it; paths of ours and kinds are untouched', () => {
    const rules = [rule(1, 'file', ZIP), rule(2, 'file', 'D:\\Other\\a.zip'), rule(3, 'folder', ROOT + '\\Old\\'), rule(4, 'file', '/source/x.txt'), rule(5, 'pattern', '*.tmp')];
    expect(translateLegacyRules(rules, ROOT, false).map((r) => [r.id, r.pattern])).toEqual([
      [1, '/source/IMP/Google_Takeout/takeout-20250202T053538Z-001.zip'],
      [3, '/source/Old'],
      [4, '/source/x.txt'],
      [5, '*.tmp'],
    ]);
    expect(translateLegacyRules(rules, ROOT, true).map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
    expect(translateLegacyRules(rules, ROOT, true)[1]!.pattern).toBe('D:\\Other\\a.zip');
  });
});

describe('the stored legacy rows work for a folder backup without being rewritten', () => {
  let rig: Rig;
  let folderId: number;
  let phoneId: number;
  beforeEach(() => {
    rig = makeRig();
    addPlace(rig.db, 't7', 'drive', 'T7');
    const profiles = new BackupProfileStore(rig.db);
    const p = profiles.create({ name: 'Sam phone', sourceKind: 'phone', folderPrefix: 'S' });
    const f = profiles.create({ name: 'OneDrive', sourceKind: 'folder', folderPrefix: 'O', sourceRoot: ROOT });
    if (!p.ok || !f.ok) throw new Error('create');
    phoneId = p.id;
    folderId = f.id;
  });
  afterEach(() => rig.close());

  it('the rule is stored as the full path, matches /source/<rel> when compiled, and a path outside the source is ignored', () => {
    const store = new RulesStore(rig.db, () => 5000);
    store.addLegacyFile(folderId, ZIP, 111);
    store.addLegacyFile(folderId, 'D:\\Other\\a.zip', 112);
    // stored as it was
    expect(rig.db.prepare('SELECT pattern FROM backup_rules WHERE backup_id = ? ORDER BY id').pluck().all(folderId)).toEqual([ZIP, 'D:\\Other\\a.zip']);
    const compiled = store.compiled(folderId);
    expect(compiled.count).toBe(1);
    expect(compiled.match(rulePathOf('IMP/Google_Takeout/takeout-20250202T053538Z-001.zip'))).toMatchObject({ choice: 'leave_out', scope: 'file' });
    expect(compiled.match(rulePathOf('IMP/Google_Takeout/other.zip'))).toBeNull();
    expect(compiled.match(rulePathOf('a.zip'))).toBeNull();
    // still stored as it was after compiling
    expect(rig.db.prepare('SELECT pattern FROM backup_rules WHERE backup_id = ? ORDER BY id').pluck().all(folderId)).toEqual([ZIP, 'D:\\Other\\a.zip']);
  });

  it('a phone backup is never translated', () => {
    const store = new RulesStore(rig.db, () => 5000);
    store.addLegacyFile(phoneId, ZIP, 111);
    expect(store.compiled(phoneId).match(rulePathOf('IMP/Google_Takeout/takeout-20250202T053538Z-001.zip'))).toBeNull();
    expect(store.compiled(phoneId).match(ZIP)).toMatchObject({ pattern: ZIP }); // as stored: a phone's paths are not ours to rewrite
  });

  it('the Exclusions list shows it by its path below the folder; one outside the source is still listed (so it can be undone)', () => {
    const store = new RulesStore(rig.db, () => 5000);
    store.addLegacyFile(folderId, ZIP, 111);
    store.addLegacyFile(folderId, 'D:\\Other\\a.zip', 112);
    const service = new RulesService({ db: rig.db, plans: { effectFiles: () => null }, now: () => 7000, pause: async () => undefined });
    const list = service.list(folderId);
    expect(list.ok && list.rules.map((r) => [r.pattern, r.words])).toEqual([
      ['/source/IMP/Google_Takeout/takeout-20250202T053538Z-001.zip', 'Never back up: IMP/Google_Takeout/takeout-20250202T053538Z-001.zip (file)'],
      ['D:\\Other\\a.zip', 'Never back up: D:\\Other\\a.zip (file)'],
    ]);
    // Undo still works on the stored row
    const id = list.ok ? list.rules[0]!.id : 0;
    expect(service.remove({ backupId: folderId, ruleId: id, confirmed: true })).toMatchObject({ ok: true });
    expect(rig.db.prepare('SELECT count(*) FROM backup_rules WHERE backup_id = ?').pluck().get(folderId)).toBe(1);
  });
});
