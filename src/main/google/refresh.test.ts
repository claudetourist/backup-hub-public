import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyChunk } from '../classify/sortKinds';
import { closeDatabase, currentSchemaVersion, initDatabase, MIGRATIONS, type Db } from '../db';
import { JobAborted, JobFailure, type JobContext } from '../jobs/jobService';
import { GoogleAuth, type GoogleVault } from './auth';
import { DriveApi } from './driveApi';
import { getSync } from './driveStore';
import { FakeAccount, FakeGoogle } from './fakeGoogle.testutil';
import { GoogleHttp } from './googleHttp';
import { refreshHandler } from './refreshJob';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
let db: Db;
let fake: FakeGoogle;
let sleeps: number[];
let secrets: Map<string, string>;
let vaultState: string;

const vault: GoogleVault = {
  status: () => ({ state: vaultState }),
  getSecretText: (name) => secrets.get(name) ?? null,
  putSecret: (name, value) => void secrets.set(name, value.toString()),
};

const PLACE_A = 'place-a';
const PLACE_B = 'place-b';

function addPlace(id: string, label: string, email: string, status = 'unknown'): void {
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at, last_looked_at) VALUES (?, 1, 'gdrive', ?, ?, ?, 1, 111)").run(
    id,
    label,
    JSON.stringify({ email, quotaLimit: 1, quotaUsage: 1, catalog: { from: 'fleet-manager-v1' } }),
    status,
  );
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-drive-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  fake = new FakeGoogle();
  sleeps = [];
  vaultState = 'unlocked';
  secrets = new Map([
    ['google.clientId', 'client-id-123'],
    ['google.clientSecret', 'GOCSPX-client-secret-abc'],
    [`gdrive.refreshToken.${PLACE_A}`, '1//refresh-token-alice'],
    [`gdrive.refreshToken.${PLACE_B}`, '1//refresh-token-bob'],
  ]);
  addPlace(PLACE_A, 'Alice', 'alice@example.com');
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

function alice(): FakeAccount {
  return fake.add(new FakeAccount('alice@example.com', '1//refresh-token-alice'));
}
function bob(): FakeAccount {
  addPlace(PLACE_B, 'Bob', 'bob@example.com');
  return fake.add(new FakeAccount('bob@example.com', '1//refresh-token-bob'));
}

interface Run {
  message: string;
  warns: string[];
  logs: string[];
  checkpoints: unknown[];
  progress: string[];
}

function makeHttp(): GoogleHttp {
  return new GoogleHttp({ fetchFn: fake.fetchFn, sleep: (ms) => Promise.resolve(void sleeps.push(ms)) });
}

/** Runs the handler directly with a stand-in context. Throws what the handler throws. */
async function run(placeIds: string[], options: { resume?: unknown; abortAfterYields?: number } = {}): Promise<Run> {
  const out: Run = { message: '', warns: [], logs: [], checkpoints: [], progress: [] };
  let yields = 0;
  const http = makeHttp();
  const auth = new GoogleAuth(vault, http);
  const ctx: JobContext = {
    jobId: 1,
    params: { placeIds },
    resume: options.resume ?? null,
    signal: new AbortController().signal,
    progress: (_d, _t, extras) => void (extras?.message && out.progress.push(extras.message)),
    log: (_l, text) => void out.logs.push(text),
    warn: (text) => void (out.warns.push(text), out.logs.push(text)),
    needsYou: () => Promise.reject(new Error('not used')),
    checkpoint: (value) => void out.checkpoints.push(JSON.parse(JSON.stringify(value))),
    yield: async () => {
      yields += 1;
      if (yields > (options.abortAfterYields ?? Infinity)) throw new JobAborted();
    },
  };
  const handler = refreshHandler({ db, api: new DriveApi(http, auth), auth, log: silent, tempRoot: path.join(dir, 'drive-tmp'), now: () => 5_000_000 });
  const result = await handler.run(ctx);
  out.message = typeof result === 'string' ? result : '';
  return out;
}

interface FileRow {
  id: number;
  rel_path: string;
  ext_id: string;
  size: number | null;
  md5: string | null;
  mime: string | null;
  gone_at: number | null;
}
const files = (placeId = PLACE_A): FileRow[] =>
  db.prepare('SELECT id, rel_path, ext_id, size, md5, mime, gone_at FROM files WHERE place_id = ? ORDER BY rel_path').all(placeId) as FileRow[];
const liveFiles = (placeId = PLACE_A): Record<string, string> => Object.fromEntries(files(placeId).filter((f) => f.gone_at === null).map((f) => [f.ext_id, f.rel_path]));
const place = (id = PLACE_A) => db.prepare('SELECT status, last_looked_at, identity_json FROM places WHERE id = ?').get(id) as { status: string; last_looked_at: number | null; identity_json: string };
const identity = (id = PLACE_A): Record<string, unknown> => JSON.parse(place(id).identity_json) as Record<string, unknown>;

function seedTree(a: FakeAccount): void {
  a.folder('d1', 'Docs');
  a.folder('d2', 'Taxes', 'd1');
  a.file('f1', 'readme.txt');
  a.file('f2', 'return.pdf', 'd2');
  a.file('f3', 'photo.jpg', 'd1');
  a.put({ id: 'f4', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['d1'] }); // no size, no md5
}

describe('migration 0008', () => {
  it('adds drive_items and drive_sync', () => {
    expect(MIGRATIONS.length).toBeGreaterThanOrEqual(8);
    expect(currentSchemaVersion(db)).toBe(MIGRATIONS.length);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; notnull: number; pk: number }[]).map((c) => `${c.name}:${c.notnull}:${c.pk}`);
    expect(cols('drive_items')).toEqual(['place_id:1:1', 'ext_id:1:2', 'parent_ext_id:0:0', 'name:1:0', 'is_folder:1:0']);
    expect(cols('drive_sync')).toEqual(['place_id:0:1', 'changes_token:0:0', 'full_listed_at:0:0', 'changes_at:0:0']);
  });
});

describe('the first refresh (full list)', () => {
  it('saves quota, builds paths, keeps ids of rows imported earlier, and sets the bookmark', async () => {
    const a = alice();
    seedTree(a);
    // A row the v1 import made: same ext_id, old path, must keep its id.
    db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, md5, ext_id, mime, first_seen_at, last_seen_at) VALUES (?, 'My Drive/Old Name.txt', 10, 1, 'md5-f1', 'f1', 'text/plain', 1, 1)").run(PLACE_A);
    const oldId = files()[0]!.id;

    const r = await run([PLACE_A]);
    expect(r.warns).toEqual([]);
    expect(liveFiles()).toEqual({
      f1: 'My Drive/readme.txt',
      f2: 'My Drive/Docs/Taxes/return.pdf',
      f3: 'My Drive/Docs/photo.jpg',
      f4: 'My Drive/Docs/Budget',
    });
    expect(files().find((f) => f.ext_id === 'f1')?.id).toBe(oldId);
    expect(files().find((f) => f.ext_id === 'f4')).toMatchObject({ size: null, md5: null, mime: 'application/vnd.google-apps.spreadsheet' });
    // Folders are never file rows, but they are in drive_items.
    expect(files().some((f) => f.ext_id === 'd1')).toBe(false);
    expect((db.prepare('SELECT count(*) AS n FROM drive_items WHERE place_id = ?').get(PLACE_A) as { n: number }).n).toBe(6);
    expect(db.prepare("SELECT is_folder FROM drive_items WHERE ext_id = 'd2'").get()).toEqual({ is_folder: 1 });

    expect(place().status).toBe('connected');
    expect(place().last_looked_at).toBe(5_000_000);
    expect(identity()).toMatchObject({ quotaLimit: 16106127360, quotaUsage: 5000, quotaUsageDrive: 3000, quotaUsageTrash: 100, lastQuotaAt: 5_000_000, email: 'alice@example.com' });
    expect((identity()['catalog'] as { from: string }).from).toBe('drive-api');
    const sync = getSync(db, PLACE_A);
    expect(sync.changesToken).toBe('c6'); // taken at the start: after the six seeded items
    expect(sync.fullListedAt).toBe(5_000_000);
    expect(fake.calls.map((c) => c.method)).not.toContain('DELETE');
    expect(fake.calls.every((c) => c.method === 'GET' || c.path === '/token')).toBe(true);
  });

  it('takes the bookmark before the list, so changes made during the list are replayed next time', async () => {
    const a = alice();
    seedTree(a);
    // While the list is being read, someone adds a file.
    let added = false;
    fake.override = (call) => {
      if (call.path === '/drive/v3/files' && call.query['pageToken'] === 'p2' && !added) {
        added = true;
        a.file('f9', 'late.txt');
      }
      return null;
    };
    await run([PLACE_A]);
    expect(getSync(db, PLACE_A).changesToken).toBe('c6');
    fake.override = null;
    await run([PLACE_A]);
    expect(liveFiles()['f9']).toBe('My Drive/late.txt');
  });
});

describe('resume', () => {
  it('asks only for the pages after the checkpoint and ends with the full list', async () => {
    const a = alice();
    for (let i = 1; i <= 7; i += 1) a.file(`g${i}`, `file${i}.txt`);
    fake.pageSize = 2;
    const checkpoints: unknown[] = [];
    // Run once, capturing checkpoints through a second harness call that aborts.
    const out: Run = { message: '', warns: [], logs: [], checkpoints, progress: [] };
    let yields = 0;
    const http = makeHttp();
    const auth = new GoogleAuth(vault, http);
    const base = { db, api: new DriveApi(http, auth), auth, log: silent, tempRoot: path.join(dir, 'drive-tmp'), now: () => 5_000_000 };
    const ctx = (resume: unknown, abortAt: number): JobContext => ({
      jobId: 1,
      params: { placeIds: [PLACE_A] },
      resume,
      signal: new AbortController().signal,
      progress: () => undefined,
      log: (_l, t) => void out.logs.push(t),
      warn: (t) => void out.warns.push(t),
      needsYou: () => Promise.reject(new Error('x')),
      checkpoint: (v) => void checkpoints.push(JSON.parse(JSON.stringify(v))),
      yield: async () => {
        yields += 1;
        if (yields > abortAt) throw new JobAborted();
      },
    });
    await expect(refreshHandler(base).run(ctx(null, 3))).rejects.toBeInstanceOf(JobAborted);
    expect(files()).toHaveLength(0);
    const last = checkpoints.at(-1) as { list: { pageToken: string; complete: boolean; count: number } };
    expect(last.list).toMatchObject({ pageToken: 'p6', complete: false, count: 6 });
    expect(getSync(db, PLACE_A).changesToken).toBeNull();

    fake.calls.length = 0;
    yields = 0;
    await refreshHandler(base).run(ctx(last, Infinity));
    const asked = fake.calls.filter((c) => c.path === '/drive/v3/files').map((c) => c.query['pageToken']);
    expect(asked).toEqual(['p6']);
    expect(fake.count('/drive/v3/changes/startPageToken')).toBe(0); // the bookmark was taken before and kept in the checkpoint
    expect(Object.keys(liveFiles())).toHaveLength(7);
    expect(getSync(db, PLACE_A).changesToken).toBe('c7');
  });

  it('starts the list again if the scratch list was lost', async () => {
    const a = alice();
    for (let i = 1; i <= 5; i += 1) a.file(`g${i}`, `file${i}.txt`);
    const resume = { nextIndex: 0, totals: {}, itemsSeen: 4, list: { placeId: PLACE_A, startToken: 'c0', pageToken: 'p4', complete: false, bytes: 999, count: 4 } };
    await run([PLACE_A], { resume });
    expect(Object.keys(liveFiles())).toHaveLength(5);
    expect(fake.count('/drive/v3/changes/startPageToken')).toBe(1);
  });
});

describe('gone marking', () => {
  it('marks rows missing from the list only after a complete list, and never deletes', async () => {
    const a = alice();
    a.file('f1', 'a.txt');
    a.file('f2', 'b.txt');
    a.file('f3', 'c.txt');
    db.prepare("INSERT INTO files (place_id, rel_path, size, ext_id, first_seen_at, last_seen_at) VALUES (?, 'My Drive/deleted-long-ago.txt', 1, 'zz', 1, 1)").run(PLACE_A);

    fake.pageSize = 1;
    await expect(run([PLACE_A], { abortAfterYields: 2 })).rejects.toBeInstanceOf(JobAborted);
    expect(files().filter((f) => f.gone_at !== null)).toHaveLength(0);

    await run([PLACE_A]);
    const all = files();
    expect(all.find((f) => f.ext_id === 'zz')?.gone_at).toBe(5_000_000);
    expect(all.filter((f) => f.gone_at === null).map((f) => f.ext_id).toSorted()).toEqual(['f1', 'f2', 'f3']);
    expect(all).toHaveLength(4); // nothing deleted
  });

  it('a file that comes back loses its gone mark', async () => {
    const a = alice();
    a.file('f1', 'a.txt');
    db.prepare("INSERT INTO files (place_id, rel_path, size, ext_id, first_seen_at, last_seen_at, gone_at) VALUES (?, 'My Drive/a.txt', 1, 'f1', 1, 1, 77)").run(PLACE_A);
    await run([PLACE_A]);
    expect(files()[0]!.gone_at).toBeNull();
  });
});

describe('changes since the bookmark', () => {
  async function firstThenChange(mutate: (a: FakeAccount) => void): Promise<{ a: FakeAccount; r: Run }> {
    const a = alice();
    seedTree(a);
    await run([PLACE_A]);
    expect(getSync(db, PLACE_A).changesToken).toBe('c6');
    mutate(a);
    fake.calls.length = 0;
    const r = await run([PLACE_A]);
    return { a, r };
  }

  it('does nothing but move the clock when nothing changed', async () => {
    const { r } = await firstThenChange(() => undefined);
    expect(r.warns).toEqual([]);
    expect(fake.count('/drive/v3/files')).toBe(0); // no full list
    expect(Object.keys(liveFiles())).toHaveLength(4);
    expect(getSync(db, PLACE_A).changesToken).toBe('c6');
  });

  it('adds new files, with paths', async () => {
    await firstThenChange((a) => {
      a.file('n1', 'new.txt', 'd2');
      a.folder('d3', 'Fresh');
      a.file('n2', 'inside.txt', 'd3');
    });
    expect(liveFiles()['n1']).toBe('My Drive/Docs/Taxes/new.txt');
    expect(liveFiles()['n2']).toBe('My Drive/Fresh/inside.txt');
    expect(getSync(db, PLACE_A).changesToken).toBe('c9');
  });

  it('renames a file', async () => {
    const before = files().length;
    await firstThenChange((a) => a.put({ id: 'f1', name: 'README-final.txt' }));
    expect(liveFiles()['f1']).toBe('My Drive/README-final.txt');
    expect(files().length).toBe(before + 4);
  });

  it('changes the paths of everything below a renamed or moved folder', async () => {
    await firstThenChange((a) => {
      a.put({ id: 'd1', name: 'Papers' }); // rename
      a.folder('d9', 'Archive');
      a.put({ id: 'd2', parents: ['d9'] }); // move Taxes under Archive
    });
    expect(liveFiles()).toEqual({
      f1: 'My Drive/readme.txt',
      f2: 'My Drive/Archive/Taxes/return.pdf',
      f3: 'My Drive/Papers/photo.jpg',
      f4: 'My Drive/Papers/Budget',
    });
  });

  it('gives a renamed file, and everything below a renamed folder, the kind of the new path at once, and keeps the rest', async () => {
    const a = alice();
    seedTree(a);
    await run([PLACE_A]);
    classifyChunk(db, 0);
    const kinds = (): Record<string, string | null> =>
      Object.fromEntries((db.prepare('SELECT ext_id, kind FROM files WHERE place_id = ? AND ext_id IS NOT NULL').all(PLACE_A) as { ext_id: string; kind: string | null }[]).map((r) => [r.ext_id, r.kind]));
    expect(kinds()).toEqual({ f1: 'documents', f2: 'documents', f3: 'photo-other', f4: 'google-docs' });
    a.put({ id: 'f1', name: 'README.zip' }); // renamed (and now an archive)
    a.put({ id: 'd1', name: 'Papers' }); // below it: f2, f3 and f4 get new paths
    await run([PLACE_A]);
    // No row is left without a kind: the refresh sets it when it writes the row (the renamed file is now an archive).
    expect(kinds()).toEqual({ f1: 'archives', f2: 'documents', f3: 'photo-other', f4: 'google-docs' });
    // A refresh that changes nothing about a row leaves its kind alone.
    await run([PLACE_A]);
    expect(kinds()).toEqual({ f1: 'archives', f2: 'documents', f3: 'photo-other', f4: 'google-docs' });
  });

  it('keeps the same row (id) when a file moves', async () => {
    const a = alice();
    seedTree(a);
    await run([PLACE_A]);
    const id = files().find((f) => f.ext_id === 'f1')!.id;
    a.put({ id: 'f1', parents: ['d2'] });
    await run([PLACE_A]);
    expect(files().find((f) => f.ext_id === 'f1')).toMatchObject({ id, rel_path: 'My Drive/Docs/Taxes/readme.txt', gone_at: null });
  });

  it('drops trashed, removed and no-longer-mine items (rows get gone_at, drive_items lose them)', async () => {
    await firstThenChange((a) => {
      a.put({ id: 'f1', trashed: true });
      a.remove('f2');
      a.put({ id: 'f3', ownedByMe: false });
    });
    expect(liveFiles()).toEqual({ f4: 'My Drive/Docs/Budget' });
    const gone = files().filter((f) => f.gone_at !== null).map((f) => f.ext_id).toSorted();
    expect(gone).toEqual(['f1', 'f2', 'f3']);
    expect(gone.every((id) => files().find((f) => f.ext_id === id)!.gone_at === 5_000_000)).toBe(true);
    const items = (db.prepare('SELECT ext_id FROM drive_items WHERE place_id = ?').all(PLACE_A) as { ext_id: string }[]).map((r) => r.ext_id).toSorted();
    expect(items).toEqual(['d1', 'd2', 'f4']);
  });

  it('warns when a file leaves Drive while no other place holds a copy, and only then', async () => {
    const a = alice();
    seedTree(a);
    await run([PLACE_A]);
    // f2 also exists on the laptop (same md5 and size); f1 and f3 do not.
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('laptop-x', 1, 'laptop', 'Laptop', 'connected', 1)").run();
    db.prepare("INSERT INTO files (place_id, rel_path, size, md5, first_seen_at, last_seen_at, cloud_only) VALUES ('laptop-x', 'D:/return.pdf', 10, 'md5-f2', 1, 1, 0)").run();
    a.remove('f1');
    a.remove('f2');
    a.remove('f3');
    const r = await run([PLACE_A]);
    const alert = r.warns.filter((w) => w.startsWith('Last copy gone: '));
    expect(alert).toHaveLength(1);
    expect(alert[0]).toContain('2 files');
    expect(alert[0]).toMatch(/readme\.txt|photo\.jpg/);
    expect(alert[0]).not.toContain('return.pdf');
  });

  it('does not raise that alert for a file that merely moved or was renamed', async () => {
    const { r } = await firstThenChange((a) => a.put({ id: 'f1', name: 'renamed.txt' }));
    expect(r.warns.filter((w) => w.startsWith('Last copy gone: '))).toEqual([]);
  });

  it('a trashed file that is restored comes back', async () => {
    const a = alice();
    seedTree(a);
    await run([PLACE_A]);
    a.put({ id: 'f1', trashed: true });
    await run([PLACE_A]);
    expect(liveFiles()['f1']).toBeUndefined();
    a.put({ id: 'f1', trashed: false });
    await run([PLACE_A]);
    expect(liveFiles()['f1']).toBe('My Drive/readme.txt');
  });

  it('two files that would share a path get their id added, as in the first import', async () => {
    await firstThenChange((a) => a.file('dup1', 'readme.txt'));
    const paths = Object.values(liveFiles());
    expect(paths.filter((p) => p.startsWith('My Drive/readme'))).toHaveLength(2);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('a folder moved into a folder that has not been seen yet does not crash', async () => {
    await firstThenChange((a) => a.file('n5', 'orphan.txt', 'someone-elses-folder'));
    expect(liveFiles()['n5']).toBe('(unknown folder)/orphan.txt');
  });

  it('stops with a warning and keeps the old bookmark when the next-page token does not advance', async () => {
    const a = alice();
    seedTree(a);
    await run([PLACE_A]);
    a.file('n1', 'x.txt');
    fake.stallChanges = true;
    const r = await run([PLACE_A]);
    expect(r.warns.join(' ')).toMatch(/did not move on/);
    expect(getSync(db, PLACE_A).changesToken).toBe('c6');
    expect(liveFiles()['n1']).toBeUndefined();
    expect(r.message).toMatch(/could not be refreshed/);
  });

  it('keeps the old bookmark when the run is stopped half way', async () => {
    const a = alice();
    seedTree(a);
    await run([PLACE_A]);
    for (let i = 0; i < 5; i += 1) a.file(`n${i}`, `n${i}.txt`);
    await expect(run([PLACE_A], { abortAfterYields: 2 })).rejects.toBeInstanceOf(JobAborted);
    expect(getSync(db, PLACE_A).changesToken).toBe('c6');
    expect(liveFiles()['n0']).toBeUndefined();
  });

  it('answers 410 by clearing the bookmark and reading the whole list again', async () => {
    const a = alice();
    seedTree(a);
    await run([PLACE_A]);
    a.remove('f1');
    a.file('n1', 'x.txt');
    fake.changesGone = true;
    fake.calls.length = 0;
    const r = await run([PLACE_A]);
    // The removed file was the only copy anywhere, so that (and only that) is warned about.
    expect(r.warns.map((w) => w.slice(0, 40))).toEqual(['Last copy gone: Alice: 1 file (1 MB) lef']);
    expect(fake.count('/drive/v3/files')).toBeGreaterThan(0);
    expect(liveFiles()['f1']).toBeUndefined();
    expect(liveFiles()['n1']).toBe('My Drive/x.txt');
    expect(getSync(db, PLACE_A).changesToken).toMatch(/^c\d+$/);
    expect(files().find((f) => f.ext_id === 'f1')?.gone_at).not.toBeNull();
  });
});

describe('accounts and errors', () => {
  it('skips an account whose sign-in belongs to another e-mail and changes nothing for it', async () => {
    const a = new FakeAccount('someone.else@example.com', '1//refresh-token-alice');
    fake.add(a);
    seedTree(a);
    const r = await run([PLACE_A]);
    expect(r.warns.join(' ')).toMatch(/different Google account/);
    expect(files()).toHaveLength(0);
    expect(place().status).toBe('unknown');
    expect(place().last_looked_at).toBe(111);
    expect(identity()['quotaUsage']).toBe(1);
    expect(getSync(db, PLACE_A).changesToken).toBeNull();
    expect(fake.count('/drive/v3/files')).toBe(0);
  });

  it('invalid_grant marks the account needs_signin and carries on with the next one', async () => {
    const a = alice();
    a.revoked = true;
    const b = bob();
    b.file('b1', 'bob.txt');
    const r = await run([PLACE_A, PLACE_B]);
    expect(place(PLACE_A).status).toBe('needs_signin');
    expect(place(PLACE_B).status).toBe('connected');
    expect(liveFiles(PLACE_B)).toEqual({ b1: 'My Drive/bob.txt' });
    expect(r.warns).toHaveLength(1);
    expect(r.warns[0]).toMatch(/Alice needs signing in again/);
    expect(r.message).toMatch(/1 needs signing in again/);
  });

  it('a 401 gets one new access token and one retry', async () => {
    const a = alice();
    a.file('f1', 'a.txt');
    let tokenCalls = 0;
    fake.override = (call) => {
      if (call.path === '/token') tokenCalls += 1;
      if (call.path === '/drive/v3/about' && tokenCalls === 1) {
        fake.expireTokens(); // the first token stops working just before about
      }
      return null;
    };
    await run([PLACE_A]);
    expect(tokenCalls).toBeGreaterThanOrEqual(2);
    expect(place().status).toBe('connected');
    expect(liveFiles()).toEqual({ f1: 'My Drive/a.txt' });
  });

  it('a 401 that stays a 401 becomes needs_signin instead of looping', async () => {
    const a = alice();
    a.file('f1', 'a.txt');
    fake.override = (call) => (call.path === '/drive/v3/about' ? new Response(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }), { status: 401 }) : null);
    await run([PLACE_A]);
    expect(place().status).toBe('needs_signin');
    expect(fake.count('/token')).toBe(2);
  });

  it('with no internet the account ends with a plain warning and nothing changes', async () => {
    const a = alice();
    seedTree(a);
    bob();
    fake.override = () => {
      throw new TypeError('fetch failed');
    };
    const r = await run([PLACE_A, PLACE_B]);
    expect(r.warns[0]).toBe('No internet connection; nothing was changed for Alice.');
    expect(r.warns).toHaveLength(2); // and one for the account that was not tried
    expect(files()).toHaveLength(0);
    expect(place().status).toBe('unknown');
  });

  it('a locked vault stops the job with the plain sentence, before any request', async () => {
    alice();
    vaultState = 'locked';
    await expect(run([PLACE_A])).rejects.toMatchObject({
      plain: 'The saved sign-ins are locked. Type your recovery passphrase in Settings > Security first.',
    });
    await expect(run([PLACE_A])).rejects.toBeInstanceOf(JobFailure);
    expect(fake.calls).toHaveLength(0);
  });

  it('retries 429 and 5xx with 1 s, 2 s, 4 s waits and honours Retry-After', async () => {
    const a = alice();
    a.file('f1', 'a.txt');
    let aboutTries = 0;
    fake.override = (call) => {
      if (call.path !== '/drive/v3/about') return null;
      aboutTries += 1;
      if (aboutTries === 1) return new Response('{}', { status: 503 });
      if (aboutTries === 2) return new Response(JSON.stringify({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }), { status: 403, headers: { 'Retry-After': '7' } });
      if (aboutTries === 3) return new Response('{}', { status: 429 });
      return null;
    };
    await run([PLACE_A]);
    expect(aboutTries).toBe(4);
    expect(sleeps).toEqual([1000, 7000, 4000]);
    expect(place().status).toBe('connected');
  });

  it('gives up after five tries and warns without changing anything', async () => {
    const a = alice();
    a.file('f1', 'a.txt');
    fake.override = (call) => (call.path === '/drive/v3/about' ? new Response('{}', { status: 500 }) : null);
    const r = await run([PLACE_A]);
    expect(fake.count('/drive/v3/about')).toBe(5);
    expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
    expect(r.warns.join(' ')).toMatch(/Google said no \(500\)/);
    expect(files()).toHaveLength(0);
  });

  it('never puts a token, secret or Authorization header in warnings, logs, checkpoints or the job result', async () => {
    const a = alice();
    seedTree(a);
    a.revoked = false;
    const bobAccount = bob();
    bobAccount.revoked = true;
    fake.override = (call) =>
      call.path === '/drive/v3/files' && call.account === 'alice@example.com' && call.query['pageToken'] === 'p2'
        ? new Response(JSON.stringify({ error: { message: 'bad token ya29.fake-1 and 1//refresh-token-alice and GOCSPX-client-secret-abc' } }), { status: 400 })
        : null;
    const r = await run([PLACE_A, PLACE_B]);
    const everything = JSON.stringify([r.warns, r.logs, r.checkpoints, r.message, r.progress, db.prepare('SELECT * FROM places').all()]);
    for (const secret of ['ya29.', '1//refresh-token', 'GOCSPX', 'client-id-123', 'Bearer ']) expect(everything).not.toContain(secret);
  });

  it('refreshes the accounts one after another and reports a summary', async () => {
    const a = alice();
    seedTree(a);
    const b = bob();
    b.file('b1', 'bob.txt');
    const r = await run([PLACE_A, PLACE_B]);
    expect(r.message).toBe('Refreshed 2 of 2 Google accounts. 5 new files and 0 files no longer in Drive.');
    expect(r.progress.some((m) => m.startsWith('Refreshing Alice: '))).toBe(true);
    expect(liveFiles(PLACE_B)).toEqual({ b1: 'My Drive/bob.txt' });
    expect(fake.calls.filter((c) => c.account === 'alice@example.com').length).toBeGreaterThan(0);
    // Each account's requests carried only its own token.
    expect(fake.calls.filter((c) => c.path === '/drive/v3/files' && c.account === 'bob@example.com')).toHaveLength(1);
  });
});
