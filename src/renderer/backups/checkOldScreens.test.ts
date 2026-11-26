import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CheckOldCountsResult, CheckOldPlanResult, CheckOldReport } from '../../shared/phoneBackup';
import { CheckOldHeadline, CheckOldPreview, CheckOldReportView } from './CheckOldView';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const noop = (): void => undefined;
const b = (files: number, gb: number): { files: number; bytes: number } => ({ files, bytes: Math.round(gb * 1e9) });

const counts = {
  ok: true,
  backupId: 1,
  driveLabel: 'T7',
  lookedAt: 1_700_000_000_000,
  total: { onPhone: b(33_721, 100), checked: b(12_345, 30), unchecked: b(19_900, 60), noCopy: b(1_300, 9), leftOut: b(176, 1) },
  folders: [{ folder: 'DCIM/Camera', onPhone: b(20_000, 80), checked: b(8_000, 30), unchecked: b(11_000, 45), noCopy: b(1_000, 5), leftOut: b(0, 0) }],
} satisfies Extract<CheckOldCountsResult, { ok: true }>;
const plan = { ok: true, backupId: 1, phoneName: 'Poco F4', driveLabel: 'T7', folders: [{ folder: 'DCIM/Camera', files: 11_000, bytes: 45e9 }, { folder: 'Download', files: 20, bytes: 5e6 }], totals: b(11_020, 45) } satisfies Extract<CheckOldPlanResult, { ok: true }>;
const report: CheckOldReport = {
  jobId: 5, backupName: 'Poco F4', phoneName: 'Poco F4', driveLabel: 'T7', startedAt: 1, finishedAt: 1_700_000_000_000, asked: 100,
  verified: b(97, 12), differ: [{ path: '/sdcard/DCIM/Camera/a.mp4', size: 148_000_000 }, { path: '/sdcard/b.jpg', size: 4_000_000 }], differCount: 2,
  missing: [{ path: '/sdcard/DCIM/Camera/c.jpg', size: 3_000_000 }], missingCount: 1, noLongerOnPhone: 0, couldNotRead: [],
};

describe('the backup card, as the window draws it', () => {
  it('opens with one headline, the rest in small words, a By folder fold, and the button', () => {
    const html = render(h(CheckOldHeadline, { backupName: 'Poco F4', counts, formatWhen: () => '14 Nov, 22:13', action: h('button', null, 'Check old copies') }));
    expect(html).toContain('<b>Poco F4: 12,345 of 33,721 files have a checked copy on T7.</b>');
    expect(html).toContain('19,900 files (60 GB) have a copy that was never checked');
    expect(html).toContain('As of the last look at the phone, 14 Nov, 22:13.');
    expect(html).toContain('<summary>By folder</summary>');
    expect(html).toContain('DCIM/Camera: 8,000 of 20,000 checked (30 GB of 80 GB)');
    // the button sits right next to the one line, and the By folder fold (closed) comes after both
    expect(html.indexOf('Check old copies</button>')).toBeGreaterThan(html.indexOf('have a checked copy on T7.'));
    expect(html.indexOf('By folder')).toBeGreaterThan(html.indexOf('Check old copies</button>'));
    expect(html).not.toMatch(/<details[^>]*open/);
  });

  it('puts the breakdown sentence and the date inside the By folder fold, at its top, not above it', () => {
    const html = render(h(CheckOldHeadline, { backupName: 'Poco F4', counts, formatWhen: () => '14 Nov, 22:13', action: h('button', null, 'Check old copies') }));
    const fold = html.indexOf('<summary>By folder</summary>');
    expect(html.indexOf('19,900 files (60 GB) have a copy that was never checked')).toBeGreaterThan(fold);
    expect(html.indexOf('19,900 files (60 GB)')).toBeLessThan(html.indexOf('DCIM/Camera: 8,000 of 20,000 checked'));
    expect(html.indexOf('As of the last look at the phone')).toBeGreaterThan(fold);
    expect(html.slice(0, fold)).not.toContain('never checked');
  });
});

describe('the card of a phone that was never read', () => {
  const never = { ...counts, lookedAt: null, total: { onPhone: b(0, 0), checked: b(0, 0), unchecked: b(0, 0), noCopy: b(0, 0), leftOut: b(0, 0) }, folders: [] };

  it('says the phone has not been read yet, by the backup name, with no numbers and no button', () => {
    const html = render(h(CheckOldHeadline, { backupName: 'Sam phone', counts: never, formatWhen: () => 'x', action: h('button', null, 'Check old copies') }));
    expect(html).toContain('Sam phone has not been read yet. Back it up once, then this shows how many files have a checked copy.');
    expect(html).not.toContain('0 of 0');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('By folder');
  });

  it('a phone with files and nothing left to check keeps the numbers (and its button slot)', () => {
    const allChecked = { ...counts, total: { ...counts.total, checked: counts.total.onPhone, unchecked: b(0, 0), noCopy: b(0, 0), leftOut: b(0, 0) } };
    const html = render(h(CheckOldHeadline, { backupName: 'Poco F4', counts: allChecked, formatWhen: () => 'x', action: h('span', null, 'Every copy on T7 that came from the old tool has been checked.') }));
    expect(html).toContain('<b>Poco F4: 33,721 of 33,721 files have a checked copy on T7.</b>');
    expect(html).toContain('has been checked.');
  });
});

describe('the preview of the check, as the window draws it', () => {
  const props = { plan, unticked: new Set<string>(), onToggle: noop, onTickAll: noop, onUntickAll: noop, onConfirm: noop, onCancel: noop, busy: false };

  it('lists the folders largest first, all ticked, says nothing is copied or changed, and offers one button with the count', () => {
    const html = render(h(CheckOldPreview, props));
    expect(html).toContain('Folders with copies that were never checked, largest first.');
    expect(html.indexOf('DCIM/Camera: 11,000 files, 45 GB')).toBeLessThan(html.indexOf('Download: 20 files, 5 MB'));
    expect(html.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(2);
    expect(html).toContain('Reads each file on the phone and on the drive and compares them. Nothing is copied, changed or removed on the phone or the drive.');
    expect(html).toMatch(/<button[^>]*>Check 11,020 files \(45 GB\)<\/button>/);
    expect(html).toContain('Cancel');
  });

  it('has Tick all and Untick all above the folders and the line N of M ticked', () => {
    const all = render(h(CheckOldPreview, props));
    expect(all).toContain('2 of 2 ticked');
    expect(all).toMatch(/<button[^>]*disabled[^>]*>Tick all<\/button>/);
    expect(all).toMatch(/<button(?![^>]*disabled)[^>]*>Untick all<\/button>/);
    expect(all.indexOf('Untick all')).toBeLessThan(all.indexOf('DCIM/Camera: 11,000 files'));
    const one = render(h(CheckOldPreview, { ...props, unticked: new Set(['Download']) }));
    expect(one).toContain('1 of 2 ticked');
    expect(one).toMatch(/<button(?![^>]*disabled)[^>]*>Tick all<\/button>/);
    const none = render(h(CheckOldPreview, { ...props, unticked: new Set(['DCIM/Camera', 'Download']) }));
    expect(none).toContain('0 of 2 ticked');
    expect(none).toMatch(/<button[^>]*disabled[^>]*>Untick all<\/button>/);
  });

  it('an unticked folder leaves the total, and with nothing ticked the button is off', () => {
    const one = render(h(CheckOldPreview, { ...props, unticked: new Set(['DCIM/Camera']) }));
    expect(one).toContain('Check 20 files (5 MB)');
    expect(one.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(1);
    const none = render(h(CheckOldPreview, { ...props, unticked: new Set(['DCIM/Camera', 'Download']) }));
    expect(none).toMatch(/<button[^>]*disabled[^>]*>Check 0 files/);
  });
});

describe('the report of the check, as the window draws it', () => {
  it('says what is checked now, warns about the files that differ and the missing one, and names them in folds', () => {
    const html = render(h(CheckOldReportView, { report, formatWhen: () => '14 Nov, 22:20' }));
    expect(html).toContain('Checked 100 files from Poco F4');
    expect(html).toContain('Nothing on the phone or on T7 was copied, changed or removed.');
    expect(html).toContain('97 files (12 GB) are the same on the phone and on T7.');
    expect(html).toContain('2 files are not the same on T7 as on the phone.');
    expect(html).toContain('1 file is not on T7 any more.');
    expect(html).toContain('Files that differ (2)');
    expect(html).toContain('a.mp4 (DCIM/Camera, 148 MB)');
    expect(html).toContain('Files missing on the drive (1)');
    expect(html).toContain('role="alert"');
  });

  it('a clean check has one good line and no folds', () => {
    const html = render(h(CheckOldReportView, { report: { ...report, differ: [], differCount: 0, missing: [], missingCount: 0 }, formatWhen: () => 'now' }));
    expect(html).toContain('are the same on the phone and on T7');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('role="alert"');
  });
});
