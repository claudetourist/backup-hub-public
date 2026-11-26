import { randomUUID } from 'node:crypto';
import { checkLabel } from '../../shared/places';
import type { Db } from '../db';
import { filtersJson, mergeFilters, parseFilters, type Filters } from './filters';
import { cleanRoot } from './pathForms';
import { RulesStore } from '../rules/rulesStore';

/**
 * Backup profiles: the rows of `backup_profiles`, `backup_destinations` and `backup_exclusions`, and nothing else. This is the only
 * writer of those three tables. Everything here is editable later from the app. Removing a profile never touches `files` rows.
 * A Person is a row of `profiles`; a backup profile is one backup.
 */
export type SourceKind = 'phone' | 'folder';
export type ChangeRule = 'size_and_date' | 'size_or_date';
export type DestinationRole = 'primary' | 'copy';

/** Phones: size AND date must differ (phone dates wobble). Folders: size OR date differs. */
export const changeRuleFor = (kind: SourceKind): ChangeRule => (kind === 'phone' ? 'size_and_date' : 'size_or_date');

export interface BackupProfile {
  id: number;
  personId: number;
  name: string;
  sourceKind: SourceKind;
  /** The phone place of a phone profile (made when first needed), else null. */
  sourcePlaceId: string | null;
  /** A folder profile: the Windows folder it backs up (as PhoneBackup stored it). A phone profile: ''. */
  sourceRoot: string;
  phoneSerial: string | null;
  folderPrefix: string;
  changeRule: ChangeRule;
  filters: Filters;
  enabled: boolean;
  /** The key the profile had in PhoneBackup's config.json (for example 'poco'), else null. */
  importKey: string | null;
  createdAt: number;
  /** When the backup was taken off the list ("Remove from list"), or null. Nothing else about it changes. */
  archivedAt: number | null;
}

export interface BackupDestination {
  id: number;
  backupProfileId: number;
  placeId: string;
  /** Folder below the drive, forward slashes ('MyData/POCO'). Never a drive letter. */
  root: string;
  role: DestinationRole;
  enabled: boolean;
}

export interface BackupExclusion {
  backupProfileId: number;
  sourcePath: string;
  addedAt: number;
}

export type StoreResult<T extends object = object> = ({ ok: true } & T) | { ok: false; message: string };

export interface NewBackupProfile {
  /** The Person it belongs to; the first Person when left out. */
  personId?: number | undefined;
  name: string;
  sourceKind: SourceKind;
  sourceRoot?: string | undefined;
  sourcePlaceId?: string | null | undefined;
  phoneSerial?: string | null | undefined;
  folderPrefix: string;
  changeRule?: ChangeRule | undefined;
  filters?: Partial<Filters> | undefined;
  enabled?: boolean | undefined;
  importKey?: string | null | undefined;
}

export type BackupProfilePatch = Partial<Omit<NewBackupProfile, 'sourceKind' | 'importKey'>>;

interface ProfileRow {
  id: number;
  person_id: number;
  name: string;
  source_kind: SourceKind;
  source_place_id: string | null;
  source_root: string;
  phone_serial: string | null;
  folder_prefix: string;
  change_rule: ChangeRule;
  filters_json: string;
  enabled: number;
  import_key: string | null;
  created_at: number;
  archived_at: number | null;
}

const PROFILE_COLUMNS = 'id, person_id, name, source_kind, source_place_id, source_root, phone_serial, folder_prefix, change_rule, filters_json, enabled, import_key, created_at, archived_at';

const toProfile = (r: ProfileRow): BackupProfile => ({
  id: r.id,
  personId: r.person_id,
  name: r.name,
  sourceKind: r.source_kind,
  sourcePlaceId: r.source_place_id,
  sourceRoot: r.source_root,
  phoneSerial: r.phone_serial,
  folderPrefix: r.folder_prefix,
  changeRule: r.change_rule,
  filters: parseFilters(r.filters_json),
  enabled: r.enabled === 1,
  importKey: r.import_key,
  createdAt: r.created_at,
  archivedAt: r.archived_at,
});

interface DestinationRow {
  id: number;
  backup_profile_id: number;
  place_id: string;
  root: string;
  role: DestinationRole;
  enabled: number;
}

const DESTINATION_COLUMNS = 'id, backup_profile_id, place_id, root, role, enabled';

const toDestination = (r: DestinationRow): BackupDestination => ({
  id: r.id,
  backupProfileId: r.backup_profile_id,
  placeId: r.place_id,
  root: r.root,
  role: r.role,
  enabled: r.enabled === 1,
});

const cleanSerial = (raw: string | null | undefined): string | null => {
  const s = (raw ?? '').trim();
  return s === '' ? null : s;
};

const cleanSourceRoot = (raw: string | undefined): string => (raw ?? '').trim().replace(/[\\/]+$/, '');

const BAD_ROOT = 'The backup folder must be a folder on the drive, such as MyData/POCO (no drive letter).';

export class BackupProfileStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    private readonly uuid: () => string = randomUUID,
  ) {}

  // ---- Profiles ----------------------------------------------------------------------------

  /** The Person that owns new profiles when none is given: the first one. */
  defaultPersonId(): number {
    const id = this.db.prepare('SELECT id FROM profiles ORDER BY id LIMIT 1').pluck().get() as number | undefined;
    if (id === undefined) throw new Error('There is no person to own the backup');
    return id;
  }

  /** The backups on the list. `archived`: 'hide' (default) leaves out the ones taken off the list, 'only' returns just those, 'all' both. */
  list(options: { includeDisabled?: boolean; archived?: 'hide' | 'only' | 'all' } = {}): BackupProfile[] {
    const conditions: string[] = [];
    if (options.includeDisabled === false) conditions.push('enabled = 1');
    const archived = options.archived ?? 'hide';
    if (archived === 'hide') conditions.push('archived_at IS NULL');
    else if (archived === 'only') conditions.push('archived_at IS NOT NULL');
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return (this.db.prepare(`SELECT ${PROFILE_COLUMNS} FROM backup_profiles ${where} ORDER BY id`).all() as ProfileRow[]).map(toProfile);
  }

  /**
   * "Remove from list": takes a backup that is switched off off the list. Nothing is deleted anywhere (no file row, run, history import, folder or
   * exclusion; no file on any drive). Reversible with unarchive.
   */
  archive(id: number): StoreResult {
    const profile = this.get(id);
    if (!profile) return { ok: false, message: 'That backup does not exist.' };
    if (profile.archivedAt !== null) return { ok: true };
    if (profile.enabled) return { ok: false, message: 'Only a backup that is switched off can be removed from the list.' };
    this.db.prepare('UPDATE backup_profiles SET archived_at = ? WHERE id = ?').run(this.now(), id);
    return { ok: true };
  }

  /** "Put back": the backup is on the list again, switched off as it was. */
  unarchive(id: number): StoreResult {
    if (!this.get(id)) return { ok: false, message: 'That backup does not exist.' };
    this.db.prepare('UPDATE backup_profiles SET archived_at = NULL WHERE id = ?').run(id);
    return { ok: true };
  }

  get(id: number): BackupProfile | null {
    const row = this.db.prepare(`SELECT ${PROFILE_COLUMNS} FROM backup_profiles WHERE id = ?`).get(id) as ProfileRow | undefined;
    return row ? toProfile(row) : null;
  }

  getByImportKey(key: string): BackupProfile | null {
    const row = this.db.prepare(`SELECT ${PROFILE_COLUMNS} FROM backup_profiles WHERE import_key = ?`).get(key) as ProfileRow | undefined;
    return row ? toProfile(row) : null;
  }

  create(input: NewBackupProfile): StoreResult<{ id: number }> {
    const name = checkLabel(input.name, 'backup name');
    if (!name.ok) return { ok: false, message: name.message };
    const prefix = checkLabel(input.folderPrefix, 'folder name prefix');
    if (!prefix.ok) return { ok: false, message: prefix.message };
    if (input.sourceKind !== 'phone' && input.sourceKind !== 'folder') return { ok: false, message: 'A backup is either of a phone or of a folder.' };
    const sourceRoot = input.sourceKind === 'folder' ? cleanSourceRoot(input.sourceRoot) : '';
    if (input.sourceKind === 'folder' && sourceRoot === '') return { ok: false, message: 'Choose the folder to back up.' };
    const personId = input.personId ?? this.defaultPersonId();
    if (!this.db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(personId)) return { ok: false, message: 'That person does not exist.' };
    if (this.db.prepare('SELECT 1 FROM backup_profiles WHERE person_id = ? AND name = ? COLLATE NOCASE').get(personId, name.value)) {
      return { ok: false, message: `There is already a backup called ${name.value}.` };
    }
    const serial = input.sourceKind === 'phone' ? cleanSerial(input.phoneSerial) : null;
    if (serial !== null && this.db.prepare('SELECT 1 FROM backup_profiles WHERE phone_serial = ?').get(serial)) {
      return { ok: false, message: 'That phone already has its own backup.' };
    }
    const info = this.db
      .prepare(
        `INSERT INTO backup_profiles (person_id, name, source_kind, source_place_id, source_root, phone_serial, folder_prefix, change_rule, filters_json, enabled, import_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        personId,
        name.value,
        input.sourceKind,
        input.sourcePlaceId ?? null,
        sourceRoot,
        serial,
        prefix.value,
        input.changeRule ?? changeRuleFor(input.sourceKind),
        filtersJson(mergeFilters(input.filters)),
        input.enabled === false ? 0 : 1,
        input.importKey ?? null,
        this.now(),
      );
    return { ok: true, id: Number(info.lastInsertRowid) };
  }

  update(id: number, patch: BackupProfilePatch): StoreResult {
    const current = this.get(id);
    if (!current) return { ok: false, message: 'That backup does not exist.' };
    const personId = patch.personId ?? current.personId;
    let name = current.name;
    const sets: string[] = [];
    const params: Record<string, string | number | null> = { id };
    if (patch.name !== undefined) {
      const checked = checkLabel(patch.name, 'backup name');
      if (!checked.ok) return { ok: false, message: checked.message };
      name = checked.value;
      sets.push('name = @name');
      params['name'] = name;
    }
    if (patch.personId !== undefined) {
      if (!this.db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(patch.personId)) return { ok: false, message: 'That person does not exist.' };
      sets.push('person_id = @personId');
      params['personId'] = patch.personId;
    }
    if ((patch.name !== undefined || patch.personId !== undefined) && this.db.prepare('SELECT 1 FROM backup_profiles WHERE person_id = ? AND name = ? COLLATE NOCASE AND id <> ?').get(personId, name, id)) {
      return { ok: false, message: `There is already a backup called ${name}.` };
    }
    if (patch.folderPrefix !== undefined) {
      const prefix = checkLabel(patch.folderPrefix, 'folder name prefix');
      if (!prefix.ok) return { ok: false, message: prefix.message };
      sets.push('folder_prefix = @prefix');
      params['prefix'] = prefix.value;
    }
    if (patch.changeRule !== undefined) {
      if (patch.changeRule !== 'size_and_date' && patch.changeRule !== 'size_or_date') return { ok: false, message: 'Unknown rule for changed files.' };
      sets.push('change_rule = @rule');
      params['rule'] = patch.changeRule;
    }
    if (patch.filters !== undefined) {
      sets.push('filters_json = @filters');
      params['filters'] = filtersJson(mergeFilters({ ...current.filters, ...patch.filters }));
    }
    if (patch.enabled !== undefined) {
      sets.push('enabled = @enabled');
      params['enabled'] = patch.enabled ? 1 : 0;
    }
    if (patch.sourceRoot !== undefined) {
      const root = current.sourceKind === 'folder' ? cleanSourceRoot(patch.sourceRoot) : '';
      if (current.sourceKind === 'folder' && root === '') return { ok: false, message: 'Choose the folder to back up.' };
      sets.push('source_root = @root');
      params['root'] = root;
    }
    if (patch.sourcePlaceId !== undefined) {
      sets.push('source_place_id = @placeId');
      params['placeId'] = patch.sourcePlaceId;
    }
    if (patch.phoneSerial !== undefined) {
      if (current.sourceKind !== 'phone') return { ok: false, message: 'Only a phone backup has a phone.' };
      const serial = cleanSerial(patch.phoneSerial);
      if (serial !== null && this.db.prepare('SELECT 1 FROM backup_profiles WHERE phone_serial = ? AND id <> ?').get(serial, id)) {
        return { ok: false, message: 'That phone already has its own backup.' };
      }
      sets.push('phone_serial = @serial');
      params['serial'] = serial;
    }
    if (sets.length > 0) this.db.prepare(`UPDATE backup_profiles SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return { ok: true };
  }

  /**
   * Take a backup away. A backup that was never run and never had a history imported is deleted (with its folders and exclusions);
   * any other is only switched off, so its runs and imports keep a home. File rows are never touched either way.
   */
  remove(id: number): StoreResult<{ how: 'deleted' | 'disabled' }> {
    if (!this.get(id)) return { ok: false, message: 'That backup does not exist.' };
    const used =
      this.db.prepare('SELECT 1 FROM backup_runs WHERE backup_profile_id = ? LIMIT 1').get(id) !== undefined ||
      this.db.prepare('SELECT 1 FROM ledger_imports WHERE backup_profile_id = ? LIMIT 1').get(id) !== undefined;
    if (used) {
      this.db.prepare('UPDATE backup_profiles SET enabled = 0 WHERE id = ?').run(id);
      return { ok: true, how: 'disabled' };
    }
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM backup_destinations WHERE backup_profile_id = ?').run(id);
      this.db.prepare('DELETE FROM backup_exclusions WHERE backup_profile_id = ?').run(id);
      new RulesStore(this.db, this.now).removeAllFor(id);
      this.db.prepare('DELETE FROM backup_profiles WHERE id = ?').run(id);
    })();
    return { ok: true, how: 'deleted' };
  }

  // ---- Backup folders on drives ------------------------------------------------------------

  destinations(profileId: number): BackupDestination[] {
    return (this.db.prepare(`SELECT ${DESTINATION_COLUMNS} FROM backup_destinations WHERE backup_profile_id = ? ORDER BY id`).all(profileId) as DestinationRow[]).map(toDestination);
  }

  destination(id: number): BackupDestination | null {
    const row = this.db.prepare(`SELECT ${DESTINATION_COLUMNS} FROM backup_destinations WHERE id = ?`).get(id) as DestinationRow | undefined;
    return row ? toDestination(row) : null;
  }

  addDestination(input: { profileId: number; placeId: string; root: string; role?: DestinationRole; enabled?: boolean; /** 1 = copied from the source, 2 = mirrored from 1 (R1.3). Default 1. */ position?: number }): StoreResult<{ id: number }> {
    if (!this.get(input.profileId)) return { ok: false, message: 'That backup does not exist.' };
    const place = this.db.prepare('SELECT kind FROM places WHERE id = ?').get(input.placeId) as { kind: string } | undefined;
    if (!place) return { ok: false, message: 'That place does not exist.' };
    if (place.kind === 'phone') return { ok: false, message: 'A phone cannot hold a backup.' };
    const root = cleanRoot(input.root);
    if (root === null) return { ok: false, message: BAD_ROOT };
    if (this.db.prepare('SELECT 1 FROM backup_destinations WHERE backup_profile_id = ? AND place_id = ? AND root = ? COLLATE NOCASE').get(input.profileId, input.placeId, root)) {
      return { ok: false, message: 'That backup already goes there.' };
    }
    const info = this.db
      .prepare('INSERT INTO backup_destinations (backup_profile_id, place_id, root, role, enabled, position) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.profileId, input.placeId, root, input.role ?? 'primary', input.enabled === false ? 0 : 1, input.position ?? 1);
    return { ok: true, id: Number(info.lastInsertRowid) };
  }

  updateDestination(id: number, patch: { root?: string; role?: DestinationRole; enabled?: boolean }): StoreResult {
    const current = this.destination(id);
    if (!current) return { ok: false, message: 'That backup folder does not exist.' };
    let root = current.root;
    if (patch.root !== undefined) {
      const cleaned = cleanRoot(patch.root);
      if (cleaned === null) return { ok: false, message: BAD_ROOT };
      root = cleaned;
      if (this.db.prepare('SELECT 1 FROM backup_destinations WHERE backup_profile_id = ? AND place_id = ? AND root = ? COLLATE NOCASE AND id <> ?').get(current.backupProfileId, current.placeId, root, id)) {
        return { ok: false, message: 'That backup already goes there.' };
      }
    }
    if (patch.role !== undefined && patch.role !== 'primary' && patch.role !== 'copy') return { ok: false, message: 'Unknown role.' };
    this.db
      .prepare('UPDATE backup_destinations SET root = ?, role = ?, enabled = ? WHERE id = ?')
      .run(root, patch.role ?? current.role, (patch.enabled ?? current.enabled) ? 1 : 0, id);
    return { ok: true };
  }

  removeDestination(id: number): StoreResult {
    const info = this.db.prepare('DELETE FROM backup_destinations WHERE id = ?').run(id);
    return info.changes === 1 ? { ok: true } : { ok: false, message: 'That backup folder does not exist.' };
  }

  // ---- Exclusions ("never back up this file again") ----------------------------------------

  exclusions(profileId: number): BackupExclusion[] {
    const rows = this.db.prepare('SELECT backup_profile_id, source_path, added_at FROM backup_exclusions WHERE backup_profile_id = ? ORDER BY source_path').all(profileId) as {
      backup_profile_id: number;
      source_path: string;
      added_at: number;
    }[];
    return rows.map((r) => ({ backupProfileId: r.backup_profile_id, sourcePath: r.source_path, addedAt: r.added_at }));
  }

  /** Adds one path; a path already excluded is left as it is (`added: false`). */
  addExclusion(profileId: number, sourcePath: string, addedAt: number = this.now()): StoreResult<{ added: boolean }> {
    if (!this.get(profileId)) return { ok: false, message: 'That backup does not exist.' };
    const path = sourcePath.trim();
    if (path === '') return { ok: false, message: 'Choose the file to leave out.' };
    const info = this.db.prepare('INSERT OR IGNORE INTO backup_exclusions (backup_profile_id, source_path, added_at) VALUES (?, ?, ?)').run(profileId, path, addedAt);
    // The plan reads the person's choices only (backup_rules); keep one there for every old-style exclusion too.
    new RulesStore(this.db, this.now).addLegacyFile(profileId, path, addedAt);
    return { ok: true, added: info.changes === 1 };
  }

  removeExclusion(profileId: number, sourcePath: string): StoreResult {
    const info = this.db.prepare('DELETE FROM backup_exclusions WHERE backup_profile_id = ? AND source_path = ?').run(profileId, sourcePath);
    if (info.changes === 1) new RulesStore(this.db, this.now).removeLegacyFile(profileId, sourcePath);
    return info.changes === 1 ? { ok: true } : { ok: false, message: 'That file is not on the list.' };
  }

  // ---- The phone place of a phone backup ---------------------------------------------------

  /**
   * The ONE place of kind 'phone' of a phone backup: found through `source_place_id`, else made (not connected, owned by the
   * backup's Person) and remembered there. The serial goes into `identity_json` when it is known. Null for a folder backup.
   */
  ensurePhonePlace(profileId: number): string | null {
    const profile = this.get(profileId);
    if (!profile || profile.sourceKind !== 'phone') return null;
    return this.db.transaction(() => {
      const existing = profile.sourcePlaceId
        ? (this.db.prepare("SELECT id, identity_json FROM places WHERE id = ? AND kind = 'phone'").get(profile.sourcePlaceId) as { id: string; identity_json: string } | undefined)
        : undefined;
      if (existing) {
        if (profile.phoneSerial !== null) {
          const identity = safeObject(existing.identity_json);
          if (identity['serial'] !== profile.phoneSerial) this.db.prepare('UPDATE places SET identity_json = ? WHERE id = ?').run(JSON.stringify({ ...identity, serial: profile.phoneSerial }), existing.id);
        }
        return existing.id;
      }
      const placeId = this.uuid();
      const identity: Record<string, unknown> = { backupProfileId: profile.id };
      if (profile.importKey !== null) identity['importKey'] = profile.importKey;
      if (profile.phoneSerial !== null) identity['serial'] = profile.phoneSerial;
      this.db
        .prepare(
          `INSERT INTO places (id, profile_id, kind, label, identity_json, root_hint, last_looked_at, status, created_at)
           VALUES (?, ?, 'phone', ?, ?, NULL, NULL, 'disconnected', ?)`,
        )
        .run(placeId, profile.personId, profile.name, JSON.stringify(identity), this.now());
      this.db.prepare('UPDATE backup_profiles SET source_place_id = ? WHERE id = ?').run(placeId, profile.id);
      return placeId;
    })();
  }
}

function safeObject(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
