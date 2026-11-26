import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { NewBackupChoices } from '../../shared/phoneBackup';
import { NewPhoneCard } from '../screens/Backups';
import { NewPhoneBackupDrawer } from './NewPhoneBackupDrawer';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const noop = (): void => undefined;
const today = new Date(2026, 10, 23);
const choices: Extract<NewBackupChoices, { ok: true }> = { ok: true, suggestedName: 'Redmi Note 12', drives: [{ placeId: 't7', label: 'T7', folders: ['Sam phone', 'HJ'] }] };
const drawer = (over: Partial<Parameters<typeof NewPhoneBackupDrawer>[0]> = {}): string => render(h(NewPhoneBackupDrawer, { phoneName: 'Redmi Note 12', choices, busy: false, error: null, onSave: noop, onCancel: noop, today, ...over }));

describe('the card of a new phone', () => {
  const phone = { serial: 'abc', phoneName: 'Redmi Note 12', ready: true, hint: null };
  const props = { phone, backups: [], busy: false, onYes: noop, onMakeNew: noop, onNotNow: noop };

  it('offers "Make a new backup for this phone" next to the Yes buttons and Not now', () => {
    const html = render(h(NewPhoneCard, { ...props, backups: [{ backupId: 1, backupName: 'Samsung' }] }));
    expect(html).toContain('Yes, this is Samsung');
    expect(html).toContain('Make a new backup for this phone');
    expect(html).toContain('Not now');
    expect(html.indexOf('Yes, this is Samsung')).toBeLessThan(html.indexOf('Make a new backup for this phone'));
  });

  it('with no backup waiting for a phone, says the phone has no backup yet and offers only the new backup', () => {
    const html = render(h(NewPhoneCard, props));
    expect(html).toContain('A phone is plugged in: Redmi Note 12. It has no backup yet.');
    expect(html).not.toContain('Yes, this is');
    expect(html).toContain('Make a new backup for this phone');
  });

  it('a phone that has not allowed this computer shows its hint and no new backup', () => {
    const html = render(h(NewPhoneCard, { ...props, phone: { serial: 'x', phoneName: 'a phone', ready: false, hint: 'Unlock it and tap Allow on its screen.' } }));
    expect(html).toContain('tap Allow');
    expect(html).not.toContain('Make a new backup for this phone');
  });
});

describe('the form that makes a new backup', () => {
  it('opens with the name of the phone, the only drive picked, and a new folder named from the name', () => {
    const html = drawer();
    expect(html).toContain('Make a new backup');
    expect(html).toContain('value="Redmi Note 12"');
    expect(html).toContain('Drive');
    expect(html).toMatch(/<input[^>]*type="radio"[^>]*name="new-backup-drive"[^>]*checked=""/);
    expect(html).toContain('Folder on T7');
    expect(html).toContain('A new folder: MyData\\Redmi Note 12');
    expect(html).toMatch(/<input[^>]*name="new-backup-folder"[^>]*checked=""[^>]*\/> A new folder/);
    expect(html).toContain('A folder already on the drive');
    expect(html).toContain('Each backup goes in a dated folder, like Redmi-Note-12-23Nov26.');
    expect(html).not.toContain('recognised by their checksum');
    expect(html).toMatch(/<button[^>]*>Save<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Save<\/button>/);
    expect(html).toContain('Cancel');
  });

  it('with two drives none is picked and Save is off', () => {
    const html = drawer({ choices: { ...choices, drives: [...choices.drives, { placeId: 'bk', label: 'Backup disk', folders: [] }] } });
    expect(html).toContain('Backup disk');
    expect(html).not.toMatch(/name="new-backup-drive"[^>]*checked=""/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save<\/button>/);
  });

  it('with no drive plugged in says so and has no Save', () => {
    const html = drawer({ choices: { ...choices, drives: [] } });
    expect(html).toContain('Plug in the drive you want the backups on, then press Check for a phone.');
    expect(html).not.toContain('>Save<');
    expect(html).not.toContain('Folder on');
    expect(html).toContain('Cancel');
  });

  it('shows what main refused with', () => {
    expect(drawer({ error: 'There is already a backup called Poco F4. Nothing was changed.' })).toContain('role="alert"');
  });

  it('uses plain words only', () => {
    const html = drawer();
    for (const word of ['profile', 'serial', 'place', 'destination']) expect(html.toLowerCase()).not.toContain(word);
  });
});
