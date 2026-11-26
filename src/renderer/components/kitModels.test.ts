import { describe, expect, it } from 'vitest';
import { BACKUP_STATUSES, isDashed, STATUS_ICONS, STATUS_TONES, STATUS_WORDS, statusLine, statusText } from './backupStatus';
import { contrast, closestPair } from '../colorTestUtil';
import { DEVICE_COLORS, deviceColorFor } from './deviceColors';
import { FILE_KINDS } from '../../shared/fileKinds';
import { chipDef, chipOfKind, KIND_CHIP_IDS, KIND_CHIPS } from './kindChips';
import { amountText, elapsedProps, filesPerSecondText, percentDone, secondsLeft, speedLine, speedText, timeLeftText } from './progressModel';
import { previewTotals, skippedHeadline, skippedReasonsText, sortLargestFirst, tickedOfText, tickedText, toggleUnticked, type PreviewItem } from './previewModel';
import { reasonTotal, reportHeadline, reportOutcome, type ReportData } from './reportModel';
import { DEFAULT_TTL, makeToast, MAX_TOASTS, toastReducer, type ToastItem } from './toastModel';
import { viewStateOf } from './viewState';

describe('the time left of a copy of many small files', () => {
  // The real run: 25,597 files, about 4.9 GB; the phone costs about 0.4 s a file, so the whole copy takes about 2.5 to 3 hours.
  const totalFiles = 25_597;
  const totalBytes = 4_900_000_000;
  it('counts a file as about 10 MB of work: files + bytes / 10 MB, time left = elapsed / work done x work left', () => {
    const input = { doneFiles: 2_600, totalFiles, doneBytes: 480_000_000, totalBytes, elapsedSeconds: 900, bytesPerSecond: 460_000 };
    // work done 2,648, work total 26,087: 900 s / 2,648 x 23,439 = 7,966.5 s, rounded up.
    expect(secondsLeft(input)).toBe(7_967);
    expect(timeLeftText(secondsLeft(input))).toBe('about 2 h 13 min left');
    // The bytes-only answer for the same copy (the bug the window showed: about 17 h 50 min at a low byte speed).
    expect(secondsLeft({ doneBytes: 480_000_000, totalBytes, bytesPerSecond: 68_800 })).toBeGreaterThan(17 * 3600);
  });
  it('says nothing before 20 files and 15 seconds', () => {
    const base = { totalFiles, doneBytes: 1_000_000, totalBytes };
    expect(secondsLeft({ ...base, doneFiles: 19, elapsedSeconds: 60 })).toBeNull();
    expect(secondsLeft({ ...base, doneFiles: 400, elapsedSeconds: 14 })).toBeNull();
    expect(secondsLeft({ ...base, doneFiles: 20, elapsedSeconds: 15 })).not.toBeNull();
    expect(timeLeftText(secondsLeft({ ...base, doneFiles: 5, elapsedSeconds: 2 }))).toBe('Working out the time left');
  });
  it('with files only it counts files; a job that gives no elapsed time keeps the bytes-at-the-current-speed answer', () => {
    expect(secondsLeft({ doneFiles: 100, totalFiles: 1_100, elapsedSeconds: 50 })).toBe(500);
    expect(secondsLeft({ doneBytes: 5_000_000_000, totalBytes: 10_000_000_000, doneFiles: 5200, totalFiles: 9021, bytesPerSecond: 50_000_000 })).toBe(100);
  });
  it('the speed line shows both: "3 files a second, 12 MB/s"', () => {
    expect(filesPerSecondText(2.9)).toBe('3 files a second');
    expect(filesPerSecondText(1)).toBe('1 file a second');
    expect(filesPerSecondText(0.46)).toBe('0.5 files a second');
    expect(speedLine({ bytesPerSecond: 12_000_000, filesPerSecond: 2.9 })).toBe('3 files a second, 12 MB/s');
    expect(speedLine({ bytesPerSecond: 12_000_000 })).toBe('12 MB/s');
    expect(speedLine({ bytesPerSecond: null, filesPerSecond: 3 })).toBe('Speed not known yet');
    expect(speedLine({ bytesPerSecond: null, filesPerSecond: 3, filesOnly: true })).toBe('3 files a second');
  });
  it('the elapsed time comes from the job start, and nothing when it has not started', () => {
    expect(elapsedProps(1_000, 61_000)).toEqual({ elapsedSeconds: 60 });
    expect(elapsedProps(null, 61_000)).toEqual({});
  });
  it('paused time does not count: an hour paused does not make the time left an hour longer', () => {
    // 10 minutes of work, then an hour paused: 100 of 200 files done.
    const hourPaused = 3_600_000;
    const start = 1_000;
    const now = start + 600_000 + hourPaused;
    expect(elapsedProps(start, now, hourPaused)).toEqual({ elapsedSeconds: 600 });
    expect(elapsedProps(start, now)).toEqual({ elapsedSeconds: 4200 });
    const files = { doneFiles: 100, totalFiles: 200 };
    expect(secondsLeft({ ...files, ...elapsedProps(start, now, hourPaused) })).toBe(600);
    // The old way (from the job start) would have said 4,200 seconds.
    expect(secondsLeft({ ...files, ...elapsedProps(start, now) })).toBe(4200);
    expect(elapsedProps(start, now, undefined)).toEqual({ elapsedSeconds: 4200 });
    expect(elapsedProps(start, start + 1000, 999_999_999)).toEqual({ elapsedSeconds: 0 });
  });
});

describe('the five statuses', () => {
  it('are exactly these five words', () => {
    expect(BACKUP_STATUSES.map((s) => STATUS_WORDS[s])).toEqual(['Up to date', 'Behind', 'Never backed up', 'Not connected', 'Problem']);
  });
  it('map to green, amber, grey, grey (dashed) and red, each with its own icon', () => {
    expect(BACKUP_STATUSES.map((s) => STATUS_TONES[s])).toEqual(['ok', 'amber', 'neutral', 'offline', 'crit']);
    expect(new Set(BACKUP_STATUSES.map((s) => STATUS_ICONS[s])).size).toBe(5);
    expect(BACKUP_STATUSES.filter(isDashed)).toEqual(['not-connected']);
  });
  it('say how far behind, in files and size', () => {
    expect(statusLine({ status: 'behind', files: 312, bytes: 4_200_000_000 })).toEqual({ word: 'Behind', detail: 'by 312 files (4.2 GB)', age: null });
    expect(statusLine({ status: 'behind', files: 1, bytes: 5_000_000 }).detail).toBe('by 1 file (5 MB)');
    expect(statusLine({ status: 'behind' }).detail).toBeNull();
  });
  it('say what a missing drive last looked like, and when', () => {
    expect(statusText({ status: 'not-connected', lastKnown: 'up-to-date', lastSeen: '3 Nov', updated: '19 days ago' })).toBe('Not connected last seen up to date on 3 Nov, updated 19 days ago');
  });
  it('say how many files are missing or damaged', () => {
    expect(statusLine({ status: 'problem', problems: 3 }).detail).toBe('3 files missing or damaged');
  });
  it('show how old the information is', () => {
    expect(statusLine({ status: 'up-to-date', updated: '2 hours ago' }).age).toBe('updated 2 hours ago');
  });
});

describe('the nine kinds', () => {
  it('are photos, camera videos, screenshots, WhatsApp, recordings, music, documents, archives and other', () => {
    expect(KIND_CHIPS.map((k) => k.label)).toEqual(['Photos', 'Camera videos', 'Screenshots', 'WhatsApp', 'Recordings', 'Music', 'Documents', 'Archives', 'Other']);
    expect(KIND_CHIP_IDS).toHaveLength(9);
  });
  it('every stored file kind has a chip, and an unknown one is Other', () => {
    for (const kind of FILE_KINDS) expect(KIND_CHIP_IDS).toContain(chipOfKind(kind));
    expect(chipOfKind('something-new')).toBe('other');
    expect(chipOfKind('photo-screenshot')).toBe('screenshots');
    expect(chipOfKind('photo-whatsapp')).toBe('whatsapp');
    expect(chipOfKind('video-whatsapp')).toBe('whatsapp');
    expect(chipDef(chipOfKind('audio-recording')).label).toBe('Recordings');
  });
});

describe('device colours', () => {
  it('give the same device the same colour every time', () => {
    expect(deviceColorFor('Seagate2TB')).toBe(deviceColorFor('  seagate2tb '));
    expect(DEVICE_COLORS).toContain(deviceColorFor('T7'));
  });
  it('can be seen against the card colour of both themes (3:1)', () => {
    for (const colour of DEVICE_COLORS) {
      expect(contrast(colour, '#ffffff'), colour).toBeGreaterThanOrEqual(3);
      expect(contrast(colour, '#17201c'), colour).toBeGreaterThanOrEqual(3);
    }
  });
  it('differ from each other, also for colour-blind people', () => {
    const named = Object.fromEntries(DEVICE_COLORS.map((c) => [c, c]));
    for (const vision of ['normal', 'protan', 'deutan'] as const) {
      const found = closestPair(named, vision);
      expect(found.distance, `${vision}: ${found.pair.join(' / ')}`).toBeGreaterThanOrEqual(6);
    }
  });
});

describe('the four states', () => {
  it('loading with nothing yet is the skeleton', () => {
    expect(viewStateOf({ loading: true, error: null, count: null })).toEqual({ state: 'loading', reloading: false });
  });
  it('no results is empty; results are loaded', () => {
    expect(viewStateOf({ loading: false, error: null, count: 0 })).toEqual({ state: 'empty', reloading: false });
    expect(viewStateOf({ loading: false, error: null, count: 12 })).toEqual({ state: 'loaded', reloading: false });
  });
  it('an error shows Retry, unless a retry is already running', () => {
    expect(viewStateOf({ loading: false, error: 'It failed', count: null }).state).toBe('error');
    expect(viewStateOf({ loading: false, error: 'It failed', count: 5 }).state).toBe('error');
    expect(viewStateOf({ loading: true, error: 'It failed', count: null }).state).toBe('loading');
  });
  it('old results stay, dimmed, while new ones load', () => {
    expect(viewStateOf({ loading: true, error: null, count: 12 })).toEqual({ state: 'loaded', reloading: true });
    expect(viewStateOf({ loading: true, error: null, count: 0 })).toEqual({ state: 'empty', reloading: true });
  });
});

describe('preview list maths', () => {
  const items: PreviewItem[] = [
    { id: 'a', name: 'b.jpg', bytes: 10 },
    { id: 'b', name: 'a.jpg', bytes: 10 },
    { id: 'c', name: 'big.mp4', bytes: 5000 },
    { id: 'd', name: 'tiny.txt', bytes: 1 },
  ];
  it('sorts largest first, equal sizes by name, and leaves the input alone', () => {
    expect(sortLargestFirst(items).map((i) => i.id)).toEqual(['c', 'b', 'a', 'd']);
    expect(items.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });
  it('totals only what is ticked', () => {
    expect(previewTotals(items, new Set())).toEqual({ files: 4, bytes: 5021, tickedFiles: 4, tickedBytes: 5021 });
    expect(previewTotals(items, new Set(['c']))).toEqual({ files: 4, bytes: 5021, tickedFiles: 3, tickedBytes: 21 });
    expect(tickedText(previewTotals(items, new Set(['c'])))).toBe('3 of 4 files ticked, 21 B');
  });
  it('the line above a short tick list reads N of M ticked', () => {
    expect(tickedOfText(1, 2)).toBe('1 of 2 ticked');
    expect(tickedOfText(0, 0)).toBe('0 of 0 ticked');
    expect(tickedOfText(1234, 5678)).toBe('1,234 of 5,678 ticked');
  });
  it('unticks and re-ticks without changing the old set', () => {
    const none = new Set<string>();
    const one = toggleUnticked(none, 'a');
    expect([...one]).toEqual(['a']);
    expect([...toggleUnticked(one, 'a')]).toEqual([]);
    expect(none.size).toBe(0);
  });
  it('says how many files were skipped and why', () => {
    const skipped = { count: 112, reasons: [{ reason: 'name Windows cannot store', count: 12 }, { reason: 'already on the Seagate', count: 100 }] };
    expect(skippedHeadline(skipped)).toBe('Skipped: 112 files');
    expect(skippedReasonsText(skipped)).toBe('100 already on the Seagate, 12 name Windows cannot store');
    expect(skippedHeadline({ count: 1, reasons: [] })).toBe('Skipped: 1 file');
    expect(skippedHeadline({ count: 0, reasons: [] })).toBeNull();
    expect(skippedHeadline(undefined)).toBeNull();
  });
});

describe('progress maths', () => {
  const half = { doneBytes: 5_000_000_000, totalBytes: 10_000_000_000, doneFiles: 50, totalFiles: 200, bytesPerSecond: 50_000_000 };
  it('works out percent, time left and speed', () => {
    expect(percentDone(half)).toBe(50);
    expect(secondsLeft(half)).toBe(100);
    expect(speedText(50_000_000)).toBe('50 MB/s');
    expect(amountText(half)).toBe('5 GB of 10 GB');
  });
  it('falls back to files when there are no byte totals, and to "not known" with no totals at all', () => {
    expect(percentDone({ doneFiles: 50, totalFiles: 200 })).toBe(25);
    expect(amountText({ doneFiles: 50, totalFiles: 200 })).toBe('50 of 200 files');
    expect(percentDone({})).toBeNull();
    expect(secondsLeft({ doneBytes: 1, totalBytes: 10 })).toBeNull();
    expect(speedText(null)).toBe('Speed not known yet');
  });
  it('says the time left in plain words', () => {
    expect(timeLeftText(null)).toBe('Working out the time left');
    expect(timeLeftText(2)).toBe('Almost done');
    expect(timeLeftText(45)).toBe('about 45 seconds left');
    expect(timeLeftText(600)).toBe('about 10 minutes left');
    expect(timeLeftText(5400)).toBe('about 1 h 30 min left');
    expect(timeLeftText(7200)).toBe('about 2 h left');
  });
});

describe('report maths', () => {
  const base: ReportData = { copied: { files: 312, bytes: 4_200_000_000 }, skipped: [{ reason: 'already there', count: 8 }], failed: [], where: ['Seagate'] };
  it('says what was copied when nothing failed', () => {
    expect(reportOutcome(base)).toBe('ok');
    expect(reportHeadline(base)).toBe('Copied 312 files (4.2 GB)');
  });
  it('counts failures, and calls it bad when nothing was copied', () => {
    const some = { ...base, failed: [{ reason: 'the drive stopped', count: 2 }, { reason: 'file in use', count: 1 }] };
    expect(reasonTotal(some.failed)).toBe(3);
    expect(reportOutcome(some)).toBe('warn');
    expect(reportHeadline(some)).toBe('Copied 312 files (4.2 GB), 3 failed');
    const none = { ...some, copied: { files: 0, bytes: 0 } };
    expect(reportOutcome(none)).toBe('bad');
    expect(reportHeadline(none)).toBe('Nothing was copied, 3 failed');
  });
});

describe('toasts', () => {
  it('go away by themselves, except errors', () => {
    expect(makeToast(1, { text: 'Hi' }).ttl).toBe(DEFAULT_TTL);
    expect(makeToast(2, { tone: 'error', text: 'Oops' }).ttl).toBeNull();
    expect(makeToast(3, { tone: 'ok', text: 'Done', ttl: 1000 }).ttl).toBe(1000);
  });
  it('keep the newest few and drop a repeat of the same words', () => {
    let list: ToastItem[] = [];
    for (let i = 1; i <= 5; i += 1) list = toastReducer(list, { type: 'add', toast: makeToast(i, { text: `Message ${i}` }) });
    expect(list.map((t) => t.id)).toEqual([3, 4, 5]);
    expect(list).toHaveLength(MAX_TOASTS);
    list = toastReducer(list, { type: 'add', toast: makeToast(6, { text: 'Message 5' }) });
    expect(list.map((t) => t.id)).toEqual([3, 4, 6]);
  });
  it('can be closed one by one', () => {
    const list = [makeToast(1, { text: 'a' }), makeToast(2, { text: 'b' })];
    expect(toastReducer(list, { type: 'dismiss', id: 1 }).map((t) => t.id)).toEqual([2]);
  });
});
