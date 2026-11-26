import type { Db } from '../db/connection';

export interface CachedCount<T> {
  /** The data version the count was made at. */
  version: number;
  /** When it was counted (epoch ms). */
  at: number;
  data: T;
}

/** The last result of each heavy count, kept in the database so the next start can show it at once. */
export class CountCache {
  constructor(private readonly db: Db) {}

  /** Null when nothing is saved under `key` or what is saved cannot be read (it is then simply counted again). */
  load<T>(key: string): CachedCount<T> | null {
    try {
      const row = this.db.prepare('SELECT data_version, counted_at, json FROM count_cache WHERE key = ?').get(key) as
        | { data_version: number; counted_at: number; json: string }
        | undefined;
      if (!row) return null;
      return { version: row.data_version, at: row.counted_at, data: JSON.parse(row.json) as T };
    } catch {
      return null;
    }
  }

  save(key: string, entry: CachedCount<unknown>): void {
    this.db
      .prepare(
        `INSERT INTO count_cache (key, data_version, counted_at, json) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET data_version = excluded.data_version, counted_at = excluded.counted_at, json = excluded.json`,
      )
      .run(key, entry.version, entry.at, JSON.stringify(entry.data));
  }
}
