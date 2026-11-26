import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PhoneBackupProgress, PreviewRow } from '../../shared/phoneBackup';
import { CopyingNow, CopyLists } from './PhoneCopyLists';
import { PhoneFileList } from './PhoneFileList';
import { listRows, PREVIEW_HEADLINE } from './phoneBackupModel';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const noop = (): void => undefined;

const rows: PreviewRow[] = [
  { path: '/sdcard/DCIM/Camera/small.jpg', size: 3_000_000, mtimeSec: Math.floor(new Date(2026, 10, 1, 12).getTime() / 1000), kind: 'new' },
  { path: '/sdcard/DCIM/Camera/VID_big.mp4', size: 900_000_000, mtimeSec: Math.floor(new Date(2026, 10, 2, 12).getTime() / 1000), kind: 'changed' },
];

describe('the list before the copy, as the window draws it', () => {
  const props = { rows: listRows(rows), onUntickedChange: noop, confirmLabel: 'Copy 2 files (903 MB) to T7', canConfirm: true, onConfirm: noop };

  it('opens with the plain sentence, then the list largest first with name, folder, size, date and New or Changed, then the one button', () => {
    const html = render(h(PhoneFileList, { ...props, unticked: new Set<string>() }));
    expect(html).toContain('Files to copy, largest first.');
    expect(html).toContain('Untick = skip this time. Exclude = never back up.');
    expect(PREVIEW_HEADLINE).toContain('largest first');
    expect(html.indexOf('VID_big.mp4')).toBeLessThan(html.indexOf('small.jpg'));
    expect(html).toContain('<b class="phone-file__name">VID_big.mp4</b>');
    expect(html).toContain('<span class="phone-file__folder">DCIM/Camera</span>');
    expect(html).toContain('900 MB');
    expect(html).toContain('2 Nov 2026');
    expect(html).toContain('Changed');
    expect(html).toContain('New');
    expect(html).toContain('Search by file or folder name');
    expect(html).toContain('2 of 2 files ticked');
    expect(html.indexOf('Copy 2 files (903 MB) to T7')).toBeGreaterThan(html.indexOf('small.jpg'));
  });

  it('shows the tick of each row, and turns the button off when nothing would be copied', () => {
    const html = render(h(PhoneFileList, { ...props, unticked: new Set(['/sdcard/DCIM/Camera/VID_big.mp4']), canConfirm: false, confirmLabel: 'Copy 1 file (3 MB) to T7' }));
    expect(html).toContain('1 of 2 files ticked');
    expect(html.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Copy 1 file \(3 MB\) to T7/);
  });
});

describe('the copy lists, as the window draws them', () => {
  const progress: PhoneBackupProgress = {
    jobId: 1,
    total: 6,
    done: 2,
    waiting: 2,
    failedCount: 1,
    current: { path: '/sdcard/DCIM/Camera/VID_now.mp4', size: 150_000_000 },
    next: [
      { path: '/sdcard/Download/next1.pdf', size: 1000 },
      { path: '/sdcard/Download/next2.pdf', size: 2000 },
    ],
    recent: [
      { path: '/sdcard/DCIM/Camera/IMG_done2.jpg', size: 4000 },
      { path: '/sdcard/DCIM/Camera/IMG_done1.jpg', size: 5000 },
    ],
    failed: [{ path: '/sdcard/Documents/bad.pdf', size: 90, reason: "The copy did not match the phone's checksum." }],
    finished: false,
  };

  it('says which file is being copied now and how many are finished', () => {
    const html = render(h(CopyingNow, { progress }));
    expect(html).toContain('Copying now: VID_now.mp4 (150 MB)');
    expect(html).toContain('3 of 6 files finished');
  });

  it('shows the files still to copy in order, the done ones with a tick, and the failed one with a red mark and its reason', () => {
    const html = render(h(CopyLists, { progress }));
    expect(html).toContain('Still to copy (2)');
    expect(html.indexOf('next1.pdf')).toBeLessThan(html.indexOf('next2.pdf'));
    expect(html).toContain('Done (2)');
    expect(html.indexOf('IMG_done2.jpg')).toBeLessThan(html.indexOf('IMG_done1.jpg'));
    expect(html).toContain('aria-label="Copied and checked"');
    expect(html).toContain('Not copied (1)');
    expect(html).toContain('phone-line--failed');
    expect(html).toContain('<span class="phone-file__reason">The copy did not match the phone&#x27;s checksum.</span>');
  });

  it('draws nothing before the first answer, and no failed list when nothing failed', () => {
    expect(render(h(CopyLists, { progress: null }))).toBe('');
    expect(render(h(CopyLists, { progress: { ...progress, failedCount: 0, failed: [] } }))).not.toContain('Not copied');
    expect(render(h(CopyingNow, { progress: null }))).toContain('Getting the list of files ready');
  });
});
