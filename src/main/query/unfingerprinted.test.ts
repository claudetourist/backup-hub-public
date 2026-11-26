import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_SEARCH, hasSearchCriteria, toSearchRequest, type SearchRequest } from '../../shared/search';
import { closeDatabase, initDatabase, type Db } from '../db';
import { searchQuery } from './searchQuery';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-unfp-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('laptop-1', 1, 'laptop', 'L', 'connected', 1)").run();
  db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('od', 1, 'onedrive', 'OD', 'connected', 1)").run();
  const add = db.prepare(
    'INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, cloud_only, gone_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, 1, 2)',
  );
  add.run('laptop-1', 'D:/x/checked.txt', 5, 'aa', 'bb', 0, null);
  add.run('laptop-1', 'D:/x/new.txt', 6, null, null, 0, null);
  add.run('laptop-1', 'D:/x/gone.txt', 7, null, null, 0, 99);
  add.run('od', 'cloudonly.txt', 8, null, null, 1, null);
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

const names = (request: Partial<SearchRequest>): string[] => {
  const response = searchQuery(db, { ...EMPTY_SEARCH, ...request });
  if (response.status !== 'done') throw new Error(`unexpected ${response.status}`);
  return response.hits.map((h) => h.name).toSorted();
};

describe('the "not checked yet" filter', () => {
  it('finds only live files with no checksum that are on this PC (not checked ones, gone ones or cloud-only ones)', () => {
    expect(names({ unfingerprinted: true })).toEqual(['new.txt']);
  });

  it('combines with the other filters', () => {
    expect(names({ unfingerprinted: true, text: 'zzz' })).toEqual([]);
    expect(names({ unfingerprinted: true, placeIds: ['od'] })).toEqual([]);
    expect(names({ unfingerprinted: true, placeIds: ['laptop-1'] })).toEqual(['new.txt']);
  });

  it('counts as a search criterion, survives the trip from the window, and is off by default', () => {
    expect(hasSearchCriteria({ ...EMPTY_SEARCH, unfingerprinted: true })).toBe(true);
    expect(hasSearchCriteria(EMPTY_SEARCH)).toBe(false);
    expect(toSearchRequest({ unfingerprinted: true }).unfingerprinted).toBe(true);
    expect(toSearchRequest({ unfingerprinted: 'yes' }).unfingerprinted).toBe(false);
    expect(toSearchRequest(null).unfingerprinted).toBe(false);
  });
});
