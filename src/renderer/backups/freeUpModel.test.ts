import { describe, expect, it } from 'vitest';
import type { FreeUpGroupView, FreeUpPrepareView, FreeUpResultView } from '../../shared/freeUp';
import { CHECK_MODES, keptNote, ranSteps, removeModeSummary, shortDate, shortFolder, stepLine, stepsHeader, ageText, confirmLines, groupWords, isOldCheck, lockedLines, notReadyHeader, removeButton, removedLine, reviewButton, tickedTotals, pageTick, pageFilesTick, tickAllGroupLink, untickAllLink, TICK_HELP, putBackButton, putBackConfirmLine, putBackDate, rangeText, shortDateTime, tickAllLink, tickOne, tickPage, tickedBytes } from './freeUpModel';

const groups: FreeUpGroupView[] = [
  { id: 'big-videos', label: 'Big videos (over 100 MB)', files: 12, bytes: 30_200_000_000 },
  { id: 'camera-photos', label: 'Camera photos', files: 408, bytes: 16_000_000_000 },
];

describe('the words of Free up phone space', () => {
  it('writes a group as its name, its files and its size', () => {
    expect(groupWords(groups[0]!)).toBe('Big videos (over 100 MB): 12 files, 30.2 GB');
    expect(groupWords({ label: 'Screenshots', files: 1, bytes: 400_000 })).toBe('Screenshots: 1 file, 0 MB');
  });

  it('says how many files of a group the person left out (unticked), and nothing when none', () => {
    expect(groupWords({ ...groups[1]!, files: 398, leftOutFiles: 10 })).toBe('Camera photos: 398 files, 16.0 GB (10 left out)');
    expect(groupWords({ ...groups[1]!, leftOutFiles: 0 })).toBe('Camera photos: 408 files, 16.0 GB');
  });

  it('the per-file ticks: the header tick of a page, the Tick all / Untick all words, and the difference from Keep', () => {
    expect(pageFilesTick([{ ticked: true }, { ticked: true }])).toBe('all');
    expect(pageFilesTick([{ ticked: true }, { ticked: false }])).toBe('some');
    expect(pageFilesTick([{ ticked: false }, {}])).toBe('none');
    expect(pageFilesTick([])).toBe('none');
    expect(tickAllGroupLink(12_345)).toBe('Tick all 12,345');
    expect(untickAllLink).toBe('Untick all');
    expect(TICK_HELP).toMatch(/stays on the phone this time/);
    expect(TICK_HELP).toMatch(/Keep on the phone.*never offered/);
  });

  it('adds up only the ticked groups, and says what the one button does', () => {
    expect(tickedTotals(groups, new Set())).toEqual({ files: 0, bytes: 0 });
    expect(tickedTotals(groups, new Set(['big-videos', 'camera-photos']))).toEqual({ files: 420, bytes: 46_200_000_000 });
    expect(reviewButton({ files: 0, bytes: 0 })).toBe('Tick a group to go on');
    expect(reviewButton({ files: 420, bytes: 46_200_000_000 })).toBe('Review 420 files: free 46.2 GB');
  });

  it('the confirm screen says exactly what goes and where the three copies are', () => {
    const p: FreeUpPrepareView = { checkId: 1, groups, files: 420, bytes: 46_200_000_000, places: ['T7', 'Seagate2TB', 'Google'], hash: 'h' };
    const c = confirmLines(p);
    expect(c.headline).toBe('Free 46.2 GB: 420 files');
    expect(c.lines[0]).toBe('The copies are on T7, Seagate2TB and Google. They are not touched.');
    expect(c.lines.join(' ')).toMatch(/read again just before it is removed/);
    expect(removeButton(p)).toBe('Remove 420 files from the phone');
    expect(removeButton({ files: 1 })).toBe('Remove 1 file from the phone');
  });

  it('says how much space is kept locked and why, and nothing about an empty part', () => {
    const base: FreeUpResultView['locked'] = { keepFiles: 0, keepBytes: 0, googleKinds: [], otherFiles: 0, otherBytes: 0 };
    expect(lockedLines(base)).toEqual([]);
    expect(lockedLines({ keepFiles: 3, keepBytes: 3_000_000_000, googleKinds: [{ label: 'Camera videos', files: 5, bytes: 9_000_000_000 }], otherFiles: 40, otherBytes: 1_200_000_000 })).toEqual([
      'Kept on the phone because you said so: 3 files, 3.0 GB.',
      'Not sent to Google, so never removed: camera videos, 5 files, 9.0 GB.',
      'Never offered (documents, downloads, music, app folders): 40 files, 1.2 GB.',
    ]);
  });

  it('names the files that are not ready, the age of a check, and what is waiting to be put back', () => {
    expect(notReadyHeader({ notReady: { files: 7, bytes: 2_000_000_000, reasons: [] } } as unknown as FreeUpResultView)).toBe('Not ready: 7 files, 2.0 GB');
    expect(ageText(1000, 1000 + 30_000)).toBe('just now');
    expect(ageText(0, 5 * 60_000)).toBe('5 minutes ago');
    expect(isOldCheck(0, 29 * 60_000)).toBe(false);
    expect(isOldCheck(0, 31 * 60_000)).toBe(true);
    expect(removedLine({ files: 2, bytes: 5_000_000_000 })).toBe('Removed and not put back: 2 files, 5.0 GB.');
  });

  it('says what each check mode does, the steps with their counts, and the chosen removal mode', () => {
    expect(CHECK_MODES.map((m) => m.mode)).toEqual(['quick', 'full']);
    expect(CHECK_MODES[0]!.line).toMatch(/seconds/);
    expect(CHECK_MODES[1]!.line).toMatch(/1 hour for 46 GB/);
    const at = new Date(2026, 5, 12, 12, 5).getTime();
    expect(stepsHeader({ mode: 'quick', at })).toBe('Quick check, 12:05');
    expect(stepsHeader({ mode: 'full', at })).toBe('Full check, 12:05');
    expect(stepLine({ what: 'Phone: checksum read on the phone now', passed: 1200, failed: 3 })).toBe('Phone: checksum read on the phone now: 1,200 passed, 3 did not');
    expect(ranSteps({ steps: [{ what: 'a', passed: 0, failed: 0 }] })).toEqual([]);
    expect(ranSteps({ steps: [{ what: 'a', passed: 1, failed: 0 }] })).toHaveLength(1);
    expect(removeModeSummary('quick')).toMatch(/Does not read the files again/);
    expect(removeModeSummary('full')).toMatch(/Reads each file again/);
  });

  it('writes a file row: the date taken, the shortened folder, and the note after Keep (with the rule to undo)', () => {
    expect(shortDate(new Date(2026, 5, 12, 10).getTime() / 1000)).toBe('12 Jun 2026');
    expect(shortDate(0)).toBe('-');
    expect(shortFolder('/sdcard/DCIM/Camera')).toBe('DCIM/Camera');
    expect(shortFolder('/storage/emulated/0/Pictures/a/b/c/d')).toBe('…/b/c/d');
    expect(shortFolder('/sdcard')).toBe('Phone storage');
    const rules = [{ id: 3, scope: 'file' as const, path: '/sdcard/DCIM/Camera/IMG_1.jpg' }, { id: 5, scope: 'folder' as const, path: '/sdcard/Pictures/Family' }];
    expect(keptNote('file', '/sdcard/DCIM/Camera/IMG_1.jpg', rules)).toEqual({ text: 'Kept on the phone: IMG_1.jpg', ruleId: 3 });
    expect(keptNote('folder', '/sdcard/Pictures/Family/', rules)).toEqual({ text: 'Kept on the phone: everything in Family', ruleId: 5 });
    expect(keptNote('file', '/sdcard/other.jpg', rules).ruleId).toBeNull();
  });
});

describe('the put-back list', () => {
  const rows = [{ id: 10 }, { id: 9 }, { id: 8 }];
  it('says which part of the list is on screen', () => {
    expect(rangeText(0, 100, 422)).toBe('1-100 of 422');
    expect(rangeText(400, 22, 422)).toBe('401-422 of 422');
    expect(rangeText(0, 0, 0)).toBe('0 of 0');
    expect(tickAllLink(422)).toBe('Tick all 422');
  });

  it('shows the date taken, or the day it was removed when the taken date is not known', () => {
    const taken = new Date(2026, 5, 12, 10).getTime() / 1000;
    expect(putBackDate({ takenSec: taken, removedAt: 0 })).toEqual({ text: '12 Jun 2026', title: 'Date taken' });
    const removed = new Date(2026, 10, 26, 10, 3).getTime();
    expect(putBackDate({ takenSec: 0, removedAt: removed }).text).toBe('26 Nov 2026');
    expect(putBackDate({ takenSec: 0, removedAt: removed }).title).toMatch(/not known/);
    expect(shortDateTime(removed)).toBe('26 Nov 2026, 10:03');
    expect(shortDateTime(0)).toBe('-');
  });

  it('the header tick ticks or unticks the page only; ticks on other pages stay; one tick changes one file', () => {
    let t: ReadonlySet<number> = new Set([1, 2]);
    expect(pageTick(rows, t)).toBe('none');
    t = tickPage(t, rows, true);
    expect([...t].toSorted((a, b) => a - b)).toEqual([1, 2, 8, 9, 10]);
    expect(pageTick(rows, t)).toBe('all');
    t = tickOne(t, 9, false);
    expect(pageTick(rows, t)).toBe('some');
    t = tickPage(t, rows, false);
    expect([...t].toSorted((a, b) => a - b)).toEqual([1, 2]);
    expect(pageTick([], new Set())).toBe('none');
  });

  it('adds up the size of what is ticked from the sizes seen (pages and Tick all) and words the button and the confirm step', () => {
    const sizes = new Map([[1, 1_000_000_000], [2, 500_000_000], [3, 7]]);
    expect(tickedBytes(new Set([1, 2]), sizes)).toBe(1_500_000_000);
    expect(tickedBytes(new Set(), sizes)).toBe(0);
    expect(putBackButton(0, 0)).toBe('Put back 0 ticked');
    expect(putBackButton(422, 46_200_000_000)).toBe('Put back 422 ticked (46.2 GB)');
    expect(putBackConfirmLine(1, 3_000_000)).toBe('Put 1 file (3 MB) back on the phone? They are copied from the first drive and checked on the phone.');
  });
});
