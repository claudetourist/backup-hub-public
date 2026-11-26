import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { restoreDateText } from '../../shared/restore';
import { tabsFor } from './backupListModel';
import { RestoreDays } from './RestoreBrowser';
import { RestoreDestinationChoice } from './RestoreDestination';
import { childPath, crumbs, entrySize, googleLine, heldHeadline, pickOf, planHeadline, roomWarning, tickedText, tickKey, toggleTick } from './restoreModel';

describe('Get files back: the plain parts', () => {
  it('keys a tick by its path below the day, a folder with a slash', () => {
    expect(tickKey('', { name: 'a.jpg', folder: false })).toBe('a.jpg');
    expect(tickKey('DCIM', { name: 'Camera', folder: true })).toBe('DCIM/Camera/');
    const on = toggleTick(new Set(), 'a');
    expect([...on]).toEqual(['a']);
    expect(toggleTick(on, 'a').size).toBe(0);
    expect(childPath('', 'DCIM')).toBe('DCIM');
    expect(crumbs('DCIM/Camera')).toEqual([{ label: 'Top', path: '' }, { label: 'DCIM', path: 'DCIM' }, { label: 'Camera', path: 'DCIM/Camera' }]);
  });
  it('makes the pick: nothing until something is ticked; the newest copy needs no day', () => {
    const base = { backupId: 4, flat: false, day: 'POCO-23Nov26', everything: false, ticks: new Set<string>() };
    expect(pickOf({ ...base, mode: 'day' })).toBeNull();
    expect(pickOf({ ...base, mode: 'day', ticks: new Set(['DCIM/']) })).toEqual({ kind: 'date', backupId: 4, folder: 'POCO-23Nov26', items: ['DCIM/'] });
    expect(pickOf({ ...base, mode: 'day', everything: true })).toEqual({ kind: 'date', backupId: 4, folder: 'POCO-23Nov26', items: [] });
    expect(pickOf({ ...base, mode: 'day', day: null, everything: true })).toBeNull();
    expect(pickOf({ ...base, mode: 'day', flat: true, day: null, everything: true })).toEqual({ kind: 'date', backupId: 4, folder: null, items: [] });
    expect(pickOf({ ...base, mode: 'newest', day: null })).toEqual({ kind: 'newest', backupId: 4 });
  });
  it('words: sizes, what is ticked, the list, Google, no room', () => {
    expect(entrySize({ folder: true, files: 1204, bytes: 3_200_000_000 })).toContain('1,204 files');
    expect(tickedText(0, false)).toBe('Nothing ticked yet');
    expect(tickedText(2, false)).toBe('2 things ticked');
    expect(tickedText(0, true)).toBe('Everything on this day');
    expect(planHeadline({ files: 1, bytes: 2000, fromWords: 'T7' })).toBe('1 file (2 KB) will come back from T7.');
    expect(googleLine({ fromGoogle: 0 })).toBeNull();
    expect(googleLine({ fromGoogle: 12 })).toContain('12 files will be downloaded from Google');
    expect(heldHeadline(2)).toBe('2 files will not come back:');
    expect(roomWarning({ bytes: 5e9, freeBytes: 1e9 })).toContain('not enough room');
    expect(roomWarning({ bytes: 5e9, freeBytes: null })).toBeNull();
    expect(restoreDateText(Date.UTC(2026, 10, 22, 12))).toContain('2026');
  });
  it('is a tab of every backup', () => {
    expect(tabsFor({ kind: 'phone' }).find((t) => t.id === 'restore')?.label).toBe('Get files back');
    expect(tabsFor({ kind: 'folder' }).some((t) => t.id === 'restore')).toBe(true);
  });
});

describe('Get files back as the window draws it', () => {
  it('the destination: a new folder is the first choice, "back to where they were" only for a folder backup', () => {
    const noop = (): void => undefined;
    const phone = renderToStaticMarkup(h(RestoreDestinationChoice, { name: 'x', value: { mode: 'new' }, defaultParent: 'D:\\Restored', originalWords: null, onChange: noop }));
    expect(phone).toContain('Into a new folder (recommended)');
    expect(phone).toContain('D:\\Restored');
    expect(phone).not.toContain('Back to where they were');
    const folder = renderToStaticMarkup(h(RestoreDestinationChoice, { name: 'y', value: { mode: 'new' }, defaultParent: 'D:\\Restored', originalWords: 'C:\\Docs', onChange: noop }));
    expect(folder).toContain('Back to where they were');
  });
  it('the days are chips, newest first, one pressed', () => {
    const html = renderToStaticMarkup(h(RestoreDays, { dates: [{ folder: 'POCO-23Nov26', at: Date.UTC(2026, 10, 23, 12) }, { folder: 'POCO-20Nov26', at: Date.UTC(2026, 10, 20, 12) }], day: 'POCO-20Nov26', onPick: () => undefined }));
    expect(html).toContain('Pick a day');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.indexOf('23 Nov')).toBeLessThan(html.indexOf('20 Nov'));
  });
});
