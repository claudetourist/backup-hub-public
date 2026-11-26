import { describe, expect, it } from 'vitest';
import { inScope, isOwnedKind, scopeBackups, scopeDecisions, scopeDevices, scopeFromSetting, scopeJobs, scopeLabel, scopeToSetting, searchPerson } from './profileScope';

const people = [
  { id: 1, name: 'You' },
  { id: 2, name: 'Mom' },
  { id: 3, name: 'Sam' },
];

describe('the person in focus', () => {
  it('reads the saved choice: a person, Everyone (null), or the first person when that person is gone', () => {
    expect(scopeFromSetting(null, people)).toBe('all');
    expect(scopeFromSetting(3, people)).toBe(3);
    expect(scopeFromSetting(9, people)).toBe(1);
    expect(scopeFromSetting(9, [])).toBe('all');
    expect(scopeToSetting('all')).toBeNull();
    expect(scopeToSetting(2)).toBe(2);
    expect(searchPerson('all')).toBeNull();
    expect(searchPerson(3)).toBe(3);
  });

  it('shows the phones and Google accounts of the person, and always the drives, the laptop and OneDrive', () => {
    const places = [
      { kind: 'drive', profileId: 1 },
      { kind: 'laptop', profileId: 1 },
      { kind: 'onedrive', profileId: 1 },
      { kind: 'phone', profileId: 1 },
      { kind: 'phone', profileId: 3 },
      { kind: 'gdrive', profileId: 2 },
      { kind: 'gdrive', profileId: 3 },
    ] as const;
    expect(scopeDevices(places, 3).map((p) => `${p.kind}${p.profileId}`)).toEqual(['drive1', 'laptop1', 'onedrive1', 'phone3', 'gdrive3']);
    expect(scopeDevices(places, 'all')).toHaveLength(7);
    expect(isOwnedKind('phone')).toBe(true);
    expect(isOwnedKind('drive')).toBe(false);
  });

  it('shows the backups of the person, all of them under Everyone', () => {
    const rows = [
      { id: 1, personId: 1 },
      { id: 2, personId: 3 },
      { id: 3, personId: 3 },
    ];
    expect(scopeBackups(rows, 3).map((r) => r.id)).toEqual([2, 3]);
    expect(scopeBackups(rows, 2)).toEqual([]);
    expect(scopeBackups(rows, 'all')).toHaveLength(3);
    expect(inScope('all', 5)).toBe(true);
    expect(inScope(1, 2)).toBe(false);
  });

  it('shows the jobs of the person; jobs of no one are shared (kept for Needs you, otherwise only under Everyone)', () => {
    const jobs = [{ personId: 3 }, { personId: 1 }, { personId: null }, {}];
    expect(scopeJobs(jobs, 3, true)).toEqual([{ personId: 3 }, { personId: null }, {}]);
    expect(scopeJobs(jobs, 3, false)).toEqual([{ personId: 3 }]);
    expect(scopeJobs(jobs, 'all', false)).toHaveLength(4);
  });

  it('shows the cases of the person\'s backups, and the cases that belong to no backup (a drive)', () => {
    const cases = [{ backupId: 1 }, { backupId: 2 }, { backupId: null }];
    const backups = [
      { id: 1, personId: 1 },
      { id: 2, personId: 3 },
    ];
    expect(scopeDecisions(cases, backups, 3)).toEqual([{ backupId: 2 }, { backupId: null }]);
    expect(scopeDecisions(cases, backups, 'all')).toHaveLength(3);
  });

  it('labels the scope', () => {
    expect(scopeLabel('all', people)).toBe('Everyone');
    expect(scopeLabel(2, people)).toBe('Mom');
    expect(scopeLabel(7, people)).toBe('Everyone');
  });
});
