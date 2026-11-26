/**
 * Google Drive "shared with me", read only. Files other people own that were shared with a signed-in account are listed here
 * and nowhere else: their own tables (`shared_with_me`, `shared_with_me_runs`), never `files` or `drive_items`, so coverage,
 * clean-up cannot count them as a backup copy (the owner can remove them). This module only
 * asks Google for pages of a list (GET) and writes its own two tables; it cannot change, copy or delete anything in Google.
 */
import { SHARED_MAX_PAGES, SHARED_SHOWN, type SharedAccountView, type SharedItemView, type SharedLookResult, type SharedWithMeOverview } from '../../shared/sharedWithMe';
import type { Db } from '../db';
import type { DriveSharedPage } from './driveApi';

/** The one call this feature needs. Tests pass a fake; the real one is `DriveApi`. */
export interface SharedWithMeApi {
  listSharedWithMePage(placeId: string, pageToken: string | null, signal?: AbortSignal): Promise<DriveSharedPage>;
}

export interface SharedWithMeDeps {
  db: Db;
  api: SharedWithMeApi;
  now?: () => number;
  /** Called after the rows changed. */
  changed?: () => void;
}

interface Collected {
  id: string;
  name: string;
  mime: string | null;
  size: number | null;
  mtime: number | null;
  link: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
}

export class SharedWithMeService {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly busy = new Set<string>();

  constructor(private readonly deps: SharedWithMeDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
  }

  /** What was found at the last look of each Google account (nothing is asked of Google here). */
  overview(): SharedWithMeOverview {
    const accounts = this.db
      .prepare(
        `SELECT p.id AS placeId, p.label AS label,
                (SELECT count(*) FROM shared_with_me s WHERE s.place_id = p.id) AS count,
                (SELECT coalesce(sum(size), 0) FROM shared_with_me s WHERE s.place_id = p.id) AS bytes,
                r.looked_at AS lookedAt, coalesce(r.truncated, 0) AS truncated
           FROM places p LEFT JOIN shared_with_me_runs r ON r.place_id = p.id
          WHERE p.kind = 'gdrive' ORDER BY p.label`,
      )
      .all() as { placeId: string; label: string; count: number; bytes: number; lookedAt: number | null; truncated: number }[];
    const items = this.db
      .prepare(
        `SELECT s.place_id AS placeId, p.label AS accountLabel, s.file_id AS fileId, s.name, s.mime_type AS mimeType, s.size, s.mtime,
                coalesce(s.owner_name, s.owner_email) AS owner, s.web_link AS webLink
           FROM shared_with_me s JOIN places p ON p.id = s.place_id
          ORDER BY coalesce(s.mtime, 0) DESC, s.name LIMIT ?`,
      )
      .all(SHARED_SHOWN) as SharedItemView[];
    const totalItems = accounts.reduce((n, a) => n + a.count, 0);
    const views: SharedAccountView[] = accounts.map((a) => ({ placeId: a.placeId, label: a.label, count: a.count, bytes: a.bytes, lookedAt: a.lookedAt, truncated: a.truncated === 1 }));
    return { accounts: views, items, totalItems };
  }

  /** Looks at what is shared with one account and replaces its list. A failure leaves the old list as it was. */
  async look(placeId: string, signal?: AbortSignal): Promise<SharedLookResult> {
    const place = this.db.prepare("SELECT label FROM places WHERE id = ? AND kind = 'gdrive'").get(placeId) as { label: string } | undefined;
    if (!place) return { ok: false, message: 'That is not a Google Drive account. Nothing was changed.' };
    if (this.busy.has(placeId)) return { ok: false, message: 'Already checking that account. Nothing was changed.' };
    this.busy.add(placeId);
    try {
      const rows: Collected[] = [];
      let token: string | null = null;
      let truncated = false;
      for (let page = 0; ; page += 1) {
        if (page >= SHARED_MAX_PAGES) {
          truncated = true;
          break;
        }
        const result: DriveSharedPage = await this.deps.api.listSharedWithMePage(placeId, token, signal);
        for (const f of result.files) {
          rows.push({ id: f.id, name: f.name, mime: f.mimeType || null, size: f.size, mtime: f.mtime, link: f.webLink, ownerName: f.ownerName, ownerEmail: f.ownerEmail });
        }
        token = result.nextPageToken;
        if (token === null) break;
      }
      const at = this.now();
      const insert = this.db.prepare(
        'INSERT OR REPLACE INTO shared_with_me (place_id, file_id, name, mime_type, size, mtime, web_link, owner_name, owner_email, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM shared_with_me WHERE place_id = ?').run(placeId);
        for (const r of rows) insert.run(placeId, r.id, r.name, r.mime, r.size, r.mtime, r.link, r.ownerName, r.ownerEmail, at);
        this.db.prepare('INSERT OR REPLACE INTO shared_with_me_runs (place_id, looked_at, item_count, truncated) VALUES (?, ?, ?, ?)').run(placeId, at, rows.length, truncated ? 1 : 0);
      })();
      this.deps.changed?.();
      const count = rows.length.toLocaleString('en-US');
      return {
        ok: true,
        count: rows.length,
        truncated,
        message: `${place.label}: ${count} ${rows.length === 1 ? 'file is' : 'files are'} shared with this account${truncated ? ' (only the first part was read)' : ''}. Nothing was changed in Google.`,
      };
    } catch {
      return { ok: false, message: 'Google could not be asked right now. The list was not changed and nothing was changed in Google.' };
    } finally {
      this.busy.delete(placeId);
    }
  }
}
