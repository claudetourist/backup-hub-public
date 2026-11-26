import {
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  validSettingValue,
  type AppSettings,
  type SettingKey,
  type SettingResult,
} from '../../shared/settings';
import { defaultAppDataSources } from '../../shared/plans';
import type { Db } from '../db';

/** Typed access to the `settings` table. Values are stored as JSON text; bad or missing values fall back to defaults. */
export class SettingsStore {
  private readonly listeners = new Set<(settings: AppSettings) => void>();

  constructor(private readonly db: Db) {}

  get(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string | null }[];
    const out: AppSettings = { ...DEFAULT_SETTINGS, writeProtectedDrives: [...DEFAULT_SETTINGS.writeProtectedDrives], skipFolders: [...DEFAULT_SETTINGS.skipFolders], appDataSources: defaultAppDataSources() };
    for (const row of rows) {
      if (!(SETTING_KEYS as readonly string[]).includes(row.key) || row.value === null) continue;
      try {
        const key = row.key as SettingKey;
        const value = validSettingValue(key, JSON.parse(row.value));
        if (value !== undefined) Object.assign(out, { [key]: value });
      } catch {
        // Unreadable value: keep the default.
      }
    }
    return out;
  }

  set(key: unknown, value: unknown): SettingResult {
    if (typeof key !== 'string' || !(SETTING_KEYS as readonly string[]).includes(key)) {
      return { ok: false, message: 'That setting does not exist.' };
    }
    const typedKey = key as SettingKey;
    const valid = validSettingValue(typedKey, value);
    if (valid === undefined) return { ok: false, message: 'That value is not allowed for this setting.' };
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(typedKey, JSON.stringify(valid));
    const settings = this.get();
    for (const listener of this.listeners) listener(settings);
    return { ok: true, settings };
  }

  onChanged(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
