import { describe, expect, it } from 'vitest';
import type { LeftOutGroup, PhoneBackupReport, PreviewRow } from '../../shared/phoneBackup';
import { ruleWords, type RuleView } from '../../shared/rules';
import {
  backUpNowButton,
  cappedNote,
  cardTitle,
  copyingTitle,
  phoneModelLine,
  confirmText,
  copiedFoldTitle,
  copiedRows,
  copyingNowText,
  dateText,
  doneTitle,
  filesDoneText,
  filterListRows,
  fileNameOf,
  folderOf,
  folderPathOf,
  folderTotals,
  leftOutLine,
  listCount,
  listCountText,
  listRows,
  notCopiedTitle,
  OLD_TOOL_WARNING,
  PREVIEW_HEADLINE,
  UNTICK_VS_EXCLUDE,
  excludedBy,
  withoutExcluded,
  PROGRESS_POLL_MS,
  progressRow,
  reportData,
  selectionTotals,
  setTicks,
  stillToCopyTitle,
  toggleFolder,
  untickEveryRow,
} from './phoneBackupModel';

const rows: PreviewRow[] = [
  { path: '/sdcard/DCIM/Camera/a.jpg', size: 3000, mtimeSec: 1, kind: 'new' },
  { path: '/sdcard/DCIM/Camera/b.jpg', size: 1000, mtimeSec: 1, kind: 'changed' },
  { path: '/sdcard/Download/c.pdf', size: 500, mtimeSec: 1, kind: 'new' },
  { path: '/sdcard/top.txt', size: 1, mtimeSec: 1, kind: 'new' },
];
const group: LeftOutGroup = { key: 'nomedia|/sdcard/Games', filter: 'nomedia', folder: '/sdcard/Games', files: 10, bytes: 2_000_000, canInclude: true };

describe("the card of a connected phone uses the backup's name, not the phone's model", () => {
  it('the title, the button and the progress headline carry the name; the model is only a quiet line', () => {
    expect(cardTitle('Sam phone')).toBe('Sam phone is connected: back up now?');
    expect(backUpNowButton('Sam phone')).toBe('Back up Sam phone now');
    expect(copyingTitle('Sam phone', 'T7')).toBe('Copying Sam phone to T7');
    expect(copyingTitle('Sam phone', null)).toBe('Copying Sam phone to the drive');
    expect(phoneModelLine('Sam phone', 'SM M356B')).toBe('Phone: SM M356B');
    expect(phoneModelLine('Poco F4', 'poco f4')).toBeNull();
    expect(phoneModelLine('Sam phone', '  ')).toBeNull();
    for (const words of [cardTitle('Sam phone'), backUpNowButton('Sam phone'), copyingTitle('Sam phone', 'T7')]) expect(words).not.toContain('SM M356B');
  });
});

describe('the phone backup panel model', () => {
  it('groups rows by folder, biggest first', () => {
    expect(folderOf('/sdcard/DCIM/Camera/Sub/a.jpg')).toBe('DCIM/Camera');
    expect(folderOf('/sdcard/top.txt')).toBe('Phone storage');
    expect(folderTotals(rows, new Set()).map((f) => [f.folder, f.files, f.bytes])).toEqual([
      ['DCIM/Camera', 2, 4000],
      ['Download', 1, 500],
      ['Phone storage', 1, 1],
    ]);
  });

  it('unticking a folder unticks every file in it, and ticking brings them back', () => {
    const off = toggleFolder(rows, new Set(), 'DCIM/Camera');
    expect([...off].toSorted()).toEqual(['/sdcard/DCIM/Camera/a.jpg', '/sdcard/DCIM/Camera/b.jpg']);
    expect(toggleFolder(rows, off, 'DCIM/Camera').size).toBe(0);
    expect(folderTotals(rows, off)[0]!.tickedFiles).toBe(0);
  });

  it('Untick all in the By folder fold unticks every row, and an empty set is Tick all', () => {
    const off = untickEveryRow(rows);
    expect([...off].toSorted()).toEqual(rows.map((r) => r.path).toSorted());
    expect(folderTotals(rows, off).every((f) => f.tickedFiles === 0)).toBe(true);
    expect(folderTotals(rows, new Set()).every((f) => f.tickedFiles === f.files)).toBe(true);
  });

  it('the copy button says what will be copied, with included left-out groups added', () => {
    expect(selectionTotals({ rows, leftOut: [group] }, new Set(['/sdcard/top.txt']), new Set())).toEqual({ files: 3, bytes: 4500 });
    expect(selectionTotals({ rows, leftOut: [group] }, new Set(), new Set([group.key]))).toEqual({ files: 14, bytes: 2_004_501 });
    expect(confirmText({ files: 312, bytes: 46_500_000_000 }, 'T7')).toBe('Copy 312 files (46.5 GB) to T7');
    expect(confirmText({ files: 1, bytes: 5 }, 'T7')).toBe('Copy 1 file (5 B) to T7');
  });

  it('says how many files each filter left out, per folder', () => {
    expect(leftOutLine(group)).toBe('Folders the phone marks as not for the gallery (.nomedia): /sdcard/Games: left out: 10 files, 2 MB');
  });

  it('turns the stored report into the kit report and keeps the warning about the old tool', () => {
    const r: PhoneBackupReport = {
      jobId: 1, runId: 1, backupName: 'Poco', phoneName: 'Poco F4', startedAt: 1, finishedAt: 2, copied: { files: 5, bytes: 100 }, linked: 2,
      skipped: [{ reason: 'It changed on the phone after the preview.', count: 1, examples: ['x'] }], failed: [], leftOut: { files: 0, bytes: 0 }, where: ['T7: MyData\\POCO'], notCovered: [], listPath: null, listProblem: null,
    };
    const data = reportData(r, () => 'now');
    expect(data.skipped.map((s) => s.count)).toEqual([1, 2]);
    expect(data.finished).toBe('now');
    expect(OLD_TOOL_WARNING).toContain('Do not run the old PhoneBackup');
  });
});

describe('the list before the copy', () => {
  const day = Math.floor(new Date(2026, 10, 23, 12).getTime() / 1000);
  const big: PreviewRow[] = [
    { path: '/sdcard/DCIM/Camera/VID_1.mp4', size: 900_000_000, mtimeSec: day, kind: 'new' },
    { path: '/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-1-WA0001.jpg', size: 80_000, mtimeSec: day, kind: 'new' },
    { path: '/sdcard/DCIM/Camera/IMG_2.jpg', size: 4_000_000, mtimeSec: day, kind: 'changed' },
    { path: '/sdcard/DCIM/Camera/IMG_1.jpg', size: 4_000_000, mtimeSec: day, kind: 'new' },
    { path: '/sdcard/notes.txt', size: 2000, mtimeSec: day, kind: 'new' },
  ];

  it('says what the list is for, in plain words', () => {
    expect(PREVIEW_HEADLINE).toBe('Files to copy, largest first.');
    expect(UNTICK_VS_EXCLUDE).toBe('Untick = skip this time. Exclude = never back up.');
  });

  it('splits a path into the name and the whole folder under it', () => {
    expect(fileNameOf('/sdcard/DCIM/Camera/VID_1.mp4')).toBe('VID_1.mp4');
    expect(folderPathOf('/sdcard/DCIM/Camera/VID_1.mp4')).toBe('DCIM/Camera');
    expect(folderPathOf('/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/x.jpg')).toBe('Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images');
    expect(folderPathOf('/sdcard/notes.txt')).toBe('Phone storage');
    expect(dateText(day)).toBe('23 Nov 2026');
  });

  it('lists the largest first; the same size goes by name, so the order never jumps', () => {
    const list = listRows(big);
    expect(list.map((r) => r.name)).toEqual(['VID_1.mp4', 'IMG_1.jpg', 'IMG_2.jpg', 'IMG-1-WA0001.jpg', 'notes.txt']);
    expect(list[0]).toMatchObject({ folder: 'DCIM/Camera', size: 900_000_000, date: '23 Nov 2026', kind: 'new' });
    expect(list[2]!.kind).toBe('changed');
    expect(listRows([...big].toReversed()).map((r) => r.path)).toEqual(list.map((r) => r.path));
  });

  it('the search keeps the rows whose name or folder holds every word, in any case; an empty box keeps all', () => {
    const list = listRows(big);
    expect(filterListRows(list, '')).toHaveLength(5);
    expect(filterListRows(list, '   ')).toHaveLength(5);
    expect(filterListRows(list, 'whatsapp').map((r) => r.name)).toEqual(['IMG-1-WA0001.jpg']);
    expect(filterListRows(list, 'camera IMG').map((r) => r.name)).toEqual(['IMG_1.jpg', 'IMG_2.jpg']);
    expect(filterListRows(list, 'DCIM/CAMERA vid').map((r) => r.name)).toEqual(['VID_1.mp4']);
    expect(filterListRows(list, 'nothing like this')).toEqual([]);
  });

  it('Untick all and Tick all act only on the rows the search shows', () => {
    const list = listRows(big);
    const camera = filterListRows(list, 'camera');
    const off = setTicks(new Set(['/sdcard/notes.txt']), camera, false);
    expect([...off].toSorted()).toEqual(['/sdcard/DCIM/Camera/IMG_1.jpg', '/sdcard/DCIM/Camera/IMG_2.jpg', '/sdcard/DCIM/Camera/VID_1.mp4', '/sdcard/notes.txt']);
    const back = setTicks(off, camera, true);
    expect([...back]).toEqual(['/sdcard/notes.txt']);
    // The input set is never changed.
    expect(off.size).toBe(4);
  });

  it('counts what is ticked, with and without a search, and the button words follow', () => {
    const list = listRows(big);
    const unticked = new Set(['/sdcard/DCIM/Camera/VID_1.mp4', '/sdcard/notes.txt']);
    expect(listCountText(listCount(list, list, unticked))).toBe('3 of 5 files ticked');
    const camera = filterListRows(list, 'camera');
    expect(listCount(list, camera, unticked)).toEqual({ shown: 3, shownTicked: 2, all: 5, allTicked: 3, excluded: 0 });
    expect(listCountText(listCount(list, camera, unticked))).toBe('Showing 3 of 5 files (2 ticked). 3 of 5 files ticked.');
    const plan = { rows: big, leftOut: [] };
    const sel = selectionTotals(plan, unticked, new Set());
    expect(sel).toEqual({ files: 3, bytes: 8_080_000 });
    expect(confirmText({ files: 180, bytes: 1_100_000_000 }, 'T7')).toBe('Copy 180 files (1.1 GB) to T7');
  });

  describe('excluded rows (never back up) are not untick', () => {
    const view = (id: number, scope: RuleView['scope'], pattern: string, choice: RuleView['choice'] = 'leave_out'): RuleView => ({ id, scope, choice, pattern, words: ruleWords({ scope, pattern, choice }), createdAt: 1, everyBackup: false });

    it('finds the rows a file, folder or type choice names, with the choice that decides each', () => {
      const list = listRows(big);
      const by = excludedBy(list, [view(1, 'file', '/sdcard/notes.txt'), view(2, 'folder', '/sdcard/Android/media/com.whatsapp'), view(3, 'pattern', '*.MP4')]);
      expect([...by.keys()].toSorted()).toEqual(['/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-1-WA0001.jpg', '/sdcard/DCIM/Camera/VID_1.mp4', '/sdcard/notes.txt']);
      expect(by.get('/sdcard/DCIM/Camera/VID_1.mp4')!.id).toBe(3);
      expect(by.get('/sdcard/notes.txt')!.id).toBe(1);
    });

    it('a more specific "always include" brings a row back, an empty list excludes nothing', () => {
      const list = listRows(big);
      const by = excludedBy(list, [view(1, 'folder', '/sdcard/DCIM'), view(2, 'file', '/sdcard/DCIM/Camera/IMG_1.jpg', 'include')]);
      expect([...by.keys()].toSorted()).toEqual(['/sdcard/DCIM/Camera/IMG_2.jpg', '/sdcard/DCIM/Camera/VID_1.mp4']);
      expect(excludedBy(list, []).size).toBe(0);
      expect(excludedBy(list, [view(3, 'folder', '/sdcard/DCIM', 'include')]).size).toBe(0);
    });

    it('an excluded row is never counted as ticked: "47 of 47 files ticked · 1 excluded"', () => {
      const list = listRows(big);
      const excluded = excludedBy(list, [view(1, 'file', '/sdcard/notes.txt')]);
      const c = listCount(list, list, new Set(['/sdcard/DCIM/Camera/VID_1.mp4']), excluded);
      expect(c).toEqual({ shown: 4, shownTicked: 3, all: 4, allTicked: 3, excluded: 1 });
      expect(listCountText(c)).toBe('3 of 4 files ticked · 1 excluded');
      expect(listCountText(listCount(list, list, new Set(), excluded))).toBe('4 of 4 files ticked · 1 excluded');
      expect(withoutExcluded(list, excluded)).toHaveLength(4);
      // the copy button counts the same rows
      expect(selectionTotals({ rows: withoutExcluded(big, excluded), leftOut: [] }, new Set(), new Set())).toEqual({ files: 4, bytes: 908_080_000 });
    });

    it('undo: with the choice gone the row is counted and ticked again', () => {
      const list = listRows(big);
      const rules = [view(1, 'file', '/sdcard/notes.txt')];
      expect(excludedBy(list, rules).size).toBe(1);
      expect(listCountText(listCount(list, list, new Set(), excludedBy(list, [])))).toBe('5 of 5 files ticked');
    });
  });
});

describe('the copy while it runs', () => {
  it('asks no faster than once a second', () => {
    expect(PROGRESS_POLL_MS).toBeGreaterThanOrEqual(1000);
  });

  it('says which file is being copied now, with its size', () => {
    expect(copyingNowText({ path: '/sdcard/DCIM/Camera/VID_1.mp4', size: 150_000_000 })).toBe('Copying now: VID_1.mp4 (150 MB)');
    expect(copyingNowText(null)).toBe('Getting the next file ready');
  });

  it('names the lists with their counts and says when a list shows only the start', () => {
    const p = { done: 203, failedCount: 1, waiting: 1204, total: 1408 };
    expect(filesDoneText(p)).toBe('204 of 1,408 files');
    expect(stillToCopyTitle(p)).toBe('Still to copy (1,204)');
    expect(doneTitle(p)).toBe('Done (203)');
    expect(notCopiedTitle(p)).toBe('Not copied (1)');
    expect(cappedNote(200, 1204)).toBe('Showing the first 200 of 1,204.');
    expect(cappedNote(50, 50)).toBeNull();
  });

  it('shows a waiting or finished file as its name, its folder and its size', () => {
    expect(progressRow({ path: '/sdcard/Download/a.pdf', size: 1500 })).toEqual({ key: '/sdcard/Download/a.pdf', name: 'a.pdf', folder: 'Download', size: 1500 });
  });

  it('lists the copied files of the report, largest first, with the fold title', () => {
    expect(copiedFoldTitle(203)).toBe('Show all copied files (203)');
    const copied = copiedRows([
      { path: '/sdcard/a.txt', size: 5, mtimeMs: null },
      { path: '/sdcard/Download/b.zip', size: 9000, mtimeMs: new Date(2026, 10, 23, 12).getTime() },
    ]);
    expect(copied.map((r) => [r.name, r.folder, r.size, r.date])).toEqual([
      ['b.zip', 'Download', 9000, '23 Nov 2026'],
      ['a.txt', 'Phone storage', 5, ''],
    ]);
  });
});
