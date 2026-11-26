import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideDevDataDir, realDataDirs } from './dataDir';

describe('decideDevDataDir (dev runs never open the real data folder)', () => {
  const real = ['D:\\BackupHub\\data', 'E:\\Somewhere\\data'];
  const temp = 'D:\\BackupHub\\app\\.devdata\\run1';

  it('lets a packaged app through and ignores the variable', () => {
    expect(decideDevDataDir({ isPackaged: true, envDataDir: undefined, realDirs: real })).toEqual({ ok: true, dataDir: null });
    expect(decideDevDataDir({ isPackaged: true, envDataDir: 'D:\\BackupHub\\data', realDirs: real })).toEqual({
      ok: true,
      dataDir: null,
    });
  });

  it('refuses a dev run without BACKUPHUB_DATA_DIR', () => {
    for (const env of [undefined, '', '   ']) {
      const result = decideDevDataDir({ isPackaged: false, envDataDir: env, realDirs: real });
      expect(result).toMatchObject({ ok: false, title: 'Dev run needs BACKUPHUB_DATA_DIR' });
    }
  });

  it('refuses a relative path', () => {
    expect(decideDevDataDir({ isPackaged: false, envDataDir: 'relative\\dir', realDirs: real }).ok).toBe(false);
  });

  it('refuses the real default folder, the location.json folder, and anything inside or around them', () => {
    const bad = ['D:\\BackupHub\\data', 'd:\\backuphub\\data\\', 'D:\\BackupHub\\data\\sub', 'E:\\Somewhere\\data', 'D:\\BackupHub', 'D:\\'];
    for (const env of bad) {
      expect(decideDevDataDir({ isPackaged: false, envDataDir: env, realDirs: real }).ok).toBe(false);
    }
  });

  it('accepts a separate temporary folder', () => {
    expect(decideDevDataDir({ isPackaged: false, envDataDir: temp, realDirs: real })).toEqual({
      ok: true,
      dataDir: path.resolve(temp),
    });
  });
});

describe('realDataDirs', () => {
  it('returns the default plus the folder location.json names, read only', () => {
    const files: Record<string, string> = {
      [path.join('APPDATA', 'BackupHub', 'location.json')]: JSON.stringify({ dataDir: 'E:\\Somewhere\\data' }),
    };
    const fake = {
      readFileSync: (p: string) => {
        const text = files[p];
        if (text === undefined) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        return text;
      },
    };
    expect(realDataDirs('APPDATA', 'D:\\BackupHub\\data', fake as never)).toEqual(['D:\\BackupHub\\data', 'E:\\Somewhere\\data']);
    expect(realDataDirs('OTHER', 'D:\\BackupHub\\data', fake as never)).toEqual(['D:\\BackupHub\\data']);
  });
});
