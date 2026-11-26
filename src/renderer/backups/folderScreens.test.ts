import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PhoneFileList } from './PhoneFileList';
import { listRows } from './phoneBackupModel';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const noop = (): void => undefined;

describe('the list of a folder backup, as the window draws it', () => {
  const rows = listRows([
    { path: '/source/Videos/Trip Goa.mp4', size: 900_000_000, mtimeSec: Math.floor(new Date(2026, 10, 2, 12).getTime() / 1000), kind: 'changed' },
    { path: '/source/notes.txt', size: 2_100, mtimeSec: Math.floor(new Date(2026, 10, 1, 12).getTime() / 1000), kind: 'new' },
  ]);
  const props = { rows, unticked: new Set<string>(), onUntickedChange: noop, confirmLabel: 'Copy 2 files (900 MB) to T7', canConfirm: true, onConfirm: noop };

  it('names each file with its folder below the backed-up folder, never the internal "/source"', () => {
    const html = render(h(PhoneFileList, { ...props, backupId: 2, onChoose: noop }));
    expect(html).toContain('<b class="phone-file__name">Trip Goa.mp4</b>');
    expect(html).toContain('<span class="phone-file__folder">Videos</span>');
    expect(html).toContain('<span class="phone-file__folder">Main folder</span>');
    expect(html).not.toContain('/source');
    expect(html).not.toContain('Phone storage');
    expect(html).toContain('Untick = skip this time. Exclude = never back up.');
    expect(html).toContain('Why?');
  });

  it('for the Google Keep notes: no exclude menu, no "Why?", and the headline only says what unticking does', () => {
    const html = render(h(PhoneFileList, { ...props, untickOnly: true }));
    expect(html).toContain('Untick = skip this time.');
    expect(html).not.toContain('Exclude');
    expect(html).not.toContain('Why?');
  });
});
