import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MirrorPlanView } from '../../shared/mirror';
import { AlsoKeepCopy } from './AlsoKeepCopy';
import { MirrorFileList } from './MirrorFileList';
import { listRows, MIRROR_HEADLINE } from './mirrorModel';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const noop = (): void => undefined;

const plan: Pick<MirrorPlanView, 'rows' | 'backups'> = {
  backups: [{ backupId: 1, backupName: 'Poco F4', sourceLabel: 'T7', targetLabel: 'Seagate2TB', folderWords: 'MyData\\POCO', files: 2, bytes: 0 }],
  rows: [
    { id: '0:S1/small.jpg', backupIndex: 0, path: 'S1/small.jpg', size: 3_000_000, mtimeMs: new Date(2026, 10, 1, 12).getTime(), ownChecksum: false },
    { id: '0:S1/VID_big.mp4', backupIndex: 0, path: 'S1/VID_big.mp4', size: 900_000_000, mtimeMs: new Date(2026, 10, 2, 12).getTime(), ownChecksum: true },
  ],
};

describe('the list before the copy to the second drive, as the window draws it', () => {
  const props = { rows: listRows(plan), onUntickedChange: noop, confirmLabel: 'Copy 2 files (903 MB) to Seagate2TB', canConfirm: true, onConfirm: noop, showBackup: false };

  it('opens with the plain sentence, then the list largest first with name, folder, size, date and what it is checked against, then the one button', () => {
    const html = render(h(MirrorFileList, { ...props, unticked: new Set<string>() }));
    expect(html).toContain('Files to copy, largest first.');
    expect(MIRROR_HEADLINE).toContain('largest first');
    expect(html).toContain('Untick = skip this time.');
    expect(html.indexOf('VID_big.mp4')).toBeLessThan(html.indexOf('small.jpg'));
    expect(html).toContain('<b class="phone-file__name">VID_big.mp4</b>');
    expect(html).toContain('900 MB');
    expect(html).toContain('2 Nov 2026');
    expect(html).toContain('Own checksum');
    expect(html).toContain('Phone checksum');
    expect(html).toContain('Search by file or folder name');
    expect(html).toContain('2 of 2 files ticked');
    expect(html.indexOf('Copy 2 files (903 MB) to Seagate2TB')).toBeGreaterThan(html.indexOf('small.jpg'));
  });

  it('shows the tick of each row, and turns the button off when nothing would be copied', () => {
    const html = render(h(MirrorFileList, { ...props, unticked: new Set(['0:S1/VID_big.mp4']), canConfirm: false, confirmLabel: 'Copy 1 file (3 MB) to Seagate2TB' }));
    expect(html).toContain('1 of 2 files ticked');
    expect(html.match(/type="checkbox"[^>]*checked=""/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Copy 1 file \(3 MB\) to Seagate2TB/);
  });

  it('names the backup under each file when the list covers several', () => {
    expect(render(h(MirrorFileList, { ...props, unticked: new Set<string>(), showBackup: true }))).toContain('Poco F4: S1');
  });
});

describe('"Also keep a copy" before the drive is known', () => {
  it('is a quiet button that is off until main has said which drive can hold the copy', () => {
    const html = render(h(AlsoKeepCopy, { backupId: 1, backupName: 'Poco F4', onAdded: noop }));
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Also keep a copy on another drive/);
  });
});
