import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FreeUpFileRowView } from '../../shared/freeUp';
import { GroupFilesTable } from './FreeUpPanel';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const row = (n: number, ticked: boolean | undefined): FreeUpFileRowView => ({ path: `/sdcard/DCIM/Camera/IMG_${n}.jpg`, name: `IMG_${n}.jpg`, folder: '/sdcard/DCIM/Camera', size: 3_000_000 - n, mtimeSec: 1_700_000_000, missing: [], hasCopy: true, ...(ticked === undefined ? {} : { ticked }) });
const noop = (): void => undefined;

describe('Free up: a tick per file in "Show files"', () => {
  it('has a tick column, a header tick for the page, and one tick per file (ticked = in this removal)', () => {
    const html = render(h(GroupFilesTable, { rows: [row(1, true), row(2, false), row(3, true)], notReady: false, onTick: noop, onKeep: noop, onShow: noop }));
    expect(html).toContain('Tick or untick every file on this page');
    expect(html.match(/<input type="checkbox"/g)).toHaveLength(4); // the header + three files
    expect(html.match(/checked=""/g)).toHaveLength(2); // two ticked files; the header is "some" (indeterminate, not checked)
    expect(html).toContain('aria-label="Free IMG_2.jpg"');
    expect(html).toContain('Keep on the phone'); // Keep stays a separate action
    expect(html).toContain('Keep folder');
  });

  it('the header tick is checked when every file of the page is ticked', () => {
    const html = render(h(GroupFilesTable, { rows: [row(1, true), row(2, true)], notReady: false, onTick: noop, onKeep: noop, onShow: noop }));
    expect(html.match(/checked=""/g)).toHaveLength(3);
  });

  it('an empty page says so and has nothing to tick', () => {
    const html = render(h(GroupFilesTable, { rows: [], notReady: false, onTick: noop, onKeep: noop, onShow: noop }));
    expect(html).toContain('No files here.');
    expect(html).toMatch(/<input[^>]*disabled/);
  });

  it('the list of files that are not ready has no ticks (they cannot go)', () => {
    const html = render(h(GroupFilesTable, { rows: [{ ...row(1, undefined), missing: ['No copy on Seagate2TB'] }], notReady: true, onTick: noop, onKeep: noop, onShow: noop }));
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('No copy on Seagate2TB');
    expect(html).toContain('Why');
  });
});
