import type { BackupRow } from '../../shared/backups';
import type { DecisionCase } from '../../shared/decisions';
import type { JobRecord } from '../../shared/jobs';
import { EVERYONE_WORD } from '../../shared/people';
import type { PlaceView } from '../../shared/places';
import type { ProfileView } from '../../shared/settings';

/** Whose things the screens show: everyone's, or one person's. */
export type ProfileScope = 'all' | number;

/**
 * The scope for the saved choice (the setting "activePerson": a person's id, or null for Everyone). A person who is gone, or a choice
 * made before the people were known, shows the first person ("You"); with no people at all it is Everyone.
 */
export function scopeFromSetting(saved: number | null, people: readonly Pick<ProfileView, 'id'>[]): ProfileScope {
  if (saved === null) return 'all';
  if (people.some((p) => p.id === saved)) return saved;
  return people[0]?.id ?? 'all';
}

export const scopeToSetting = (scope: ProfileScope): number | null => (scope === 'all' ? null : scope);

export const inScope = (scope: ProfileScope, personId: number): boolean => scope === 'all' || scope === personId;

/** Phones and Google accounts belong to a person; drives, the laptop and OneDrive are shared and always shown. */
export const isOwnedKind = (kind: PlaceView['kind']): boolean => kind === 'phone' || kind === 'gdrive';

/** The devices of the person in focus, plus every shared one (drives, the laptop, OneDrive). */
export function scopeDevices<T extends Pick<PlaceView, 'kind' | 'profileId'>>(places: readonly T[], scope: ProfileScope): T[] {
  return places.filter((p) => !isOwnedKind(p.kind) || inScope(scope, p.profileId));
}

/** The backups of the person in focus (everyone's under Everyone). */
export function scopeBackups<T extends Pick<BackupRow, 'personId'>>(rows: readonly T[], scope: ProfileScope): T[] {
  return rows.filter((r) => inScope(scope, r.personId));
}

/**
 * Jobs of the person in focus. A job with no owner (a drive, the laptop, the app itself) is shared: `sharedToo` keeps those (Home's
 * "Needs you" always shows them), otherwise they appear only under Everyone (Activity).
 */
export function scopeJobs<T extends Pick<JobRecord, 'personId'>>(jobs: readonly T[], scope: ProfileScope, sharedToo: boolean): T[] {
  if (scope === 'all') return [...jobs];
  return jobs.filter((j) => (j.personId === undefined || j.personId === null ? sharedToo : j.personId === scope));
}

/** "Needs your decision" cases of the person in focus; a case that belongs to no backup (a drive) is shared and always shown. */
export function scopeDecisions<T extends Pick<DecisionCase, 'backupId'>>(cases: readonly T[], backups: readonly Pick<BackupRow, 'id' | 'personId'>[], scope: ProfileScope): T[] {
  if (scope === 'all') return [...cases];
  const mine = new Set(backups.filter((b) => b.personId === scope).map((b) => b.id));
  return cases.filter((c) => c.backupId === null || mine.has(c.backupId));
}

/** The name shown for a scope ("Everyone" or the person's name). */
export function scopeLabel(scope: ProfileScope, people: readonly Pick<ProfileView, 'id' | 'name'>[]): string {
  return scope === 'all' ? EVERYONE_WORD : (people.find((p) => p.id === scope)?.name ?? EVERYONE_WORD);
}

/** What the search asks main for: the person's id, or null for everyone. */
export const searchPerson = (scope: ProfileScope): number | null => scopeToSetting(scope);
