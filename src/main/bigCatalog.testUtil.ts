import type { Db } from './db';

/**
 * Test helper: fill the file list with a lot of fake rows in one go (about 100k rows a second), so the big-catalog tests
 * run against a table of the real size. Rows are `<prefix>/d<n>/f<m>.dat`, live, 1 KB, with or without a fingerprint, and with or without a file-system id (`fsIds`).
 */
export function insertFakeRows(db: Db, placeId: string, prefix: string, count: number, options: { fingerprinted: boolean; perFolder?: number; fsIds?: boolean; start?: number } = { fingerprinted: true }): void {
  const perFolder = options.perFolder ?? 50;
  // The id column exists from schema 24; databases made at an older version (the migration tests) are filled without it.
  const ids = options.fsIds === true;
  const stmt = db.prepare(
    `INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, sha256, md5, hashed_at, cloud_only${ids ? ', fs_id' : ''})
     VALUES (@placeId, @rel, @size, @mtime, 1, 1, @sha, @md5, @hashedAt, 0${ids ? ', @fsId' : ''})`,
  );
  db.transaction(() => {
    for (let i = options.start ?? 0; i < (options.start ?? 0) + count; i += 1) {
      const folder = Math.floor(i / perFolder);
      stmt.run({
        placeId,
        rel: `${prefix}/d${folder}/f${i % perFolder}.dat`,
        size: 1000 + (i % 977),
        mtime: 1_700_000_000_000 + i,
        sha: options.fingerprinted ? `sha${i.toString(16).padStart(60, '0')}` : null,
        md5: options.fingerprinted ? `md5${i.toString(16).padStart(29, '0')}` : null,
        hashedAt: options.fingerprinted ? 1 : null,
        ...(ids ? { fsId: `${prefix}#${i}` } : {}),
      });
    }
  })();
}
