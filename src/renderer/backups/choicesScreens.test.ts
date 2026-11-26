import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PreviewRow } from '../../shared/phoneBackup';
import { NOT_COVERED_ITEMS, ruleWords, type NotCoveredResult, type RuleView, type RulesListResult } from '../../shared/rules';
import { ChoicesList } from './YourChoicesDrawer';
import { NotCoveredView } from './NotCoveredCard';
import { PhoneFileList } from './PhoneFileList';
import { listRows } from './phoneBackupModel';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const noop = (): void => undefined;

const rows: PreviewRow[] = [
  { path: '/sdcard/Android/media/com.whatsapp/WhatsApp/Media/.Statuses/s1.jpg', size: 3_000_000, mtimeSec: Math.floor(new Date(2026, 10, 1, 12).getTime() / 1000), kind: 'new' },
  { path: '/sdcard/notes.txt', size: 2_000, mtimeSec: Math.floor(new Date(2026, 10, 2, 12).getTime() / 1000), kind: 'changed' },
];

describe('the list before the copy with the menu of your choices', () => {
  const props = { rows: listRows(rows), unticked: new Set<string>(), onUntickedChange: noop, confirmLabel: 'Copy 2 files to T7', canConfirm: true, onConfirm: noop };

  it('has a "Your choices" column with one menu per row when it is given somewhere to send the choice', () => {
    const html = render(h(PhoneFileList, { ...props, onChoose: noop }));
    expect(html).toContain('Exclude');
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Exclude or include s1.jpg"');
    expect(html).toContain('aria-label="Exclude or include notes.txt"');
  });

  it('shows an excluded row as Excluded, dimmed, with Undo, and counts it apart', () => {
    const rule: RuleView = { id: 7, scope: 'folder', choice: 'leave_out', pattern: '/sdcard/Android/media/com.whatsapp/WhatsApp/Media/.Statuses', words: 'Never back up: Android/media/com.whatsapp/WhatsApp/Media/.Statuses (folder)', createdAt: 1, everyBackup: false };
    const html = render(h(PhoneFileList, { ...props, onChoose: noop, onUndo: noop, excluded: new Map([[rows[0]!.path, rule]]), exclusionCount: 1, onOpenExclusions: noop }));
    expect(html).toContain('>Excluded<');
    expect(html).toContain('phone-file--excluded');
    expect(html).toContain('>Undo (folder)<');
    expect(html).toContain('title="Never back up: Android/media/com.whatsapp/WhatsApp/Media/.Statuses (folder)"');
    expect(html).toContain('1 of 1 file ticked · 1 excluded');
    expect(html).toContain('Untick = skip this time. Exclude = never back up.');
    expect(html).toContain('>Exclusions (1)<');
    expect(html.match(/type="checkbox"/g)).toHaveLength(1); // the excluded row has no tick box
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(1); // and no menu: Undo instead
  });

  it('has no menu at all without it (the old list is unchanged)', () => {
    const html = render(h(PhoneFileList, props));
    expect(html).not.toContain('aria-haspopup');
    expect(html).not.toContain('Exclude or include');
  });
});

describe('Exclusions of a backup, in the drawer', () => {
  const rule = (id: number, scope: RuleView['scope'], pattern: string, choice: RuleView['choice'], createdAt: number, everyBackup = false): RuleView => ({ id, scope, choice, pattern, words: ruleWords({ scope, pattern, choice }), createdAt, everyBackup });
  const base = { message: null, onUndo: noop };
  const list: RulesListResult = {
    ok: true,
    backupId: 1,
    backupName: 'Sam phone',
    rules: [
      rule(1, 'folder', '/sdcard/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/.Statuses', 'leave_out', new Date(2026, 10, 20, 9).getTime()),
      rule(2, 'file', '/sdcard/Download/never.pdf', 'leave_out', new Date(2026, 10, 21, 9).getTime()),
      rule(3, 'pattern', '*.TMP', 'leave_out', new Date(2026, 10, 22, 9).getTime()),
      rule(4, 'folder', '/sdcard/Android/data/com.x', 'include', new Date(2026, 10, 23, 9).getTime(), true),
    ],
  };

  it('is one compact list: kind, name in bold, folder under it, date added and an Undo per line', () => {
    const html = render(h(ChoicesList, { ...base, list }));
    expect(html).toContain('>Folder<');
    expect(html).toContain('>File<');
    expect(html).toContain('>Type<');
    expect(html).toContain('<b class="phone-file__name">.Statuses</b>');
    expect(html).toContain('Android/media/com.whatsapp.w4b/WhatsApp Business/Media');
    expect(html).toContain('<b class="phone-file__name">never.pdf</b>');
    expect(html).toContain('<b class="phone-file__name">.tmp</b>');
    expect(html).toContain('20 Nov 2026');
    expect(html).toContain('>Undo (folder)<');
    expect(html).toContain('>Undo<');
    expect(html).toContain('>Undo (.tmp)<');
    expect(html).toContain('title="Never back up: Download/never.pdf (file)"');
    expect(html).not.toMatch(/\b(rule|pattern|scope|profile|destination)\b/i);
  });

  it('a long path is shown whole: wrapped in the line, with the whole path in a tooltip', () => {
    const long = '/source/' + Array.from({ length: 12 }, (_, i) => `Some_Long_Folder_Name_${i}`).join('/') + '/takeout-20250202T053538Z-001.zip';
    const html = render(h(ChoicesList, { ...base, list: { ok: true, backupId: 3, backupName: 'OneDrive', rules: [rule(9, 'file', long, 'leave_out', 1)] } }));
    expect(html).toContain('class="phone-file exclusion-line__what"');
    expect(html).toContain('Some_Long_Folder_Name_0/Some_Long_Folder_Name_1');
    expect(html).toContain('Some_Long_Folder_Name_11');
    expect(html).toContain('title="Never back up: Some_Long_Folder_Name_0/');
    expect(html).not.toContain('Phone storage');
  });

  it('keeps "Always include" apart, below the exclusions', () => {
    const html = render(h(ChoicesList, { ...base, list }));
    expect(html.indexOf('aria-label="Always include"')).toBeGreaterThan(html.indexOf('never.pdf'));
    expect(html).toContain('23 Nov 2026');
    expect(html).toContain('every backup');
    expect(html.match(/>Undo/g)).toHaveLength(4);
  });

  it('says so when nothing is excluded, while reading, and when it cannot be read', () => {
    expect(render(h(ChoicesList, { ...base, list: { ok: true, backupId: 1, backupName: 'Sam phone', rules: [] } }))).toContain('Nothing excluded. Use Exclude on a file to never back it up.');
    expect(render(h(ChoicesList, { ...base, list: { ok: true, backupId: 1, backupName: 'Sam phone', rules: [list.rules[3]!] } }))).toContain('Nothing excluded.');
    expect(render(h(ChoicesList, { ...base, list: null }))).toContain('Reading your exclusions.');
    expect(render(h(ChoicesList, { ...base, list: { ok: false, message: 'That backup does not exist.' } }))).toContain('That backup does not exist.');
  });
});

describe('the card of things no backup can copy', () => {
  const state = (ticked: string[]): Extract<NotCoveredResult, { ok: true }> => ({
    ok: true,
    backupId: 1,
    backupName: 'Sam phone',
    items: NOT_COVERED_ITEMS.map((i) => ({ ...i, ticked: ticked.includes(i.id), tickedAt: ticked.includes(i.id) ? new Date(2026, 10, 12, 10).getTime() : null })),
    done: ticked.length,
    total: NOT_COVERED_ITEMS.length,
  });

  it('has the header with the count, the five items each with one line on what to do, and a tick for each', () => {
    const html = render(h(NotCoveredView, { state: state(['contacts_messages', 'whatsapp']), busy: false, framed: true, onTick: noop }));
    expect(html).toContain('Not covered by this backup');
    expect(html).toContain('<summary>Things no backup can copy: 2 of 5 done</summary>');
    expect(html).not.toMatch(/<details[^>]*open/);
    for (const title of ['Authenticator app codes', 'Contacts and messages', 'WhatsApp chats', 'Signal', 'App logins and passwords']) expect(html).toContain(title);
    expect(html).toContain('save each account&#x27;s recovery codes somewhere safe such as Vault');
    expect(html).toContain('keep the 64-digit key safe');
    expect(html.match(/type="checkbox"/g)).toHaveLength(5);
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(html).toContain('Done 12 Nov 2026');
    expect(html).not.toMatch(/\b(rule|pattern|scope|profile|destination)\b/i);
  });

  it('is a closed fold in the unframed card too, with the count in its summary and the ticks inside', () => {
    const html = render(h(NotCoveredView, { state: state([]), busy: false, framed: false, onTick: noop }));
    expect(html).toContain('<summary>Things no backup can copy: 0 of 5 done</summary>');
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html.indexOf('<summary>')).toBeLessThan(html.indexOf('type="checkbox"'));
    expect(html).not.toContain('<b>Not covered by this backup</b>');
  });

  it('inside another card it has no frame of its own, and says so while reading or when it cannot', () => {
    expect(render(h(NotCoveredView, { state: state([]), busy: false, framed: false, onTick: noop }))).toContain('Things no backup can copy: 0 of 5 done');
    expect(render(h(NotCoveredView, { state: null, busy: false, framed: false, onTick: noop }))).toContain('Reading the list.');
    expect(render(h(NotCoveredView, { state: { ok: false, message: 'That is not a phone backup.' }, busy: false, framed: false, onTick: noop }))).toContain('That is not a phone backup.');
  });
});
