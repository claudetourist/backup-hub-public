import { describe, expect, it } from 'vitest';
import type { CheckOldCounts, CheckOldFolderCounts, CheckOldReport } from '../../shared/phoneBackup';
import { breakdownText, CHECK_OLD_BUTTON, neverRead, neverReadText, confirmText, folderLine, folderTickLine, foldTitle, headlineText, lookedAtText, namedRows, reportLines, reportTitle, selectionTotals, tickAll, tickedFolders, toggleFolder, untickAll } from './checkOldModel';

const b = (files: number, gb: number): { files: number; bytes: number } => ({ files, bytes: Math.round(gb * 1e9) });
const counts: CheckOldCounts = { onPhone: b(33_721, 100), checked: b(12_345, 30), unchecked: b(19_900, 60), noCopy: b(1_300, 9), leftOut: b(176, 1) };
const folder: CheckOldFolderCounts = { folder: 'DCIM/Camera', onPhone: b(20_000, 80), checked: b(8_000, 30), unchecked: b(11_000, 45), noCopy: b(1_000, 5), leftOut: b(0, 0) };
const report: CheckOldReport = {
  jobId: 5, backupName: 'Poco F4', phoneName: 'Poco F4', driveLabel: 'T7', startedAt: 1, finishedAt: 2, asked: 100,
  verified: b(94, 12), differ: [{ path: '/sdcard/DCIM/Camera/a.mp4', size: 148_000_000 }, { path: '/sdcard/b.jpg', size: 4_000_000 }], differCount: 2,
  missing: [{ path: '/sdcard/DCIM/Camera/c.jpg', size: 3_000_000 }], missingCount: 1, noLongerOnPhone: 2,
  couldNotRead: [{ reason: 'The phone did not give a checksum for this file.', count: 1, examples: ['/sdcard/DCIM/Camera/d.jpg'] }],
};

describe('the words of "Check old copies"', () => {
  it('the headline says how many files have a checked copy and where', () => {
    expect(headlineText('Poco F4', 'T7', counts)).toBe('Poco F4: 12,345 of 33,721 files have a checked copy on T7.');
    expect(headlineText('Poco F4', 'T7', { ...counts, onPhone: b(1, 0), checked: b(1, 0) })).toBe('Poco F4: 1 of 1 file has a checked copy on T7.');
    expect(CHECK_OLD_BUTTON).toBe('Check old copies');
  });

  it('a phone with no file known yet was never read: one plain sentence by the backup name', () => {
    expect(neverRead({ onPhone: b(0, 0), checked: b(0, 0), unchecked: b(0, 0), noCopy: b(0, 0), leftOut: b(0, 0) })).toBe(true);
    expect(neverRead(counts)).toBe(false);
    expect(neverReadText('Sam phone')).toBe('Sam phone has not been read yet. Back it up once, then this shows how many files have a checked copy.');
  });

  it('names the rest in plain words and leaves out the parts that are zero', () => {
    expect(breakdownText(counts)).toBe('19,900 files (60 GB) have a copy that was never checked; 1,300 files (9 GB) have no copy yet; 176 files (1 GB) are left out on purpose.');
    expect(breakdownText({ ...counts, unchecked: b(0, 0), leftOut: b(0, 0) })).toBe('1,300 files (9 GB) have no copy yet.');
    expect(breakdownText({ onPhone: b(0, 0), checked: b(0, 0), unchecked: b(0, 0), noCopy: b(0, 0), leftOut: b(0, 0) })).toBe('');
  });

  it('a folder line shows checked of all, in files and GB', () => {
    expect(folderLine(folder)).toBe('DCIM/Camera: 8,000 of 20,000 checked (30 GB of 80 GB). not checked yet: 11,000 (45 GB), no copy: 1,000');
    expect(lookedAtText(null, String)).toBeNull();
    expect(lookedAtText(5, (ms) => `day ${ms}`)).toBe('As of the last look at the phone, day 5.');
  });

  it('the preview button counts only the ticked folders, and a folder can be unticked and ticked again', () => {
    const folders = [{ folder: 'DCIM/Camera', files: 11_000, bytes: 45e9 }, { folder: 'Download', files: 20, bytes: 5e6 }];
    expect(selectionTotals(folders, new Set())).toEqual({ files: 11_020, bytes: 45_005_000_000 });
    expect(confirmText(selectionTotals(folders, new Set()))).toBe('Check 11,020 files (45 GB)');
    expect(confirmText(selectionTotals(folders, new Set(['DCIM/Camera'])))).toBe('Check 20 files (5 MB)');
    expect(confirmText({ files: 1, bytes: 1000 })).toBe('Check 1 file (1 KB)');
    expect(folderTickLine(folders[0]!)).toBe('DCIM/Camera: 11,000 files, 45 GB');
    const off = toggleFolder(new Set(), 'Download');
    expect([...off]).toEqual(['Download']);
    expect(toggleFolder(off, 'Download').size).toBe(0);
  });

  it('Tick all and Untick all give a new set and the ticked count follows', () => {
    const folders = [{ folder: 'DCIM/Camera', files: 11_000, bytes: 45e9 }, { folder: 'Download', files: 20, bytes: 5e6 }];
    const off = untickAll(folders);
    expect([...off].toSorted()).toEqual(['DCIM/Camera', 'Download']);
    expect(tickedFolders(folders, off)).toBe(0);
    expect(selectionTotals(folders, off)).toEqual({ files: 0, bytes: 0 });
    const on = tickAll();
    expect(on.size).toBe(0);
    expect(tickedFolders(folders, on)).toBe(2);
    expect(tickedFolders(folders, new Set(['Download']))).toBe(1);
    expect(tickAll()).not.toBe(on);
  });

  it('the report says what is now checked, what differs (and that it will be copied again), what is missing, gone and unread', () => {
    const lines = reportLines(report);
    expect(lines.map((l) => l.key)).toEqual(['verified', 'differ', 'missing', 'gone', 'unread:The phone did not give a checksum for this file.']);
    expect(lines[0]!.text).toBe('94 files (12 GB) are the same on the phone and on T7. They now count as checked copies.');
    expect(lines[1]!.text).toBe('2 files are not the same on T7 as on the phone. The copy on T7 was left exactly as it is. The next backup copies these files again, into a new folder.');
    expect(lines[2]!.text).toBe('1 file is not on T7 any more. The next backup copies it again.');
    expect(lines[3]!.text).toBe('2 files are no longer on the phone. Skipped.');
    expect(lines[4]!.text).toContain('could not be read');
    expect(lines[4]!.text).toContain('For example: d.jpg.');
    // Nothing found wrong: only the good line.
    expect(reportLines({ ...report, differCount: 0, differ: [], missingCount: 0, missing: [], noLongerOnPhone: 0, couldNotRead: [] }).map((l) => l.key)).toEqual(['verified']);
    expect(reportTitle(report)).toBe('Checked 100 files from Poco F4');
  });

  it('names the files that differ with their folder and size, and says when only the first are named', () => {
    expect(namedRows(report.differ)).toEqual([
      { key: '/sdcard/DCIM/Camera/a.mp4', name: 'a.mp4', folder: 'DCIM/Camera', size: '148 MB' },
      { key: '/sdcard/b.jpg', name: 'b.jpg', folder: 'Phone storage', size: '4 MB' },
    ]);
    expect(foldTitle('Files that differ', 2, 2)).toBe('Files that differ (2)');
    expect(foldTitle('Files that differ', 5000, 2000)).toBe('Files that differ (5,000, the first 2,000 are named)');
  });

  it('uses none of the program words on screen', () => {
    const all = [headlineText('Poco F4', 'T7', counts), breakdownText(counts), folderLine(folder), ...reportLines(report).map((l) => l.text)].join(' ');
    for (const word of ['verified_how', 'row', 'index', 'destination', 'serial', 'differs']) expect(all.toLowerCase(), word).not.toMatch(new RegExp(`\\b${word}\\b`));
  });
});
