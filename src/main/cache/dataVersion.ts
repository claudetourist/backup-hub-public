import type { Db } from '../db/connection';

/**
 * A counter that goes up whenever something the Home numbers are counted from changes. A saved count remembers the
 * version it was counted at; it needs counting again only when the version has moved on. Reading is free (kept in
 * memory); bumping is one tiny write.
 */
export class DataVersion {
  private n: number;
  private readonly listeners = new Set<(version: number) => void>();

  constructor(private readonly db: Db) {
    const row = db.prepare('SELECT n FROM data_version WHERE id = 1').get() as { n: number } | undefined;
    this.n = row?.n ?? 1;
  }

  current(): number {
    return this.n;
  }

  /** Something the counts depend on changed. */
  bump(): void {
    this.n += 1;
    this.db.prepare('UPDATE data_version SET n = ? WHERE id = 1').run(this.n);
    for (const listener of this.listeners) listener(this.n);
  }

  onBump(listener: (version: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
