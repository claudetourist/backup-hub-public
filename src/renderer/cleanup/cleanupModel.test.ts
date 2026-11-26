import { describe, expect, it } from 'vitest';
import { DAY_MS, type DuplicateGroup, type PhoneCleanFile } from '../../shared/cleanup';
import { NOT_READY_TEXT, NOT_READY_TITLE, secondDriveNotReady, duplicateTotals, folderShown, removableGroupIds, groupPhoneFiles, lockLeft, safeIndexes, shownPath, tickedTotals, verdictLabel } from './cleanupModel';

const f = (index: number, folder: string, month: string, size: number, verdict: PhoneCleanFile['verdict'] = 'safe'): PhoneCleanFile => ({
  index,
  path: `${folder}/${index}.jpg`,
  folder,
  month,
  name: `${index}.jpg`,
  size,
  mtimeSec: 1,
  sha256: 'a'.repeat(64),
  verdict,
  reason: '',
  vouchers: [],
});

describe('cleanup model', () => {
  const files = [f(0, '/sdcard/DCIM/Camera', '2026-01', 10), f(1, '/sdcard/DCIM/Camera', '2026-03', 20), f(2, '/sdcard/DCIM/Camera', '2026-03', 30, 'waiting'), f(3, '/sdcard/Download', '2025-12', 5)];

  it('groups by folder, then by month with the newest month first', () => {
    const groups = groupPhoneFiles(files);
    expect(groups.map((g) => g.folder)).toEqual(['/sdcard/DCIM/Camera', '/sdcard/Download']);
    expect(groups[0]!.months.map((m) => m.month)).toEqual(['2026-03', '2026-01']);
    expect(groups[0]).toMatchObject({ files: 3, bytes: 60, safe: 2 });
  });

  it('counts only ticked SAFE files', () => {
    expect(tickedTotals(files, new Set([0, 1, 2, 9]))).toEqual({ count: 2, bytes: 30 });
    expect(safeIndexes(files)).toEqual([0, 1, 3]);
  });

  it('words', () => {
    expect(folderShown('/sdcard/DCIM/Camera')).toBe('DCIM / Camera');
    expect(folderShown('/sdcard')).toBe('Phone storage');
    expect(lockLeft(10 * DAY_MS, 0)).toBe('10 days left');
    expect(lockLeft(1, 0)).toBe('1 day left');
    expect(lockLeft(0, 5)).toBe('Ends today');
    expect(verdictLabel('safe').text).toBe('Safe to remove');
    expect(verdictLabel('waiting').tone).toBe('amber');
  });
});

describe('duplicate totals', () => {
  const group = (id: string, size: number, removable: boolean[]): DuplicateGroup => ({
    id,
    size,
    keep: 'p0',
    freeable: 0,
    members: removable.map((r, i) => ({ relPath: `p${i}`, mtime: i, collection: null, removable: r, why: null })),
  });
  it('counts the removable copies except the one kept, for ticked groups only', () => {
    const groups = [group('a', 10, [true, true, true]), group('b', 100, [true, false, true]), group('c', 5, [true, true])];
    const keepOf = (g: DuplicateGroup): string => g.keep;
    expect(duplicateTotals(groups, new Set(['a', 'b']), keepOf)).toEqual({ count: 3, bytes: 120 });
    expect(duplicateTotals(groups, new Set(['b']), (g) => (g.id === 'b' ? 'p1' : g.keep))).toEqual({ count: 2, bytes: 200 });
    expect(duplicateTotals(groups, new Set(), keepOf)).toEqual({ count: 0, bytes: 0 });
  });
  it('Tick all offers only the groups with a copy that would move, after the kept one is chosen', () => {
    const groups = [group('a', 10, [true, true, true]), group('b', 100, [true, false, false]), group('c', 5, [true, true])];
    expect(removableGroupIds(groups, (g) => g.keep)).toEqual(['a', 'c']);
    // keeping p1 of group b leaves its removable p0 to move
    expect(removableGroupIds(groups, (g) => (g.id === 'b' ? 'p1' : g.keep))).toEqual(['a', 'b', 'c']);
    expect(removableGroupIds([], (g) => g.keep)).toEqual([]);
  });
  it('splits a catalog path', () => {
    expect(shownPath('C:/Users/me/a.jpg')).toEqual({ folder: 'C:/Users/me', name: 'a.jpg' });
  });
});

describe('the second drive is not ready', () => {
  const seagate = (over: { status?: 'connected' | 'disconnected' | 'problem'; problem?: string | null } = {}) => ({ kind: 'drive' as const, label: 'Seagate2TB', status: 'connected' as const, problem: null, ...over });
  it('is ready when Seagate2TB is plugged in with no problem', () => {
    expect(secondDriveNotReady([seagate(), { kind: 'drive', label: 'T7', status: 'disconnected', problem: null }])).toBe(false);
  });
  it('is not ready when it is not plugged in, shows a problem, or is not known', () => {
    expect(secondDriveNotReady([seagate({ status: 'disconnected' })])).toBe(true);
    expect(secondDriveNotReady([seagate({ status: 'problem', problem: "Windows can't read it" })])).toBe(true);
    expect(secondDriveNotReady([seagate({ problem: 'Read errors' })])).toBe(true);
    expect(secondDriveNotReady([{ kind: 'drive', label: 'T7', status: 'connected', problem: null }])).toBe(true);
  });
  it('says nothing until the places are read', () => {
    expect(secondDriveNotReady(null)).toBe(false);
  });
  it('words the panel plainly', () => {
    expect(NOT_READY_TITLE).toBe('Not ready yet');
    expect(NOT_READY_TEXT).toBe(
      'Removing files from a phone needs three checked copies: on the T7, on a second drive and in Google. The second drive (Seagate2TB) is not available, so nothing can be removed yet. Nothing is changed on your phone.',
    );
  });
});
