import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kindOf } from '../../shared/fileKinds';
import { closeDatabase, currentSchemaVersion, DB_FILE_NAME, initDatabase, MIGRATIONS, type Db } from '../db';
import { KINDS_COMPLETE_SQL } from '../query/searchQuery';
import { classifyChunk, countUnclassified, hasUnclassified, makeKindResolver, nameOfRelPath } from './sortKinds';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-classify-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('laptop-1', 1, 'laptop', 'L', 'connected', 1)").run();
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

let serial = 0;
function addFiles(count: number, goneEvery = 0): void {
  const insert = db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at, gone_at) VALUES ('laptop-1', ?, 1, 1, 2, ?)");
  const names = ['D:/Phone/DCIM/Camera/IMG_{i}.jpg', 'D:/Phone/WhatsApp/Media/IMG-{i}-WA0001.jpg', 'D:/x/{i}.pdf', 'D:/Rec/Recording {i}.m4a', 'D:/x/{i}.xyz', 'D:/Pictures/Screenshots/{i}.png'];
  db.transaction(() => {
    for (let i = 0; i < count; i += 1) {
      serial += 1;
      insert.run(names[i % names.length]!.replace('{i}', String(serial)), goneEvery > 0 && i % goneEvery === 0 ? 9 : null);
    }
  })();
}

interface Row {
  rel_path: string;
  name: string;
  mime: string | null;
  kind: string | null;
}
const all = (): Row[] => db.prepare('SELECT rel_path, name, mime, kind FROM files').all() as Row[];

describe('migration 0009', () => {
  it('adds the kind column and its three indexes, and is the latest schema version', () => {
    expect(currentSchemaVersion(db)).toBe(MIGRATIONS.length);
    expect(MIGRATIONS[8]?.name).toBe('file_kind');
    const cols = (db.prepare('PRAGMA table_info(files)').all() as { name: string; type: string; notnull: number }[]).filter((c) => c.name === 'kind');
    expect(cols.map((c) => `${c.name}:${c.type}:${c.notnull}`)).toEqual(['kind:TEXT:0']);
    const idx = (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN ('idx_files_kind', 'idx_files_unclassified', 'idx_files_mtime')").all() as { name: string; sql: string }[]).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    expect(idx.map((i) => i.name)).toEqual(['idx_files_kind', 'idx_files_mtime', 'idx_files_unclassified']);
    expect(idx.find((i) => i.name === 'idx_files_unclassified')?.sql).toContain('WHERE kind IS NULL');
  });

  it('a new row has no kind', () => {
    addFiles(3);
    expect(all().every((r) => r.kind === null)).toBe(true);
    expect(hasUnclassified(db)).toBe(true);
    expect(countUnclassified(db)).toBe(3);
  });

  it('the indexes serve the questions they were made for', () => {
    const plan = (sql: string): string => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((p) => p.detail).join(' ');
    expect(plan('SELECT 1 FROM files WHERE kind IS NULL LIMIT 1')).toContain('idx_files_unclassified');
    // Search asks this before EVERY search; without the hint SQLite scanned idx_files_mtime (all rows) to find nothing.
    expect(plan(KINDS_COMPLETE_SQL)).toBe('SCAN files USING INDEX idx_files_unclassified');
    expect(plan("SELECT count(*) FROM files WHERE gone_at IS NULL AND kind IN ('photo-camera')")).toContain('idx_files_kind');
    expect(plan('SELECT id FROM files WHERE gone_at IS NULL ORDER BY mtime DESC LIMIT 10')).toContain('idx_files_mtime');
  });
});

describe('classifyChunk', () => {
  it('sets the kind the pure function gives, for live and gone rows, in chunks that continue after the last id', () => {
    addFiles(25, 5);
    let after = 0;
    const sizes: number[] = [];
    for (;;) {
      const chunk = classifyChunk(db, after, 10);
      if (chunk.lastId === null) break;
      sizes.push(chunk.sorted);
      after = chunk.lastId;
    }
    expect(sizes).toEqual([10, 10, 5]);
    for (const row of all()) expect(row.kind, row.rel_path).toBe(kindOf(row.rel_path, row.name, row.mime));
    expect(hasUnclassified(db)).toBe(false);
  });

  it('leaves a row alone that already has a kind', () => {
    addFiles(1);
    db.prepare("UPDATE files SET kind = 'other'").run();
    expect(classifyChunk(db, 0).sorted).toBe(0);
    expect(all()[0]?.kind).toBe('other');
  });
});


describe('makeKindResolver', () => {
  it('gives the automatic kind, and your own choice wins', () => {
    const kindFor = makeKindResolver(db);
    expect(kindFor('laptop-1', 'D:/Phone/DCIM/Camera/IMG_1.jpg', null, 5)).toBe('photo-camera');
    expect(kindFor('laptop-1', 'D:/x/empty.pdf', null, 0)).toBe('empty');
    db.prepare("INSERT INTO kind_overrides (place_id, rel_path, kind, set_at) VALUES ('laptop-1', 'D:/x/a.pdf', 'photo-camera', 1)").run();
    expect(kindFor('laptop-1', 'D:/x/a.pdf', null, 5)).toBe('photo-camera');
    expect(kindFor('laptop-2', 'D:/x/a.pdf', null, 5)).toBe('documents');
  });

  it('takes the name from the path the way the generated name column does', () => {
    addFiles(6);
    for (const row of all()) expect(nameOfRelPath(row.rel_path), row.rel_path).toBe(row.name);
    expect(nameOfRelPath('plain.txt')).toBe('plain.txt');
  });
});

describe('the lock fix: sorting waits for other writers', () => {
  it('a chunk takes the write lock at BEGIN (immediate) and waits for a writer that holds it, instead of failing with SQLITE_BUSY_SNAPSHOT', async () => {
    addFiles(6);
    const file = path.join(dir, DB_FILE_NAME);
    // Another connection (in another thread) holds the write lock for about 500 ms, then commits.
    const holder = new Worker(
      `const Database = require('better-sqlite3');
       const { workerData, parentPort } = require('node:worker_threads');
       const db = new Database(workerData);
       db.pragma('busy_timeout = 5000');
       db.exec('BEGIN IMMEDIATE');
       db.exec("INSERT INTO meta (key, value) VALUES ('lock-test', '1')");
       parentPort.postMessage('locked');
       setTimeout(() => { db.exec('COMMIT'); db.close(); parentPort.postMessage('released'); }, 500);`,
      { eval: true, workerData: file },
    );
    await once(holder, 'message');
    const second = new Database(file);
    second.pragma('busy_timeout = 5000');
    try {
      const started = Date.now();
      const result = classifyChunk(second, 0);
      expect(result.sorted).toBe(6);
      expect(Date.now() - started).toBeGreaterThanOrEqual(300);
      expect(countUnclassified(db)).toBe(0);
    } finally {
      second.close();
      await holder.terminate();
    }
  });

  it('reads and writes in one immediate transaction (source check)', () => {
    expect(classifyChunk.toString()).toContain('.immediate()');
  });
});
