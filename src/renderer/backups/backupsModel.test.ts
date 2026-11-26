import { describe, expect, it } from 'vitest';
import type { HistoryResult } from '../../shared/backups';
import type { ConnectedPhones } from '../../shared/phoneBackup';
import { BEHIND_AFTER_DAYS, EXISTING_FOLDER_NOTE, MAKE_NEW_BACKUP_TEXT, NO_DRIVE_LINE, changePhoneWarning, agoText, backupStatusOf, createRequest, datedFolderExample, historyBroughtInText, shortDate, formProblem, initialForm, newFolderChoiceText, pickDrive, driveText, forgetUnplugged, lastBackupText, newPhoneQuestion, phonesToAsk, readLine, reportHeadline, spareText, yesThisIsText } from './backupsModel';

describe('backups words', () => {
  it('says the last backup date, or that it is not known', () => {
    expect(lastBackupText(null)).toBe('Not known yet');
    expect(lastBackupText(new Date(2026, 6, 17, 12).getTime())).toBe('17 Jul 2026');
  });

  describe('the status word of a backup', () => {
    const now = new Date(2026, 10, 24, 12).getTime();
    const day = (n: number): number => new Date(2026, 10, 24 - n, 12).getTime();
    it('is Problem when the last run failed, even with a recent date', () => {
      expect(backupStatusOf({ lastBackupAt: day(1), lastRunFailed: true }, now)).toBe('problem');
      expect(backupStatusOf({ lastBackupAt: null, lastRunFailed: true }, now)).toBe('problem');
    });
    it('is Never backed up with no date', () => {
      expect(backupStatusOf({ lastBackupAt: null, lastRunFailed: false }, now)).toBe('never');
    });
    it('is Up to date up to 14 days and Behind after that', () => {
      expect(BEHIND_AFTER_DAYS).toBe(14);
      expect(backupStatusOf({ lastBackupAt: day(0), lastRunFailed: false }, now)).toBe('up-to-date');
      expect(backupStatusOf({ lastBackupAt: day(14), lastRunFailed: false }, now)).toBe('up-to-date');
      expect(backupStatusOf({ lastBackupAt: day(14) - 1000, lastRunFailed: false }, now)).toBe('behind');
      expect(backupStatusOf({ lastBackupAt: day(130), lastRunFailed: false }, now)).toBe('behind');
    });
  });

  it('writes a short date and how long ago it was', () => {
    const now = new Date(2026, 10, 24, 12).getTime();
    const at = (y: number, m: number, d: number): number => new Date(y, m, d, 12).getTime();
    expect(shortDate(at(2026, 10, 23), now)).toBe('23 Nov');
    expect(shortDate(at(2025, 10, 23), now)).toBe('23 Nov 2025');
    expect(agoText(at(2026, 10, 24), now)).toBe('today');
    expect(agoText(at(2026, 10, 23), now)).toBe('yesterday');
    expect(agoText(at(2026, 10, 15), now)).toBe('9 days ago');
    expect(agoText(at(2026, 9, 26), now)).toBe('29 days ago');
    expect(agoText(at(2026, 6, 17), now)).toBe('4 months ago');
    expect(agoText(at(2026, 9, 10), now)).toBe('1 month ago');
    expect(agoText(at(2024, 10, 24), now)).toBe('2 years ago');
    expect(agoText(at(2026, 10, 30), now)).toBe('today');
    expect(historyBroughtInText(at(2026, 10, 23), now)).toBe('PhoneBackup history brought in on 23 Nov.');
  });

  it('says where a backup goes', () => {
    expect(driveText({ driveLabel: 'T7', folder: 'MyData/POCO', driveConnected: true })).toBe('T7, folder MyData/POCO');
    expect(driveText({ driveLabel: 'T7', folder: 'MyData/POCO', driveConnected: false })).toBe('T7, folder MyData/POCO (not plugged in)');
    expect(driveText({ driveLabel: null, folder: null, driveConnected: false })).toBe('No backup folder yet');
  });

  it('lists what will be read', () => {
    const file = { backup: 'Poco F4', path: 'F:\\MyData\\POCO\\ledger.db', found: true, bytes: 14_553_088, modifiedAt: new Date(2026, 9, 26, 12).getTime(), lastBroughtInAt: null };
    expect(readLine(file)).toBe('Poco F4: 14.6 MB, last written 26 Oct 2026');
    expect(readLine({ ...file, found: false })).toBe('Poco F4: no history file found');
  });

  it('writes the counts headline and the Spare line', () => {
    const result: Extract<HistoryResult, { ok: true }> = {
      ok: true,
      driveLabel: 'T7',
      made: [],
      alreadyThere: [],
      lines: [],
      totals: { rowsIn: 1000, linked: 900, loose: 50, stale: 100 },
      spare: { inHistory: 228, marked: 228, stillShown: 0 },
      notes: [],
    };
    expect(reportHeadline(result)).toBe('1,000 rows brought in: 900 matched to files on the T7, 50 with no original path, 100 could not be matched.');
    expect(spareText(result.spare)).toBe('Spare: 228 rows in the history, 228 marked as kept only on the Seagate.');
    expect(spareText({ inHistory: 228, marked: 0, stillShown: 228 })).toContain('228 still show as on the T7');
    expect(spareText({ inHistory: 0, marked: 0, stillShown: 0 })).toBeNull();
  });
});

describe('which backup is the plugged-in phone for', () => {
  const poco = { serial: 'SERIAL0001', phoneName: 'Poco F4', ready: true, hint: null };
  const connected = (over: Partial<ConnectedPhones> = {}): ConnectedPhones => ({ adb: 'ready', phones: [], hint: null, newPhones: [poco], backupsWithoutPhone: [{ backupId: 1, backupName: 'Poco F4' }], ...over });

  it('writes the question and the button', () => {
    expect(newPhoneQuestion('Poco F4', ['Samsung'])).toBe("A phone is plugged in: Poco F4. Is this the phone for 'Samsung'?");
    expect(newPhoneQuestion('22021211RI', ['Poco F4', 'Samsung'])).toBe('A phone is plugged in: 22021211RI. Is this the phone for one of these backups?');
    expect(yesThisIsText('Samsung')).toBe('Yes, this is Samsung');
    expect(changePhoneWarning('Poco F4')).toContain('forget which phone is Poco F4');
  });

  it('asks about every phone that belongs to no backup, and not about a phone put off with Not now', () => {
    expect(phonesToAsk(connected(), new Set())).toEqual([poco]);
    expect(phonesToAsk(connected({ backupsWithoutPhone: [] }), new Set())).toEqual([poco]); // a second family phone: no backup lacks a phone, the card still asks
    expect(phonesToAsk(connected(), new Set(['SERIAL0001']))).toEqual([]);
    expect(phonesToAsk(null, new Set())).toEqual([]);
  });

  it('says there is no backup yet when none waits for a phone', () => {
    expect(newPhoneQuestion('Redmi Note 12', [])).toBe('A phone is plugged in: Redmi Note 12. It has no backup yet.');
    expect(MAKE_NEW_BACKUP_TEXT).toBe('Make a new backup for this phone');
  });

  it('Not now holds until the phone is plugged in again', () => {
    const hidden = new Set(['SERIAL0001']);
    expect(forgetUnplugged(hidden, connected())).toEqual(hidden); // still plugged in: still put off
    expect(forgetUnplugged(hidden, connected({ newPhones: [] }))).toEqual(new Set()); // unplugged: forgotten
    expect(phonesToAsk(connected(), forgetUnplugged(hidden, connected({ newPhones: [] })))).toEqual([poco]); // plugged in again: asked again
    expect(forgetUnplugged(hidden, null)).toEqual(new Set());
  });
});

describe('the form that makes a new backup for a phone', () => {
  const choices = { ok: true as const, suggestedName: 'Redmi Note 12', drives: [{ placeId: 't7', label: 'T7', folders: ['HJ', 'Sam phone'] }] };
  const two = { ...choices, drives: [...choices.drives, { placeId: 'bk', label: 'Backup disk', folders: ['Other'] }] };

  it('opens with the phone name, the only drive picked, and a new folder', () => {
    expect(initialForm(choices)).toEqual({ name: 'Redmi Note 12', placeId: 't7', folderKind: 'new', existingName: null, ownerId: null, newPersonName: '' });
    expect(initialForm(choices, 3).ownerId).toBe(3);
    expect(initialForm(two).placeId).toBeNull();
    expect(initialForm({ ...choices, drives: [] }).placeId).toBeNull();
  });

  it('shows the folder name live, made safe for Windows', () => {
    expect(newFolderChoiceText("Sam's phone")).toBe("A new folder: MyData\\Sam's phone");
    expect(newFolderChoiceText('a:b ')).toBe('A new folder: MyData\\ab');
    expect(newFolderChoiceText('...')).toBe('A new folder (the name needs letters or numbers)');
  });

  it('gives the example of a dated folder from the name and today', () => {
    expect(datedFolderExample('Sam phone', new Date(2026, 10, 23))).toBe('Each backup goes in a dated folder, like Sam-phone-23Nov26.');
    expect(datedFolderExample('', new Date(2026, 0, 5))).toBe('Each backup goes in a dated folder, like Phone-05Jan26.');
    expect(EXISTING_FOLDER_NOTE).toBe('Files already in this folder are recognised by their checksum and not copied again. Nothing in it is changed or removed.');
    expect(NO_DRIVE_LINE).toBe('Plug in the drive you want the backups on, then press Check for a phone.');
  });

  it('says what is missing, and only a complete form makes a request', () => {
    const form = initialForm(choices);
    expect(formProblem(form)).toBeNull();
    expect(formProblem({ ...form, name: '  ' })).toBe('Type a name for the backup.');
    expect(formProblem({ ...form, name: 'x'.repeat(41) })).toContain('under 41');
    expect(formProblem({ ...form, placeId: null })).toBe('Choose the drive.');
    expect(formProblem({ ...form, name: '..' })).toContain('letters or numbers');
    expect(formProblem({ ...form, folderKind: 'existing' })).toBe('Choose the folder.');
    expect(createRequest(form)).toEqual({ name: 'Redmi Note 12', placeId: 't7', folder: { kind: 'new' } });
    expect(createRequest({ ...form, name: ' Sam ', folderKind: 'existing', existingName: 'Sam phone' })).toEqual({ name: 'Sam', placeId: 't7', folder: { kind: 'existing', name: 'Sam phone' } });
    expect(createRequest({ ...form, placeId: null })).toBeNull();
    // Whose phone it is: a person that exists, or someone new (a name is needed).
    expect(createRequest({ ...form, ownerId: 3 })).toEqual({ name: 'Redmi Note 12', placeId: 't7', folder: { kind: 'new' }, owner: { id: 3 } });
    expect(createRequest({ ...form, ownerId: 'new', newPersonName: ' Aunt ' })).toEqual({ name: 'Redmi Note 12', placeId: 't7', folder: { kind: 'new' }, owner: { newName: 'Aunt' } });
    expect(formProblem({ ...form, ownerId: 'new', newPersonName: ' ' })).toBe('Type the name of the person this phone belongs to.');
    expect(createRequest({ ...form, ownerId: 'new', newPersonName: '' })).toBeNull();
    expect(formProblem({ ...form, ownerId: 3 })).toBeNull();
  });

  it('picking another drive drops a folder that drive does not have', () => {
    const form = { ...initialForm(two), placeId: 't7', folderKind: 'existing' as const, existingName: 'HJ' };
    expect(pickDrive(form, two, 'bk')).toMatchObject({ placeId: 'bk', existingName: null });
    expect(pickDrive(form, two, 't7')).toMatchObject({ existingName: 'HJ' });
  });
});
