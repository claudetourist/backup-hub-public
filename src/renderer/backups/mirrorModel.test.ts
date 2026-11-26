import { describe, expect, it } from 'vitest';
import type { MirrorBackupStatus, MirrorPlanView, MirrorReport } from '../../shared/mirror';
import type { MirrorCheckPlanView, MirrorCheckReport } from '../../shared/mirrorCheck';
import { alsoKeepButton, alsoKeepQuestion, behindText, bringAllButton, bringUpButton, bringUpState, checkedWord, combinedStatus, checkAllButton, checkButton, checkConfirmText, checkHeadline, checkPlanLines, checkReportLines, confirmText, countOf, durationText, estimateLine, countText, filterRows, listRows, plugInNote, planLines, reportData, savedToText, selectionTotals, setTicks, statusLine, secondHint } from './mirrorModel';

const status = (over: Partial<MirrorBackupStatus['mirrors'][number]> = {}, source = true): MirrorBackupStatus => ({
  backupId: 1,
  sourceLabel: 'T7',
  sourceConnected: source,
  mirrors: [{ placeId: 's', label: 'Seagate2TB', position: 2, connected: true, behindFiles: 1234, behindBytes: 12_000_000_000, needYou: 0, ...over }],
});

describe('the words of the second drive', () => {
  it('names the buttons after the drive', () => {
    expect(alsoKeepButton('Seagate2TB')).toBe('Also keep a copy on Seagate2TB');
    expect(bringUpButton('Seagate2TB')).toBe('Bring Seagate2TB up to date');
    expect(bringAllButton('Seagate2TB')).toBe('Bring Seagate2TB up to date (all backups)');
    expect(alsoKeepQuestion('Poco F4', 'Seagate2TB', 'MyData/POCO')).toContain('Nothing is copied until you bring Seagate2TB up to date.');
  });

  it('shows "T7 + Seagate2TB" and says which drive is not plugged in', () => {
    const base = { driveLabel: 'T7', folder: 'MyData/POCO', driveConnected: true };
    expect(savedToText({ ...base })).toBe('T7, folder MyData/POCO');
    const two = [{ placeId: 'a', label: 'T7', position: 1, connected: true }, { placeId: 'b', label: 'Seagate2TB', position: 2, connected: false }];
    expect(savedToText({ ...base, destinations: two })).toBe('T7 + Seagate2TB, folder MyData/POCO (Seagate2TB not plugged in)');
    expect(savedToText({ driveLabel: null, folder: null, driveConnected: false })).toBe('No backup folder yet');
  });

  it('the status line says each drive: "T7: up to date · Seagate2TB: behind by 1,234 files (12 GB)"', () => {
    expect(statusLine('T7', 'up-to-date', status())).toBe('T7: up to date · Seagate2TB: behind by 1,234 files (12 GB)');
    expect(statusLine('T7', 'up-to-date', status({ behindFiles: 0, behindBytes: 0 }))).toBe('T7: up to date · Seagate2TB: up to date');
    expect(statusLine('T7', 'up-to-date', status({ behindFiles: null }))).toContain('counting...');
    expect(statusLine('T7', 'up-to-date', status({ needYou: 2, connected: false }))).toContain('2 files need you');
    expect(statusLine('T7', 'up-to-date', status({ needYou: 1 }))).toContain('1 file needs you');
    expect(statusLine('T7', 'up-to-date', status({ connected: false }))).toContain('(not plugged in)');
    expect(statusLine('T7', 'up-to-date', undefined)).toBeNull();
    expect(behindText(1, 2_000_000)).toBe('behind by 1 file (2 MB)');
  });

  it('a backup is Up to date only if each drive is', () => {
    expect(combinedStatus('up-to-date', status())).toBe('behind');
    expect(combinedStatus('up-to-date', status({ behindFiles: 0, behindBytes: 0 }))).toBe('up-to-date');
    expect(combinedStatus('up-to-date', status({ behindFiles: null }))).toBe('up-to-date');
    expect(combinedStatus('behind', status({ behindFiles: 0, behindBytes: 0 }))).toBe('behind');
    expect(combinedStatus('problem', status())).toBe('problem');
    expect(combinedStatus('up-to-date', undefined)).toBe('up-to-date');
  });

  it('says plainly to plug in the T7 when only the Seagate is here', () => {
    expect(plugInNote(status({}, false))).toBe('Plug in the T7 to bring the Seagate2TB up to date');
    expect(plugInNote(status({}, true))).toBeNull();
    expect(plugInNote(status({ connected: false }, false))).toBeNull();
    expect(bringUpState(status({}, false))).toEqual({ enabled: false, why: 'The second copy is made from T7 to Seagate2TB, so both must be plugged in. Plug in T7.' });
    expect(bringUpState(status({ connected: false }))).toEqual({ enabled: false, why: 'The second copy is made from T7 to Seagate2TB, so both must be plugged in. Plug in Seagate2TB.' });
    expect(secondHint(status({}, false))).toEqual({ ready: false, text: 'Seagate2TB is behind. The second copy is made from T7 to Seagate2TB, so both must be plugged in. Plug in T7.' });
    expect(secondHint(undefined)).toBeNull();
    expect(bringUpState(status())).toEqual({ enabled: true, why: null });
  });
});

describe('the list before the copy', () => {
  const plan: Pick<MirrorPlanView, 'rows' | 'backups'> = {
    backups: [{ backupId: 1, backupName: 'Poco F4', sourceLabel: 'T7', targetLabel: 'Seagate2TB', folderWords: 'MyData\\POCO', files: 3, bytes: 0 }],
    rows: [
      { id: '0:S1/small.jpg', backupIndex: 0, path: 'S1/small.jpg', size: 3_000, mtimeMs: Date.UTC(2026, 10, 1, 12), ownChecksum: false },
      { id: '0:S1/DCIM/VID_big.mp4', backupIndex: 0, path: 'S1/DCIM/VID_big.mp4', size: 900_000_000, mtimeMs: Date.UTC(2026, 10, 2, 12), ownChecksum: true },
      { id: '0:top.txt', backupIndex: 0, path: 'top.txt', size: 3_000, mtimeMs: Date.UTC(2026, 10, 3, 12), ownChecksum: false },
    ],
  };
  const rows = listRows(plan);

  it('is largest first, then by name, with the folder, the date and what it is checked against', () => {
    expect(rows.map((r) => r.name)).toEqual(['VID_big.mp4', 'small.jpg', 'top.txt']);
    expect(rows[0]).toMatchObject({ folder: 'S1/DCIM', checked: 'Own checksum' });
    expect(rows[2]!.folder).toBe('Top folder');
    expect(checkedWord(false)).toBe('Phone checksum');
  });

  it('searches by name or folder, and ticks only what the search shows', () => {
    expect(filterRows(rows, 'dcim big').map((r) => r.name)).toEqual(['VID_big.mp4']);
    expect(filterRows(rows, '  ')).toHaveLength(3);
    expect(filterRows(rows, 'nothing')).toEqual([]);
    const shown = filterRows(rows, 's1');
    const none = setTicks(new Set(), shown, false);
    expect([...none].toSorted()).toEqual(['0:S1/DCIM/VID_big.mp4', '0:S1/small.jpg']);
    expect(setTicks(none, shown.slice(0, 1), true).size).toBe(1);
  });

  it('counts ticks and says what the one button will do', () => {
    const unticked = new Set(['0:S1/small.jpg']);
    const c = countOf(rows, rows, unticked);
    expect(countText(c)).toBe('2 of 3 files ticked');
    expect(countText(countOf(rows, filterRows(rows, 'small'), unticked))).toBe('Showing 1 of 3 files (0 ticked). 2 of 3 files ticked.');
    const sel = selectionTotals(rows, unticked);
    expect(sel).toEqual({ files: 2, bytes: 900_003_000 });
    expect(confirmText(sel, 'Seagate2TB')).toBe('Copy 2 files (900 MB) to Seagate2TB');
    expect(confirmText({ files: 1, bytes: 3_000 }, 'Seagate2TB')).toBe('Copy 1 file (3 KB) to Seagate2TB');
  });

  it('says what the list leaves out: the checks and the different ones', () => {
    const lines = planLines({ toCheck: { files: 4310, bytes: 38_400_000_000 }, different: { files: 2, examples: ['S1/a/Form_06.pdf'] } }, 'Seagate2TB');
    expect(lines[0]).toBe('Already on Seagate2TB (same size, not checked yet): 4,310 files, 38.4 GB. This copy does not read them.');
    expect(lines[1]).toContain('2 files are on Seagate2TB with another size');
    expect(lines[1]).toContain('Form_06.pdf');
    expect(planLines({ toCheck: { files: 0, bytes: 0 }, different: { files: 0, examples: [] } }, 'X')).toEqual([]);
  });
});

describe('the report', () => {
  it('counts linked, damaged and different files as skipped with their reasons, never as failed', () => {
    const r: MirrorReport = { jobId: 1, startedAt: 1, finishedAt: 2, backups: [], copied: { files: 100, bytes: 4_000_000_000 }, linked: 4308, damaged: 1, different: 2, ownChecksums: 2, skipped: [], failed: [], where: ['Seagate2TB: MyData\\POCO'], listPaths: [], listProblem: null, usbPauses: 0 };
    const data = reportData(r, () => 'today');
    expect(data.copied).toEqual({ files: 100, bytes: 4_000_000_000 });
    expect(data.skipped.map((s) => s.count)).toEqual([4308, 1, 2]);
    expect(data.failed).toEqual([]);
    expect(data.finished).toBe('today');
  });
});

const checkPlan = (over: Partial<MirrorCheckPlanView> = {}): MirrorCheckPlanView => ({
  planId: 'p', hash: 'h',
  backups: [{ backupId: 1, backupName: 'Poco F4', sourceLabel: 'T7', targetLabel: 'Seagate2TB', files: 40_940, bytes: 173_000_000_000 }],
  totals: { files: 40_940, bytes: 173_000_000_000 },
  groups: [{ group: 'photos', files: 18_000, bytes: 122_000_000_000 }, { group: 'documents', files: 2_300, bytes: 6_000_000_000 }, { group: 'other', files: 20_640, bytes: 45_000_000_000 }],
  oneRead: { files: 31_000, bytes: 100_000_000_000 }, twoReads: { files: 9_940, bytes: 73_000_000_000 },
  alreadyChecked: 0, estimateSeconds: 10_800, notes: [],
  ...over,
});

describe('"Check old copies": the words', () => {
  it('names the buttons after the drive', () => {
    expect(checkButton('Seagate2TB')).toBe('Check old copies on Seagate2TB');
    expect(checkAllButton('Seagate2TB')).toBe('Check old copies on Seagate2TB (all backups)');
  });

  it('gives an honest time, the clock time it should end, and says a long job leaves the laptop free', () => {
    expect(durationText(30)).toBe('less than a minute');
    expect(durationText(600)).toBe('about 10 min');
    expect(durationText(5000)).toBe('about 83 min');
    expect(durationText(10_800)).toBe('about 3 h');
    const noon = new Date(2026, 10, 25, 12, 0).getTime();
    expect(estimateLine(10_800, noon)).toBe('Rough time: about 3 h; you can keep using the laptop. Should finish around 3:00 pm. This is a guess from the file list; the real time shows after a few minutes.');
    expect(estimateLine(1200, noon)).toContain('Should finish around 12:20 pm');
    expect(estimateLine(1200, noon)).not.toContain('laptop');
    expect(estimateLine(10_800, noon)).not.toContain('overnight');
    expect(estimateLine(10_800, new Date(2026, 10, 25, 22, 30).getTime())).toContain('Should finish around 1:30 am tomorrow');
    expect(estimateLine(30, noon)).not.toContain('finish');
  });

  it('the preview says what is checked, in which order, how many reads, and what happens to each file', () => {
    const p = checkPlan();
    expect(checkHeadline(p, 'Seagate2TB')).toBe('Poco F4: 40,940 files (173 GB) on Seagate2TB have the same size as on T7 but were never proven to be the same.');
    const lines = checkPlanLines(p, 'Seagate2TB');
    expect(lines[0]).toBe('Order: photos and videos: 18,000 files (122 GB), then documents: 2,300 files (6 GB), then other files: 20,640 files (45 GB). A stop part-way keeps the valuable ones proven.');
    expect(lines[1]).toBe('31,000 files need one read (their checksum is known, so only Seagate2TB is read); 9,940 need two (the T7 file is read too).');
    expect(lines[2]).toContain('never replaced');
    expect(lines[2]).toContain('Needs your decision');
    expect(checkConfirmText(p, 'Seagate2TB')).toBe('Check 40,940 files on Seagate2TB');
  });

  it('says plainly when there is nothing to check', () => {
    const p = checkPlan({ totals: { files: 0, bytes: 0 }, groups: [], alreadyChecked: 12 });
    expect(checkHeadline(p, 'Seagate2TB')).toContain('Nothing to check');
    expect(checkPlanLines(p, 'Seagate2TB')).toEqual(['12 files were proven earlier.']);
  });

  it('the report counts the same and the different, one read and two, and says when it was stopped', () => {
    const r: MirrorCheckReport = { jobId: 1, startedAt: 1, finishedAt: 2, complete: false, backups: [], verified: 12_338, differs: 2, oneRead: 9_000, twoReads: 3_340, groups: [{ group: 'photos', done: 12_340, total: 18_000 }], skipped: [], failed: [], usbPauses: 0 };
    const lines = checkReportLines(r, 'Seagate2TB');
    expect(lines[0]).toBe('Stopped after checking 12,340 files: 12,338 are the same and now verified copies on Seagate2TB; 2 are different (not replaced, see Needs your decision).');
    expect(lines[1]).toBe('9,000 files needed one read, 3,340 needed two.');
    expect(lines[2]).toBe('Checked: photos and videos 12,340 of 18,000.');
    expect(lines[3]).toContain('stays proven');
    expect(checkReportLines({ ...r, complete: true }, 'S')[0]).toMatch(/^Checked 12,340 files/);
  });
});
