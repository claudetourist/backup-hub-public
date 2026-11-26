import type { Db } from '../db';
import { isReminderDays, type ReminderDays } from '../../shared/insights';

/** Kept in `meta` (not `settings`: that table is read whole and typed). One small JSON object: backup id -> days. */
const META_KEY = 'insights.reminderDays';

export class ReminderStore {
  constructor(private readonly db: Db) {}

  get(): ReminderDays {
    const text = this.db.prepare('SELECT value FROM meta WHERE key = ?').pluck().get(META_KEY) as string | undefined;
    if (text === undefined) return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: ReminderDays = {};
      for (const [id, days] of Object.entries(parsed)) if (/^\d+$/.test(id) && isReminderDays(days)) out[id] = days;
      return out;
    } catch {
      return {};
    }
  }

  /** days = null puts the backup back on the default. Returns the new list, or null when the number is not allowed. */
  set(backupId: number, days: number | null): ReminderDays | null {
    if (days !== null && !isReminderDays(days)) return null;
    const next = this.get();
    if (days === null) delete next[String(backupId)];
    else next[String(backupId)] = days;
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(META_KEY, JSON.stringify(next));
    return next;
  }
}
