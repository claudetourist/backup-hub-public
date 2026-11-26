import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, type Db } from '../db';
import { MIGRATIONS } from '../db/migrations';
import { turn } from '../sliceWork';
import { matchMoves } from './moveMatch';

/**
 * R1.6 on a catalog of the real size (CLAUDE.md: every new piece of work gets a main-thread block test, limit 250 ms; the real db has ~1.1 M file rows).
 * The database is made at the version before the file ids (23) with a million rows, then migrated: adding the column and the indexes must be fast, no row is
 * rewritten. Then a folder of 1,000 files is "renamed" (its rows vanished, 1,000 new rows with the same ids appeared) and matched ON THE MAIN THREAD, the worst
 * case (the app runs it on the listing worker): a timer says how late it fires. The real numbers are printed.
 */
const ROWS = Number(process.env['MOVE_BLOCK_ROWS'] ?? 1_000_000);
const RENAMED = 1000;
const MAX_BLOCK_MS = 250;
const PLACE = 'laptop-big';

function watchdog(intervalMs = 10): { stop(): number } {
  let last = performance.now();
  let lastCpu = process.cpuUsage();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const cpuMs = (cpu.user - lastCpu.user + (cpu.system - lastCpu.system)) / 1000;
    max = Math.max(max, Math.min(now - last - intervalMs, cpuMs));
    last = now;
    lastCpu = cpu;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return Math.max(0, Math.round(max));
    },
  };
}

let dir: string;
let db: Db;
let migrateMs = 0;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-move-big-'));
  db = openDatabase(path.join(dir, 'big.db'));
  runMigrations(db, MIGRATIONS.slice(0, 23));
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES (?, 1, 'laptop', 'Laptop', '{}', 1)").run(PLACE);
  const insert = db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, sha256, hashed_at, cloud_only, kind) VALUES (?, ?, ?, ?, 1, 1, ?, 1, 0, 'other')");
  for (let from = 0; from < ROWS; from += 50_000) {
    db.transaction(() => {
      for (let i = from; i < Math.min(ROWS, from + 50_000); i += 1) insert.run(PLACE, `Z:/other/d${Math.floor(i / 50)}/f${i % 50}.dat`, 1000 + (i % 977), 1_700_000_000_000 + i, `sha${i}`);
    })();
    await turn();
  }
  const t0 = performance.now();
  runMigrations(db);
  migrateMs = Math.round(performance.now() - t0);
  // The first full look after the upgrade fills the ids (here in one statement; the look does it with its normal saves).
  db.exec("UPDATE files SET fs_id = '1a2b-' || id");
}, 900_000);
afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}, 120_000);

describe('rename detection never freezes the window', () => {
  it('the migration (a column and indexes) on a million rows is quick and rewrites no row', () => {
    console.log(`[migration 24] ${ROWS.toLocaleString('en-US')} rows: ${migrateMs} ms`);
    expect(migrateMs).toBeLessThan(5000);
    expect(db.prepare('SELECT count(*) FROM file_paths').pluck().get()).toBe(0);
    expect(db.prepare('SELECT count(*) FROM files').pluck().get()).toBe(ROWS);
  });

  it('the two queries of the matching use their indexes', () => {
    const plan = (sql: string, ...params: unknown[]): string => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail).join(' | ');
    expect(plan("SELECT id FROM files INDEXED BY idx_files_gone_fs WHERE place_id = ? AND gone_at IS NOT NULL AND gone_at >= ? AND fs_id IS NOT NULL AND gone_reason IS NULL", PLACE, 1)).toContain('idx_files_gone_fs');
    const same = plan('SELECT id FROM files INDEXED BY idx_files_fs_id WHERE place_id = ? AND fs_id = ?', PLACE, 'x');
    expect(same).toContain('idx_files_fs_id');
    expect(same).not.toContain('SCAN');
    expect(plan('SELECT id FROM files WHERE place_id = ? AND fs_id = ?', PLACE, 'x')).toContain('idx_files_fs_id');
  });

  it('a folder of 1,000 files renamed on a catalog of a million rows: matched, and no block over 250 ms', async () => {
    const runStart = 5_000_000;
    // The renamed folder's rows vanished in this look ...
    const first = 200_000;
    db.prepare('UPDATE files SET gone_at = ? WHERE id > ? AND id <= ?').run(runStart + 1, first, first + RENAMED);
    // ... and the same files (same ids, sizes, dates) appeared under the new name.
    const old = db.prepare('SELECT id, size, mtime, fs_id, sha256 FROM files WHERE id > ? AND id <= ?').all(first, first + RENAMED) as { id: number; size: number; mtime: number; fs_id: string; sha256: string }[];
    const add = db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, cloud_only, kind, fs_id) VALUES (?, ?, ?, ?, ?, ?, 0, 'other', ?)");
    db.transaction(() => {
      old.forEach((o, i) => add.run(PLACE, `Z:/Goa 2026/f${i}.dat`, o.size, o.mtime, runStart + 1, runStart + 1, o.fs_id));
    })();
    await turn();

    const dog = watchdog();
    const t0 = performance.now();
    const result = await matchMoves(db, { placeId: PLACE, runStart, now: runStart + 2 });
    const ms = Math.round(performance.now() - t0);
    const block = dog.stop();
    console.log(`[move matching] ${RENAMED.toLocaleString('en-US')} renamed files on ${ROWS.toLocaleString('en-US')} rows: ${result.moved} matched, ${ms} ms in all, longest block ${block} ms`);
    expect(result.moved).toBe(RENAMED);
    expect(block).toBeLessThan(MAX_BLOCK_MS);
    // The old rows kept their ids and checksums and have the new paths; no duplicate was left.
    expect(db.prepare("SELECT count(*) FROM files WHERE rel_path LIKE 'Z:/Goa 2026/%' AND gone_at IS NULL").pluck().get()).toBe(RENAMED);
    expect(db.prepare('SELECT count(*) FROM files').pluck().get()).toBe(ROWS);
    expect(db.prepare("SELECT count(*) FROM files WHERE rel_path LIKE 'Z:/Goa 2026/%' AND id > ? AND id <= ? AND sha256 IS NOT NULL").pluck().get(first, first + RENAMED)).toBe(RENAMED);
    expect(db.prepare('SELECT count(*) FROM file_paths').pluck().get()).toBe(RENAMED * 2);
  }, 300_000);

  it('a look with nothing vanished costs almost nothing on a million rows', async () => {
    const dog = watchdog();
    const t0 = performance.now();
    const result = await matchMoves(db, { placeId: PLACE, runStart: 9_000_000, now: 9_000_001 });
    const ms = Math.round(performance.now() - t0);
    console.log(`[move matching, nothing vanished] ${ms} ms, longest block ${dog.stop()} ms`);
    expect(result).toEqual({ moved: 0, unmatched: 0 });
    expect(ms).toBeLessThan(250);
  });
});
