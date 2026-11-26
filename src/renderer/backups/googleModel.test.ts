import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { accountPick, googleBytes, type GoogleAccountPick, type GoogleCopyPlan, type GoogleCopyPreview, type GoogleCopyReport, type GoogleKindRow } from '../../shared/googleCopy';
import { AccountPicker } from './AccountPicker';
import { GooglePanel } from './GooglePanel';
import { GoogleSummaryBar } from './GoogleSummary';
import {
  accountChecked,
  accountSpace,
  FIT_LABEL,
  fitIsOn,
  fitLine,
  ONLY_ON_PHONE_LABEL,
  repeatLine,
  roomOf,
  shortBytes,
  accountTake,
  cannotStart,
  CHECK_BUTTON,
  becameFits,
  capacitySummary,
  accountGetLines,
  GOOGLE_STEP_1,
  GOOGLE_STEP_2,
  GOOGLE_STEP_3,
  moreSummary,
  pickedAccounts,
  progressLine,
  reportSummaryLine,
  runningAccountLines,
  stepOneNote,
  stepTwoNote,
  confirmLines,
  filterAccountRows,
  googleSummary,
  googleReportData,
  initialAccountTicks,
  kindProgress,
  kindSize,
  moreAccountTicks,
  planLineText,
  seenRoom,
  showFindBox,
  sortAccountRows,
  startButton,
  suggestionNote,
  tickedAccountIds,
  tickedKinds,
} from './googleModel';
import { tabsFor } from './backupListModel';
import { ADD_ACCOUNT_BUTTON, keyReady, removeQuestion, WHOSE_QUESTION } from '../places/googleAccountModel';

const row = (kind: GoogleKindRow['kind'], files: number, bytes: number, on = 0, onBytes = 0): GoogleKindRow => ({ kind, label: kind, files, bytes, onGoogleFiles: on, onGoogleBytes: onBytes, toGoFiles: files - on, toGoBytes: bytes - onBytes, repeatFiles: 0, ticked: true, leftOut: false });

const preview = (over: Partial<GoogleCopyPreview> = {}): GoogleCopyPreview => ({
  backupId: 5,
  backupName: 'POCO',
  isPhone: true,
  onlyOnPhone: false,
  driveLabel: 'T7',
  driveConnected: true,
  kinds: [row('video-camera', 100, (50 * GB)), row('photo-camera', 1000, (5 * GB), 200, (1 * GB)), row('documents', 10, (1 * MB))],
  room: { accounts: 3, roomBytes: (80 * GB) },
  noChecksumFiles: 0,
  blocker: null,
  accounts: [],
  ...over,
});

const MB = 1024 ** 2; // sizes on Google screens are binary, like Google Drive shows them
const GB = 1024 ** 3;
const acct = (id: string, email: string, limitGb: number, usageGb: number, over: Partial<Parameters<typeof accountPick>[0]> = {}): GoogleAccountPick =>
  accountPick({ placeId: id, label: id.toUpperCase(), email, limit: limitGb * GB, usage: usageGb * GB, needsSignIn: false, remembered: false, checkedNow: true, checkFailed: null, ...over });

const plan = (over: Partial<GoogleCopyPlan> = {}): GoogleCopyPlan => ({ lines: [], toPlaceFiles: 1, toPlaceBytes: 1, unplacedFiles: 0, unplacedBytes: 0, ...over });

const all = new Set(['video-camera', 'photo-camera', 'documents']);

describe('the capacity screen words', () => {
  const accounts = [acct('g1', 'a@x.com', 100, 10), acct('g2', 'b@x.com', 100, 20), acct('g3', 'c@x.com', 100, 10)]; // room 65, 55, 65 GB
  const withAccounts = (a: GoogleAccountPick[] = accounts): GoogleCopyPreview => preview({ accounts: a, room: { accounts: a.length, roomBytes: 0 } });
  const picked = (...ids: string[]): Set<string> => new Set(ids);

  it('the summary bar says what is to send, placed and still to place, and whether everything fits', () => {
    const line = (files: number, bytes: number, id = 'g1', email = 'a@x.com') => ({ placeId: id, label: id.toUpperCase(), email, files, bytes, endsPercent: 50 });
    expect(capacitySummary(withAccounts(), all, picked('g1'), plan({ lines: [line(910, 54.001 * GB)] })).text).toBe('To send: 54.0 GB (910 files) · Placed: 54.0 GB in 1 account · Still to place: 0 MB ✓ Everything fits');
    const fits = capacitySummary(withAccounts(), all, picked('g1'), plan({ lines: [line(910, 54.001 * GB)] }));
    expect(fits).toMatchObject({ state: 'fits', stillBytes: 0 });
    const short = capacitySummary(withAccounts([acct('g1', 'a@x.com', 100, 70)]), new Set(['video-camera']), picked('g1'), plan({ lines: [line(10, 5 * GB)], unplacedFiles: 90, unplacedBytes: 45 * GB }));
    expect(short.text).toBe('To send: 50.0 GB (100 files) · Placed: 5.0 GB in 1 account · Still to place: 45.0 GB ✗ Tick more accounts or fewer kinds');
    expect(short.state).toBe('short');
    expect(capacitySummary(withAccounts(), all, picked(), null).text).toBe('To send: 54.0 GB (910 files) · Placed: 0 MB in 0 accounts · Still to place: 54.0 GB ✗ Tick an account');
    expect(capacitySummary(withAccounts(), new Set(), picked('g1'), null)).toMatchObject({ state: 'empty', text: 'To send: 0 MB (0 files) · Nothing is ticked to send.' });
  });

  it('after each tick the bar at once shows what is still left, before the exact plan is there', () => {
    const p = withAccounts([acct('g1', 'a@x.com', 100, 70), acct('g2', 'b@x.com', 100, 50)]); // room 5 and 25 GB
    const one = capacitySummary(p, new Set(['video-camera']), picked('g1'), 'loading');
    expect(one).toMatchObject({ state: 'loading', stillBytes: 45 * GB });
    expect(one.text).toBe('To send: 50.0 GB (100 files) · Placed: 5.0 GB in 1 account · Still to place: at least 45.0 GB Working out where each file goes...');
    expect(capacitySummary(p, new Set(['video-camera']), picked('g1', 'g2'), 'loading').still).toBe('Still to place: at least 20.0 GB');
    expect(capacitySummary(withAccounts(), all, picked('g1'), 'loading').still).toBe('Still to place: 0 MB');
  });

  it('the real per-file plan wins over the totals: files are never split', () => {
    const short = plan({ lines: [{ placeId: 'g1', label: 'G1', email: 'a@x.com', files: 1, bytes: 1, endsPercent: 1 }], unplacedFiles: 2, unplacedBytes: 12.4 * GB });
    expect(capacitySummary(withAccounts(), all, picked('g1', 'g2', 'g3'), short).still).toBe('Still to place: 12.4 GB');
    expect(cannotStart(withAccounts(), all, picked('g1', 'g2', 'g3'), short)).toBe('Short by 12.4 GB: tick more accounts or fewer kinds');
  });

  it('the picker that comes back when accounts are full shows the same bar for what is left', () => {
    const p = withAccounts([acct('g1', 'a@x.com', 100, 74), acct('g2', 'b@x.com', 100, 50)]); // 1 GB and 25 GB
    expect(moreSummary(30 * GB, pickedAccounts(p, picked('g1')), 'loading').text).toBe('To send: 30.0 GB · Placed: 1.0 GB in 1 account · Still to place: at least 29.0 GB Working out where each file goes...');
    expect(moreSummary(30 * GB, pickedAccounts(p, picked('g1', 'g2')), plan({ toPlaceFiles: 40, lines: [{ placeId: 'g2', label: 'G2', email: 'b@x.com', files: 40, bytes: 25 * GB, endsPercent: 75 }], unplacedFiles: 5, unplacedBytes: 4 * GB })).text).toBe('To send: 30.0 GB (40 files) · Placed: 26.0 GB in 1 account · Still to place: 4.0 GB ✗ Tick more accounts or fewer kinds');
  });

  it('the celebration plays only when it goes from not fitting to fitting, never on a first look or while loading', () => {
    expect(becameFits('short', 'fits')).toBe(true);
    expect(becameFits('none', 'fits')).toBe(true);
    expect(becameFits('empty', 'fits')).toBe(true);
    expect(becameFits('fits', 'fits')).toBe(false);
    expect(becameFits(null, 'fits')).toBe(false);
    expect(becameFits('loading', 'fits')).toBe(false);
    expect(becameFits('short', 'short')).toBe(false);
    expect(becameFits('fits', 'short')).toBe(false);
  });

  it('the step headings and their notes use the same words', () => {
    const p = withAccounts();
    expect(GOOGLE_STEP_1).toBe('Step 1 of 3 · What to send');
    expect(GOOGLE_STEP_2).toBe('Step 2 of 3 · Where to put it');
    expect(GOOGLE_STEP_3).toBe('Step 3 of 3 · Check and copy');
    expect(stepOneNote(p, new Set(['video-camera']))).toBe('50.0 GB ticked');
    expect(stepTwoNote(54 * GB, pickedAccounts(p, picked('g1', 'g2')))).toBe('54.0 GB to fit · 120.0 GB room in 2 ticked accounts');
    expect(stepTwoNote(54 * GB, pickedAccounts(p, picked('g2')))).toBe('54.0 GB to fit · 55.0 GB room in 1 ticked account');
    expect(stepTwoNote(54 * GB, [])).toBe('54.0 GB to fit · no account ticked');
  });

  it('a ticked account says what it will get; while the plan loads it says what it takes of what is left; an unticked one says nothing', () => {
    const p = withAccounts([acct('g1', 'a@x.com', 100, 70), acct('g2', 'b@x.com', 100, 50), acct('g3', 'c@x.com', 100, 0)]); // 5, 25, 75 GB
    const real = plan({ lines: [{ placeId: 'g2', label: 'G2', email: 'b@x.com', files: 608, bytes: (288 * MB), endsPercent: 51 }] });
    expect(accountGetLines(p.accounts, picked('g1', 'g2'), (288 * MB), real)).toEqual({ g1: 'will get nothing', g2: 'will get 288 MB (608 files)' });
    expect(accountGetLines(p.accounts, picked('g1', 'g2'), 30 * GB, 'loading')).toEqual({ g2: 'takes about 25.0 GB of what is left', g1: 'takes about 5.0 GB of what is left' });
    expect(accountGetLines(p.accounts, picked('g3'), 8.4 * GB, null)).toEqual({ g3: 'takes about 8.4 GB of what is left' });
    expect(accountGetLines(p.accounts, picked(), 1, 'loading')).toEqual({});
  });

  it('while the copy runs it says what was sent and what is still to send; after it the report says sent, not sent and why', () => {
    expect(progressLine((120 * MB), (288 * MB))).toBe('Worked through 120 MB of 288 MB · 168 MB to go');
    expect(progressLine((300 * MB), (288 * MB))).toBe('Worked through 300 MB of 288 MB · 0 MB to go');
    const confirmed = [{ placeId: 'g1', label: 'G1', email: 'a@x.com', files: 1, bytes: (144 * MB), endsPercent: null }, { placeId: 'g2', label: 'G2', email: null, files: 1, bytes: (144 * MB), endsPercent: null }];
    // Before the first live numbers: the confirmed plan. Then: each account live, "60 MB of 144 MB".
    expect(runningAccountLines(confirmed)).toEqual(['a@x.com: 144 MB to send', 'G2: 144 MB to send']);
    expect(runningAccountLines(confirmed, [])).toEqual(['a@x.com: 144 MB to send', 'G2: 144 MB to send']);
    const sent = [
      { placeId: 'g2', label: 'G2', files: 0, bytes: (12 * MB), toSend: (144 * MB) },
      { placeId: 'g1', label: 'G1', files: 1, bytes: (60 * MB), toSend: (144 * MB) },
      { placeId: 'g3', label: 'G3', files: 0, bytes: 0, toSend: 0 },
    ];
    expect(runningAccountLines(confirmed, sent)).toEqual(['a@x.com: 60 MB of 144 MB', 'G2: 12 MB of 144 MB']);
    // After a restart the confirmed plan is not known: the account's label is used. A number that went past the plan is never shown as more than "of" itself.
    expect(runningAccountLines(null, [{ placeId: 'g1', label: 'Mum', files: 2, bytes: (150 * MB), toSend: (144 * MB) }])).toEqual(['Mum: 150 MB of 150 MB']);
    expect(runningAccountLines(null, [])).toEqual([]);
    const r: GoogleCopyReport = { copied: { files: 600, bytes: (280 * MB) }, alreadyThere: 4, repeats: 0, heldBack: [{ reason: 'x', count: 1, examples: [] }], failed: [{ reason: 'y', count: 2, examples: [] }], noRoom: { files: 5, bytes: (8 * MB) }, mismatches: 0, perAccount: [], stopped: false };
    expect(reportSummaryLine(r)).toBe('Sent 280 MB (600 files) · Not sent: 8 files (why is listed below) · Already in Google from an earlier copy: 4, checked, not sent again');
    // Repeats are named apart from "already in Google": the same picture in an older phone backup is sent once.
    expect(reportSummaryLine({ ...r, repeats: 227 })).toBe('Sent 280 MB (600 files) · Not sent: 8 files (why is listed below) · Repeats (same picture in another phone backup): 227, sent once · Already in Google from an earlier copy: 4, checked, not sent again');
    expect(reportSummaryLine({ ...r, alreadyThere: 0, repeats: 0, heldBack: [], failed: [], noRoom: { files: 0, bytes: 0 } })).toBe('Sent 280 MB (600 files) · Not sent: nothing');
  });

  it('the one button is off for a plain reason until every file fits, and says how many accounts', () => {
    const p = withAccounts();
    expect(startButton(3)).toBe('Use these 3 accounts and copy');
    expect(startButton(1)).toBe('Use these 1 account and copy');
    expect(cannotStart(p, new Set(['video-camera']), picked('g1'), plan())).toBeNull();
    expect(cannotStart(p, new Set(['video-camera']), picked('g1'), 'loading')).toBe('Working out where each file goes...');
    expect(cannotStart(p, new Set(), picked('g1'), null)).toBe('Tick at least one kind of file.');
    expect(cannotStart(p, new Set(['video-camera']), picked(), null)).toBe('Tick at least one Google account.');
    // Ticked but greyed (cannot take): not counted.
    const grey = withAccounts([acct('g1', 'a@x.com', 100, 90)]);
    expect(cannotStart(grey, new Set(['video-camera']), picked('g1'), null)).toBe('Tick at least one Google account.');
    expect(cannotStart(withAccounts([acct('g1', 'a@x.com', 100, 70)]), new Set(['video-camera']), picked('g1'), plan())).toBe('Short by 45.0 GB: tick more accounts or fewer kinds');
    expect(cannotStart(preview({ driveConnected: false, accounts }), new Set(['video-camera']), picked('g1'), plan())).toBe('Plug in T7 first: the files are read from it.');
    expect(cannotStart(preview({ blocker: 'The Google app key is not saved yet.', accounts }), new Set(['video-camera']), picked('g1'), plan())).toBe('The Google app key is not saved yet.');
    const done = preview({ kinds: [row('video-camera', 5, (1 * GB), 5, (1 * GB))], accounts });
    expect(cannotStart(done, new Set(['video-camera']), picked('g1'), plan())).toBe('Everything that is ticked is already on Google.');
    expect(CHECK_BUTTON).toBe('Next: check and copy');
  });

  it('the rows: most "can still take" first, greyed ones last with their reason, a find box only above 8 accounts', () => {
    const rows = [
      acct('g1', 'full@x.com', 100, 80),
      acct('g2', 'small@x.com', 100, 50),
      acct('g3', 'signin@x.com', 100, 0, { needsSignIn: true }),
      acct('g4', 'big@x.com', 100, 0),
      acct('g5', 'unknown@x.com', 0, 0, { limit: null, usage: null, checkedNow: false }),
      acct('g6', 'down@x.com', 100, 0, { checkedNow: false, checkFailed: 'no internet connection' }),
    ];
    expect(sortAccountRows(rows).map((r) => r.email)).toEqual(['big@x.com', 'small@x.com', 'down@x.com', 'full@x.com', 'signin@x.com', 'unknown@x.com']);
    const by = Object.fromEntries(rows.map((r) => [r.placeId, r]));
    expect(by['g1']).toMatchObject({ canTake: false, reason: 'full: keeps 25% free', room: 0 });
    expect(by['g3']).toMatchObject({ canTake: false, reason: 'needs signing in' });
    expect(by['g5']).toMatchObject({ canTake: false, reason: 'space not known yet: press Refresh on Devices' });
    expect(by['g6']).toMatchObject({ canTake: false, reason: 'could not check: no internet connection', limit: null, checkedNow: false });
    expect(by['g4']).toMatchObject({ canTake: true, reason: null, room: (75 * GB), percent: 0, free: (100 * GB), checkedNow: true });
    expect(accountTake(by['g4']!)).toBe('can take 75.0 GB (keeping 25% free)');
    expect(accountTake(by['g1']!)).toBe('full: keeps 25% free');
    expect(accountSpace(by['g2']!)).toBe('50.0 GB free of 100.0 GB');
    expect(accountChecked(by['g4']!)).toBe('checked just now');
    expect(accountChecked(by['g6']!)).toBe('');
    expect(showFindBox(rows)).toBe(false);
    expect(showFindBox([...rows, acct('g7', 'a7@x.com', 10, 0), acct('g8', 'a8@x.com', 10, 0), acct('g9', 'a9@x.com', 10, 0)])).toBe(true);
    expect(showFindBox(rows.slice(0, 5))).toBe(false);
    expect(filterAccountRows(rows, 'SMALL').map((r) => r.placeId)).toEqual(['g2']);
    expect(filterAccountRows(rows, '  ')).toHaveLength(6);
    expect(filterAccountRows(rows, 'nomatch')).toEqual([]);
  });

  it('a ticked account that cannot take files is never remembered as ticked', () => {
    expect(acct('g1', 'a@x.com', 100, 90, { remembered: true }).ticked).toBe(false);
    expect(acct('g1', 'a@x.com', 100, 10, { remembered: true }).ticked).toBe(true);
    expect(acct('g1', 'a@x.com', 100, 10, { remembered: true, checkFailed: 'Google did not answer' }).ticked).toBe(false);
  });

  it('the suggestion is the person\'s own last choice, else the fewest accounts that fit, most room first', () => {
    const fresh = withAccounts();
    expect(initialAccountTicks(fresh, new Set(['video-camera']))).toEqual(new Set(['g1'])); // 50 GB: one account with 65 GB (ties: by name)
    expect(initialAccountTicks(fresh, all)).toEqual(new Set(['g1'])); // 54 GB
    expect(initialAccountTicks(withAccounts([acct('g1', 'a@x.com', 100, 50), acct('g2', 'b@x.com', 100, 40), acct('g3', 'c@x.com', 100, 60)]), new Set(['video-camera']))).toEqual(new Set(['g2', 'g1'])); // 35 + 25 = 60 >= 50
    expect(initialAccountTicks(withAccounts([acct('g1', 'a@x.com', 100, 70), acct('g2', 'b@x.com', 100, 74)]), new Set(['video-camera']))).toEqual(new Set(['g1', 'g2'])); // cannot fit: all that can take
    expect(initialAccountTicks(withAccounts([acct('g1', 'a@x.com', 100, 90)]), new Set(['video-camera']))).toEqual(new Set());
    expect(initialAccountTicks(fresh, new Set())).toEqual(new Set());
    const last = withAccounts([acct('g1', 'a@x.com', 100, 10), acct('g2', 'b@x.com', 100, 20, { remembered: true }), acct('g3', 'c@x.com', 100, 10)]);
    expect(initialAccountTicks(last, new Set(['video-camera']))).toEqual(new Set(['g2']));
    expect(suggestionNote(fresh)).toBe('Suggested by Backup Hub: check and change the ticks if needed');
    expect(suggestionNote(last)).toBe('Suggested by Backup Hub (your choice last time): check and change the ticks if needed');
    expect(suggestionNote(withAccounts([acct('g1', 'a@x.com', 100, 90)]))).toBeNull();
  });

  it('the confirm step lists the ticked accounts by email with what each gets', () => {
    const p = withAccounts();
    const lines = confirmLines(p, picked('g1', 'g2'), plan({ lines: [{ placeId: 'g1', label: 'G1', email: 'a@x.com', files: 1200, bytes: 31.2 * GB, endsPercent: 41 }] }));
    expect(lines).toEqual(['a@x.com: will get 31.2 GB (1,200 files), ends 41% full', 'b@x.com: will get nothing']);
    expect(planLineText({ placeId: 'g9', label: 'G9', email: null, files: 1, bytes: 2 * GB, endsPercent: null })).toBe('G9: will get 2.0 GB (1 file)');
    expect(seenRoom(p, picked('g1', 'g2'))).toEqual({ g1: (65 * GB), g2: (55 * GB) });
    expect(tickedAccountIds(p, picked('g3', 'g1', 'nope'))).toEqual(['g1', 'g3']);
  });

  it('a waiting copy keeps the accounts in use ticked and suggests the fewest more that cover what is left', () => {
    const p = withAccounts([acct('g1', 'a@x.com', 100, 74), acct('g2', 'b@x.com', 100, 50), acct('g3', 'c@x.com', 100, 70), acct('g4', 'd@x.com', 100, 0)]); // room 1, 25, 5, 75
    expect(moreAccountTicks(p, ['g1'], 30 * GB)).toEqual(new Set(['g1', 'g4']));
    expect(moreAccountTicks(p, ['g1', 'g4'], 30 * GB)).toEqual(new Set(['g1', 'g4']));
    expect(moreAccountTicks(p, ['g1'], 1000 * GB)).toEqual(new Set(['g1', 'g4', 'g2', 'g3']));
  });

  it('a row says its size and how much is already on Google', () => {
    expect(kindSize(row('video-camera', 1, (2 * GB)))).toBe('1 file, 2.0 GB');
    expect(kindProgress(row('photo-camera', 1000, (5 * GB), 200, (1 * GB)))).toBe('200 already on Google, 800 to go');
    expect(kindProgress(row('video-camera', 100, (50 * GB)))).toBe('100 to go');
    expect(tickedKinds(preview().kinds, new Set(['documents', 'video-camera']))).toEqual(['video-camera', 'documents']);
  });

  it('the report puts held back, already there and no-room under Skipped, failures under Failed and the accounts under Where it went', () => {
    const r: GoogleCopyReport = {
      copied: { files: 3, bytes: (3 * GB) },
      alreadyThere: 4, repeats: 0,
      heldBack: [{ reason: 'The copy on T7 does not match its saved checksum.', count: 1, examples: ['a.jpg'] }],
      failed: [{ reason: 'The upload kept failing.', count: 2, examples: ['b.mp4'] }],
      noRoom: { files: 5, bytes: (2 * GB) },
      mismatches: 0,
      perAccount: [{ label: 'Mum 1', files: 3, bytes: (3 * GB) }],
      stopped: false,
    };
    const d = googleReportData(r, '3 Nov, 14:05');
    expect(d.copied).toEqual({ files: 3, bytes: (3 * GB) });
    expect(d.skipped.map((s) => s.count)).toEqual([1, 4, 5]);
    expect(d.skipped[0]!.reason).toMatch(/^not sent: The copy on T7/);
    expect(d.skipped[2]!.reason).toMatch(/no account had room \(2\.0 GB; every account keeps 25% free\)/);
    expect(d.failed).toHaveLength(1);
    expect(d.where).toEqual(['Mum 1: 3 files, 3.0 GB']);
  });
});

describe('the Which accounts? step as shown', () => {
  const rows = [acct('g1', 'big@x.com', 100, 0), acct('g2', 'full@x.com', 100, 80), acct('g3', 'out@x.com', 100, 0, { needsSignIn: true }), acct('g4', 'down@x.com', 100, 0, { checkedNow: false, checkFailed: 'no internet connection' })];
  const html = (accounts: GoogleAccountPick[], ticks: string[], locked: string[] = []): string => renderToStaticMarkup(h(AccountPicker, { accounts, ticks: new Set(ticks), locked: new Set(locked), note: 'Suggested by Backup Hub: check and change the ticks if needed', title: 'Step 2 of 3 · Where to put it', titleNote: '288 MB to fit · 31.2 GB room in 2 ticked accounts', gets: { g1: 'will get 288 MB (608 files)', g2: 'will get 1 MB (1 file)' }, onToggle: () => undefined }));

  it('shows a row per account with space, what it can still take, and the suggestion line; greyed rows cannot be ticked and say why', () => {
    const out = html(rows, ['g1']);
    expect(out).toContain('Step 2 of 3 · Where to put it');
    expect(out).toContain('288 MB to fit · 31.2 GB room in 2 ticked accounts');
    expect(out).toContain('will get 288 MB (608 files)');
    expect(out).not.toContain('will get 1 MB');
    expect(out).toContain('Suggested by Backup Hub: check and change the ticks if needed');
    expect(out).toContain('can take 75.0 GB (keeping 25% free)');
    expect(out).toContain('100.0 GB free of 100.0 GB');
    expect(out).toContain('checked just now');
    expect(out).toContain('full: keeps 25% free');
    expect(out).toContain('needs signing in');
    expect(out).toContain('could not check: no internet connection');
    expect(out.match(/type="checkbox"/g)).toHaveLength(4);
    expect(out.match(/disabled=""/g)).toHaveLength(3); // full, signed out, could not check
    expect(out.match(/checked=""/g)).toHaveLength(1);
    expect(out).not.toContain('Find an account');
    expect(out.indexOf('big@x.com')).toBeLessThan(out.indexOf('full@x.com'));
  });

  it('a ticked account that cannot take files is not shown as ticked; accounts in use are ticked and locked', () => {
    expect(html(rows, ['g2']).match(/checked=""/g)).toBeNull();
    const out = html(rows, ['g1'], ['g1']);
    expect(out).toContain('used by this copy');
    expect(out.match(/disabled=""/g)).toHaveLength(4);
  });

  it('has a Find an account box only when there are more than 8 accounts', () => {
    const many = Array.from({ length: 9 }, (_, i) => acct('x' + i, `n${i}@x.com`, 100, 0));
    expect(html(many.slice(0, 8), [])).not.toContain('Find an account');
    expect(html(many, [])).toContain('Find an account');
  });
});

describe('the summary bar as shown', () => {
  const sumOf = (...a: Parameters<typeof googleSummary>) => renderToStaticMarkup(h(GoogleSummaryBar, { summary: googleSummary(...a) }));
  const g1 = acct('g1', 'a@x.com', 100, 10);
  const line = { placeId: 'g1', label: 'G1', email: 'a@x.com', files: 608, bytes: (288 * MB), endsPercent: 10 };

  it('shows the three parts and the check mark when everything fits, red attention when short, and no pop on a first look', () => {
    const fits = sumOf((288 * MB), 608, [g1], plan({ lines: [line] }));
    expect(fits).toContain('To send: 288 MB (608 files)');
    expect(fits).toContain('Placed: 288 MB in 1 account');
    expect(fits).toContain('Still to place: 0 MB');
    expect(fits).toContain('Everything fits');
    expect(fits).toContain('✓');
    expect(fits).toContain('is-fits');
    expect(fits).not.toContain('is-pop');
    expect(fits).not.toContain('google-summary__burst');
    const short = sumOf((288 * MB), 608, [g1], plan({ lines: [], unplacedFiles: 1, unplacedBytes: (12.4 * GB) }));
    expect(short).toContain('is-short');
    expect(short).toContain('Still to place: 12.4 GB');
    expect(short).toContain('Tick more accounts or fewer kinds');
    expect(short).not.toContain('✓');
    expect(sumOf((288 * MB), 608, [g1], 'loading')).toContain('Working out where each file goes...');
  });
});

describe('where the Google section is', () => {
  it('a phone backup has a Google section after "Check old copies"; a folder backup does not', () => {
    const ids = (kind: 'phone' | 'folder'): string[] => tabsFor({ kind }).map((t) => t.id);
    expect(ids('phone')).toEqual(['overview', 'backup', 'check', 'google', 'free', 'choices', 'covered', 'history', 'restore']);
    expect(ids('folder')).not.toContain('google');
  });

  it('opens with a counting placeholder, the plain promise and one main button, and no words of another kind of backup', () => {
    const html = renderToStaticMarkup(h(GooglePanel, { backupId: 5, onFinished: () => undefined }));
    expect(html).toContain('Counting what is on Google...');
    expect(html).toContain('Nothing in Google is ever deleted');
    expect(html.match(/btn--primary/g)).toHaveLength(1);
    expect(html).toContain('>Copy to Google<');
    expect(html).not.toMatch(/\b(rule|pattern|scope|destination|profile)\b/i);
  });
});

describe('add an account, whose, remove, the app key', () => {
  it('has plain words', () => {
    expect(ADD_ACCOUNT_BUTTON).toBe('Add a Google account');
    expect(WHOSE_QUESTION).toBe('Whose account is this?');
    expect(removeQuestion('Mum 1')).toBe('Take Mum 1 off the list? Nothing in the Google account is deleted.');
    expect(keyReady({ clientId: ' ', clientSecret: 'x' })).toBe(false);
    expect(keyReady({ clientId: 'a', clientSecret: 'b' })).toBe(true);
  });
});

describe('sizes on the Google screens are shown like Google Drive shows them', () => {
  it('1 MB is 1,048,576 bytes and 1 GB is 1024^3 bytes (183,505,725 bytes is 175 MB, as the Drive storage line says)', () => {
    expect(googleBytes(183_505_725)).toBe('175 MB');
    expect(googleBytes(1024 ** 3)).toBe('1.0 GB');
    expect(googleBytes(15 * 1024 ** 3)).toBe('15.0 GB');
    expect(googleBytes(1_000_000_000)).toBe('954 MB');
    expect(kindSize(row('video-camera', 1, 183_505_725))).toBe('1 file, 175 MB');
  });
});

describe('repeats from older phone backups', () => {
  const rep = (kind: GoogleKindRow['kind'], files: number, bytes: number, repeats: number): GoogleKindRow => ({ ...row(kind, files, bytes), repeatFiles: repeats });

  it('says how many different files there are and that repeats are sent once, with the sizes of the different ones', () => {
    const rows = [rep('photo-screenshot', 381, 183_505_725, 227)];
    expect(repeatLine(rows)).toBe('608 files, but 381 different ones (227 are repeats from older phone backups): 381 files, 175 MB will be sent');
    expect(repeatLine([rep('photo-screenshot', 2, 4096, 1)])).toBe('3 files, but 2 different ones (1 is a repeat from older phone backups): 2 files, 0 MB will be sent');
  });

  it('is silent without repeats, and counts only the ticked kinds', () => {
    expect(repeatLine([row('video-camera', 10, 1000)])).toBeNull();
    const rows = [rep('video-camera', 10, 1000, 4), { ...rep('photo-camera', 5, 500, 9), ticked: false }];
    expect(repeatLine(rows)).toMatch(/^14 files, but 10 different ones \(4 are repeats/);
  });

  it('the report names the repeats apart from what was already in Google from an earlier copy', () => {
    const r: GoogleCopyReport = { copied: { files: 381, bytes: 183_505_725 }, alreadyThere: 3, repeats: 227, heldBack: [], failed: [], noRoom: { files: 0, bytes: 0 }, mismatches: 0, perAccount: [], stopped: false };
    expect(reportSummaryLine(r)).toBe('Sent 175 MB (381 files) · Not sent: nothing · Repeats (same picture in another phone backup): 227, sent once · Already in Google from an earlier copy: 3, checked, not sent again');
    const d = googleReportData(r, 'today');
    expect(d.skipped.map((s) => [s.reason, s.count])).toEqual([
      ['repeats (same picture in another phone backup): sent once', 227],
      ['already in Google from an earlier copy (checked, not sent again)', 3],
    ]);
    // An older saved report has no repeats at all.
    expect(reportSummaryLine({ ...r, repeats: undefined as never })).not.toMatch(/Repeats/);
  });
});

describe('only what is still on the phone, and fit what I have room for', () => {
  const p = (over: Partial<GoogleCopyPreview> = {}) => preview({ kinds: [row('video-camera', 100, 46 * GB)], accounts: [acct('g1', 'a@x.com', 15, 0), acct('g2', 'b@x.com', 15, 0), acct('g3', 'c@x.com', 15, 0)], ...over });
  const three = new Set(['g1', 'g2', 'g3']);
  const fitPlan = (over: Partial<GoogleCopyPlan> = {}): GoogleCopyPlan => plan({ fit: true, toPlaceFiles: 212, toPlaceBytes: 31.8 * GB, waitingFiles: 40, waitingBytes: 14.2 * GB, lines: [{ placeId: 'g1', label: 'G1', email: 'a@x.com', files: 212, bytes: 31.8 * GB, endsPercent: 70 }], ...over });

  it('the two ticks have plain words', () => {
    expect(ONLY_ON_PHONE_LABEL).toBe('Only what is still on the phone');
    expect(FIT_LABEL).toBe('Fit what I have room for, biggest first');
  });

  it('fit is on by default only when what is ticked is bigger than the room in the ticked accounts; the person\'s choice wins; never on another kind of backup', () => {
    const pv = p();
    expect(roomOf(pickedAccounts(pv, three))).toBe(3 * 11.25 * GB);
    expect(fitIsOn(pv, new Set(['video-camera']), three, null)).toBe(true); // 46 GB into 33.75 GB
    expect(fitIsOn(pv, new Set(['video-camera']), three, false)).toBe(false);
    const small = p({ kinds: [row('video-camera', 10, 5 * GB)] });
    expect(fitIsOn(small, new Set(['video-camera']), three, null)).toBe(false);
    expect(fitIsOn(small, new Set(['video-camera']), three, true)).toBe(true);
    expect(fitIsOn(p({ isPhone: false }), new Set(['video-camera']), three, true)).toBe(false);
  });

  it('says plainly how much will be sent, how many of the biggest files, and what waits', () => {
    expect(fitLine(fitPlan())).toBe('Will send 31.8 GB of 46.0 GB: the 212 biggest files. 14.2 GB waits for another account.');
    expect(fitLine(fitPlan({ toPlaceFiles: 1, waitingFiles: 3 }))).toMatch(/: the biggest file\. /);
    expect(fitLine(fitPlan({ waitingFiles: 0, waitingBytes: 0, toPlaceFiles: 300, toPlaceBytes: 20 * GB }))).toBe('Everything fits: all 20.0 GB (300 files) will be sent.');
    expect(fitLine(plan())).toBeNull(); // not a fit plan
    expect(fitLine('loading')).toBeNull();
    expect(fitLine(null)).toBeNull();
  });

  it('with fit on, the confirm button is enabled although the ticked files do not all fit; with it off it says short by', () => {
    const pv = p();
    const ticks = new Set(['video-camera']);
    expect(shortBytes(46 * GB, pickedAccounts(pv, three), fitPlan(), true)).toBe(0);
    expect(cannotStart(pv, ticks, three, fitPlan(), true)).toBeNull();
    expect(cannotStart(pv, ticks, three, plan({ unplacedFiles: 50, unplacedBytes: 12.3 * GB }), false)).toBe('Short by 12.3 GB: tick more accounts or fewer kinds');
    expect(cannotStart(pv, ticks, three, 'loading', true)).toBe('Working out where each file goes...');
    expect(cannotStart(pv, ticks, three, fitPlan({ toPlaceFiles: 0, toPlaceBytes: 0 }), true)).toMatch(/Not even the smallest file fits/);
  });

  it('the summary then shows the chosen subset as what is sent and what waits, and it fits', () => {
    const s = capacitySummary(p(), new Set(['video-camera']), three, fitPlan(), true);
    expect(s).toMatchObject({ state: 'fits', stillBytes: 0 });
    expect(s.send).toBe('To send: 31.8 GB (212 files)');
    expect(s.still).toBe('Waits for another account: 14.2 GB');
    // Without fit the same plan is not used as a fit plan.
    expect(capacitySummary(p(), new Set(['video-camera']), three, plan({ unplacedFiles: 3, unplacedBytes: 12 * GB }), false).state).toBe('short');
  });
});
