import { describe, expect, it } from 'vitest';
import { APP_FOLDER, LEGACY_QUARANTINE_FOLDER, QUARANTINE_FOLDER, QUARANTINE_PARTS } from '../../shared/appFolders';
import { quarantineFolder } from '../places/appFolders';
import { DAY_MS, FRESH_MS, LOCK_MS, type DuplicateGroup, type PhoneCleanFile, type Voucher } from '../../shared/cleanup';
import {
  userFolderReason,
  canAskToEmpty,
  canEmptyEntry,
  canUndoEntry,
  chooseKeeper,
  isFresh,
  isInside,
  isLocked,
  isRemovablePhonePath,
  judgePhoneFile,
  lockExpiry,
  monthOf,
  movability,
  protectedReason,
  quarantineDate,
  quarantinePathFor,
  quarantineRootFor,
  recheckVoucher,
  recheckVouchers,
  removalsFor,
  selectDuplicateGroups,
  selectPhoneFiles,
  syncedReason,
  toVoucher,
  type CatalogRow,
  type JudgeContext,
  type VoucherNow,
} from './safety';

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const SHA = 'a'.repeat(64);
const MD5 = 'b'.repeat(32);

function row(over: Partial<CatalogRow> & Pick<CatalogRow, 'placeId' | 'placeKind'>): CatalogRow {
  return { placeLabel: over.placeId, relPath: 'x/a.jpg', size: 100, sha256: SHA, md5: MD5, cloudOnly: false, goneAt: null, mtime: 5, ...over };
}
const t7 = (over: Partial<CatalogRow> = {}): CatalogRow => row({ placeId: 't7', placeKind: 'drive', placeLabel: 'T7', ...over });
const gd = (over: Partial<CatalogRow> = {}): CatalogRow => row({ placeId: 'g1', placeKind: 'gdrive', placeLabel: 'Google 1', sha256: null, ...over });
const od = (over: Partial<CatalogRow> = {}): CatalogRow => row({ placeId: 'od', placeKind: 'onedrive', placeLabel: 'OneDrive', md5: null, ...over });
const allFresh: JudgeContext = { fresh: () => true, drivePluggedIn: () => true };
const file = { sha256: SHA, size: 100 };

describe('freshness (24 h)', () => {
  it('is fresh inside 24 hours and not after', () => {
    expect(isFresh(NOW - 1000, NOW)).toBe(true);
    expect(isFresh(NOW - FRESH_MS, NOW)).toBe(true);
    expect(isFresh(NOW - FRESH_MS - 1, NOW)).toBe(false);
  });
  it('never looked, NaN and a time far in the future are not fresh', () => {
    expect(isFresh(null, NOW)).toBe(false);
    expect(isFresh(Number.NaN, NOW)).toBe(false);
    expect(isFresh(NOW + 60 * 60 * 1000, NOW)).toBe(false);
    expect(isFresh(NOW + 60 * 1000, NOW)).toBe(true);
  });
});

describe('30-day locks', () => {
  it('lasts 30 days from the removal', () => {
    expect(lockExpiry(NOW)).toBe(NOW + 30 * DAY_MS);
    expect(LOCK_MS).toBe(30 * DAY_MS);
  });
  it('locks until the expiry and compares paths without regard to case', () => {
    const locks = [{ placeId: 't7', relPath: 'BackupHub/Phone/a.jpg', expiresAt: NOW + 10 }];
    expect(isLocked(locks, 't7', 'backuphub/phone/A.JPG', NOW)).toBe(true);
    expect(isLocked(locks, 't7', 'backuphub/phone/b.jpg', NOW)).toBe(false);
    expect(isLocked(locks, 'other', 'BackupHub/Phone/a.jpg', NOW)).toBe(false);
    expect(isLocked(locks, 't7', 'BackupHub/Phone/a.jpg', NOW + 10)).toBe(false);
  });
});

describe('SAFE rule: T7 + cloud with identical contents', () => {
  it('is safe with a T7 copy and a Google copy (through the drive copy MD5 + size)', () => {
    const j = judgePhoneFile(file, [t7(), gd()], allFresh);
    expect(j.verdict).toBe('safe');
    expect(j.vouchers.map((v) => v.placeId)).toEqual(['t7', 'g1']);
  });
  it('is safe with a T7 copy and a OneDrive copy (same SHA-256)', () => {
    expect(judgePhoneFile(file, [t7(), od()], allFresh).verdict).toBe('safe');
  });
  it('is only "waiting" with the T7 copy alone', () => {
    const j = judgePhoneFile(file, [t7()], allFresh);
    expect(j.verdict).toBe('waiting');
    expect(j.vouchers).toHaveLength(1);
  });
  it('is none without a T7 copy, even with two cloud copies', () => {
    expect(judgePhoneFile(file, [gd(), od()], allFresh).verdict).toBe('none');
  });
  it('never matches by name or size alone', () => {
    const other = t7({ sha256: 'c'.repeat(64) });
    expect(judgePhoneFile(file, [other, gd()], allFresh).verdict).toBe('none');
    const wrongSize = t7({ size: 101 });
    expect(judgePhoneFile(file, [wrongSize, gd({ size: 101 })], allFresh).verdict).toBe('none');
  });
  it('a Google copy with another MD5 or size does not count', () => {
    expect(judgePhoneFile(file, [t7(), gd({ md5: 'd'.repeat(32) })], allFresh).verdict).toBe('waiting');
    expect(judgePhoneFile(file, [t7(), gd({ size: 99 })], allFresh).verdict).toBe('waiting');
  });
  it('a Google copy needs the MD5 of the drive copy: without it nothing matches', () => {
    expect(judgePhoneFile(file, [t7({ md5: null }), gd()], allFresh).verdict).toBe('waiting');
  });
  it('a OneDrive placeholder, a gone row and a non-hashed row never vouch', () => {
    expect(judgePhoneFile(file, [t7(), od({ cloudOnly: true })], allFresh).verdict).toBe('waiting');
    expect(judgePhoneFile(file, [t7(), gd({ goneAt: 5 })], allFresh).verdict).toBe('waiting');
    expect(judgePhoneFile(file, [t7({ goneAt: 5 }), gd()], allFresh).verdict).toBe('none');
    expect(judgePhoneFile(file, [t7({ sha256: null }), gd()], allFresh).verdict).toBe('none');
  });
  it('two copies on the SAME drive and no cloud are not safe', () => {
    expect(judgePhoneFile(file, [t7(), t7({ relPath: 'y/b.jpg' })], allFresh).verdict).toBe('waiting');
  });
  it('a laptop copy is not a vouching copy', () => {
    expect(judgePhoneFile(file, [t7(), row({ placeId: 'lap', placeKind: 'laptop' })], allFresh).verdict).toBe('waiting');
  });
  it('a stale or unplugged drive makes it "stale", not safe', () => {
    expect(judgePhoneFile(file, [t7(), gd()], { fresh: (p) => p !== 't7', drivePluggedIn: () => true }).verdict).toBe('stale');
    const j = judgePhoneFile(file, [t7(), gd()], { fresh: () => true, drivePluggedIn: () => false });
    expect(j.verdict).toBe('stale');
    expect('stalePlaceIds' in j && j.stalePlaceIds).toEqual(['t7']);
  });
  it('a stale cloud account makes it "stale" and names the account', () => {
    const j = judgePhoneFile(file, [t7(), gd()], { fresh: (p) => p !== 'g1', drivePluggedIn: () => true });
    expect(j.verdict).toBe('stale');
    expect('stalePlaceIds' in j && j.stalePlaceIds).toEqual(['g1']);
  });
  it('a fresh second cloud copy is enough when the first is stale', () => {
    const j = judgePhoneFile(file, [t7(), gd(), od()], { fresh: (p) => p !== 'g1', drivePluggedIn: () => true });
    expect(j.verdict).toBe('safe');
    expect(j.vouchers.map((v) => v.placeId)).toEqual(['t7', 'od']);
  });
  it('refuses an empty file or a short fingerprint', () => {
    expect(judgePhoneFile({ sha256: SHA, size: 0 }, [t7({ size: 0 }), gd({ size: 0 })], allFresh).verdict).toBe('none');
    expect(judgePhoneFile({ sha256: 'abc', size: 100 }, [t7(), gd()], allFresh).verdict).toBe('none');
  });
});

describe('re-check right before the removal', () => {
  const t7v = toVoucher(t7());
  const gdv = toVoucher(gd());
  const good = (v: Voucher): VoucherNow => ({ row: v.placeKind === 'drive' ? t7() : gd(), lastLookedAt: NOW - 1000, ...(v.placeKind === 'drive' ? { onDiskSize: 100 } : {}) });

  it('passes when everything still holds', () => {
    expect(recheckVouchers([t7v, gdv], good, NOW)).toEqual({ ok: true });
  });
  it('a changed fingerprint skips the file', () => {
    const r = recheckVouchers([t7v, gdv], (v) => (v.placeKind === 'drive' ? { ...good(v), row: t7({ sha256: 'c'.repeat(64) }) } : good(v)), NOW);
    expect(r.ok).toBe(false);
  });
  it('a changed size, a gone row, a missing row all skip', () => {
    expect(recheckVoucher(t7v, { ...good(t7v), row: t7({ size: 101 }) }, NOW).ok).toBe(false);
    expect(recheckVoucher(t7v, { ...good(t7v), row: t7({ goneAt: 1 }) }, NOW).ok).toBe(false);
    expect(recheckVoucher(t7v, { ...good(t7v), row: null }, NOW).ok).toBe(false);
    expect(recheckVoucher(gdv, { ...good(gdv), row: gd({ md5: 'e'.repeat(32) }) }, NOW).ok).toBe(false);
  });
  it('a place not looked at in 24 h says Check it first', () => {
    const r = recheckVoucher(t7v, { ...good(t7v), lastLookedAt: NOW - FRESH_MS - 1 }, NOW);
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain('Check it first');
    expect(recheckVoucher(t7v, { ...good(t7v), lastLookedAt: null }, NOW).ok).toBe(false);
  });
  it('the drive copy must really be on the drive with the same size', () => {
    expect(recheckVoucher(t7v, { ...good(t7v), onDiskSize: null }, NOW).ok).toBe(false);
    expect(recheckVoucher(t7v, { ...good(t7v), onDiskSize: 99 }, NOW).ok).toBe(false);
  });
  it('needs both a drive copy and a cloud copy in the set', () => {
    expect(recheckVouchers([t7v], good, NOW).ok).toBe(false);
    expect(recheckVouchers([gdv], good, NOW).ok).toBe(false);
    expect(recheckVouchers([], good, NOW).ok).toBe(false);
  });
});

describe('phone paths, selection and months', () => {
  it('only files below a folder of /sdcard may be removed or pushed', () => {
    expect(isRemovablePhonePath('/sdcard/DCIM/Camera/a.jpg')).toBe(true);
    expect(isRemovablePhonePath('/sdcard/a.jpg')).toBe(false);
    expect(isRemovablePhonePath('/sdcard')).toBe(false);
    expect(isRemovablePhonePath('/sdcard/DCIM/')).toBe(false);
    expect(isRemovablePhonePath('/sdcard/DCIM/../x')).toBe(false);
    expect(isRemovablePhonePath("/sdcard/DCIM/it's.jpg")).toBe(false);
    expect(isRemovablePhonePath('/data/x/y')).toBe(false);
    expect(isRemovablePhonePath(42)).toBe(false);
  });
  it('months', () => {
    expect(monthOf(Date.UTC(2026, 2, 5) / 1000)).toBe('2026-03');
    expect(monthOf(0)).toBe('unknown');
  });

  const v = [toVoucher(t7()), toVoucher(gd())];
  const mk = (index: number, over: Partial<PhoneCleanFile> = {}): PhoneCleanFile => ({ index, path: `/sdcard/DCIM/Camera/${index}.jpg`, folder: '/sdcard/DCIM/Camera', month: '2026-03', name: `${index}.jpg`, size: 100, mtimeSec: 1, sha256: SHA, verdict: 'safe', reason: '', vouchers: v, ...over });
  const plan = { files: [mk(0), mk(1), mk(2, { verdict: 'waiting', vouchers: [v[0]!] }), mk(3, { path: '/sdcard/x.jpg' })] };
  it('accepts exactly the ticked safe files with matching numbers', () => {
    const s = selectPhoneFiles(plan, [0, 1, 1], 2, 200);
    expect(s).toMatchObject({ ok: true, bytes: 200 });
  });
  it('refuses waiting files, outside indexes, wrong totals, empty and odd input', () => {
    expect(selectPhoneFiles(plan, [2], 1, 100).ok).toBe(false);
    expect(selectPhoneFiles(plan, [9], 1, 100).ok).toBe(false);
    expect(selectPhoneFiles(plan, [0, 1], 3, 200).ok).toBe(false);
    expect(selectPhoneFiles(plan, [0, 1], 2, 199).ok).toBe(false);
    expect(selectPhoneFiles(plan, [], 0, 0).ok).toBe(false);
    expect(selectPhoneFiles(plan, 'x', 0, 0).ok).toBe(false);
    expect(selectPhoneFiles(plan, [0.5], 1, 100).ok).toBe(false);
    expect(selectPhoneFiles(plan, [3], 1, 100).ok).toBe(false);
  });
  it('refuses a "safe" file that lost all of its vouchers', () => {
    expect(selectPhoneFiles({ files: [mk(0, { vouchers: [] })] }, [0], 1, 100).ok).toBe(false);
  });
});

describe('protected folders and OneDrive exclusions', () => {
  it('never touches the PLAN protected folders, on any drive letter', () => {
    for (const p of [
      'D:/BackupHub/archive/a.jpg',
      'T:/BackupHub/rescue/a.mp4',
      'D:/google-fleet-manager/x.json',
      'C:/Users/me/PhoneBackup/a.jpg',
      'D:/MyData/Old phone backup/a.jpg',
      'e:/mydata/a.jpg',
      'D:\\BackupHub\\data\\backuphub.db',
      `C:/${LEGACY_QUARANTINE_FOLDER}/2026-11-03/Users/a.jpg`,
      `D:/${APP_FOLDER}/${QUARANTINE_FOLDER}/2026-11-03/Users/a.jpg`, // the app's own folder, wherever it is
      `${quarantineFolder('C:\\')}\\2026-11-03\\Users\\a.jpg`,
      'C:/Windows/System32/a.dll',
      'C:/Program Files/App/a.dll',
      'C:/ProgramData/x/a',
      'D:/code/app/node_modules/x/a.js',
      'D:/code/app/.git/objects/a',
    ]) {
      expect(protectedReason(p), p).not.toBeNull();
    }
  });
  it('lets ordinary folders through', () => {
    for (const p of ['C:/Users/me/Documents/a.jpg', 'D:/Photos/2026/a.jpg', 'C:/Users/me/Downloads/a.zip']) expect(protectedReason(p), p).toBeNull();
  });
  it('OneDrive folders, given or by name, are excluded', () => {
    expect(syncedReason('C:/Users/me/OneDrive/Pics/a.jpg', [])).not.toBeNull();
    expect(syncedReason('C:/Users/me/OneDrive - Personal/a.jpg', [])).not.toBeNull();
    expect(syncedReason('D:/Sync/a.jpg', ['d:\\sync'])).not.toBeNull();
    expect(syncedReason('D:/Syncing/a.jpg', ['d:\\sync'])).toBeNull();
    expect(syncedReason('C:/Users/me/Documents/a.jpg', ['C:/Users/me/OneDrive'])).toBeNull();
  });
  it('movability combines protected, synced, other places and locks', () => {
    const ctx = { oneDriveRoots: ['C:/Users/me/OneDrive'], locks: [{ placeId: 'lap', relPath: 'C:/Users/me/Documents/locked.jpg', expiresAt: NOW + 1 }], laptopPlaceId: 'lap', now: NOW, otherPlaceRoots: ['F:/'] };
    expect(movability('C:/Users/me/Documents/a.jpg', ctx)).toEqual({ ok: true });
    expect(movability('D:/MyData/a.jpg', ctx).ok).toBe(false);
    expect(movability('C:/Users/me/OneDrive/a.jpg', ctx).ok).toBe(false);
    expect(movability('F:/x/a.jpg', ctx).ok).toBe(false);
    expect(movability('C:/Users/me/Documents/locked.jpg', ctx).ok).toBe(false);
    expect(movability('C:/Users/me/Documents/locked.jpg', { ...ctx, now: NOW + 2 }).ok).toBe(true);
  });
});

describe('keeper choice and removals', () => {
  it('prefers a copy inside a collection, then the oldest, then the shortest path', () => {
    expect(chooseKeeper([{ relPath: 'C:/a/x.jpg', mtime: 1, inCollection: false }, { relPath: 'C:/b/longer/x.jpg', mtime: 9, inCollection: true }])).toBe('C:/b/longer/x.jpg');
    expect(chooseKeeper([{ relPath: 'C:/a/x.jpg', mtime: 5, inCollection: false }, { relPath: 'C:/b/x.jpg', mtime: 2, inCollection: false }])).toBe('C:/b/x.jpg');
    expect(chooseKeeper([{ relPath: 'C:/aaa/x.jpg', mtime: 2, inCollection: false }, { relPath: 'C:/b/x.jpg', mtime: 2, inCollection: false }])).toBe('C:/b/x.jpg');
    expect(chooseKeeper([{ relPath: 'C:/a/x.jpg', mtime: null, inCollection: false }, { relPath: 'C:/b/x.jpg', mtime: 2, inCollection: false }])).toBe('C:/b/x.jpg');
    expect(() => chooseKeeper([])).toThrow();
  });
  it('the kept copy and non-removable members never move; one always stays', () => {
    const members = [
      { relPath: 'a', removable: true },
      { relPath: 'b', removable: true },
      { relPath: 'c', removable: false },
    ];
    expect(removalsFor(members, 'a')).toEqual({ ok: true, remove: ['b'] });
    expect(removalsFor(members, 'c')).toEqual({ ok: true, remove: ['a', 'b'] });
    expect(removalsFor(members, 'zzz').ok).toBe(false);
    const r = removalsFor([{ relPath: 'a', removable: true }], 'a');
    expect(r).toEqual({ ok: true, remove: [] });
  });
  const group = (id: string, keep = 'a'): DuplicateGroup => ({
    id,
    size: 10,
    keep,
    freeable: 20,
    members: [
      { relPath: 'a', mtime: 1, collection: null, removable: true, why: null },
      { relPath: 'b', mtime: 2, collection: null, removable: true, why: null },
      { relPath: 'c', mtime: 3, collection: null, removable: true, why: null },
    ],
  });
  it('selects ticked groups with the chosen keeper and checks the confirm numbers', () => {
    const plan = { groups: [group('g1'), group('g2')] };
    const s = selectDuplicateGroups(plan, [{ id: 'g1', keep: 'b' }, { id: 'g1', keep: 'a' }], 2, 20);
    expect(s).toMatchObject({ ok: true, bytes: 20 });
    if (s.ok) expect(s.items[0]!.remove).toEqual(['a', 'c']);
    expect(selectDuplicateGroups(plan, [{ id: 'g1', keep: 'b' }], 3, 30).ok).toBe(false);
    expect(selectDuplicateGroups(plan, [{ id: 'nope', keep: 'b' }], 2, 20).ok).toBe(false);
    expect(selectDuplicateGroups(plan, [{ id: 'g1', keep: 'zzz' }], 2, 20).ok).toBe(false);
    expect(selectDuplicateGroups(plan, [], 0, 0).ok).toBe(false);
    expect(selectDuplicateGroups(plan, [{ id: 'g1' }], 2, 20).ok).toBe(false);
  });
});

describe('quarantine paths, undo and emptying', () => {
  it('uses the same drive and keeps the original path', () => {
    expect(quarantineRootFor('d:/Photos/a.jpg')).toBe(quarantineFolder('D:\\'));
    expect(quarantineRootFor('d:/Photos/a.jpg')).toBe(['D:', ...QUARANTINE_PARTS].join('\\'));
    expect(quarantineRootFor('relative/a.jpg')).toBeNull();
    expect(quarantinePathFor(quarantineFolder('D:\\'), '2026-11-03', 'D:/Photos/2026/a.jpg', () => false)).toBe(`${quarantineFolder('D:\\')}\\2026-11-03\\Photos\\2026\\a.jpg`);
  });
  it('never overwrites: a taken name gets (2), (3)', () => {
    const taken = new Set(['D:\\Q\\2026-11-03\\a\\x.jpg', 'D:\\Q\\2026-11-03\\a\\x (2).jpg']);
    expect(quarantinePathFor('D:\\Q', '2026-11-03', 'D:/a/x.jpg', (p) => taken.has(p))).toBe('D:\\Q\\2026-11-03\\a\\x (3).jpg');
  });
  it('refuses paths with .. or an odd date', () => {
    expect(quarantinePathFor('D:\\Q', '2026-11-03', 'D:/a/../x.jpg', () => false)).toBeNull();
    expect(quarantinePathFor('D:\\Q', '../..', 'D:/a/x.jpg', () => false)).toBeNull();
    expect(quarantinePathFor('D:\\Q', '2026-11-03', 'nodrive/x.jpg', () => false)).toBeNull();
  });
  it('the date is local YYYY-MM-DD', () => {
    expect(quarantineDate(new Date(2026, 10, 3, 23, 59).getTime())).toBe('2026-11-03');
    expect(quarantineDate(new Date(2026, 0, 5, 0, 1).getTime())).toBe('2026-01-05');
  });
  it('isInside is strict, case-insensitive and refuses ..', () => {
    expect(isInside('D:\\Q', 'D:\\Q\\x\\a.jpg')).toBe(true);
    expect(isInside('D:\\Q', 'd:/q/x/a.jpg')).toBe(true);
    expect(isInside('D:\\Q', 'D:\\Q')).toBe(false);
    expect(isInside('D:\\Q', 'D:\\Qx\\a.jpg')).toBe(false);
    expect(isInside('D:\\Q', 'D:\\Q\\..\\x\\a.jpg')).toBe(false);
  });
  const root = quarantineFolder('D:\\');
  const entry = { removedAt: NOW - 31 * DAY_MS, undoneAt: null, emptiedAt: null, quarantinePath: `${root}\\2026-10-03\\a\\x.jpg`, size: 10 };
  it('the app may ask about emptying only after 30 days', () => {
    expect(canAskToEmpty(NOW - 30 * DAY_MS, NOW)).toBe(true);
    expect(canAskToEmpty(NOW - 30 * DAY_MS + 1, NOW)).toBe(false);
  });
  it('undo only while it waits in the quarantine', () => {
    expect(canUndoEntry(entry, root)).toBe(true);
    expect(canUndoEntry({ ...entry, undoneAt: 1 }, root)).toBe(false);
    expect(canUndoEntry({ ...entry, emptiedAt: 1 }, root)).toBe(false);
    expect(canUndoEntry({ ...entry, quarantinePath: 'D:\\other\\x.jpg' }, root)).toBe(false);
    expect(canUndoEntry({ ...entry, quarantinePath: null }, root)).toBe(false);
  });
  it('emptying needs age 30 days, not undone, inside the quarantine', () => {
    expect(canEmptyEntry(entry, root, NOW)).toEqual({ ok: true });
    expect(canEmptyEntry({ ...entry, removedAt: NOW - 5 * DAY_MS }, root, NOW).ok).toBe(false);
    expect(canEmptyEntry({ ...entry, undoneAt: 1 }, root, NOW).ok).toBe(false);
    expect(canEmptyEntry({ ...entry, emptiedAt: 1 }, root, NOW).ok).toBe(false);
    expect(canEmptyEntry({ ...entry, quarantinePath: 'D:\\Photos\\x.jpg' }, root, NOW).ok).toBe(false);
    expect(canEmptyEntry({ ...entry, quarantinePath: `${root}\\..\\Photos\\x.jpg` }, root, NOW).ok).toBe(false);
  });
  it('files that an earlier version moved to the old quarantine folder of the same drive can still be put back or emptied', () => {
    const old = { ...entry, quarantinePath: `D:\\${LEGACY_QUARANTINE_FOLDER}\\2026-10-03\\a\\x.jpg` };
    expect(canUndoEntry(old, root)).toBe(true);
    expect(canEmptyEntry(old, root, NOW)).toEqual({ ok: true });
    // Only the same drive's old folder, not another drive's and not a look-alike.
    expect(canUndoEntry({ ...old, quarantinePath: `E:\\${LEGACY_QUARANTINE_FOLDER}\\2026-10-03\\x.jpg` }, root)).toBe(false);
    expect(canUndoEntry({ ...old, quarantinePath: `D:\\${LEGACY_QUARANTINE_FOLDER}-x\\2026-10-03\\x.jpg` }, root)).toBe(false);
  });
});

describe('userFolderReason', () => {
  it('matches the profile folder and everything below it, any case and slash, and nothing beside it', () => {
    const roots = ['C:/Users/me/'];
    expect(userFolderReason('C:/Users/me/Documents/a.jpg', roots)).not.toBeNull();
    expect(userFolderReason('c:/users/ME/AppData/x', roots)).not.toBeNull();
    expect(userFolderReason('C:/Users/me', roots)).not.toBeNull();
    expect(userFolderReason('C:/Users/mer/Documents/a.jpg', roots)).toBeNull();
    expect(userFolderReason('D:/Users/me/a.jpg', roots)).toBeNull();
    expect(userFolderReason('C:/Users/me/a.jpg', [])).toBeNull();
  });
});
