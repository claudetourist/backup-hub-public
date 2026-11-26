import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SHARED_MAX_PAGES } from '../../shared/sharedWithMe';
import { computeAllCoverage } from '../copies/copiesIndex';
import { closeDatabase, initDatabase, type Db } from '../db';
import type { DriveSharedInfo, DriveSharedPage } from './driveApi';
import { SharedWithMeService, type SharedWithMeApi } from './sharedWithMe';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const SHA = 'a'.repeat(64);
const MD5 = 'b'.repeat(32);

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-shared-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  for (const [id, label] of [['g1', 'one@example.com'], ['g2', 'two@example.com']] as const) {
    db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES (?, 1, 'gdrive', ?, '{}', 'connected', 1)").run(id, label);
  }
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('lap', 1, 'laptop', 'Laptop', '{}', 'connected', 1)").run();
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

const item = (id: string, name: string, size: number | null = 100, mtime: number | null = 1000): DriveSharedInfo => ({
  id,
  name,
  mimeType: 'image/jpeg',
  size,
  md5: MD5,
  mtime,
  webLink: `https://drive.google.com/file/d/${id}/view`,
  parent: null,
  ownerName: 'Aunt May',
  ownerEmail: 'may@example.com',
});

/** A fake Drive client over fixed pages. It records every call and has no way to write, so a write cannot happen by accident. */
function fakeApi(pages: Record<string, DriveSharedPage[]>): SharedWithMeApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    listSharedWithMePage(placeId, pageToken) {
      calls.push(`${placeId}:${pageToken ?? 'first'}`);
      const list = pages[placeId];
      if (!list) return Promise.reject(new Error('offline'));
      const index = pageToken === null ? 0 : Number(pageToken);
      return Promise.resolve(list[index] ?? { files: [], nextPageToken: null });
    },
  };
}

describe('Google Drive "shared with me"', () => {
  it('lists the items of each account on their own, newest first, with the owner', async () => {
    const api = fakeApi({
      g1: [
        { files: [item('a', 'old.jpg', 10, 100), item('b', 'new.jpg', 20, 900)], nextPageToken: '1' },
        { files: [item('c', 'middle.jpg', 30, 500)], nextPageToken: null },
      ],
      g2: [{ files: [], nextPageToken: null }],
    });
    const service = new SharedWithMeService({ db, api, now: () => 5000 });
    expect(service.overview().totalItems).toBe(0);
    const result = await service.look('g1');
    expect(result).toMatchObject({ ok: true, count: 3, truncated: false });
    expect(api.calls).toEqual(['g1:first', 'g1:1']);
    const o = service.overview();
    expect(o.items.map((i) => i.name)).toEqual(['new.jpg', 'middle.jpg', 'old.jpg']);
    expect(o.items[0]).toMatchObject({ owner: 'Aunt May', accountLabel: 'one@example.com', size: 20 });
    expect(o.accounts.find((a) => a.placeId === 'g1')).toMatchObject({ count: 3, bytes: 60, lookedAt: 5000, truncated: false });
    expect(o.accounts.find((a) => a.placeId === 'g2')).toMatchObject({ count: 0, lookedAt: null });
  });

  it('is never counted as a backup copy: no row in files or drive_items, coverage unchanged, and no table the counts read', async () => {
    db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, hashed_at, first_seen_at, last_seen_at) VALUES (?, ?, 100, 1, ?, ?, 1, 1, 1)').run('lap', 'C:/x/a.jpg', SHA, MD5);
    const before = JSON.stringify([...computeAllCoverage(db)]);
    const filesBefore = db.prepare('SELECT count(*) AS n FROM files').get();
    const itemsBefore = db.prepare('SELECT count(*) AS n FROM drive_items').get();
    // The shared file has the SAME md5 and size as the laptop file: it still must not make the laptop file "backed up".
    const api = fakeApi({ g1: [{ files: [item('a', 'a.jpg', 100)], nextPageToken: null }] });
    const service = new SharedWithMeService({ db, api });
    await service.look('g1');
    expect(JSON.stringify([...computeAllCoverage(db)])).toBe(before);
    expect(db.prepare('SELECT count(*) AS n FROM files').get()).toEqual(filesBefore);
    expect(db.prepare('SELECT count(*) AS n FROM drive_items').get()).toEqual(itemsBefore);
    expect(db.prepare('SELECT count(*) AS n FROM shared_with_me').get()).toEqual({ n: 1 });
  });

  it('replaces the account list on the next look (an item that is no longer shared disappears) and leaves other accounts alone', async () => {
    const pages: Record<string, DriveSharedPage[]> = {
      g1: [{ files: [item('a', 'a.jpg'), item('b', 'b.jpg')], nextPageToken: null }],
      g2: [{ files: [item('z', 'z.jpg')], nextPageToken: null }],
    };
    const service = new SharedWithMeService({ db, api: fakeApi(pages) });
    await service.look('g1');
    await service.look('g2');
    pages['g1'] = [{ files: [item('a', 'a.jpg')], nextPageToken: null }];
    await service.look('g1');
    expect(service.overview().items.map((i) => i.name).toSorted()).toEqual(['a.jpg', 'z.jpg']);
  });

  it('keeps the old list when Google cannot be asked, and says nothing was changed in Google', async () => {
    const pages: Record<string, DriveSharedPage[]> = { g1: [{ files: [item('a', 'a.jpg')], nextPageToken: null }] };
    const service = new SharedWithMeService({ db, api: fakeApi(pages) });
    await service.look('g1');
    delete pages['g1'];
    const r = await service.look('g1');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('nothing was changed in Google');
    expect(service.overview().totalItems).toBe(1);
  });

  it('stops after a fixed number of pages and says so; refuses an id that is not a Google account', async () => {
    const endless: DriveSharedPage[] = Array.from({ length: SHARED_MAX_PAGES + 5 }, (_, i) => ({ files: [item(`f${i}`, `f${i}.jpg`)], nextPageToken: String(i + 1) }));
    const api = fakeApi({ g1: endless });
    const service = new SharedWithMeService({ db, api });
    const r = await service.look('g1');
    expect(r).toMatchObject({ ok: true, truncated: true, count: SHARED_MAX_PAGES });
    expect(api.calls).toHaveLength(SHARED_MAX_PAGES);
    expect(service.overview().accounts.find((a) => a.placeId === 'g1')?.truncated).toBe(true);
    expect((await service.look('lap')).ok).toBe(false);
    expect((await service.look('nope')).ok).toBe(false);
  });
});

describe('static: shared with me stays read only and apart', () => {
  const root = path.resolve(__dirname, '..');
  const read = (f: string): string => fs.readFileSync(path.join(root, f), 'utf8');

  it('the service has no network, no copy and no delete of its own; it only asks for a list and writes its two tables', () => {
    const text = read('google/sharedWithMe.ts');
    expect(text).not.toMatch(/googleHttp|GoogleHttp|fetch\(|\.request\(|uploader|DriveUploader|unlink|rmSync/);
    const writes = [...text.matchAll(/(?:INSERT(?: OR REPLACE)? INTO|UPDATE|DELETE FROM)\s+(\w+)/g)].map((m) => m[1]);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((t) => t === 'shared_with_me' || t === 'shared_with_me_runs')).toBe(true);
  });

  it('nothing that counts copies or cleans up reads the shared tables', () => {
    for (const f of ['copies/copiesIndex.ts', 'query/collectionsQuery.ts', 'cleanup/safety.ts', 'cleanup/phoneCleanPlanner.ts', 'cleanup/laptopCleanPlanner.ts', 'query/queryCore.ts']) {
      if (fs.existsSync(path.join(root, f))) expect(read(f), f).not.toMatch(/shared_with_me/);
    }
  });

  it('the API call is a plain GET of the files list through the existing allowlist (no new URL, no write method)', () => {
    const api = read('google/driveApi.ts');
    const body = api.slice(api.indexOf('async listSharedWithMePage'), api.indexOf('async changesPage'));
    expect(body).toContain('FILES_URL');
    expect(body).toContain('this.get(');
    expect(body).not.toMatch(/POST|PATCH|DELETE|PUT/);
    expect(api).toContain("sharedWithMe = true and trashed = false");
  });
});
