/**
 * Dev only: people for the sample screens. Three people (You, Mom, Sam), backups and devices that belong to them, and the calls that
 * change them, so the person switcher, the "Belongs to" chips, Settings > People and the new phone form can be clicked through in a
 * plain browser. Nothing here touches real data.
 */
import type { BackupRow } from '../../shared/backups';
import type { JobRecord } from '../../shared/jobs';
import { ownerChangedText, paletteColor, PERSON_COLORS, removeBlockedMessage, type OwnerResult } from '../../shared/people';
import type { PlacesSnapshot } from '../../shared/places';
import type { ProfileResult, ProfileView } from '../../shared/settings';
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/settings';
import type { SearchHit, SearchRequest } from '../../shared/search';
import type { CreatePhoneBackupRequest, CreatePhoneBackupResult } from '../../shared/phoneBackup';

export interface MockPeople {
  handlers: Record<string, unknown>;
  /** Backups with their current owners. */
  backups: (base: readonly BackupRow[]) => BackupRow[];
  /** Jobs with the owner each belongs to. */
  jobs: (jobs: readonly JobRecord[]) => JobRecord[];
  /** The search hits of the person asked for (null = everyone). */
  scopeHits: (hits: SearchHit[], person: SearchRequest['person']) => SearchHit[];
}

const ONE_PHONE_BACKUP = 1;

/** Which backup folder a drive path sits under, so a hit can be given to the person who owns that backup. */
const BACKUP_FOLDERS: readonly { backupId: number; placeId: string; prefix: string }[] = [
  { backupId: 1, placeId: 't7', prefix: 'MyData/POCO/' },
  { backupId: 2, placeId: 't7', prefix: 'MyData/OneDriveBackup/' },
  { backupId: 4, placeId: 't7', prefix: 'MyData/Sam phone/' },
];

export function createPeopleMock(places: PlacesSnapshot, notifyPlaces: () => void, notifySettings: () => void): MockPeople & { settings: () => AppSettings } {
  const people: ProfileView[] = [
    { id: 1, name: 'You', color: PERSON_COLORS[0]!, createdAt: 1, placeCount: 0, backups: 0, phones: 0, accounts: 0, isFirst: true },
    { id: 2, name: 'Mom', color: PERSON_COLORS[1]!, createdAt: 2, placeCount: 0, backups: 0, phones: 0, accounts: 0, isFirst: false },
    { id: 3, name: 'Sam', color: PERSON_COLORS[4]!, createdAt: 3, placeCount: 0, backups: 0, phones: 0, accounts: 0, isFirst: false },
  ];
  // Owners of the sample backups (id -> person) and the extra backup of Sam's phone.
  const owners = new Map<number, number>([
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 3],
  ]);
  const extraBackups: BackupRow[] = [
    { id: 4, personId: 3, name: 'Sam phone', kind: 'phone', from: 'Phone', driveLabel: 'T7', folder: 'MyData/Sam phone', driveConnected: true, lastBackupAt: Date.UTC(2026, 10, 12, 12), enabled: true, lastRunFailed: false, hubHasRun: false, phoneLinked: true, choices: 0 },
  ];
  let nextBackupId = 10;
  let settings: AppSettings = { ...DEFAULT_SETTINGS };

  // Sample devices: two Google accounts to Mom, one to Sam; Sam's and Mom's phones are added as places.
  const phone = (id: string, label: string, profileId: number): PlacesSnapshot['places'][number] => ({ ...places.places.find((p) => p.kind === 'drive')!, id, kind: 'phone', label, profileId, status: 'disconnected', files: null, fingerprint: null, canList: false, canFingerprint: false, rootHint: null, capacityBytes: null, freeBytes: null });
  places.places.push(phone('phone-poco', 'Poco F4', 1), phone('phone-sam', 'Sam phone', 3));
  places.places.forEach((p) => {
    if (p.kind === 'gdrive') p.profileId = Number(p.id.slice(1)) % 3 === 0 ? 2 : Number(p.id.slice(1)) % 3 === 1 ? 3 : 1;
  });
  const nameOf = (id: number): string => people.find((p) => p.id === id)?.name ?? '';
  const sync = (): void => {
    for (const p of places.places) p.profileName = nameOf(p.profileId);
    for (const person of people) {
      const own = places.places.filter((p) => p.profileId === person.id);
      person.placeCount = own.length;
      person.phones = own.filter((p) => p.kind === 'phone').length;
      person.accounts = own.filter((p) => p.kind === 'gdrive').length;
      person.backups = [...owners.values()].filter((o) => o === person.id).length;
    }
  };
  sync();
  const list = (): ProfileResult => ({ ok: true, profiles: people.map((p) => ({ ...p })) });

  const setBackupOwner = (backupId: number, personId: number): OwnerResult => {
    const backup = [...extraBackups].find((b) => b.id === backupId) ?? undefined;
    const name = backup?.name ?? (backupId === ONE_PHONE_BACKUP ? 'Poco F4' : backupId === 2 ? 'OneDrive Local Backup' : 'OneDrive IMP Folder');
    owners.set(backupId, personId);
    if (backupId === 4) places.places.find((p) => p.id === 'phone-sam')!.profileId = personId;
    if (backupId === 1) places.places.find((p) => p.id === 'phone-poco')!.profileId = personId;
    sync();
    notifyPlaces();
    return { ok: true, message: ownerChangedText(name, nameOf(personId)) };
  };
  const setPlaceOwner = (placeId: string, personId: number): OwnerResult => {
    const place = places.places.find((p) => p.id === placeId);
    if (!place) return { ok: false, message: 'That device no longer exists. Nothing was changed.' };
    if (place.kind !== 'phone' && place.kind !== 'gdrive') return { ok: false, message: place.label + ' is shared by everyone. Nothing was changed.' };
    place.profileId = personId;
    if (placeId === 'phone-sam') owners.set(4, personId);
    if (placeId === 'phone-poco') owners.set(1, personId);
    sync();
    notifyPlaces();
    return { ok: true, message: ownerChangedText(place.label, nameOf(personId)) };
  };

  const handlers: Record<string, unknown> = {
    'profiles.list': () => Promise.resolve(list()),
    'profiles.create': (name: string, color?: string): Promise<ProfileResult> => {
      const clean = String(name).trim();
      if (clean === '') return Promise.resolve({ ok: false, message: 'Please type a name.' });
      if (people.some((p) => p.name.toLowerCase() === clean.toLowerCase())) return Promise.resolve({ ok: false, message: `There is already someone called ${clean}.` });
      const chosen = color === undefined ? PERSON_COLORS[people.length % PERSON_COLORS.length]! : paletteColor(color);
      if (chosen === null) return Promise.resolve({ ok: false, message: 'Please pick one of the colours shown.' });
      people.push({ id: Math.max(...people.map((p) => p.id)) + 1, name: clean, color: chosen, createdAt: Date.now(), placeCount: 0, backups: 0, phones: 0, accounts: 0, isFirst: false });
      sync();
      return Promise.resolve(list());
    },
    'profiles.rename': (id: number, name: string): Promise<ProfileResult> => {
      const person = people.find((p) => p.id === id);
      if (!person) return Promise.resolve({ ok: false, message: 'That person no longer exists.' });
      person.name = String(name).trim() || person.name;
      sync();
      notifyPlaces();
      return Promise.resolve(list());
    },
    'profiles.delete': (id: number): Promise<ProfileResult> => {
      const person = people.find((p) => p.id === id);
      if (!person || person.isFirst) return Promise.resolve({ ok: false, message: 'You cannot be removed. Nothing was removed.' });
      const blocked = removeBlockedMessage(person.name, person);
      if (blocked !== null) return Promise.resolve({ ok: false, message: blocked });
      people.splice(people.indexOf(person), 1);
      return Promise.resolve(list());
    },
    'people.setBackupOwner': (backupId: number, personId: number) => Promise.resolve(setBackupOwner(backupId, personId)),
    'people.setPlaceOwner': (placeId: string, personId: number) => Promise.resolve(setPlaceOwner(placeId, personId)),
    'settings.get': () => Promise.resolve({ settings }),
    'settings.set': (key: keyof AppSettings, value: never) => {
      settings = { ...settings, [key]: value };
      notifySettings();
      return Promise.resolve({ ok: true, settings });
    },
    // The new phone form: makes the backup (and a new person when asked), in memory only.
    'backups.createPhoneBackup': (request: CreatePhoneBackupRequest): Promise<CreatePhoneBackupResult> => {
      let personId = 1;
      if (request.owner && 'id' in request.owner) personId = request.owner.id;
      else if (request.owner) {
        const made = (handlers['profiles.create'] as (n: string) => Promise<ProfileResult>)(request.owner.newName);
        return made.then((result) => {
          if (!result.ok) return { ok: false as const, message: result.message };
          const id = Math.max(...result.profiles.map((p) => p.id));
          return addBackup(request.name, id);
        });
      }
      return Promise.resolve(addBackup(request.name, personId));
    },
  };
  function addBackup(name: string, personId: number): CreatePhoneBackupResult {
    const id = nextBackupId++;
    owners.set(id, personId);
    extraBackups.push({ id, personId, name, kind: 'phone', from: 'Phone', driveLabel: 'T7', folder: 'MyData/' + name, driveConnected: true, lastBackupAt: null, enabled: true, lastRunFailed: false, hubHasRun: false, phoneLinked: true, choices: 0 });
    places.places.push({ ...phone('phone-' + id, name, personId) });
    sync();
    notifyPlaces();
    return { ok: true, backupId: id, message: `${name} is set up. Its backups go to T7\\MyData\\${name}.` };
  }

  return {
    handlers,
    settings: () => settings,
    backups: (base) => [...base, ...extraBackups].map((b) => Object.assign({}, b, { personId: owners.get(b.id) ?? 1 })),
    jobs: (jobs) =>
      jobs.map((j): JobRecord => {
        // A few sample jobs belong to people (a backup of Sam's phone, a Google account), the rest are shared.
        const person = j.kind === 'drive.refresh' ? 3 : j.id === 19 ? 3 : j.kind.startsWith('phone.') ? (owners.get(1) ?? 1) : null;
        return { ...j, personId: person };
      }),
    scopeHits: (hits, person) => {
      if (person === null) return hits;
      const mineBackup = (b: { backupId: number }): boolean => owners.get(b.backupId) === person;
      return hits.filter((h) =>
        h.copies.some((c) => {
          const place = places.places.find((p) => p.id === c.placeId);
          if (place && (place.kind === 'phone' || place.kind === 'gdrive')) return place.profileId === person;
          return BACKUP_FOLDERS.some((b) => b.placeId === c.placeId && c.relPath.startsWith(b.prefix) && mineBackup(b));
        }),
      );
    },
  };
}
