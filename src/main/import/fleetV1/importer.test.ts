import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, type Db } from '../../db';
import { JobAborted, JobFailure, type JobContext, type JobHandler } from '../../jobs/jobService';
import { VaultService, type KeyProtector } from '../../vault/vaultService';
import { decryptV10 } from './decrypt';
import { CLIENT_ID, CLIENT_SECRET, folder, makeFixture, type FixtureAccount, type FixtureFile } from './fixture.testutil';
import { fleetV1Handler, refreshTokenSecretName, SECRET_CLIENT_ID, SECRET_CLIENT_SECRET, summaryText, zeroCounts, type ImportVault } from './importer';
import { FOLDER_MIME } from './paths';
import { setSync } from '../../google/driveStore';

function fakeProtector(): KeyProtector {
  const machineKey = randomBytes(32);
  return {
    isAvailable: () => true,
    protect(plain: Buffer): Buffer {
      const nonce = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', machineKey, nonce);
      const body = Buffer.concat([c.update(plain), c.final()]);
      return Buffer.concat([nonce, c.getAuthTag(), body]);
    },
    unprotect(blob: Buffer): Buffer {
      const d = createDecipheriv('aes-256-gcm', machineKey, blob.subarray(0, 12));
      d.setAuthTag(blob.subarray(12, 28));
      return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
    },
  };
}

const TOKEN = (n: number) => `1//SYNTHETIC-REFRESH-TOKEN-${n}-zzz`;

interface Harness {
  texts: string[];
  warns: string[];
  progress: { done: number; total: number; message: string | undefined }[];
  checkpoints: unknown[];
  ctx: (resume?: unknown, abortAfterYields?: number) => JobContext;
}

function harness(): Harness {
  const h: Harness = {
    texts: [],
    warns: [],
    progress: [],
    checkpoints: [],
    ctx: (resume = null, abortAfterYields = Infinity) => {
      let yields = 0;
      return {
        jobId: 1,
        params: { confirmed: true },
        resume,
        signal: new AbortController().signal,
        progress: (done, total, extras) => h.progress.push({ done, total, message: extras?.message }),
        log: (_level, text) => h.texts.push(text),
        warn: (text) => {
          h.warns.push(text);
          h.texts.push(text);
        },
        needsYou: () => Promise.reject(new Error('not used')),
        checkpoint: (value) => h.checkpoints.push(JSON.parse(JSON.stringify(value))),
        yield: async () => {
          yields += 1;
          if (yields > abortAfterYields) throw new JobAborted();
        },
      };
    },
  };
  return h;
}

let root: string;
let dataDir: string;
let sourceDir: string;
let db: Db;
let vault: VaultService;
let logged: string[];

const logger = {
  info: (...a: unknown[]) => void logged.push(a.map(String).join(' ')),
  warn: (...a: unknown[]) => void logged.push(a.map(String).join(' ')),
  error: (...a: unknown[]) => void logged.push(a.map(String).join(' ')),
};
const silent = { info: () => {}, warn: () => {}, error: () => {} };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-importv1-'));
  dataDir = path.join(root, 'data');
  sourceDir = path.join(root, 'archive');
  fs.mkdirSync(dataDir);
  const opened = initDatabase(dataDir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  vault = new VaultService({ db, dataDir, protector: fakeProtector(), kdf: { N: 1024, r: 8, p: 1 } });
  logged = [];
});
afterEach(() => {
  vault.close();
  closeDatabase(db, silent);
  // Fixture files may carry the read-only attribute.
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

const accounts: FixtureAccount[] = [
  { id: 1, email: 'alpha.synthetic@example.invalid', nickname: 'Alpha', token: TOKEN(1), completedAt: 1_760_000_000_000 },
  { id: 2, email: 'beta.synthetic@example.invalid', token: TOKEN(2), quotaLimit: 100, quotaUsage: 50 },
  { id: 3, email: 'gamma.synthetic@example.invalid', token: TOKEN(3) },
];

const files: FixtureFile[] = [
  folder(1, 'F-photos', 'Photos', 'ROOT-1'),
  folder(1, 'F-2026', '2026', 'F-photos'),
  { account: 1, id: 'a1', name: 'trip.jpg', mime: 'image/jpeg', size: 1234, md5: 'ABCDEF0123456789ABCDEF0123456789', modified: '2026-03-04T10:20:30.000Z', link: 'https://example.invalid/a1', parent: 'F-2026' },
  { account: 1, id: 'a2', name: 'Budget', mime: 'application/vnd.google-apps.spreadsheet', parent: 'ROOT-1' },
  { account: 1, id: 'a3', name: 'old.txt', mime: 'text/plain', size: 5, md5: 'aa', parent: 'ROOT-1', trashed: true },
  { account: 1, id: 'a4', name: 'stray.png', mime: 'image/png', size: 9, md5: 'bb', parent: 'MISSING-FOLDER' },
  { account: 1, id: 'a5', name: 'root.txt', mime: 'text/plain', size: 7, md5: 'cc', parent: 'ROOT-1' },
  { account: 2, id: 'b1', name: 'doc.pdf', mime: 'application/pdf', size: 99, md5: 'dd', parent: 'ROOT-2' },
  folder(2, 'G-dup', 'Same', 'ROOT-2'),
  { account: 2, id: 'b2', name: 'twin.txt', mime: 'text/plain', size: 1, md5: 'e1', parent: 'G-dup' },
  { account: 2, id: 'b3', name: 'twin.txt', mime: 'text/plain', size: 2, md5: 'e2', parent: 'G-dup' },
  folder(3, 'C-a', 'Loop A', 'C-b'),
  folder(3, 'C-b', 'Loop B', 'C-a'),
  { account: 3, id: 'c1', name: 'in-loop.txt', mime: 'text/plain', size: 3, md5: 'ff', parent: 'C-a' },
];

function setup(opts: { accts?: FixtureAccount[]; rows?: FixtureFile[]; readOnly?: boolean; clientSecret?: string | null } = {}) {
  return makeFixture(sourceDir, { accounts: opts.accts ?? accounts, files: opts.rows ?? files, readOnly: opts.readOnly ?? false, ...(opts.clientSecret !== undefined ? { clientSecret: opts.clientSecret } : {}) });
}

function handlerFor(fx: ReturnType<typeof setup>, over: { vault?: ImportVault; now?: () => number } = {}): JobHandler {
  return fleetV1Handler({
    db,
    vault: over.vault ?? vault,
    tempRoot: path.join(dataDir, 'import-tmp'),
    log: logger,
    sourceDir,
    dpapiUnprotect: fx.dpapi,
    now: over.now ?? (() => 1_800_000_000_000),
  });
}

interface PlaceT {
  id: string;
  label: string;
  status: string;
  identity_json: string;
  last_looked_at: number | null;
  profile_id: number;
}
interface FileT {
  ext_id: string;
  rel_path: string;
  name: string;
  size: number | null;
  md5: string | null;
  mtime: number | null;
  mime: string | null;
  web_link: string | null;
  first_seen_at: number;
  last_seen_at: number;
  gone_at: number | null;
}
const byText = (a: string, b: string) => a.localeCompare(b);
const sha = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const placeRows = () => db.prepare("SELECT * FROM places WHERE kind = 'gdrive' ORDER BY label").all() as PlaceT[];
const fileRows = (placeId: string) => db.prepare('SELECT * FROM files WHERE place_id = ? ORDER BY ext_id').all(placeId) as FileT[];
const placeIdOf = (email: string) => placeRows().find((p) => JSON.parse(p.identity_json).email === email)!.id;
const tempLeft = () => (fs.existsSync(path.join(dataDir, 'import-tmp')) ? fs.readdirSync(path.join(dataDir, 'import-tmp')) : []);

describe('import.fleetV1: accounts and secrets', () => {
  it('creates one gdrive place per account with identity, labels and the vault secrets', async () => {
    const fx = setup();
    const h = harness();
    const summary = await handlerFor(fx).run(h.ctx());

    const rows = placeRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.label).toSorted(byText)).toEqual(['Alpha', 'beta.synthetic@example.invalid', 'gamma.synthetic@example.invalid']);
    const profile = db.prepare("SELECT name FROM profiles WHERE id = ?").get(rows[0]!.profile_id) as { name: string };
    expect(profile.name).toBe('You');

    const alpha = rows.find((r) => r.label === 'Alpha')!;
    const identity = JSON.parse(alpha.identity_json);
    expect(identity).toMatchObject({
      email: 'alpha.synthetic@example.invalid',
      accountId: 1,
      quotaLimit: 15_000_000_000,
      quotaUsage: 2_000_000_000,
      quotaUsageDrive: 100,
      quotaUsageTrash: 5,
      lastQuotaAt: 1_700_000_000_000,
      catalog: { from: 'fleet-manager-v1', v1CompletedAt: 1_760_000_000_000 },
    });
    expect(alpha.last_looked_at).toBe(1_760_000_000_000);
    expect(alpha.status).toBe('unknown');

    expect(vault.getSecretText(SECRET_CLIENT_ID)).toBe(CLIENT_ID);
    expect(vault.getSecretText(SECRET_CLIENT_SECRET)).toBe(CLIENT_SECRET);
    expect(vault.getSecretText(refreshTokenSecretName(alpha.id))).toBe(TOKEN(1));
    expect(vault.getSecretText(refreshTokenSecretName(placeIdOf('beta.synthetic@example.invalid')))).toBe(TOKEN(2));
    expect(summary).toContain('3 Google accounts');
    expect(summary).toContain('3 sign-ins unlocked, 0 need signing in again');
    // Without a v1 catalog time, an account that has files gets the import time.
    const beta = rows.find((r) => r.label.startsWith('beta'))!;
    expect(beta.last_looked_at).toBe(1_800_000_000_000);
  });

  it('marks an account whose sign-in cannot be unlocked as needs_signin and carries on', async () => {
    const fx = setup({ accts: accounts.map((a) => (a.id === 2 ? { ...a, token: 'CORRUPT' } : a)) });
    const h = harness();
    const summary = await handlerFor(fx).run(h.ctx());
    const beta = placeRows().find((r) => r.label.startsWith('beta'))!;
    expect(beta.status).toBe('needs_signin');
    expect(vault.getSecretText(refreshTokenSecretName(beta.id))).toBeNull();
    expect(placeRows().filter((r) => r.status === 'unknown')).toHaveLength(2);
    const tokenWarns = h.warns.filter((w) => w.includes('sign-in could not be brought in'));
    expect(tokenWarns).toHaveLength(1);
    expect(tokenWarns[0]).toContain('Account 2');
    expect(summary).toContain('2 sign-ins unlocked, 1 need signing in again');
    // Its files are still brought in.
    expect(fileRows(beta.id).length).toBeGreaterThan(0);
  });

  it('marks an account with no saved sign-in, or one v1 flagged reauth_needed, as needs_signin', async () => {
    const fx = setup({ accts: [{ ...accounts[0]!, token: null }, { ...accounts[1]!, status: 'reauth_needed' }, accounts[2]!] });
    await handlerFor(fx).run(harness().ctx());
    const byEmail = (e: string) => placeRows().find((r) => JSON.parse(r.identity_json).email === e)!;
    expect(byEmail('alpha.synthetic@example.invalid').status).toBe('needs_signin');
    expect(byEmail('beta.synthetic@example.invalid').status).toBe('needs_signin');
    expect(byEmail('gamma.synthetic@example.invalid').status).toBe('unknown');
  });

  it('when Windows cannot unlock the v1 key, every account needs signing in but accounts and files still come in', async () => {
    const fx = setup();
    const failing = fleetV1Handler({
      db,
      vault,
      tempRoot: path.join(dataDir, 'import-tmp'),
      log: logger,
      sourceDir,
      dpapiUnprotect: async () => {
        throw new Error('Key not valid for use in specified state.');
      },
      now: () => 1_800_000_000_000,
    });
    const h = harness();
    const summary = await failing.run(h.ctx());
    expect(placeRows().every((r) => r.status === 'needs_signin')).toBe(true);
    expect(summary).toContain('0 sign-ins unlocked, 3 need signing in again');
    expect(vault.getSecretText(SECRET_CLIENT_SECRET)).toBeNull();
    expect(vault.getSecretText(SECRET_CLIENT_ID)).toBe(CLIENT_ID);
    expect(h.warns.some((w) => w.includes('Windows could not unlock'))).toBe(true);
    expect(db.prepare('SELECT count(*) AS n FROM files').get()).toMatchObject({ n: 8 });
    void fx;
  });

  it('writes no secret material to any log, warning, summary or progress text', async () => {
    const fx = setup();
    const h = harness();
    const summary = (await handlerFor(fx).run(h.ctx())) as string;
    const everything = [...h.texts, ...logged, summary, ...h.progress.map((p) => p.message ?? '')].join('\n');
    const needles = [CLIENT_SECRET, 'SYNTHETIC-REFRESH-TOKEN', fx.key.toString('hex'), fx.key.toString('base64'), fx.fakeBlob.toString('base64')];
    for (const needle of needles) expect(everything).not.toContain(needle);
    // Nor any e-mail address: only counts and account numbers.
    expect(everything).not.toMatch(/@example\.invalid/);
    // Secret values never reach the database in clear either.
    const dump = db.prepare('SELECT hex(ciphertext) AS c FROM secrets').all() as { c: string }[];
    for (const row of dump) expect(Buffer.from(row.c, 'hex').toString('utf8')).not.toContain('SYNTHETIC');
  });
});

describe('import.fleetV1: files', () => {
  it('skips folders and trashed items, rebuilds paths, keeps Google Docs with size null', async () => {
    const fx = setup();
    const summary = await handlerFor(fx).run(harness().ctx());
    const alpha = fileRows(placeIdOf('alpha.synthetic@example.invalid'));
    expect(alpha.map((r) => r.ext_id)).toEqual(['a1', 'a2', 'a4', 'a5']);
    const byId = Object.fromEntries(alpha.map((r) => [r.ext_id, r]));
    expect(byId['a1']).toMatchObject({
      rel_path: 'My Drive/Photos/2026/trip.jpg',
      name: 'trip.jpg',
      size: 1234,
      md5: 'abcdef0123456789abcdef0123456789',
      mtime: Date.parse('2026-03-04T10:20:30.000Z'),
      mime: 'image/jpeg',
      web_link: 'https://example.invalid/a1',
      first_seen_at: 1_800_000_000_000,
      last_seen_at: 1_760_000_000_000,
      gone_at: null,
    });
    expect(byId['a2']).toMatchObject({ rel_path: 'My Drive/Budget', size: null, md5: null, mtime: null });
    expect(byId['a4']!.rel_path).toBe('(unknown folder)/stray.png');
    expect(byId['a5']!.rel_path).toBe('My Drive/root.txt');
    expect(summary).toContain('Skipped 5 folders and 1 trashed item');
  });

  it('keeps two files with the same name in one folder by adding a short id to the second', async () => {
    const fx = setup();
    await handlerFor(fx).run(harness().ctx());
    const beta = fileRows(placeIdOf('beta.synthetic@example.invalid'));
    expect(beta.map((r) => r.rel_path).toSorted(byText)).toEqual(['My Drive/Same/twin [b3].txt', 'My Drive/Same/twin.txt', 'My Drive/doc.pdf'].toSorted(byText));
  });

  it('survives folder cycles and counts orphans', async () => {
    const fx = setup();
    const h = harness();
    const summary = await handlerFor(fx).run(h.ctx());
    const gamma = fileRows(placeIdOf('gamma.synthetic@example.invalid'));
    expect(gamma).toHaveLength(1);
    expect(gamma[0]!.rel_path.startsWith('(unknown folder)/')).toBe(true);
    expect(summary).toContain('"(unknown folder)"');
    expect(h.warns.some((w) => w.includes('did not list'))).toBe(true);
  });

  it('reports progress in files and a checkpoint per account', async () => {
    const fx = setup();
    const h = harness();
    await handlerFor(fx).run(h.ctx());
    expect(h.progress.at(-1)).toMatchObject({ done: 8, total: 8 });
    expect(h.checkpoints).toHaveLength(3);
    expect(h.checkpoints.at(-1)).toMatchObject({ nextIndex: 3, filesDone: 8 });
  });
});

describe('import.fleetV1: reruns, resume and safety', () => {
  it('is idempotent: a second run adds no places, secrets or files and updates in place', async () => {
    const fx = setup();
    const first = await handlerFor(fx).run(harness().ctx());
    const placesBefore = placeRows().map((r) => r.id);
    const filesBefore = db.prepare('SELECT count(*) AS n FROM files').get() as { n: number };
    const secretsBefore = vault.listSecretNames();

    // The user renamed a place meanwhile: the import must not undo that.
    db.prepare("UPDATE places SET label = 'My main' WHERE label = 'Alpha'").run();
    const second = await handlerFor(fx).run(harness().ctx());

    expect(placeRows().map((r) => r.id).toSorted(byText)).toEqual([...placesBefore].toSorted(byText));
    expect(placeRows().some((r) => r.label === 'My main')).toBe(true);
    expect(db.prepare('SELECT count(*) AS n FROM files').get()).toEqual(filesBefore);
    expect(vault.listSecretNames()).toEqual(secretsBefore);
    expect(first).toContain('8 files (8 new)');
    expect(second).toContain('8 files (0 new)');
  });

  it('never deletes: rows it did not bring in, and files v1 no longer lists, stay', async () => {
    const fx = setup();
    await handlerFor(fx).run(harness().ctx());
    const alphaId = placeIdOf('alpha.synthetic@example.invalid');
    db.prepare(
      "INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at, ext_id) VALUES (?, 'My Drive/added-later.txt', 1, 1, 1, 'later')",
    ).run(alphaId);
    // v1 now lists fewer files.
    fs.rmSync(sourceDir, { recursive: true, force: true });
    const fx2 = setup({ rows: files.filter((f) => f.id !== 'a5') });
    await handlerFor(fx2).run(harness().ctx());
    const ids = fileRows(alphaId).map((r) => r.ext_id);
    expect(ids).toContain('later');
    expect(ids).toContain('a5');
  });

  it('matches existing gdrive places by e-mail (any case) instead of duplicating', async () => {
    const fx = setup();
    db.prepare(
      "INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('pre-1', 1, 'gdrive', 'Mine', ?, 'unknown', 1)",
    ).run(JSON.stringify({ email: 'ALPHA.synthetic@example.invalid', keep: 'me' }));
    await handlerFor(fx).run(harness().ctx());
    expect(placeRows()).toHaveLength(3);
    const pre = db.prepare("SELECT * FROM places WHERE id = 'pre-1'").get() as PlaceT;
    expect(pre.label).toBe('Mine');
    expect(JSON.parse(pre.identity_json)).toMatchObject({ keep: 'me', accountId: 1 });
    expect(vault.getSecretText(refreshTokenSecretName('pre-1'))).toBe(TOKEN(1));
  });

  it('does not replace a newer last-looked date with the old v1 one', async () => {
    const fx = setup();
    await handlerFor(fx).run(harness().ctx());
    const alphaId = placeIdOf('alpha.synthetic@example.invalid');
    // A later real refresh (P4c) replaced the catalog marker and set a new date.
    const identity = JSON.parse((db.prepare('SELECT identity_json FROM places WHERE id = ?').get(alphaId) as { identity_json: string }).identity_json);
    delete identity.catalog;
    db.prepare('UPDATE places SET identity_json = ?, last_looked_at = 1900000000000 WHERE id = ?').run(JSON.stringify(identity), alphaId);
    await handlerFor(fx).run(harness().ctx());
    expect((db.prepare('SELECT last_looked_at FROM places WHERE id = ?').get(alphaId) as { last_looked_at: number }).last_looked_at).toBe(1_900_000_000_000);
  });

  it('refuses to start without the confirmation, changing nothing', async () => {
    const fx = setup();
    const unconfirmed = { ...harness().ctx(), params: {} } as JobContext;
    await expect(handlerFor(fx).run(unconfirmed)).rejects.toBeInstanceOf(JobFailure);
    await expect(handlerFor(fx).run(unconfirmed)).rejects.toThrow(/not confirmed/);
    expect(placeRows()).toHaveLength(0);
    expect(vault.listSecretNames()).toEqual([]);
    expect(tempLeft()).toEqual([]);
  });

  it('a second run leaves an account that Backup Hub refreshed itself exactly as it is (token, space numbers, file rows), still adds a new account, and says so', async () => {
    const fx = setup({ accts: accounts.slice(0, 2), rows: files.filter((f) => f.account !== 3) });
    await handlerFor(fx).run(harness().ctx());
    const alphaId = placeIdOf('alpha.synthetic@example.invalid');
    const betaId = placeIdOf('beta.synthetic@example.invalid');
    // Backup Hub refreshed alpha itself: new sign-in, new space numbers, new file rows, sync bookmark written.
    vault.putSecret(refreshTokenSecretName(alphaId), 'V2-NEWER-TOKEN');
    const identity = JSON.parse((db.prepare('SELECT identity_json FROM places WHERE id = ?').get(alphaId) as { identity_json: string }).identity_json);
    const v2Identity = { ...identity, quotaLimit: 999, quotaUsage: 777 };
    db.prepare('UPDATE places SET identity_json = ?, last_looked_at = 1900000000000 WHERE id = ?').run(JSON.stringify(v2Identity), alphaId);
    db.prepare("UPDATE files SET size = 4242, md5 = 'v2md5', mime = 'text/v2', web_link = 'https://v2', rel_path = 'My Drive/moved-by-v2/' || name, last_seen_at = 1900000000000 WHERE place_id = ?").run(alphaId);
    setSync(db, alphaId, 'tok', { fullListedAt: 1_900_000_000_000 });
    const alphaFilesBefore = fileRows(alphaId);
    const alphaPlaceBefore = db.prepare('SELECT * FROM places WHERE id = ?').get(alphaId);
    const betaBefore = db.prepare('SELECT * FROM places WHERE id = ?').get(betaId);

    // The archive now also holds a brand-new account.
    fs.rmSync(sourceDir, { recursive: true, force: true });
    const fx2 = setup();
    const h = harness();
    const summary = await handlerFor(fx2).run(h.ctx());

    expect(vault.getSecretText(refreshTokenSecretName(alphaId))).toBe('V2-NEWER-TOKEN');
    expect(db.prepare('SELECT * FROM places WHERE id = ?').get(alphaId)).toEqual(alphaPlaceBefore);
    expect(fileRows(alphaId)).toEqual(alphaFilesBefore);
    // Beta was only ever brought in: refreshed from v1 as before. Gamma is new.
    expect((db.prepare('SELECT * FROM places WHERE id = ?').get(betaId) as PlaceT).identity_json).toBe((betaBefore as PlaceT).identity_json);
    expect(placeRows()).toHaveLength(3);
    const gammaId = placeIdOf('gamma.synthetic@example.invalid');
    expect(fileRows(gammaId).length).toBeGreaterThan(0);
    expect(vault.getSecretText(refreshTokenSecretName(gammaId))).toBe(TOKEN(3));
    expect(summary).toContain('Skipped 1 account that Backup Hub has already refreshed itself');
    expect(h.warns.some((w) => w.includes('Skipped 1 account that Backup Hub has already refreshed itself'))).toBe(true);
  });

  it('a sign-in done by Backup Hub (signedInAt) protects the account even before any refresh', async () => {
    const fx = setup();
    await handlerFor(fx).run(harness().ctx());
    const alphaId = placeIdOf('alpha.synthetic@example.invalid');
    vault.putSecret(refreshTokenSecretName(alphaId), 'V2-SIGNED-IN-AGAIN');
    const identity = JSON.parse((db.prepare('SELECT identity_json FROM places WHERE id = ?').get(alphaId) as { identity_json: string }).identity_json);
    db.prepare('UPDATE places SET identity_json = ? WHERE id = ?').run(JSON.stringify({ ...identity, signedInAt: 1_900_000_000_000 }), alphaId);
    const summary = await handlerFor(fx).run(harness().ctx());
    expect(vault.getSecretText(refreshTokenSecretName(alphaId))).toBe('V2-SIGNED-IN-AGAIN');
    expect(summary).toContain('Skipped 1 account that Backup Hub has already refreshed itself');
  });

  it('keeps a Google client id and secret that Backup Hub already holds', async () => {
    const fx = setup();
    vault.putSecret(SECRET_CLIENT_ID, 'v2-client-id');
    vault.putSecret(SECRET_CLIENT_SECRET, 'v2-client-secret');
    await handlerFor(fx).run(harness().ctx());
    expect(vault.getSecretText(SECRET_CLIENT_ID)).toBe('v2-client-id');
    expect(vault.getSecretText(SECRET_CLIENT_SECRET)).toBe('v2-client-secret');
  });

  it('continues from a checkpoint after an interruption and ends with the same data', async () => {
    const fx = setup();
    const first = harness();
    await expect(handlerFor(fx).run(first.ctx(null, 4))).rejects.toBeInstanceOf(JobAborted);
    expect(first.checkpoints.length).toBeGreaterThanOrEqual(1);
    expect(tempLeft()).toEqual([]);
    const resumed = harness();
    const summary = await handlerFor(fx).run(resumed.ctx(first.checkpoints.at(-1)));

    expect(placeRows()).toHaveLength(3);
    expect(db.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 8 });
    expect(summary).toContain('3 Google accounts');
    expect(summary).toContain('8 files');
  });

  it('copies the files first, never changes the archive, and removes its copy', async () => {
    const fx = setup({ readOnly: true });
    const dbFile = path.join(sourceDir, 'fleet.db');
    const stateFile = path.join(sourceDir, 'Local State');
    const before = [sha(dbFile), sha(stateFile)];
    const entries = fs.readdirSync(sourceDir).toSorted(byText);
    await handlerFor(fx).run(harness().ctx());
    expect([sha(dbFile), sha(stateFile)]).toEqual(before);
    expect(fs.readdirSync(sourceDir).toSorted(byText)).toEqual(entries);
    expect(tempLeft()).toEqual([]);
    expect(placeRows()).toHaveLength(3);
  });

  it('stops with a plain message, changing nothing, when the files are missing or not a v1 database', async () => {
    const fx = setup({ rows: [] });
    fs.rmSync(path.join(sourceDir, 'Local State'));
    await expect(handlerFor(fx).run(harness().ctx())).rejects.toBeInstanceOf(JobFailure);

    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(path.join(sourceDir, 'fleet.db'), 'this is not a database');
    fs.writeFileSync(path.join(sourceDir, 'Local State'), '{}');
    await expect(handlerFor(fx).run(harness().ctx())).rejects.toThrow(/Nothing was changed/);

    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.mkdirSync(sourceDir);
    const Database = (await import('better-sqlite3')).default;
    const other = new Database(path.join(sourceDir, 'fleet.db'));
    other.exec('CREATE TABLE accounts (id INTEGER, email TEXT); CREATE TABLE settings (key TEXT, value TEXT);');
    other.close();
    fs.writeFileSync(path.join(sourceDir, 'Local State'), '{}');
    await expect(handlerFor(fx).run(harness().ctx())).rejects.toThrow(/not a Fleet Manager v1 database/);

    expect(placeRows()).toHaveLength(0);
    expect(db.prepare('SELECT count(*) AS n FROM files').get()).toEqual({ n: 0 });
    expect(vault.listSecretNames()).toEqual([]);
    expect(tempLeft()).toEqual([]);
  });

  it('refuses to start while the vault is locked or unavailable, before decrypting anything', async () => {
    const fx = setup();
    let putCalls = 0;
    const locked: ImportVault = {
      status: () => ({ state: 'locked' }),
      putSecret: () => void (putCalls += 1),
      listSecretNames: () => [],
    };
    await expect(handlerFor(fx, { vault: locked }).run(harness().ctx())).rejects.toThrow(/locked/);
    expect(putCalls).toBe(0);
    expect(placeRows()).toHaveLength(0);
    expect(tempLeft()).toEqual([]);
  });

  it('turns a vault write failure into a plain stop and rolls that account back', async () => {
    const fx = setup();
    const broken: ImportVault = {
      status: () => ({ state: 'unlocked' }),
      putSecret: (name) => {
        if (name.startsWith('gdrive.refreshToken')) throw new Error('disk full');
      },
      listSecretNames: () => [],
    };
    await expect(handlerFor(fx, { vault: broken }).run(harness().ctx())).rejects.toBeInstanceOf(JobFailure);
    expect(placeRows()).toHaveLength(0);
  });
});

describe('helpers', () => {
  it('summaryText uses counts only', () => {
    const text = summaryText({ ...zeroCounts(), accounts: 1, tokensOk: 1, filesNew: 2, filesUpdated: 1, foldersSkipped: 1, trashedSkipped: 2 });
    expect(text).toBe('Brought in 1 Google account (1 sign-ins unlocked, 0 need signing in again) and 3 files (2 new). Skipped 1 folder and 2 trashed items.');
  });

  it('decryptV10 can read what the fixture wrote (sanity)', () => {
    const fx = makeFixture(path.join(root, 'fx'), { accounts: [], files: [{ account: 1, id: 'x', name: 'x', mime: FOLDER_MIME }] });
    expect(decryptV10(fx.encrypt('abc'), fx.key).toString()).toBe('abc');
  });
});
