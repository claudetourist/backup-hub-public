import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kindOf } from '../../src/shared/fileKinds';
import { CountCache } from '../../src/main/cache/countCache';
import { DataVersion } from '../../src/main/cache/dataVersion';
import { closeDatabase, DB_FILE_NAME, initDatabase, markCleanShutdown, markFullCheckPassed, MIGRATIONS } from '../../src/main/db';
import { coverageQuery, statsQuery } from '../../src/main/query/queryCore';

/**
 * Builds the database the bench measures on: the real schema (the app's own migrations), 2,000,000 file rows over four places,
 * the kinds already sorted and a fingerprint on most rows (what a settled catalog looks like), and the saved counts Home shows
 * at start. The same content sits in several places, so "copies" and the one-result-per-content grouping do real work.
 * Cached under the system temp folder (never on D:); a half-built file is never used. Used only by scripts/bench (not npm test).
 */
export const GENERATOR_VERSION = 1;
export const TOTAL_ROWS = 2_000_000;
export const BENCH_ROOT = path.join(os.tmpdir(), 'backuphub-bench');
export const GENERATED_DIR = path.join(BENCH_ROOT, 'generated-2m');
export const GENERATED_DB = path.join(GENERATED_DIR, DB_FILE_NAME);
const STAMP_FILE = path.join(GENERATED_DIR, 'stamp.json');

interface PlaceSpec {
  id: string;
  kind: 'laptop' | 'drive' | 'gdrive';
  label: string;
  prefix: string;
  /** Contents from..from+count-1 are held here. */
  from: number;
  count: number;
  /** A Google Drive row has an md5 and no sha256, and is not on the disk. */
  cloud: boolean;
  /** The last rows of the place have no fingerprint yet. */
  unfingerprinted: number;
}

const PLACES: readonly PlaceSpec[] = [
  { id: 'laptop-1', kind: 'laptop', label: 'This laptop', prefix: 'Users/home/Documents', from: 0, count: 900_000, cloud: false, unfingerprinted: 20_000 },
  { id: 'drive-t7', kind: 'drive', label: 'T7', prefix: 'Backups/Laptop', from: 0, count: 700_000, cloud: false, unfingerprinted: 0 },
  { id: 'gdrive-1', kind: 'gdrive', label: 'Google Drive', prefix: 'My Drive', from: 0, count: 250_000, cloud: true, unfingerprinted: 0 },
  { id: 'drive-seagate', kind: 'drive', label: 'Seagate2TB', prefix: 'Archive', from: 900_000, count: 150_000, cloud: false, unfingerprinted: 0 },
];

const WORDS = ['holiday', 'invoice', 'report', 'family', 'budget', 'scan', 'photo', 'notes', 'screenshot', 'project', 'tax', 'recipe'];
const EXTENSIONS = ['jpg', 'jpg', 'jpg', 'png', 'mp4', 'pdf', 'docx', 'txt', 'mp3', 'zip'];

/** Name, size and date of content number c: the same in every place that holds it. */
function contentOf(c: number): { name: string; size: number; mtime: number; folder: string } {
  const ext = EXTENSIONS[(c * 7) % 10]!;
  const word = c % 5003 === 0 ? 'zebra' : WORDS[c % 12]!;
  const name = ext === 'jpg' && c % 2 === 0 ? `IMG_${String(c).padStart(8, '0')}.jpg` : `${word}-${c}.${ext}`;
  return {
    name,
    size: 500 + ((c * 104_729) % 20_000_000),
    mtime: 1_400_000_000_000 + ((c * 2_654_435_761) % 380_000_000) * 1000,
    folder: `${2010 + (c % 15)}/d${Math.floor(c / 200)}`,
  };
}

const hexOf = (c: number, length: number): string => c.toString(16).padStart(8, '0').repeat(length / 8);

export interface GeneratedInfo {
  generatorVersion: number;
  rows: number;
  schemaVersion: number;
  builtAt: string;
  buildSeconds: number;
  dbBytes: number;
  kinds: Record<string, number>;
}

/** The cached database's stamp when it is complete and current, else null. */
export function currentStamp(): GeneratedInfo | null {
  try {
    const stamp = JSON.parse(fs.readFileSync(STAMP_FILE, 'utf8')) as GeneratedInfo;
    const ok = stamp.generatorVersion === GENERATOR_VERSION && stamp.rows === TOTAL_ROWS && stamp.schemaVersion === MIGRATIONS.length && fs.existsSync(GENERATED_DB);
    return ok ? stamp : null;
  } catch {
    return null;
  }
}

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** Builds the database unless a current one is cached. Only ever removes its own temp folder under backuphub-bench. */
export function ensureGeneratedDb(log: (line: string) => void = () => {}): GeneratedInfo {
  const existing = currentStamp();
  if (existing) return existing;
  const started = Date.now();
  fs.rmSync(GENERATED_DIR, { recursive: true, force: true });
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const opened = initDatabase(GENERATED_DIR, silent);
  if (!opened.ok) throw new Error(`generated database did not open: ${opened.messages.join(' | ')}`);
  const db = opened.db;
  const kinds: Record<string, number> = {};
  try {
    db.pragma('synchronous = OFF');
    const addPlace = db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at, last_looked_at) VALUES (?, 1, ?, ?, 'connected', 1, 1700000000000)");
    for (const place of PLACES) addPlace.run(place.id, place.kind, place.label);
    const insert = db.prepare(
      `INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, sha256, md5, hashed_at, cloud_only, kind)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)`,
    );
    const CHUNK = 100_000;
    let done = 0;
    for (const place of PLACES) {
      for (let start = 0; start < place.count; start += CHUNK) {
        db.transaction(() => {
          for (let i = start; i < Math.min(start + CHUNK, place.count); i += 1) {
            const c = place.from + i;
            const content = contentOf(c);
            const rel = `${place.prefix}/${content.folder}/${content.name}`;
            const kind = kindOf(rel, content.name, null, content.size);
            kinds[kind] = (kinds[kind] ?? 0) + 1;
            const fingerprinted = i < place.count - place.unfingerprinted;
            const sha = fingerprinted && !place.cloud ? hexOf(c, 64) : null;
            const md5 = fingerprinted ? hexOf(c, 32) : null;
            insert.run(place.id, rel, content.size, content.mtime, sha, md5, sha ? 1 : null, place.cloud ? 1 : 0, kind);
          }
        })();
        done += Math.min(CHUNK, place.count - start);
        log(`generated ${done.toLocaleString('en-US')} of ${TOTAL_ROWS.toLocaleString('en-US')} rows`);
      }
    }
    // The saved counts Home reads at start (same keys and shapes as QueryService), counted at the current data version.
    const version = new DataVersion(db).current();
    const cache = new CountCache(db);
    cache.save('stats', { version, at: Date.now(), data: statsQuery(db) });
    cache.save('coverage', { version, at: Date.now(), data: coverageQuery(db) });
    markFullCheckPassed(db, Date.now());
    markCleanShutdown(db);
  } finally {
    closeDatabase(db, silent);
  }
  const rows = PLACES.reduce((sum, place) => sum + place.count, 0);
  const stamp: GeneratedInfo = {
    generatorVersion: GENERATOR_VERSION,
    rows,
    schemaVersion: MIGRATIONS.length,
    builtAt: new Date().toISOString(),
    buildSeconds: Math.round((Date.now() - started) / 1000),
    dbBytes: fs.statSync(GENERATED_DB).size,
    kinds,
  };
  fs.writeFileSync(STAMP_FILE, JSON.stringify(stamp, null, 2));
  return stamp;
}
