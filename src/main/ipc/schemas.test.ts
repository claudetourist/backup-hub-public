import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC } from '../../shared/ipc';
import { FIRE_AND_FORGET, SCHEMAS } from './schemas';

const SRC = path.resolve(__dirname, '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

const parse = (channel: keyof typeof SCHEMAS, ...args: unknown[]) => SCHEMAS[channel].safeParse(args);

describe('every channel has exactly one schema', () => {
  it('IPC channel names are unique and SCHEMAS covers exactly them', () => {
    const channels = Object.values(IPC);
    expect(new Set(channels).size).toBe(channels.length);
    expect(Object.keys(SCHEMAS).toSorted()).toEqual([...channels].toSorted());
  });

  it('the fire-and-forget channels are real channels', () => {
    for (const channel of FIRE_AND_FORGET) expect(Object.values(IPC)).toContain(channel);
  });

  it('every channel is registered through the secure wrapper (the dev-only demo channel included)', () => {
    const text = ['appIpc.ts', 'main.ts', path.join('jobs', 'electronWiring.ts')].map((f) => fs.readFileSync(path.join(SRC, 'main', f), 'utf8')).join('\n');
    const registered = new Set([...text.matchAll(/(?:handle|secure\.handle|secure\.on)\(IPC\.(\w+)/g)].map((m) => m[1]));
    const names = Object.keys(IPC);
    expect(names.filter((n) => !registered.has(n))).toEqual([]);
  });

  it('no file outside src/main/ipc registers an ipcMain handler or listener', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !file.startsWith(path.join(SRC, 'main', 'ipc') + path.sep))
      .filter((file) => /\bipcMain\s*\.\s*(handle|handleOnce|on|once|addListener)\b/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('zod stays out of the renderer, the preload and the shared files', () => {
    const offenders = [...sourceFiles(path.join(SRC, 'renderer')), ...sourceFiles(path.join(SRC, 'preload')), ...sourceFiles(path.join(SRC, 'shared'))]
      .filter((file) => /from ['"]zod/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file));
    expect(offenders).toEqual([]);
  });
});

describe('argument checks', () => {
  it('channels without arguments refuse any argument', () => {
    expect(parse(IPC.placesList).success).toBe(true);
    expect(parse(IPC.placesList, 1).success).toBe(false);
    expect(parse(IPC.cleanupLaptopPlan, {}).success).toBe(false);
  });

  it('ids must be whole numbers above 0', () => {
    expect(parse(IPC.jobsCancel, 5).success).toBe(true);
    for (const bad of [0, -1, 1.5, '5', null, undefined, Number.NaN, 2 ** 60]) expect(parse(IPC.jobsCancel, bad).success).toBe(false);
    expect(parse(IPC.jobsCancel).success).toBe(false);
    expect(parse(IPC.jobsCancel, 5, 6).success).toBe(false);
  });

  it('strings are bounded like the old checks (place ids 80, names 200, folders 1000)', () => {
    expect(parse(IPC.placesRename, 'x'.repeat(80), 'y'.repeat(200)).success).toBe(true);
    expect(parse(IPC.placesRename, 'x'.repeat(81), 'y').success).toBe(false);
    expect(parse(IPC.placesRename, 'x', 'y'.repeat(201)).success).toBe(false);
    expect(parse(IPC.listingRemoveRoot, 'laptop', 'z'.repeat(1001), true).success).toBe(false);
    expect(parse(IPC.jobsResolve, 1, 'a'.repeat(500)).success).toBe(true);
    expect(parse(IPC.jobsResolve, 1, 'a'.repeat(501)).success).toBe(false);
  });

  it('only a real boolean can be a confirmation', () => {
    expect(parse(IPC.profilesDelete, 3, true).success).toBe(true);
    for (const bad of ['true', 1, null, undefined]) expect(parse(IPC.profilesDelete, 3, bad).success).toBe(false);
    expect(parse(IPC.importV1Start, 'yes').success).toBe(false);
    expect(parse(IPC.vaultForgot, 1).success).toBe(false);
  });

  it('people: owner changes take whole ids and a place id; a new person may carry a colour; a search may name a person', () => {
    expect(parse(IPC.peopleSetBackupOwner, 6, 3).success).toBe(true);
    for (const bad of [[0, 3], [6, 0], ['6', 3], [6, 1.5], [6]]) expect(parse(IPC.peopleSetBackupOwner, ...bad).success).toBe(false);
    expect(parse(IPC.peopleSetBackupOwner, 6, 3, 9).success).toBe(false);
    expect(parse(IPC.peopleSetPlaceOwner, 'phone-1', 2).success).toBe(true);
    for (const bad of [['', 2], ['x'.repeat(81), 2], [5, 2], ['p', -1]]) expect(parse(IPC.peopleSetPlaceOwner, ...bad).success).toBe(false);
    expect(parse(IPC.profilesCreate, 'Sam').success).toBe(true);
    expect(parse(IPC.profilesCreate, 'Sam', '#e74796').success).toBe(true);
    expect(parse(IPC.profilesCreate, 'Sam', 5).success).toBe(false);
    expect(parse(IPC.profilesCreate, 'Sam', 'x'.repeat(21)).success).toBe(false);
    expect(parse(IPC.searchRun, { text: 'a', person: 3 }).success).toBe(true);
    expect(parse(IPC.searchRun, { text: 'a', person: null }).success).toBe(true);
    for (const bad of [0, -2, 'Sam', 1.5]) expect(parse(IPC.searchRun, { text: 'a', person: bad }).success).toBe(false);
    const phone = { serial: 'S1', name: 'Redmi', placeId: 't7', folder: { kind: 'new' } };
    expect(parse(IPC.backupsCreatePhoneBackup, { ...phone, owner: { id: 2 } }).success).toBe(true);
    expect(parse(IPC.backupsCreatePhoneBackup, { ...phone, owner: { newName: 'Aunt' } }).success).toBe(true);
    expect(parse(IPC.backupsCreatePhoneBackup, phone).success).toBe(true);
    for (const bad of [{ id: 0 }, { newName: '' }, { id: 2, newName: 'x' }, { who: 'x' }, 'Sam']) expect(parse(IPC.backupsCreatePhoneBackup, { ...phone, owner: bad }).success).toBe(false);
  });

  it('jobs list: known states only, a bounded limit, no extra keys; the filter is optional', () => {
    expect(parse(IPC.jobsList).success).toBe(true);
    expect(parse(IPC.jobsList, undefined).success).toBe(true);
    expect(parse(IPC.jobsList, { limit: 300 }).success).toBe(true);
    expect(parse(IPC.jobsList, { states: ['running', 'failed'], limit: 10 }).success).toBe(true);
    expect(parse(IPC.jobsList, { states: ['bogus'] }).success).toBe(false);
    expect(parse(IPC.jobsList, { limit: 5000 }).success).toBe(false);
    expect(parse(IPC.jobsList, { limit: 1.5 }).success).toBe(false);
    expect(parse(IPC.jobsList, { limit: 10, extra: 1 }).success).toBe(false);
    expect(parse(IPC.jobsList, null).success).toBe(false);
  });

  it('name a drive: strict object, optional existingPlaceId, confirmed a boolean', () => {
    expect(parse(IPC.placesNameDrive, { letter: 'E', name: 'T7', confirmed: true }).success).toBe(true);
    expect(parse(IPC.placesNameDrive, { letter: 'E', name: 'T7', confirmed: true, existingPlaceId: 'drive:abc' }).success).toBe(true);
    expect(parse(IPC.placesNameDrive, { letter: 'E', name: 'T7' }).success).toBe(false);
    expect(parse(IPC.placesNameDrive, { letter: 'E', name: 'T7', confirmed: 'yes' }).success).toBe(false);
    expect(parse(IPC.placesNameDrive, { letter: 'E', name: 'T7', confirmed: true, force: true }).success).toBe(false);
    expect(parse(IPC.placesNameDrive, { letter: 'E', name: 'x'.repeat(201), confirmed: true }).success).toBe(false);
  });

  it('settings.set: a known key and a bounded plain value', () => {
    expect(parse(IPC.settingsSet, 'theme', 'dark').success).toBe(true);
    expect(parse(IPC.settingsSet, 'skipFolders', ['node_modules', '.git']).success).toBe(true);
    expect(parse(IPC.settingsSet, 'appDataSources', [{ path: 'C:/x', priority: 'high', on: true }]).success).toBe(true);
    expect(parse(IPC.settingsSet, 'recoveryGoogleAccount', null).success).toBe(true);
    expect(parse(IPC.settingsSet, '__proto__', 1).success).toBe(false);
    expect(parse(IPC.settingsSet, 'theme', { deep: { nested: 1 } }).success).toBe(false);
    expect(parse(IPC.settingsSet, 'theme', 'x'.repeat(2001)).success).toBe(false);
    expect(parse(IPC.settingsSet, 'skipFolders', Array.from({ length: 501 }, () => 'a')).success).toBe(false);
  });

  it('search: strict keys, known sorts and categories, bounded text', () => {
    expect(parse(IPC.searchRun, { text: 'holiday', sort: 'name', category: null, part: 'page', offset: 0 }).success).toBe(true);
    expect(parse(IPC.searchRun, {}).success).toBe(true);
    expect(parse(IPC.searchRun, { text: 'a'.repeat(4001) }).success).toBe(false);
    expect(parse(IPC.searchRun, { sort: 'random' }).success).toBe(false);
    expect(parse(IPC.searchRun, { category: 'ebooks' }).success).toBe(false);
    expect(parse(IPC.searchRun, { text: 'a', sql: '1=1' }).success).toBe(false);
    expect(parse(IPC.searchRun, { minSize: -1 }).success).toBe(false);
    expect(parse(IPC.searchRun, { placeIds: [1] }).success).toBe(false);
    expect(parse(IPC.searchRun, 'holiday').success).toBe(false);
  });

  it('kind change: 1 to 500 file targets, a known kind, no extra keys', () => {
    const target = { type: 'file', fileId: 7 };
    expect(parse(IPC.kindsChange, { kind: 'photo-camera', targets: [target], similar: true }).success).toBe(true);
    expect(parse(IPC.kindsChange, { kind: 'photo-camera', targets: [] }).success).toBe(false);
    expect(parse(IPC.kindsChange, { kind: 'photo-camera', targets: Array.from({ length: 501 }, () => target) }).success).toBe(false);
    expect(parse(IPC.kindsChange, { kind: 'nope', targets: [target] }).success).toBe(false);
    expect(parse(IPC.kindsChange, { kind: 'other', targets: [{ type: 'folder', fileId: 7 }] }).success).toBe(false);
    expect(parse(IPC.kindsChange, { kind: 'other', targets: [{ ...target, path: 'C:/x' }] }).success).toBe(false);
  });

  it('clean-up starts: the plan id, the hash, the exact numbers and a boolean confirmation are all required', () => {
    const base = { planId: 'p', hash: 'h', confirmed: true, expectCount: 2, expectBytes: 100 };
    expect(parse(IPC.cleanupPhoneStart, { ...base, indexes: [0, 1] }).success).toBe(true);
    expect(parse(IPC.cleanupPhoneStart, { ...base, indexes: [0, -1] }).success).toBe(false);
    expect(parse(IPC.cleanupPhoneStart, { ...base, indexes: [0.5] }).success).toBe(false);
    expect(parse(IPC.cleanupPhoneStart, { ...base, confirmed: 1, indexes: [] }).success).toBe(false);
    expect(parse(IPC.cleanupPhoneStart, { planId: 'p', indexes: [] }).success).toBe(false);
    expect(parse(IPC.cleanupPhoneStart, { ...base, indexes: [], files: [] }).success).toBe(false);
    expect(parse(IPC.cleanupLaptopStart, { ...base, groups: [{ id: 'g', keep: 'C:/a.jpg' }] }).success).toBe(true);
    expect(parse(IPC.cleanupLaptopStart, { ...base, groups: [{ id: 'g', keep: 5 }] }).success).toBe(false);
    expect(parse(IPC.cleanupEmptyQuarantine, { date: '2026-11-01', confirmed: true, expectCount: 1, expectBytes: 2 }).success).toBe(true);
    expect(parse(IPC.cleanupEmptyQuarantine, { date: '2026-11-01', confirmed: true, expectCount: -1, expectBytes: 2 }).success).toBe(false);
    expect(parse(IPC.cleanupPhonePlan, 'serial', 'camera').success).toBe(true);
    expect(parse(IPC.cleanupPhonePlan, 'serial').success).toBe(true);
    expect(parse(IPC.cleanupPhonePlan, 'serial', 'everything').success).toBe(false);
    expect(parse(IPC.cleanupPutBack, { serial: 's', removalIds: [1, 2], confirmed: true }).success).toBe(true);
    expect(parse(IPC.cleanupPutBack, { serial: 's', removalIds: [0], confirmed: true }).success).toBe(false);
  });

  it('local copy start needs exactly the plan id, hash and confirmation', () => {
    expect(parse(IPC.localCopyStart, { planId: 'p', hash: 'h', confirmed: true }).success).toBe(true);
    expect(parse(IPC.localCopyStart, { planId: 'p', hash: 'h', confirmed: true, target: 'F:' }).success).toBe(false);
    expect(parse(IPC.localCopyPlan, 0, 'drive').success).toBe(false);
  });

  it('passphrases are bounded strings; the restore passphrase may be null', () => {
    expect(parse(IPC.vaultUnlock, 'correct horse').success).toBe(true);
    expect(parse(IPC.vaultUnlock, 'x'.repeat(1001)).success).toBe(false);
    expect(parse(IPC.vaultUnlock, 123).success).toBe(false);
    expect(parse(IPC.settingsRestoreFromFile, null, true).success).toBe(true);
    expect(parse(IPC.settingsRestoreFromFile, 'phrase', false).success).toBe(true);
    expect(parse(IPC.settingsRestoreFromFile, undefined, true).success).toBe(false);
  });

  it('link a phone: a backup id and a serial text, nothing else; Change phone needs an id and a boolean', () => {
    expect(parse(IPC.backupsLinkPhone, { backupId: 1, serial: 'SERIAL0001' }).success).toBe(true);
    expect(parse(IPC.backupsLinkPhone, { backupId: 0, serial: 'SERIAL0001' }).success).toBe(false);
    expect(parse(IPC.backupsLinkPhone, { backupId: 1, serial: '' }).success).toBe(false);
    expect(parse(IPC.backupsLinkPhone, { backupId: 1, serial: 'x'.repeat(101) }).success).toBe(false);
    expect(parse(IPC.backupsLinkPhone, { backupId: 1, serial: 'a', extra: true }).success).toBe(false);
    expect(parse(IPC.backupsLinkPhone, { backupId: '1', serial: 'a' }).success).toBe(false);
    expect(parse(IPC.backupsNewPhoneChoices, 'sam-serial').success).toBe(true);
    expect(parse(IPC.backupsNewPhoneChoices, '').success).toBe(false);
    expect(parse(IPC.backupsNewPhoneChoices).success).toBe(false);
    const make = { serial: 'sam-serial', name: "Sam's phone", placeId: 'drive-1', folder: { kind: 'new' } };
    expect(parse(IPC.backupsCreatePhoneBackup, make).success).toBe(true);
    expect(parse(IPC.backupsCreatePhoneBackup, { ...make, folder: { kind: 'existing', name: 'Sam phone' } }).success).toBe(true);
    expect(parse(IPC.backupsCreatePhoneBackup, { ...make, folder: { kind: 'existing' } }).success).toBe(false);
    expect(parse(IPC.backupsCreatePhoneBackup, { ...make, folder: { kind: 'new', name: 'x' } }).success).toBe(false);
    expect(parse(IPC.backupsCreatePhoneBackup, { ...make, folder: { kind: 'other' } }).success).toBe(false);
    expect(parse(IPC.backupsCreatePhoneBackup, { ...make, serial: '' }).success).toBe(false);
    expect(parse(IPC.backupsCreatePhoneBackup, { ...make, extra: 1 }).success).toBe(false);
    expect(parse(IPC.backupsUnlinkPhone, 1, true).success).toBe(true);
    expect(parse(IPC.backupsUnlinkPhone, 1, 'yes').success).toBe(false);
    expect(parse(IPC.backupsUnlinkPhone, 1).success).toBe(false);
  });

  it('first paint report: a finite number or null, nothing else', () => {
    expect(parse(IPC.reportFirstPaint, { fcpMs: 123.4 }).success).toBe(true);
    expect(parse(IPC.reportFirstPaint, { fcpMs: null }).success).toBe(true);
    expect(parse(IPC.reportFirstPaint, { fcpMs: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(parse(IPC.reportFirstPaint, { fcpMs: '12' }).success).toBe(false);
    expect(parse(IPC.reportFirstPaint, { fcpMs: 1, other: 2 }).success).toBe(false);
    expect(parse(IPC.reportFirstPaint).success).toBe(false);
  });

  it('demo job options are bounded', () => {
    expect(parse(IPC.jobsCreateDemo).success).toBe(true);
    expect(parse(IPC.jobsCreateDemo, { steps: 20, stepMs: 100, mode: 'warn', heavy: true }).success).toBe(true);
    expect(parse(IPC.jobsCreateDemo, { mode: 'explode' }).success).toBe(false);
    expect(parse(IPC.jobsCreateDemo, { steps: 1e9 }).success).toBe(false);
  });
});

describe('your choices channels', () => {
  const draft = { scope: 'folder', pattern: '/sdcard/DCIM/Camera', choice: 'leave_out' };

  it('list, not-covered and its tick take exact arguments', () => {
    expect(parse(IPC.rulesList, 3).success).toBe(true);
    for (const bad of [0, -1, 1.5, '3', null, undefined]) expect(parse(IPC.rulesList, bad).success).toBe(false);
    expect(parse(IPC.rulesList, 3, 4).success).toBe(false);
    expect(parse(IPC.notCoveredGet, 3).success).toBe(true);
    expect(parse(IPC.notCoveredGet, 0).success).toBe(false);
    expect(parse(IPC.notCoveredTick, { backupId: 3, item: 'signal', ticked: true }).success).toBe(true);
    expect(parse(IPC.notCoveredTick, { backupId: 3, item: 'signal', ticked: 'yes' }).success).toBe(false);
    expect(parse(IPC.notCoveredTick, { backupId: 3, item: '', ticked: true }).success).toBe(false);
    expect(parse(IPC.notCoveredTick, { backupId: 3, item: 'signal', ticked: true, extra: 1 }).success).toBe(false);
  });

  it('saving a choice takes a known scope and choice, a path and a backup id, nothing else', () => {
    expect(parse(IPC.rulesAdd, { backupId: 3, ...draft }).success).toBe(true);
    expect(parse(IPC.rulesAdd, { backupId: 3, ...draft, scope: 'regex' }).success).toBe(false);
    expect(parse(IPC.rulesAdd, { backupId: 3, ...draft, choice: 'delete' }).success).toBe(false);
    expect(parse(IPC.rulesAdd, { backupId: 3, ...draft, pattern: '' }).success).toBe(false);
    expect(parse(IPC.rulesAdd, { backupId: 3, ...draft, pattern: 'x'.repeat(4001) }).success).toBe(false);
    expect(parse(IPC.rulesAdd, { backupId: 0, ...draft }).success).toBe(false);
    expect(parse(IPC.rulesAdd, { backupId: 3, ...draft, destination: 'google' }).success).toBe(false);
    expect(parse(IPC.rulesAdd, { ...draft }).success).toBe(false);
  });

  it('removing needs a real boolean confirmed and both ids', () => {
    expect(parse(IPC.rulesRemove, { backupId: 3, ruleId: 9, confirmed: true }).success).toBe(true);
    expect(parse(IPC.rulesRemove, { backupId: 3, ruleId: 9, confirmed: 'true' }).success).toBe(false);
    expect(parse(IPC.rulesRemove, { backupId: 3, confirmed: true }).success).toBe(false);
    expect(parse(IPC.rulesRemove, { backupId: 3, ruleId: -9, confirmed: true }).success).toBe(false);
  });

  it('the effect takes an add or a remove, an optional plan id, and nothing else', () => {
    expect(parse(IPC.rulesEffect, { backupId: 3, change: { kind: 'add', draft } }).success).toBe(true);
    expect(parse(IPC.rulesEffect, { backupId: 3, planId: 'abc', change: { kind: 'remove', ruleId: 4 } }).success).toBe(true);
    expect(parse(IPC.rulesEffect, { backupId: 3, change: { kind: 'wipe' } }).success).toBe(false);
    expect(parse(IPC.rulesEffect, { backupId: 3, change: { kind: 'remove' } }).success).toBe(false);
    expect(parse(IPC.rulesEffect, { backupId: 3, change: { kind: 'add', draft: { ...draft, scope: 'glob' } } }).success).toBe(false);
    expect(parse(IPC.rulesEffect, { backupId: 3, planId: 'x'.repeat(101), change: { kind: 'remove', ruleId: 4 } }).success).toBe(false);
    expect(parse(IPC.rulesEffect, { change: { kind: 'remove', ruleId: 4 } }).success).toBe(false);
  });
});

describe('the second drive (R1.3)', () => {
  it('choices, preview and report take one id; status takes nothing; look takes an optional id', () => {
    for (const channel of [IPC.mirrorChoices, IPC.mirrorPreview, IPC.mirrorReport]) {
      expect(parse(channel, 4).success).toBe(true);
      for (const bad of [0, -1, 1.5, '4', null]) expect(parse(channel, bad).success).toBe(false);
      expect(parse(channel).success).toBe(false);
    }
    expect(parse(IPC.mirrorStatus).success).toBe(true);
    expect(parse(IPC.mirrorStatus, 1).success).toBe(false);
    expect(parse(IPC.mirrorLook).success).toBe(true);
    expect(parse(IPC.mirrorLook, 3).success).toBe(true);
    expect(parse(IPC.mirrorLook, 0).success).toBe(false);
    expect(parse(IPC.mirrorLook, 3, 4).success).toBe(false);
  });

  it('"also keep a copy" takes a backup id and a drive id, nothing else', () => {
    expect(parse(IPC.mirrorAdd, { backupId: 1, placeId: 'drive-abc' }).success).toBe(true);
    for (const bad of [{ backupId: 0, placeId: 'x' }, { backupId: 1, placeId: '' }, { backupId: 1, placeId: 'x'.repeat(81) }, { backupId: 1 }, { backupId: 1, placeId: 'x', extra: true }]) expect(parse(IPC.mirrorAdd, bad).success).toBe(false);
  });

  it('the start needs the plan id, the hash and the unticks; nothing else (the old "also check" flag is gone)', () => {
    const ok = { planId: 'p', hash: 'h', unticked: ['0:S1/a.jpg'] };
    expect(parse(IPC.mirrorStart, ok).success).toBe(true);
    for (const bad of [{ ...ok, skipChecks: false }, { ...ok, unticked: 'a' }, { ...ok, extra: 1 }, { planId: 'p', hash: 'h' }, { ...ok, unticked: [1] }]) expect(parse(IPC.mirrorStart, bad).success).toBe(false);
  });

  it('"Check old copies": the preview takes an optional backup id, the start the plan id and hash, the report a job id', () => {
    expect(parse(IPC.mirrorCheckPreview).success).toBe(true);
    expect(parse(IPC.mirrorCheckPreview, 3).success).toBe(true);
    expect(parse(IPC.mirrorCheckPreview, 0).success).toBe(false);
    expect(parse(IPC.mirrorCheckStart, { planId: 'p', hash: 'h' }).success).toBe(true);
    for (const bad of [{ planId: 'p' }, { planId: 'p', hash: 'h', unticked: [] }, { planId: 'p', hash: 'h', extra: 1 }, { planId: 1, hash: 'h' }]) expect(parse(IPC.mirrorCheckStart, bad).success).toBe(false);
    expect(parse(IPC.mirrorCheckReport, 7).success).toBe(true);
    expect(parse(IPC.mirrorCheckReport, 'x').success).toBe(false);
  });

  it('the folder backup (R2.1, R2.8): ids and exact objects only', () => {
    for (const channel of [IPC.folderBackupLook, IPC.folderBackupPreview, IPC.folderBackupReport, IPC.folderBackupProgress, IPC.folderBackupCopied]) {
      expect(parse(channel, 5).success).toBe(true);
      for (const bad of [0, -1, 1.5, 'x', undefined]) expect(parse(channel, bad).success).toBe(false);
      expect(parse(channel, 5, 6).success).toBe(false);
    }
    expect(parse(IPC.folderBackupCards).success).toBe(true);
    expect(parse(IPC.folderBackupCards, 1).success).toBe(false);
    expect(parse(IPC.folderBackupAddKeepSync).success).toBe(true);
    expect(parse(IPC.folderBackupAddKeepSync, true).success).toBe(false);
    const ok = { planId: 'p', hash: 'h', unticked: ['/source/a.txt'], untickedFolders: ['/source/Games'], included: [] };
    expect(parse(IPC.folderBackupStart, ok).success).toBe(true);
    for (const bad of [{ ...ok, extra: 1 }, { ...ok, unticked: 'a' }, { ...ok, unticked: [1] }, { planId: 'p', hash: 'h' }, { ...ok, hash: 1 }]) expect(parse(IPC.folderBackupStart, bad).success).toBe(false);
  });

  it('"Leave it as it is" is an answer main takes for a mirror case', () => {
    expect(parse(IPC.decisionsAnswer, { key: 'mirror:7', choice: 'leave_as_is' }).success).toBe(true);
  });
});

describe('Needs your decision and Why? (R1.2b part 2)', () => {
  it('the list takes only a backup id and a time, both optional', () => {
    expect(parse(IPC.decisionsList, {}).success).toBe(true);
    expect(parse(IPC.decisionsList, { backupId: 3, since: 1_700_000_000_000 }).success).toBe(true);
    for (const bad of [{ backupId: 0 }, { backupId: '3' }, { since: -1 }, { since: 1.5 }, { extra: 1 }]) expect(parse(IPC.decisionsList, bad).success).toBe(false);
    expect(parse(IPC.decisionsList).success).toBe(false);
    expect(parse(IPC.decisionsList, {}, {}).success).toBe(false);
  });

  it('an answer is a key, one of the five answers main takes, and a real boolean for "the same for the others"', () => {
    for (const choice of ['same_drive', 'other_drive', 'try_again', 'accept', 'copy_again']) expect(parse(IPC.decisionsAnswer, { key: 'differs:7', choice }).success).toBe(true);
    expect(parse(IPC.decisionsAnswer, { key: 'differs:7', choice: 'copy_again', similar: true }).success).toBe(true);
    expect(parse(IPC.decisionsAnswer, { key: 'differs:7', choice: 'copy_again', similar: 'yes' }).success).toBe(false);
    expect(parse(IPC.decisionsAnswer, { key: 'differs:7', choice: 'show_file' }).success).toBe(false); // "Show the file" is the search's own call, not an answer
    expect(parse(IPC.decisionsAnswer, { key: 'differs:7', choice: 'delete' }).success).toBe(false);
    expect(parse(IPC.decisionsAnswer, { key: '', choice: 'accept' }).success).toBe(false);
    expect(parse(IPC.decisionsAnswer, { key: 'x'.repeat(41), choice: 'accept' }).success).toBe(false);
    expect(parse(IPC.decisionsAnswer, { choice: 'accept' }).success).toBe(false);
    expect(parse(IPC.decisionsAnswer, { key: 'look:1', choice: 'accept', force: true }).success).toBe(false);
  });

  it('Why? takes a file id, or a backup id with a phone path, and nothing else', () => {
    expect(parse(IPC.fileWhy, { fileId: 12 }).success).toBe(true);
    expect(parse(IPC.fileWhy, { backupId: 3, phonePath: '/sdcard/DCIM/a.jpg' }).success).toBe(true);
    for (const bad of [{ fileId: 0 }, { fileId: '12' }, { backupId: 3 }, { phonePath: '/sdcard/a' }, { backupId: 3, phonePath: '' }, { backupId: 3, phonePath: 'x'.repeat(4001) }, { fileId: 12, backupId: 3, phonePath: '/sdcard/a.jpg' }, {}]) expect(parse(IPC.fileWhy, bad).success).toBe(false);
  });
});
