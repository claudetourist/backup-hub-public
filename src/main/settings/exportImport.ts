import fs from 'node:fs';
import { checkLabel, type PlaceKind } from '../../shared/places';
import { SETTING_KEYS, validSettingValue, type AppSettings, type SettingKey } from '../../shared/settings';
import type { Db } from '../db';
import { assertWritable } from '../fsutil';
import { PROFILE_COLORS } from '../profiles/profileService';
import type { SettingsStore } from './settingsStore';

export const EXPORT_FORMAT = 'backuphub-settings';
export const EXPORT_VERSION = 1;
/** Import refuses files larger than this (a settings file is a few KB). */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

const PLACE_KINDS: ReadonlySet<string> = new Set(['laptop', 'drive', 'phone', 'gdrive', 'onedrive']);

export interface ExportedPlace {
  id: string;
  kind: PlaceKind;
  label: string;
  /** Name of the owning profile. */
  profile: string;
  rootHint: string | null;
  /** Non-secret identity details (drive serial, size). Never a key, token or password. */
  identity: Record<string, unknown>;
}

export interface SettingsExport {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  appVersion: string;
  settings: Partial<AppSettings>;
  profiles: { name: string; color: string }[];
  places: ExportedPlace[];
}

/**
 * Build the export. It reads `profiles`, `places` and `settings` only: the `secrets` table, the
 * `meta` table (which holds the vault's key material) and every file are never read.
 */
export function buildExport(db: Db, settings: SettingsStore, appVersion: string, now: Date = new Date()): SettingsExport {
  const profiles = db.prepare('SELECT name, color FROM profiles ORDER BY id').all() as { name: string; color: string }[];
  const rows = db
    .prepare(
      `SELECT p.id, p.kind, p.label, p.identity_json, p.root_hint, pr.name AS profile
       FROM places p JOIN profiles pr ON pr.id = p.profile_id ORDER BY p.created_at, p.label`,
    )
    .all() as { id: string; kind: PlaceKind; label: string; identity_json: string; root_hint: string | null; profile: string }[];
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    appVersion,
    settings: settings.get(),
    profiles,
    places: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      profile: r.profile,
      rootHint: r.root_hint,
      identity: parseObject(r.identity_json),
    })),
  };
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export type ParsedExport = { ok: true; data: SettingsExport } | { ok: false; message: string };

/** Check a settings file's text. Unknown keys are ignored; anything malformed is reported in plain words. */
export function parseExport(text: string): ParsedExport {
  if (text.length > MAX_IMPORT_BYTES) return { ok: false, message: 'That file is too large to be a Backup Hub settings file.' };
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { ok: false, message: 'That file is not a Backup Hub settings file (it is not readable JSON).' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'That file is not a Backup Hub settings file.' };
  const o = raw as Record<string, unknown>;
  if (o['format'] !== EXPORT_FORMAT) return { ok: false, message: 'That file is not a Backup Hub settings file.' };
  if (typeof o['version'] !== 'number' || o['version'] > EXPORT_VERSION) {
    return { ok: false, message: 'That settings file is from a newer version of Backup Hub. Update the app first.' };
  }

  const settings: Partial<AppSettings> = {};
  const rawSettings = o['settings'];
  if (rawSettings !== null && typeof rawSettings === 'object' && !Array.isArray(rawSettings)) {
    for (const key of SETTING_KEYS) {
      // Which person is in focus is a number of this computer's database: it means nothing in another one.
      if (key === 'activePerson') continue;
      // Uploading to Google starts only from a choice made in Settings on this computer, never from a file.
      if (key === 'recoveryToGoogle' || key === 'recoveryGoogleAccount') continue;
      // Write protection is only ever changed by hand in Settings on this computer; a file cannot lift it.
      if (key === 'writeProtectedDrives') continue;
      // Offering the files in the C: user folders for clean-up is switched on by hand on this computer only.
      if (key === 'duplicatesInUserFolders') continue;
      const value = validSettingValue(key, (rawSettings as Record<string, unknown>)[key]);
      if (value !== undefined) (settings[key] as AppSettings[SettingKey]) = value;
    }
  }

  const profiles: { name: string; color: string }[] = [];
  if (Array.isArray(o['profiles'])) {
    for (const p of o['profiles'] as unknown[]) {
      if (p === null || typeof p !== 'object') continue;
      const name = checkLabel((p as Record<string, unknown>)['name'], 'profile name');
      const color = (p as Record<string, unknown>)['color'];
      if (name.ok) profiles.push({ name: name.value, color: typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color) ? color : PROFILE_COLORS[0]! });
    }
  }

  const places: ExportedPlace[] = [];
  if (Array.isArray(o['places'])) {
    for (const p of o['places'] as unknown[]) {
      if (p === null || typeof p !== 'object') continue;
      const r = p as Record<string, unknown>;
      const label = checkLabel(r['label'], 'name');
      const profile = checkLabel(r['profile'], 'profile name');
      if (typeof r['id'] !== 'string' || r['id'] === '' || r['id'].length > 80) continue;
      if (!PLACE_KINDS.has(r['kind'] as string) || !label.ok || !profile.ok) continue;
      places.push({
        id: r['id'],
        kind: r['kind'] as PlaceKind,
        label: label.value,
        profile: profile.value,
        rootHint: typeof r['rootHint'] === 'string' ? r['rootHint'].slice(0, 10) : null,
        identity: r['identity'] !== null && typeof r['identity'] === 'object' && !Array.isArray(r['identity']) ? (r['identity'] as Record<string, unknown>) : {},
      });
    }
  }

  return {
    ok: true,
    data: {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: typeof o['exportedAt'] === 'string' ? o['exportedAt'] : '',
      appVersion: typeof o['appVersion'] === 'string' ? o['appVersion'] : '',
      settings,
      profiles,
      places,
    },
  };
}

export interface ImportSummary {
  settingsApplied: number;
  profilesAdded: number;
  placesAdded: number;
  placesSkipped: number;
}

/**
 * Apply a parsed settings file. Only ADDS and changes settings: existing profiles and places are
 * never overwritten or removed (a place with an id we already have is skipped). Imported places
 * start as "unknown" until they are seen again. Runs in one transaction.
 */
export function applyImport(db: Db, settings: SettingsStore, data: SettingsExport, now: number = Date.now()): ImportSummary {
  const summary: ImportSummary = { settingsApplied: 0, profilesAdded: 0, placesAdded: 0, placesSkipped: 0 };
  const run = db.transaction(() => {
    const profileId = (name: string, color: string): number => {
      const found = db.prepare('SELECT id FROM profiles WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined;
      if (found) return found.id;
      const info = db.prepare('INSERT INTO profiles (name, color, created_at) VALUES (?, ?, ?)').run(name, color, now);
      summary.profilesAdded += 1;
      return Number(info.lastInsertRowid);
    };
    for (const p of data.profiles) profileId(p.name, p.color);
    for (const place of data.places) {
      if (db.prepare('SELECT 1 FROM places WHERE id = ?').get(place.id)) {
        summary.placesSkipped += 1;
        continue;
      }
      const owner = profileId(place.profile, PROFILE_COLORS[0]!);
      db.prepare(
        `INSERT INTO places (id, profile_id, kind, label, identity_json, root_hint, last_looked_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, 'unknown', ?)`,
      ).run(place.id, owner, place.kind, place.label, JSON.stringify(place.identity), place.rootHint, now);
      summary.placesAdded += 1;
    }
    for (const key of SETTING_KEYS) {
      if (key === 'activePerson') continue;
      const value = data.settings[key];
      if (value === undefined) continue;
      if (settings.set(key, value).ok) summary.settingsApplied += 1;
    }
  });
  run();
  return summary;
}

/**
 * Writes the settings file the person chose. The T7 write ban is checked first, so a protected drive is refused before anything is
 * created (`DriveWriteProtectedError`). Returns the numbers for the message.
 */
export function writeSettingsExport(file: string, db: Db, settings: SettingsStore, appVersion: string, now: Date = new Date()): { profiles: number; places: number } {
  assertWritable(file);
  const data = buildExport(db, settings, appVersion, now);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}
`, 'utf8');
  return { profiles: data.profiles.length, places: data.places.length };
}
