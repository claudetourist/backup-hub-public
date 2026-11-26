import { describe, expect, it } from 'vitest';
import type { FolderBackupReport } from '../../shared/folderBackup';
import { FOLDER_TOP_WORDS } from '../../shared/folderBackup';
import { choiceOptions, exclusionLine, folderChoice, draftTitle } from './choicesModel';
import { alreadyLine, folderButton, folderIdleLines, folderReportData, movedLine, movedLines, onlineOnlyLine } from './folderBackupModel';
import { excludedBy, folderOf, folderPathOf, folderTotals, listRows } from './phoneBackupModel';

describe('a folder backup in the list, the choices and the words', () => {
  const rows = [
    { path: '/source/Photos/2026/a.jpg', size: 3_000_000, mtimeSec: 1_760_000_000, kind: 'new' as const },
    { path: '/source/top.txt', size: 40, mtimeSec: 1_760_000_000, kind: 'changed' as const },
  ];

  it('names a file by its folder below the backed-up folder, and a file in the top folder by the plain words "Main folder"', () => {
    expect(folderOf('/source/Photos/2026/a.jpg')).toBe('Photos/2026');
    expect(folderPathOf('/source/Photos/2026/Trips/a.jpg')).toBe('Photos/2026/Trips');
    expect(folderOf('/source/top.txt')).toBe(FOLDER_TOP_WORDS);
    expect(folderPathOf('/source/top.txt')).toBe('Main folder');
    // The phone's words are unchanged.
    expect(folderOf('/sdcard/top.txt')).toBe('Phone storage');
    expect(listRows(rows).map((r) => [r.name, r.folder])).toEqual([['a.jpg', 'Photos/2026'], ['top.txt', 'Main folder']]);
    expect(folderTotals(rows, new Set()).map((f) => f.folder)).toEqual(['Photos/2026', 'Main folder']);
  });

  it('offers "never back up" for the file, its folder and its kind, in the words of the folder (never "/source/")', () => {
    const options = choiceOptions('/source/Photos/2026/a.jpg');
    expect(options.map((o) => o.id)).toEqual(['file', 'folder', 'kind']);
    expect(options[1]!.hint).toBe('Photos/2026');
    expect(options[1]!.draft).toEqual({ scope: 'folder', pattern: '/source/Photos/2026', choice: 'leave_out' });
    // A file straight in the top folder has no smaller folder to name.
    expect(choiceOptions('/source/top.txt').map((o) => o.id)).toEqual(['file', 'kind']);
    expect(folderChoice('Photos/2026', '/source')?.draft.pattern).toBe('/source/Photos/2026');
    expect(folderChoice(FOLDER_TOP_WORDS, '/source')).toBeNull();
    expect(draftTitle({ scope: 'folder', pattern: '/source/Photos/2026', choice: 'leave_out' })).toBe('Never back up this folder: Photos/2026');
  });

  it('shows a row an exclusion names as excluded, the exclusion line in plain words, and nothing of the root', () => {
    const rule = { id: 4, scope: 'folder' as const, choice: 'leave_out' as const, pattern: '/source/Photos', words: 'Never back up: Photos (folder)', createdAt: 1_760_000_000_000, everyBackup: false };
    expect([...excludedBy(listRows(rows), [rule]).keys()]).toEqual(['/source/Photos/2026/a.jpg']);
    expect(exclusionLine(rule)).toMatchObject({ kind: 'Folder', name: 'Photos', where: FOLDER_TOP_WORDS });
  });

  it('the idle words, the already-backed-up line, the online-only line', () => {
    expect(folderButton('OneDrive Local Backup')).toBe('Back up OneDrive Local Backup now');
    expect(folderIdleLines({ sourceWords: 'C:\\Users\\you\\OneDrive', layout: 'dated' })).toHaveLength(1);
    const keep = folderIdleLines({ sourceWords: 'the keep-sync snapshots', layout: 'flat' }).join(' ');
    expect(keep).toContain('never opens, reads or shows what is inside');
    expect(keep).toContain('ever replaced or deleted');
    expect(alreadyLine({ alreadyBackedUp: 61_204, sameContentElsewhere: 37, differentOnDrive: 0, layout: 'dated', driveLabel: 'T7' })).toBe('Already backed up: 61,204 files. 37 of them were found by their content under another name or date, so they are linked and not copied again.');
    expect(alreadyLine({ alreadyBackedUp: 1, sameContentElsewhere: 0, differentOnDrive: 2, layout: 'flat', driveLabel: 'T7' })).toContain('2 files have the same name as one on T7 but another size. They are never replaced');
    expect(onlineOnlyLine({ files: 0, bytes: 0, examples: [] })).toBeNull();
    expect(onlineOnlyLine({ files: 412, bytes: 8_400_000_000, examples: [] })).toBe('Online only, not copied this time: 412 files, 8.4 GB. They are in OneDrive but not on this computer, so nothing was opened or downloaded.');
  });

  it('files renamed or moved since they were backed up: one plain line per folder, the biggest three, then one line for the rest', () => {
    expect(movedLine({ kind: 'folder_renamed', from: 'Trip', to: 'Goa 2026', files: 1_204 })).toBe('Folder renamed: Trip > Goa 2026 (1,204 files): nothing to copy.');
    expect(movedLine({ kind: 'folder_moved', from: 'Docs', to: 'Archive/Docs', files: 1 })).toBe('Folder moved: Docs > Archive\\Docs (1 file): nothing to copy.');
    expect(movedLine({ kind: 'folder_moved', from: '', to: 'Docs', files: 4 })).toBe(`Folder moved: ${FOLDER_TOP_WORDS} > Docs (4 files): nothing to copy.`);
    expect(movedLine({ kind: 'files', from: '', to: '', files: 7 })).toBe('7 files renamed or moved on their own: nothing to copy.');
    expect(movedLines({ moved: [], movedFiles: 0 })).toEqual([]);
    const g = (n: number, files: number): { kind: 'folder_renamed'; from: string; to: string; files: number } => ({ kind: 'folder_renamed', from: `Old${n}`, to: `New${n}`, files });
    const lines = movedLines({ moved: [g(1, 50), g(2, 40), g(3, 30), g(4, 20)], movedFiles: 160 });
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('And 40 more files renamed or moved: nothing to copy.');
  });

  it('the report lists files in use and files already in the backup as skipped, with their reason', () => {
    const report: FolderBackupReport = {
      jobId: 1, runId: 1, backupName: 'OneDrive Local Backup', sourceWords: 'C:\\OneDrive', layout: 'dated', startedAt: 1, finishedAt: 2,
      copied: { files: 10, bytes: 1000 }, linked: 3, inUse: [{ reason: 'x', count: 2, examples: ['Mail/a.pst', 'Mail/b.pst'] }], inUseCount: 2,
      skipped: [{ reason: 'It changed after the list was made.', count: 1, examples: ['c.txt'] }, { reason: 'empty', count: 0, examples: [] }], failed: [],
      leftOut: { files: 0, bytes: 0 }, onlineOnly: { files: 0, bytes: 0, examples: [] }, where: ['T7: MyData\\OneDriveBackup\\OneDrive-25Nov26'], listPath: null, listProblem: null,
    };
    const data = folderReportData(report, () => 'today');
    expect(data.copied).toEqual({ files: 10, bytes: 1000 });
    expect(data.skipped.map((s) => [s.reason, s.count])).toEqual([
      ['It changed after the list was made.', 1],
      ['In use by another program. It was skipped and the next backup tries it again.', 2],
      ['already in the backup (not copied again)', 3],
    ]);
    expect(data.skipped[1]!.examples).toEqual(['Mail/a.pst', 'Mail/b.pst']);
    expect(data.failed).toEqual([]);
  });
});
