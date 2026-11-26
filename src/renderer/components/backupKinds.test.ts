import { describe, expect, it } from 'vitest';
import { backupKindOf } from './backupKinds';

describe('backupKindOf', () => {
  it('a phone backup is a phone', () => {
    expect(backupKindOf({ kind: 'phone', from: 'Phone' })).toBe('phone');
  });
  it('OneDrive and other cloud folders are cloud', () => {
    expect(backupKindOf({ kind: 'folder', from: 'C:\\Users\\you\\OneDrive\\IMP' })).toBe('cloud');
    expect(backupKindOf({ kind: 'folder', from: 'D:\\Dropbox' })).toBe('cloud');
  });
  it('a folder on C: is the laptop, on another letter a drive', () => {
    expect(backupKindOf({ kind: 'folder', from: 'C:\\Users\\you\\Documents' })).toBe('laptop');
    expect(backupKindOf({ kind: 'folder', from: 'F:\\Photos' })).toBe('drive');
  });
});
