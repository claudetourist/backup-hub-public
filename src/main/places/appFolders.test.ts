/**
 * The folder names the user decided on, spelled out here once on purpose (this file is the module's own test), and the static rule that
 * no other source file spells them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAppOwnedEntry, isInsideAppOwnFiles, isInsideCardFolder, isOwnFilesFolder } from '../../shared/appFolders';
import {
  appFolder,
  backupsFolder,
  cardFile,
  cardFolder,
  dbCopiesFolder,
  driveTmpFolder,
  legacyCardFile,
  listsFolder,
  ownFilesFolder,
  quarantineFolder,
  setAsideFolder,
} from './appFolders';

const ROOT = 'X:\\';
const APP = "X:\\MyData\\Backup Hub - made by the app";
const OWN = `${APP}\\App's own files`;

describe('the layout of everything the app makes on a drive', () => {
  it('is one folder inside MyData, with the exact names the user chose', () => {
    expect(appFolder(ROOT)).toBe(APP);
    expect(backupsFolder(ROOT)).toBe(`${APP}\\Backups made by Backup Hub`);
    expect(ownFilesFolder(ROOT)).toBe(OWN);
  });

  it("puts the card, temp, set-aside and lists in the app's own files, in the card folder", () => {
    expect(cardFolder(ROOT)).toBe(`${OWN}\\.backuphub`);
    expect(cardFile(ROOT)).toBe(`${OWN}\\.backuphub\\drive.json`);
    expect(driveTmpFolder(ROOT)).toBe(`${OWN}\\.backuphub\\tmp`);
    expect(setAsideFolder(ROOT)).toBe(`${OWN}\\.backuphub\\set-aside`);
    expect(listsFolder(ROOT)).toBe(`${OWN}\\.backuphub\\lists`);
  });

  it("puts the database safety copies and the quarantine in the app's own files", () => {
    expect(dbCopiesFolder(ROOT)).toBe(`${OWN}\\Database safety copies`);
    expect(quarantineFolder(ROOT)).toBe(`${OWN}\\Quarantine`);
  });

  it('names the old place of the card (read only): the drive root', () => {
    expect(legacyCardFile(ROOT)).toBe('X:\\.backuphub\\drive.json');
  });

  it("nothing but the card folder, the old card folder and the app's backups folder is outside 'App's own files'", () => {
    const own = ownFilesFolder(ROOT);
    for (const f of [cardFolder, driveTmpFolder, setAsideFolder, listsFolder, dbCopiesFolder, quarantineFolder]) expect(f(ROOT).startsWith(own + path.sep)).toBe(true);
    expect(backupsFolder(ROOT).startsWith(own)).toBe(false);
  });
});

describe('what counts as the app\'s own files', () => {
  it('is the own files folder inside the app folder (case ignored), plus the card folder of an old-layout drive', () => {
    expect(isOwnFilesFolder('Backup Hub - made by the app', "App's own files")).toBe(true);
    expect(isOwnFilesFolder('backup hub - made by the app', "APP'S OWN FILES")).toBe(true);
    expect(isOwnFilesFolder('MyData', "App's own files")).toBe(false);
    expect(isAppOwnedEntry('X:', '.backuphub')).toBe(true);
    expect(isAppOwnedEntry('Backup Hub - made by the app', 'Backups made by Backup Hub')).toBe(false);
  });

  it('finds a path inside them, with either slash', () => {
    expect(isInsideAppOwnFiles(`${OWN}\\Quarantine\\a.jpg`)).toBe(true);
    expect(isInsideAppOwnFiles(OWN.replaceAll('\\', '/') + '/x')).toBe(true);
    expect(isInsideAppOwnFiles('X:\\.backuphub\\drive.json')).toBe(true);
    expect(isInsideAppOwnFiles(`${APP}\\Backups made by Backup Hub\\Reunion\\a.jpg`)).toBe(false);
    expect(isInsideAppOwnFiles('X:\\MyData\\photo.jpg')).toBe(false);
    expect(isInsideCardFolder(`${OWN}\\Database safety copies\\x.db`)).toBe(false);
    expect(isInsideCardFolder(`${OWN}\\.backuphub\\tmp\\x`)).toBe(true);
  });
});

describe('only the folder-names module spells the folder names', () => {
  const SRC = path.resolve(__dirname, '..', '..');
  const OWNERS = new Set([path.join(SRC, 'shared', 'appFolders.ts'), path.join(SRC, 'main', 'places', 'appFolders.test.ts')]);
  // ".backuphub" as a folder name (not the "com.backuphub.app" id), the old quarantine name and the new names.
  const BANNED = [/(?<![A-Za-z0-9_)\]!?])\.backuphub(?![A-Za-z0-9])/i, /BackupHub-quarantine/i, /Backup Hub - made by the app/, /Backups made by Backup Hub/, /App's own files/, /Database safety copies/];

  function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return sources(p);
      return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
    });
  }

  it('no other source file (tests included) spells them', () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      if (OWNERS.has(file)) continue;
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (BANNED.some((re) => re.test(line))) offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim().slice(0, 90)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
