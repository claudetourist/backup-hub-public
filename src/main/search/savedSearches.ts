import { defaultSavedName, MAX_SAVED_NAME, MAX_SAVED_SEARCHES, savedRequestOf, toSearchRequest, type SavedSearch, type SavedSearchResult } from '../../shared/search';
import type { Db } from '../db/connection';

/**
 * The searches saved on the Files screen (table saved_searches, migration 0026). A few rows at most (MAX_SAVED_SEARCHES), so it reads and
 * writes on the main thread. It keeps the request without its page; whatever the window sends is cleaned by toSearchRequest first.
 */
export class SavedSearches {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  list(): SavedSearch[] {
    const rows = this.db.prepare('SELECT id, name, request, created_at FROM saved_searches ORDER BY name COLLATE NOCASE, id LIMIT ?').all(MAX_SAVED_SEARCHES) as {
      id: number;
      name: string;
      request: string;
      created_at: number;
    }[];
    return rows.flatMap((r) => {
      try {
        return [{ id: r.id, name: r.name, request: savedRequestOf(toSearchRequest(JSON.parse(r.request))), createdAt: r.created_at }];
      } catch {
        return [];
      }
    });
  }

  /** Saves the search under the name (a name already used is replaced). */
  save(name: string, request: unknown): SavedSearchResult {
    const clean = savedRequestOf(toSearchRequest(request));
    const title = name.trim().slice(0, MAX_SAVED_NAME) || defaultSavedName(clean);
    const existing = this.db.prepare('SELECT id FROM saved_searches WHERE name = ? COLLATE NOCASE').pluck().get(title) as number | undefined;
    if (existing === undefined) {
      const count = this.db.prepare('SELECT count(*) FROM saved_searches').pluck().get() as number;
      if (count >= MAX_SAVED_SEARCHES) return { ok: false, message: `You can keep ${MAX_SAVED_SEARCHES} saved searches. Remove one first.` };
      this.db.prepare('INSERT INTO saved_searches (profile_id, name, request, created_at) VALUES (NULL, ?, ?, ?)').run(title, JSON.stringify(clean), this.now());
    } else {
      this.db.prepare('UPDATE saved_searches SET request = ?, created_at = ? WHERE id = ?').run(JSON.stringify(clean), this.now(), existing);
    }
    return { ok: true, saved: this.list() };
  }

  remove(id: number): SavedSearchResult {
    this.db.prepare('DELETE FROM saved_searches WHERE id = ?').run(id);
    return { ok: true, saved: this.list() };
  }
}
