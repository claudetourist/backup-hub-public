import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DecisionList } from '../../shared/decisions';
import { mockCases, mockWhy } from '../dev/mockDecisions';
import { WhyView } from '../why/WhyDrawer';
import { WhyLink } from '../why/WhyLink';
import { copyFileRequest, phoneFileRequest } from '../why/whyModel';
import { PhoneFileList } from '../backups/PhoneFileList';
import { CopyLists } from '../backups/PhoneCopyLists';
import { listRows } from '../backups/phoneBackupModel';
import { DecisionCards } from './DecisionCards';
import { NeedsYouList } from './NeedsYouList';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const noop = (): void => undefined;
const NOW = Date.now();
/** The plain-words test's own list (plainWords.test.ts), and the insider words the brief names on top of it. */
const BANNED_RENDERER = /\b(listings?|look again|looked|fingerprint\w*|ledger|catalog\w*|jobs screen|sources|destinations?)\b/i;
const INSIDER = /\b(rows?|index|rules?|destinations?|serial|verified_how)\b/i;
const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

describe('Home: three cases of "Needs your decision" in the one "Needs you" list', () => {
  const cases = mockCases();
  const list: DecisionList = { cases, total: cases.length };
  const lines = [{ key: 'job:3', text: 'Copy Reunion to the T7: The drive is full', target: 'activity' as const }];

  it('has one count badge for the cases and the other lines together, the cases first with their buttons, then the lines', () => {
    const html = render(h(NeedsYouList, { decisions: list, lines, now: NOW, onAnswered: noop, onOpen: noop }));
    expect(html).toContain('aria-label="4 things need you"');
    expect(html.indexOf('Is this still T7?')).toBeLessThan(html.indexOf('Copy Reunion to the T7'));
    expect(html.indexOf('many files look gone or changed')).toBeLessThan(html.indexOf('IMG_20260110_142233.jpg: the copy on T7'));
    for (const label of ['Yes, it is the same drive', 'No, keep it blocked', 'Try again', 'Accept it', 'Copy it again at the next backup', 'Show the file']) expect(html).toContain(label);
    expect(html).toContain('Do the same for the other 11 copies');
    expect(html).toContain('Found: ');
    expect(html).not.toContain('Nothing needs you');
  });

  it('gives every line a small link to where it is fixed', () => {
    const many = [
      { key: 'job:3', text: 'Copy Reunion to the T7: The drive is full', target: 'activity' as const },
      { key: 'space:t7', text: 'T7 is 90% full', target: 'devices' as const },
    ];
    const html = render(h(NeedsYouList, { decisions: null, lines: many, now: NOW, onAnswered: noop, onOpen: noop }));
    expect(html).toContain('Open Activity');
    expect(html).toContain('Open Devices');
  });

  it('says "Nothing needs you" and shows no badge when there is nothing', () => {
    const html = render(h(NeedsYouList, { decisions: { cases: [], total: 0 }, lines: [], now: NOW, onAnswered: noop, onOpen: noop }));
    expect(html).toContain('Nothing needs you');
    expect(html).not.toContain('count-badge');
    expect(render(h(NeedsYouList, { decisions: null, lines: [], now: NOW, onAnswered: noop, onOpen: noop }))).toContain('Nothing needs you');
  });

  it('keeps cases beyond the fifth behind "Show N more"', () => {
    const many: DecisionList = { cases: Array.from({ length: 7 }, (_, i) => ({ ...cases[0]!, key: 'drive:' + (i + 1), headline: 'Is this still T' + (i + 1) + '?' })), total: 7 };
    const html = render(h(NeedsYouList, { decisions: many, lines: [], now: NOW, onAnswered: noop, onOpen: noop }));
    expect(html).toContain('Is this still T5?');
    expect(html).not.toContain('Is this still T6?');
    expect(html).toContain('Show 2 more');
  });

  it('a case with no answer here shows what to do instead of buttons', () => {
    const stuck = { ...cases[0]!, choices: [], note: 'Unplug one of the two drives. This closes by itself.' };
    const html = render(h(DecisionCards, { cases: [stuck], now: NOW, onAnswered: noop }));
    expect(html).toContain('Unplug one of the two drives. This closes by itself.');
    expect(html).not.toContain('<button');
  });

  it('uses plain words only', () => {
    const html = text(render(h(NeedsYouList, { decisions: list, lines, now: NOW, onAnswered: noop, onOpen: noop })));
    expect(html).not.toMatch(BANNED_RENDERER);
    expect(html).not.toMatch(INSIDER);
    expect(html).not.toMatch(/\b(look again|looked|listed|listing)\b/i);
  });
});

describe('"Why?" on a file', () => {
  const rows = listRows([
    { path: '/sdcard/DCIM/Camera/IMG_1.jpg', size: 3_000_000, mtimeSec: 1_700_000_000, kind: 'new' },
    { path: '/sdcard/notes.txt', size: 2_000, mtimeSec: 1_700_000_100, kind: 'changed' },
  ]);
  const props = { rows, unticked: new Set<string>(), onUntickedChange: noop, confirmLabel: 'Copy 2 files to T7', canConfirm: true, onConfirm: noop };

  it('is a link on every row of the list before the copy, named after the file, when the backup is known', () => {
    const html = render(h(PhoneFileList, { ...props, backupId: 1 }));
    expect(html.match(/class="why__link"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Why? IMG_1.jpg"');
    expect(html).toContain('aria-label="Why? notes.txt"');
    expect(render(h(PhoneFileList, props))).not.toContain('why__link');
  });

  it('is a link on the files of the copy lists', () => {
    const file = (path: string) => ({ path, size: 10 });
    const progress = { jobId: 1, finished: false, current: null, next: [file('/sdcard/a/next.jpg')], waiting: 1, recent: [file('/sdcard/a/done.jpg')], done: 1, failed: [{ ...file('/sdcard/a/bad.jpg'), reason: 'The phone stopped answering' }], failedCount: 1, startedAt: 1, now: 2 };
    const html = render(h(CopyLists, { progress: progress as never, backupId: 1 }));
    expect(html.match(/class="why__link"/g)).toHaveLength(3);
    expect(render(h(CopyLists, { progress: progress as never }))).not.toContain('why__link');
  });

  it('a link alone is only the button (the drawer opens on a click), for a copy found by the search too', () => {
    const html = render(h(WhyLink, { request: copyFileRequest(42), name: 'a.jpg' }));
    expect(html).toContain('>Why?</button>');
    expect(html).not.toContain('role="dialog"');
    expect(phoneFileRequest(3, '/sdcard/x.jpg')).toEqual({ backupId: 3, phonePath: '/sdcard/x.jpg' });
    expect(copyFileRequest(42)).toEqual({ fileId: 42 });
  });

  it('the drawer for a phone file with one checked copy and one that is not checked yet', () => {
    const html = render(h(WhyView, { result: mockWhy() }));
    const words = text(html);
    expect(words).toContain('On T7, in MyData/POCO/POCO-05Oct26/DCIM/Camera: read back and compared with the phone');
    expect(words).toContain('On Seagate2TB, in Backups/POCO/POCO-05Oct26/DCIM/Camera: brought in from the old tool, not checked yet');
    expect(words).toContain('Not yet. Free up phone space needs a checked copy on T7, Seagate2TB, Google. Missing: Seagate2TB, Google.');
    for (const title of ['Where it is and how it was checked', 'Is it left out?', 'Free up phone space', 'What happened to it']) expect(html).toContain('<h3 class="why__title">' + title + '</h3>');
    // The colour is never the only sign: a line says it in words for a screen reader too.
    expect(html).toContain('Good: ');
    expect(html).toContain('Careful: ');
    expect(html).toContain('Problem: ');
    expect(words).not.toMatch(BANNED_RENDERER);
    expect(words).not.toMatch(INSIDER);
  });

  it('says plainly when the explanation is loading, cannot be read, or the file is not known', () => {
    expect(render(h(WhyView, { result: null }))).toContain('Reading what Backup Hub knows about this file.');
    expect(render(h(WhyView, { result: null, failed: true }))).toContain('The explanation could not be read. Nothing was changed.');
    expect(render(h(WhyView, { result: { ok: false, message: 'Backup Hub has not seen this file yet.' } }))).toContain('has not seen this file yet');
  });
});
