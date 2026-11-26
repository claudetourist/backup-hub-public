import { describe, expect, it } from 'vitest';
import type { LeftOutGroup } from '../../shared/phoneBackup';
import { REMOVE_CHOICE_LINE, notCoveredHeader, ruleWords, type RuleEffectResult, type RuleView } from '../../shared/rules';
import { choiceOptions, draftTitle, effectLines, exclusionLine, folderChoice, includeChoice, NOTHING_EXCLUDED, BACK_IN_LINE, notCoveredHeaderOf, pathsCoveredBy, savedOn, tickedText, undoLabel, untickCovered, yourChoicesButton, yourChoicesTitle } from './choicesModel';
import { leftOutLine, splitLeftOut } from './phoneBackupModel';

const effect = (over: Partial<Extract<RuleEffectResult, { ok: true }>> = {}): Extract<RuleEffectResult, { ok: true }> => ({ ok: true, backupName: 'Sam phone', hasPlan: true, leavesOut: { files: 0, bytes: 0 }, bringsBack: { files: 0, bytes: 0 }, ...over });

describe('the menu of a row', () => {
  it('offers this file, its folder and its kind, each naming what it means', () => {
    const o = choiceOptions('/sdcard/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/.Statuses/clip.MP4');
    expect(o.map((x) => x.label)).toEqual(['Never back up this file', 'Never back up this folder', 'Never back up .mp4 files']);
    expect(o[0]!.draft).toEqual({ scope: 'file', pattern: '/sdcard/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/.Statuses/clip.MP4', choice: 'leave_out' });
    expect(o[1]!.draft).toEqual({ scope: 'folder', pattern: '/sdcard/Android/media/com.whatsapp.w4b/WhatsApp Business/Media/.Statuses', choice: 'leave_out' });
    expect(o[1]!.hint).toBe('Android/media/com.whatsapp.w4b/WhatsApp Business/Media/.Statuses');
    expect(o[2]!.draft).toEqual({ scope: 'pattern', pattern: '*.mp4', choice: 'leave_out' });
  });

  it('leaves out what cannot be saved: no folder choice for a file in the top folder, no kind for a file without an extension', () => {
    expect(choiceOptions('/sdcard/notes.txt').map((x) => x.id)).toEqual(['file', 'kind']);
    expect(choiceOptions('/sdcard/DCIM/.nomedia').map((x) => x.id)).toEqual(['file', 'folder']);
    expect(folderChoice('Phone storage')).toBeNull();
    expect(folderChoice('DCIM/Camera')?.draft).toEqual({ scope: 'folder', pattern: '/sdcard/DCIM/Camera', choice: 'leave_out' });
  });

  it('"Always include" is offered for a folder, never for the whole phone', () => {
    expect(includeChoice('/sdcard/Android/data/com.x')).toEqual({ scope: 'folder', pattern: '/sdcard/Android/data/com.x', choice: 'include' });
    expect(includeChoice('/sdcard')).toBeNull();
  });
});

describe('saving a choice unticks the rows it names, exactly like unticking', () => {
  const rows = [{ path: '/sdcard/A/1.jpg' }, { path: '/sdcard/A/B/2.jpg' }, { path: '/sdcard/AB/3.jpg' }, { path: '/sdcard/A/4.txt' }];
  it('a folder names its subfolders but not a folder that only starts with the same letters', () => {
    expect(pathsCoveredBy({ scope: 'folder', pattern: '/sdcard/A', choice: 'leave_out' }, rows)).toEqual(['/sdcard/A/1.jpg', '/sdcard/A/B/2.jpg', '/sdcard/A/4.txt']);
  });
  it('a kind names every folder, in any case; a file names itself', () => {
    expect(pathsCoveredBy({ scope: 'pattern', pattern: '*.JPG', choice: 'leave_out' }, rows)).toHaveLength(3);
    expect(pathsCoveredBy({ scope: 'file', pattern: '/sdcard/A/4.txt', choice: 'leave_out' }, rows)).toEqual(['/sdcard/A/4.txt']);
  });
  it('keeps what was already unticked and does not change the old set', () => {
    const before = new Set(['/sdcard/AB/3.jpg']);
    const after = untickCovered(before, { scope: 'file', pattern: '/sdcard/A/4.txt', choice: 'leave_out' }, rows);
    expect([...after].toSorted()).toEqual(['/sdcard/A/4.txt', '/sdcard/AB/3.jpg']);
    expect(before.size).toBe(1);
  });
});

describe('the words before saving', () => {
  it('says what a choice does to the list, in the settled wording', () => {
    expect(effectLines(effect({ leavesOut: { files: 1234, bytes: 2_100_000_000 } }), 'add')).toEqual(['This leaves out 1,234 files (2.1 GB) now and in every later backup of Sam phone.']);
    expect(effectLines(effect({ bringsBack: { files: 1, bytes: 5_000 } }), 'add')).toEqual(['This brings back 1 file (5 KB) now and in every later backup of Sam phone.']);
    expect(effectLines(effect(), 'add')[0]).toMatch(/^This changes nothing in the list you see now/);
  });
  it('without a plan only the plain promise is given; a removal speaks of the next backup', () => {
    expect(effectLines(effect({ hasPlan: false }), 'add')).toEqual(['This applies to every later backup of Sam phone.']);
    expect(effectLines(effect({ hasPlan: false }), 'remove')).toEqual([]);
    expect(effectLines(effect({ bringsBack: { files: 31, bytes: 52_000_000 } }), 'remove')).toEqual(['This brings back 31 files (52 MB) in the next backup of Sam phone.']);
    expect(REMOVE_CHOICE_LINE).toBe('Removing this changes only what the next backup offers. Nothing is deleted.');
  });
  it('titles the choice and uses no technical words anywhere', () => {
    const lines = [
      draftTitle({ scope: 'folder', pattern: '/sdcard/DCIM/Camera/', choice: 'leave_out' }),
      draftTitle({ scope: 'file', pattern: '/sdcard/DCIM/a.jpg', choice: 'leave_out' }),
      draftTitle({ scope: 'pattern', pattern: '*.JPG', choice: 'leave_out' }),
      draftTitle({ scope: 'folder', pattern: '/sdcard/Download', choice: 'include' }),
      draftTitle({ scope: 'pattern', pattern: '*.mp4', choice: 'include' }),
      yourChoicesButton(3),
      yourChoicesTitle('Sam phone'),
      NOTHING_EXCLUDED,
      BACK_IN_LINE,
      REMOVE_CHOICE_LINE,
      ...effectLines(effect({ leavesOut: { files: 2, bytes: 9 }, bringsBack: { files: 1, bytes: 1 } }), 'add'),
    ];
    expect(lines[0]).toBe('Never back up this folder: DCIM/Camera');
    expect(lines[2]).toBe('Never back up .jpg files');
    expect(lines[3]).toBe('Always include this folder: Download');
    expect(lines[5]).toBe('Exclusions (3)');
    for (const l of lines) expect(l).not.toMatch(/\b(rule|rules|pattern|scope|profile|destination)\b/i);
  });
  it('dates and the tick line', () => {
    expect(savedOn(new Date(2026, 10, 20, 9).getTime())).toBe('20 Nov 2026');
    expect(tickedText(null)).toBe('');
    expect(tickedText(new Date(2026, 10, 12, 10).getTime())).toBe('Done 12 Nov 2026');
    expect(notCoveredHeader(2, 5)).toBe('Things no backup can copy: 2 of 5 done');
    expect(notCoveredHeaderOf({ ok: true, backupId: 1, backupName: 'x', items: [], done: 2, total: 5 })).toBe('Things no backup can copy: 2 of 5 done');
  });
});

describe('the Exclusions list', () => {
  const view = (id: number, scope: RuleView['scope'], pattern: string): RuleView => ({ id, scope, choice: 'leave_out', pattern, words: ruleWords({ scope, pattern, choice: 'leave_out' }), createdAt: new Date(2026, 10, 20, 9).getTime(), everyBackup: false });
  it('one line per exclusion: kind, bold name, the folder under it, the date', () => {
    expect(exclusionLine(view(1, 'file', '/sdcard/Download/never.pdf'))).toEqual({ id: 1, kind: 'File', name: 'never.pdf', where: 'Download', added: '20 Nov 2026' });
    expect(exclusionLine(view(2, 'folder', '/sdcard/Android/media/com.x/.Statuses/'))).toEqual({ id: 2, kind: 'Folder', name: '.Statuses', where: 'Android/media/com.x', added: '20 Nov 2026' });
    expect(exclusionLine(view(3, 'folder', '/sdcard/Movies'))).toMatchObject({ kind: 'Folder', name: 'Movies', where: 'Phone storage' });
    expect(exclusionLine(view(4, 'pattern', '*.TMP'))).toMatchObject({ kind: 'Type', name: '.tmp', where: 'Every folder' });
  });
  it('a folder backup says its folder words, never "Phone storage"', () => {
    expect(exclusionLine(view(1, 'file', '/source/top.zip'))).toMatchObject({ name: 'top.zip', where: 'Main folder' });
    expect(exclusionLine(view(2, 'folder', '/source/IMP'))).toMatchObject({ kind: 'Folder', name: 'IMP', where: 'Main folder' });
    expect(exclusionLine(view(3, 'file', '/source/IMP/Google_Takeout/a.zip'))).toMatchObject({ name: 'a.zip', where: 'IMP/Google_Takeout' });
    // an old full Windows path that is not under the folder is shown whole, by its own folder
    const old = exclusionLine(view(4, 'file', 'D:\\Other\\Stuff\\a.zip'));
    expect(old).toMatchObject({ name: 'a.zip', where: 'D:\\Other\\Stuff' });
    expect(exclusionLine(view(5, 'folder', 'D:\\Other\\Stuff\\')).where).toBe('D:\\Other');
    expect(exclusionLine(view(6, 'file', 'D:\\a.zip')).where).toBe('D:');
  });
  it('the Undo button says what it undoes', () => {
    expect(undoLabel(view(1, 'file', '/sdcard/a.pdf'))).toBe('Undo');
    expect(undoLabel(view(2, 'folder', '/sdcard/A'))).toBe('Undo (folder)');
    expect(undoLabel(view(3, 'pattern', '*.PDF'))).toBe('Undo (.pdf)');
  });
});

describe('the left-out groups of the preview', () => {
  const groups: LeftOutGroup[] = [
    { key: 'rule:1', filter: 'your_rule', folder: '/sdcard/A', files: 31, bytes: 52_000_000, canInclude: false, rule: { id: 1, words: 'Never back up: A (folder)' } },
    { key: 'cache_folder|/sdcard/DCIM/.thumbnails', filter: 'cache_folder', folder: '/sdcard/DCIM/.thumbnails', files: 1204, bytes: 310_000_000, canInclude: true },
  ];
  it('keeps the ones made by your choices apart from the ones the filters made', () => {
    const s = splitLeftOut(groups);
    expect(s.byYou.map((g) => g.key)).toEqual(['rule:1']);
    expect(s.byFilters.map((g) => g.key)).toEqual(['cache_folder|/sdcard/DCIM/.thumbnails']);
  });
  it('names the choice and says it was left out by your choice', () => {
    expect(leftOutLine(groups[0]!)).toBe('Never back up: A (folder). Left out by your choice: 31 files, 52 MB.');
    expect(leftOutLine(groups[1]!)).toContain('left out: 1,204 files, 310 MB');
  });
});
