import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FreeUpPrepareView } from '../../shared/freeUp';
import { ConfirmView } from './FreeUpPanel';
import { tabsFor } from './backupListModel';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const noop = (): void => undefined;

const prepare: FreeUpPrepareView = {
  checkId: 4,
  groups: [
    { id: 'big-videos', label: 'Big videos (over 100 MB)', files: 12, bytes: 30_200_000_000 },
    { id: 'camera-photos', label: 'Camera photos', files: 408, bytes: 16_000_000_000 },
  ],
  files: 420,
  bytes: 46_200_000_000,
  places: ['T7', 'Seagate2TB', 'Google'],
  hash: 'abc',
};

describe('Free up phone space as the window draws it', () => {
  it('the confirm screen says what goes and where the copies are, with one main button', () => {
    const html = render(h(ConfirmView, { step: { name: 'confirm', checkId: 4, groups: ['big-videos', 'camera-photos'], prepare }, onBack: noop, onStarted: noop, onMessage: noop }));
    expect(html).toContain('Free 46.2 GB: 420 files');
    expect(html).toContain('Big videos (over 100 MB): 12 files, 30.2 GB');
    expect(html).toContain('The copies are on T7, Seagate2TB and Google.');
    expect(html.match(/btn--primary/g)).toHaveLength(1);
    expect(html).toContain('Remove 420 files from the phone');
    expect(html).toContain('>Back<');
  });

  it('the confirm screen lets the person choose how each file is checked before it goes: Full is chosen and recommended, Quick is explained in one line', () => {
    const html = render(h(ConfirmView, { step: { name: 'confirm', checkId: 4, groups: ['big-videos'], prepare }, onBack: noop, onStarted: noop, onMessage: noop }));
    expect(html).toContain('Full (recommended)');
    expect(html).toMatch(/<input type="radio" name="remove-mode" checked=""[^>]*\/> <b>Full \(recommended\)/);
    expect(html).toContain('Does not read the files again: checks each copy is still there at its size, asks Google, checks the phone&#x27;s file size.');
    expect(html.match(/type="radio"/g)).toHaveLength(2);
  });

  it('is a tab of a phone backup only', () => {
    expect(tabsFor({ kind: 'phone' }).find((t) => t.id === 'free')?.label).toBe('Free up phone space');
    expect(tabsFor({ kind: 'folder' }).some((t) => t.id === 'free')).toBe(false);
  });
});
