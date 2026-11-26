import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const slash = (p: string): string => p.split(String.fromCharCode(92)).join('/');

const sources = (dir: string): { file: string; text: string }[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    const isCode = e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.testutil.ts');
    return isCode ? [{ file: slash(full).split('/src/main/')[1]!, text: readFileSync(full, 'utf8') }] : [];
  });

/** A call that creates, changes, renames or removes something on disk (or hands a path to SQLite to write). */
const WRITES =
  /\b\w*[Ff]s\w*\.(?:promises\.)?(?:writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|rename|renameSync|mkdir|mkdirSync|mkdtempSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|createWriteStream|truncate|truncateSync|cp|cpSync|symlink|utimes|utimesSync)\b|\bwriteFileAtomic\(|\bcreateWriteStream\(|VACUUM INTO|\.backup\(|\.open\([^)]*,\s*'(?:w|wx|a|ax|r\+)'/;

/**
 * Modules that write, but only inside Backup Hub's own folders on the laptop (the data folder, its logs, %APPDATA% pointer or the
 * system temp folder) and never to a path that came from a drive or from the person. Each needs a reason.
 */
const APP_DATA_ONLY: Record<string, string> = {
  'logger.ts': 'log files in the logs folder inside the data folder',
  'profileOnce.ts': 'one CPU profile file in the logs folder, only when BACKUPHUB_PROFILE is set',
  'dataDir.ts': 'location.json pointer in %APPDATA% and creating the data folder the person chose at first start',
  'places/thisDevice.ts': 'this-device.json in the data folder',
  'google/refreshJob.ts': 'temporary page files below the job temp folder in the data folder',
  'import/fleetV1/source.ts': 'a temporary copy of the archived v1 files in the data folder import-tmp',
  'db/externalDb.ts': 'a scratch copy in the system temp folder of a database that lives on a drive; the drive itself is only read',
  'listing/cloudOnly.ts': 'a small path list in a fresh folder of the system temp folder, read by PowerShell',
  'danger/ownFiles.ts': 'removes and replaces only inside the fixed app-owned folders (it refuses every other path); its callers call the guard first',
};

describe('T7 WRITE BAN: every module that writes asks the guard or is app-data only', () => {
  const all = sources(join(__dirname));
  const writers = all.filter((s) => WRITES.test(s.text));

  it('finds the writers (so this test cannot pass by finding nothing)', () => {
    const names = writers.map((s) => s.file);
    for (const expected of ['places/driveCard.ts', 'settings/saveToDrive.ts', 'localCopy/localCopyJob.ts', 'db/snapshots.ts', 'danger/index.ts']) {
      expect(names).toContain(expected);
    }
  });

  it('each writer imports and calls assertWritable, or is on the app-data-only list with a reason', () => {
    const unguarded = writers.filter((s) => !/import\s*\{[^}]*\bassertWritable\b[^}]*\}\s*from\s*'(?:\.\.\/)*(?:\.\/)?fsutil'/.test(s.text) || !/\bassertWritable\(/.test(s.text)).map((s) => s.file);
    const allowed = new Set(Object.keys(APP_DATA_ONLY));
    expect(unguarded.filter((f) => f !== 'fsutil.ts' && !allowed.has(f))).toEqual([]);
  });

  it('the app-data-only list has no stale entries and every entry has a reason', () => {
    const names = new Set(writers.map((s) => s.file));
    for (const [file, reason] of Object.entries(APP_DATA_ONLY)) {
      expect(names.has(file), `${file} no longer writes: remove it from the list`).toBe(true);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it('the paths that reach a drive are guarded in the module that writes them', () => {
    const mustGuard = ['places/driveCard.ts', 'settings/saveToDrive.ts', 'settings/savedCopyActions.ts', 'db/snapshots.ts', 'localCopy/localCopyJob.ts', 'danger/index.ts', 'recovery/restore.ts', 'recovery/recoveryFile.ts', 'db/restore.ts', 'vault/vaultService.ts', 'appIpc.ts', 'places/placeService.ts', 'main.ts'];
    for (const file of mustGuard) {
      const text = all.find((s) => s.file === file)?.text ?? '';
      expect(/\bassertWritable\(/.test(text) || /\bprotectedDriveFor\(/.test(text), `${file} must call the guard`).toBe(true);
    }
  });

  it('the setting defaults to empty (T7 ban lifted by the user, 5 Nov 2026) and the guard still reads it', () => {
    const settings = readFileSync(join(__dirname, '..', 'shared', 'settings.ts'), 'utf8');
    expect(settings).toContain('writeProtectedDrives: [],');
    const fsutil = all.find((s) => s.file === 'fsutil.ts')!.text;
    expect(fsutil).toContain('DEFAULT_WRITE_PROTECTED_DRIVES: readonly string[] = [];');
    expect(fsutil).toContain('config.protectedDrives()');
  });
});
