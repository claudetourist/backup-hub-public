import { KIND_LABELS } from '../../shared/fileKinds';
import { endingOf, folderPartOf, namePrefix, nameOfPath, type KindChange, type KindChangeResult, type SimilarFiles } from '../../shared/kinds';
import type { Db } from '../db/connection';
import { folderPrefix, prefixUpperBound } from '../listing/skipRules';

/**
 * The ONLY writer of `kind_overrides` (Files search: "Change category"). It never touches `files` except the `kind` column of
 * the rows whose kind you changed, and never touches a file on disk. Writes go in small steps with a turn for the window in
 * between, so a change to a big folder never freezes it.
 */
export interface KindStoreOptions {
  db: Db;
  /** Something changed that the counts are made from. */
  changed: () => void;
  now?: () => number;
}

/** Rows written per step. */
const STEP_ROWS = 2000;

interface Row {
  id: number;
  place_id: string;
  rel_path: string;
}

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class KindStore {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(private readonly opts: KindStoreOptions) {
    this.db = opts.db;
    this.now = opts.now ?? Date.now;
  }

  private fileRow(fileId: number): Row | undefined {
    return this.db.prepare('SELECT id, place_id, rel_path FROM files WHERE id = ? AND gone_at IS NULL').get(fileId) as Row | undefined;
  }

  /** The files that look like this one: same place, same folder (and below), same ending, and the same start of the name when it has one. */
  similarRows(fileId: number): { rows: Row[]; description: string } | null {
    const file = this.db.prepare('SELECT id, place_id, rel_path, name FROM files WHERE id = ? AND gone_at IS NULL').get(fileId) as (Row & { name: string }) | undefined;
    if (!file) return null;
    const folder = folderPartOf(file.rel_path);
    const prefix = folderPrefix(folder);
    const ending = endingOf(file.name);
    const start = namePrefix(file.name);
    const where = ['gone_at IS NULL', 'place_id = ?', 'id <> ?'];
    const params: (string | number)[] = [file.place_id, file.id];
    if (prefix !== '') {
      where.push('rel_path >= ? AND rel_path < ?');
      params.push(prefix, prefixUpperBound(prefix));
    }
    if (ending !== '') {
      where.push('substr(lower(name), ?) = ?');
      params.push(-(ending.length + 1), `.${ending}`);
    }
    const rows = this.db.prepare(`SELECT id, place_id, rel_path, name FROM files WHERE ${where.join(' AND ')}`).all(...params) as (Row & { name: string })[];
    const matching = start === '' ? rows : rows.filter((r) => r.name.toLowerCase().startsWith(start));
    const what = `${ending === '' ? 'files' : `.${ending} files`}${start === '' ? '' : ` starting with ${nameOfPath(file.rel_path).slice(0, start.length)}`}`;
    return { rows: matching, description: `all ${what} in ${folder === '' ? 'the top of this place' : folder.replaceAll('/', '\\')}` };
  }

  similar(fileId: number): SimilarFiles {
    const found = this.similarRows(fileId);
    return found ? { count: found.rows.length, description: found.description } : { count: 0, description: '' };
  }

  /** Give files a kind of your own. It is written to `kind_overrides` (so it survives sorting again) and to `files.kind` at once. */
  async changeKind(change: KindChange): Promise<KindChangeResult> {
    const rows = new Map<number, Row>();
    for (const t of change.targets) {
      const row = this.fileRow(t.fileId);
      if (row) rows.set(row.id, row);
    }
    if (change.similar) {
      const first = change.targets[0];
      const similar = first ? this.similarRows(first.fileId) : null;
      for (const r of similar?.rows ?? []) rows.set(r.id, r);
    }
    if (rows.size === 0) return { ok: false, message: 'Those files are not on the list any more. Nothing was changed.' };
    const all = [...rows.values()];
    const at = this.now();
    const upsert = this.db.prepare(
      'INSERT INTO kind_overrides (place_id, rel_path, kind, set_at) VALUES (?, ?, ?, ?) ON CONFLICT (place_id, rel_path) DO UPDATE SET kind = excluded.kind, set_at = excluded.set_at',
    );
    const setKind = this.db.prepare('UPDATE files SET kind = ? WHERE id = ?');
    for (let i = 0; i < all.length; i += STEP_ROWS) {
      this.db.transaction(() => {
        for (const r of all.slice(i, i + STEP_ROWS)) {
          upsert.run(r.place_id, r.rel_path, change.kind, at);
          setKind.run(change.kind, r.id);
        }
      })();
      await turn();
    }
    this.opts.changed();
    return { ok: true, files: all.length, message: `${all.length.toLocaleString('en-US')} ${all.length === 1 ? 'file is' : 'files are'} now ${KIND_LABELS[change.kind]}.` };
  }
}
