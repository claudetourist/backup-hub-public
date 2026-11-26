import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeRig, type Rig } from '../look/harness/world.testutil';
import { whyFile } from './whyFile';

/**
 * "Why?" on one file must be quick on a catalog of the real size: 2,000,000 rows (the shape of the bench database: a phone with 1,000,000
 * files, T7 600,000, the Seagate 300,000, Google 100,000, every copy linked to its phone file and sharing its checksum), with every index
 * the app has. The rows are made inside SQLite itself (a recursive query), so building them takes about a minute; the limit is on the
 * answer: a file in under 50 ms (median of repeated calls; the worst call is printed too).
 */
const PHONE = 1_000_000;
const T7 = 600_000;
const SEAGATE = 300_000;
const GOOGLE = 100_000;
const MAX_MS = 50;

let rig: Rig;

/** The path every generated row gets, in step with the row number: sorted, like a real folder walk, so the database loads quickly. */
const pathSql = (prefix: string): string => `'${prefix}' || printf('%03d', i / 2000) || '/IMG_' || printf('%07d', i) || '.jpg'`;
const pathOf = (prefix: string, i: number): string => `${prefix}${String(Math.floor(i / 2000)).padStart(3, '0')}/IMG_${String(i).padStart(7, '0')}.jpg`;
const PHONE_DIR = 'sdcard/DCIM/Camera';
const T7_DIR = 'MyData/POCO/POCO-01Nov26/DCIM/Camera';
const SEAGATE_DIR = 'Backups/POCO/POCO-01Nov26/DCIM/Camera';
const GOOGLE_DIR = 'Backup Hub/Sam/Poco F4/DCIM/Camera';
const CHUNK = 100_000;

beforeAll(async () => {
  rig = makeRig();
  const { db } = rig;
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  db.pragma('cache_size = -400000');
  const place = db.prepare('INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES (?, 1, ?, ?, ?, 1)');
  place.run('phone', 'phone', 'Poco F4', '{}');
  place.run('t7', 'drive', 'T7', '{}');
  place.run('sg', 'drive', 'Seagate2TB', '{}');
  place.run('g1', 'gdrive', 'sam@example.com', '{}');
  db.prepare("INSERT INTO backup_profiles (id, person_id, name, source_kind, source_place_id, source_root, phone_serial, folder_prefix, change_rule, created_at) VALUES (7, 1, 'Poco F4', 'phone', 'phone', '', 'SER', 'POCO', 'size_and_date', 1)").run();
  db.prepare("INSERT INTO backup_runs (id, backup_profile_id, destination_place_id, folder, started_at, state) VALUES (3, 7, 't7', 'f', 1700000000000, 'done')").run();

  // Loading 2,000,000 rows into a table that keeps all its indexes up to date takes minutes; the same indexes are built once, after the load,
  // from their own definitions (the unique one on place and path stays: the rows arrive in its order). The finished catalog has every index the app has.
  const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'files' AND sql IS NOT NULL").all() as { name: string; sql: string }[];
  for (const ix of indexes) db.exec(`DROP INDEX ${ix.name}`);
  const rows = 'WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i < ?)';
  const load = async (sql: string, count: number, ...args: unknown[]): Promise<void> => {
    for (let from = 1; from <= count; from += CHUNK) {
      db.prepare(sql).run(...args, from, Math.min(count, from + CHUNK - 1));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  // The phone: ids 1..PHONE (the table is empty), so a copy can name its phone row by the same number.
  await load(
    `${rows} INSERT INTO files (place_id, rel_path, size, mtime, sha256, first_seen_at, last_seen_at, kind)
     SELECT 'phone', ${pathSql(PHONE_DIR)}, 1000 + (i % 977), 1700000000000 + i, printf('%064x', i), 1700000000000, 1700000100000, 'photos' FROM n`,
    PHONE,
  );
  const copies = (placeId: string, n: number, prefix: string, how: string): Promise<void> =>
    load(
      `${rows} INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, first_seen_at, last_seen_at, origin_file_id, backup_run_id, verified_how, verified_at, kind)
       SELECT '${placeId}', ${pathSql(prefix)}, 1000 + (i % 977), 1700000000000 + i, printf('%064x', i), printf('%032x', i), 1700000000000, 1700000100000, i, 3, '${how}', 1700000200000, 'photos' FROM n`,
      n,
    );
  await copies('t7', T7, T7_DIR, 'read_both');
  await copies('sg', SEAGATE, SEAGATE_DIR, 'imported');
  await load(
    `${rows} INSERT INTO files (place_id, rel_path, size, mtime, md5, first_seen_at, last_seen_at, kind)
     SELECT 'g1', ${pathSql(GOOGLE_DIR)}, 1000 + (i % 977), 1700000000000 + i, printf('%032x', i), 1700000000000, 1700000100000, 'photos' FROM n`,
    GOOGLE,
  );
  for (const ix of indexes) {
    db.exec(ix.sql);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  db.exec('ANALYZE');
}, 900_000);

afterAll(() => rig.close());

function time(fileId: number, runs = 15): { median: number; worst: number } {
  const ms: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    const r = whyFile({ db: rig.db }, { fileId });
    ms.push(performance.now() - t0);
    expect(r.ok).toBe(true);
  }
  const sorted = ms.toSorted((a, b) => a - b);
  return { median: sorted[Math.floor(runs / 2)]!, worst: sorted[runs - 1]! };
}

// Slow (builds a 2M-row database, ~85 s): skipped unless BACKUPHUB_SLOW=1   BACKUPHUB_SLOW=1 npx vitest run src/main/why/whySpeed.test.ts
describe.skipIf(process.env['BACKUPHUB_SLOW'] !== '1')('Why? on one file of a catalog with 2,000,000 rows', () => {
  it('has the shape of the bench database', () => {
    expect(rig.db.prepare('SELECT count(*) FROM files').pluck().get()).toBe(PHONE + T7 + SEAGATE + GOOGLE);
  });

  it('a phone file with a copy on T7, one on the Seagate and one in Google (4 rows tied together) answers in under 50 ms', () => {
    const phoneId = 77_777;
    const r = whyFile({ db: rig.db }, { fileId: phoneId });
    expect(r).toMatchObject({ ok: true, name: 'IMG_0077777.jpg', headline: '4 copies: the phone, T7, Seagate2TB, Google' });
    if (r.ok) expect(r.sections.find((s) => s.title === 'Free up phone space')!.lines[0]!.text).toMatch(/^Not yet\..*Missing: Seagate2TB\.$/);
    const t = time(phoneId);
    console.log(`WHY (phone file, 4 copies): median ${t.median.toFixed(1)} ms, worst ${t.worst.toFixed(1)} ms on ${PHONE + T7 + SEAGATE + GOOGLE} rows`);
    expect(t.median).toBeLessThan(MAX_MS);
  });

  it('a copy on the drive, asked from its own side, and a phone file with no copy at all: the same limit', () => {
    const copy = rig.db.prepare("SELECT id FROM files WHERE place_id = 't7' AND rel_path = ?").pluck().get(pathOf(T7_DIR, 555_555)) as number;
    const a = time(copy);
    const alone = time(PHONE - 5); // 999,995: no copy anywhere
    const byPath = (() => {
      const ms: number[] = [];
      for (let i = 0; i < 15; i += 1) {
        const t0 = performance.now();
        whyFile({ db: rig.db }, { backupId: 7, phonePath: '/' + pathOf(PHONE_DIR, 123_123) });
        ms.push(performance.now() - t0);
      }
      return ms.toSorted((x, y) => x - y)[7]!;
    })();
    console.log(`WHY (copy on T7): median ${a.median.toFixed(1)} ms, worst ${a.worst.toFixed(1)} ms; (phone file alone): median ${alone.median.toFixed(1)} ms, worst ${alone.worst.toFixed(1)} ms; (by phone path): median ${byPath.toFixed(1)} ms`);
    expect(a.median).toBeLessThan(MAX_MS);
    expect(alone.median).toBeLessThan(MAX_MS);
    expect(byPath).toBeLessThan(MAX_MS);
  });
});
