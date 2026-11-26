import { describe, expect, it } from 'vitest';
import { FOLDER_NAME_MAX, FOLDER_PREFIX_MAX, folderPrefixFor, folderRootOf, safeFolderName } from './newPhoneBackup';

describe('the folder name made from a backup name', () => {
  it('keeps an ordinary name as it is', () => {
    expect(safeFolderName('Sam phone')).toBe('Sam phone');
    expect(safeFolderName("Sam's phone")).toBe("Sam's phone");
    expect(safeFolderName('  Redmi   Note 12 ')).toBe('Redmi Note 12');
  });

  it('drops the characters Windows does not allow', () => {
    expect(safeFolderName('a:b')).toBe('ab');
    expect(safeFolderName('a*b?c"d<e>f|g/h\\i')).toBe('abcdefghi');
    expect(safeFolderName('tab\there\x01')).toBe('tabhere');
  });

  it('drops dots and spaces at the end, and refuses a name with nothing left', () => {
    expect(safeFolderName('name. ')).toBe('name');
    expect(safeFolderName('name...')).toBe('name');
    expect(safeFolderName('..')).toBeNull();
    expect(safeFolderName('.')).toBeNull();
    expect(safeFolderName('')).toBeNull();
    expect(safeFolderName(' :*? ')).toBeNull();
    expect(safeFolderName('..x')).toBe('..x');
  });

  it('gives a reserved name a suffix', () => {
    expect(safeFolderName('CON')).toBe('CON-backup');
    expect(safeFolderName('nul')).toBe('nul-backup');
    expect(safeFolderName('Com1')).toBe('Com1-backup');
    expect(safeFolderName('LPT9')).toBe('LPT9-backup');
    expect(safeFolderName('con.old')).toBe('con-backup.old');
    expect(safeFolderName('Console')).toBe('Console');
    expect(safeFolderName('COM10')).toBe('COM10');
  });

  it('keeps an emoji and cuts a long name without splitting a character', () => {
    expect(safeFolderName('Mom 😀 phone')).toBe('Mom 😀 phone');
    const long = safeFolderName('😀'.repeat(60) + 'abc')!;
    expect(Array.from(long)).toHaveLength(FOLDER_NAME_MAX);
    expect(safeFolderName('x'.repeat(60))).toHaveLength(FOLDER_NAME_MAX);
    expect(safeFolderName('x'.repeat(59) + ' ' + 'y'.repeat(5))).toBe('x'.repeat(59));
  });

  it('never gives a path that leaves MyData', () => {
    for (const hostile of ['..', '../x', '..\\x', 'C:\\Windows', '/etc', 'a/../b']) {
      const safe = safeFolderName(hostile);
      if (safe !== null) {
        expect(safe).not.toMatch(/[\\/:]/);
        expect(safe).not.toBe('..');
      }
    }
  });
});

describe('the prefix of the dated folders', () => {
  it('turns every run of other characters into one dash', () => {
    expect(folderPrefixFor("Sam's phone")).toBe('Sam-s-phone');
    expect(folderPrefixFor('Sam phone')).toBe('Sam-phone');
    expect(folderPrefixFor('  Poco -- F4  ')).toBe('Poco-F4');
    expect(folderPrefixFor('22021211RI')).toBe('22021211RI');
  });

  it('is at most 24 characters and never ends with a dash', () => {
    const p = folderPrefixFor('Aaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbb');
    expect(p.length).toBeLessThanOrEqual(FOLDER_PREFIX_MAX);
    expect(p).toBe('Aaaaaaaaaaaaaaaaaaaaaaa');
    expect(folderPrefixFor('x'.repeat(60))).toHaveLength(FOLDER_PREFIX_MAX);
  });

  it('falls back to Phone when no letter or digit is left', () => {
    expect(folderPrefixFor('')).toBe('Phone');
    expect(folderPrefixFor('..')).toBe('Phone');
    expect(folderPrefixFor('😀😀')).toBe('Phone');
    expect(folderPrefixFor(':*?')).toBe('Phone');
  });

  it('keeps letters of other alphabets', () => {
    expect(folderPrefixFor('Zoë Ünal')).toBe('Zoë-Ünal');
  });
});

it('the folder root is MyData and the folder, with a forward slash and no drive letter', () => {
  expect(folderRootOf('Sam phone')).toBe('MyData/Sam phone');
});
