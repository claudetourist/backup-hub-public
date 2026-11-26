import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, type Db } from '../db';
import { NeedsSignInError } from '../google/auth';
import { GoogleApiError } from '../google/googleHttp';
import { JobFailure, type JobContext } from '../jobs/jobService';
import { SettingsStore } from '../settings/settingsStore';
import { VaultService, type KeyProtector } from '../vault/vaultService';
import { openRecoveryFile, readRecoveryHeader, RECOVERY_CHUNK_BYTES, RecoveryFileError, writeRecoveryFile } from './recoveryFile';
import { recoveryFileName, recoveryHandler, recoveryIsDue, RECOVERY_FOLDER, RECOVERY_PREFIX, type RecoveryJobDeps } from './recoveryJob';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const FAST = { N: 1024, r: 8, p: 1 };
const PASS = 'correct horse battery staple';

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

let dir: string;
let db: Db;
let settings: SettingsStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-rec-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scratch'), { recursive: true });
  const opened = initDatabase(path.join(dir, 'data'), silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  settings = new SettingsStore(db);
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('g1', 1, 'gdrive', 'Mom 1', '{}', 'connected', 1)").run();
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

function bigFile(name: string, bytes: number): string {
  const file = path.join(dir, name);
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 32) createHash('sha256').update(`x${i}`).digest().copy(buf, i, 0, Math.min(32, bytes - i));
  fs.writeFileSync(file, buf);
  return file;
}

describe('the recovery file', () => {
  const key = randomBytes(32);
  const meta = { createdAt: 1234, appVersion: '0.1.0', vault: { v: 1, mode: 'passphrase' } };

  it('opens with the key and gives the same bytes back (several frames)', async () => {
    const src = bigFile('src.db', RECOVERY_CHUNK_BYTES * 2 + 12345);
    const enc = path.join(dir, 'a.bhrc');
    await writeRecoveryFile(src, enc, key, meta);
    expect(fs.readFileSync(enc).includes(fs.readFileSync(src).subarray(100, 140))).toBe(false); // not in the clear
    const out = path.join(dir, 'out.db');
    expect(await openRecoveryFile(enc, out, key)).toBe(true);
    expect(fs.readFileSync(out).equals(fs.readFileSync(src))).toBe(true);
    expect((await readRecoveryHeader(enc)).header).toMatchObject({ createdAt: 1234, appVersion: '0.1.0' });
  });

  it('handles an empty source and a tiny one', async () => {
    for (const size of [0, 5]) {
      const src = bigFile(`s${size}.db`, size);
      const enc = path.join(dir, `e${size}.bhrc`);
      await writeRecoveryFile(src, enc, key, meta);
      const out = path.join(dir, `o${size}.db`);
      expect(await openRecoveryFile(enc, out, key)).toBe(true);
      expect(fs.readFileSync(out).length).toBe(size);
    }
  });

  it('refuses a wrong key, a changed byte and a cut file, and leaves nothing behind', async () => {
    const src = bigFile('src.db', RECOVERY_CHUNK_BYTES * 3);
    const enc = path.join(dir, 'a.bhrc');
    await writeRecoveryFile(src, enc, key, meta);
    expect(await openRecoveryFile(enc, path.join(dir, 'w.db'), randomBytes(32))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'w.db'))).toBe(false);

    const bytes = fs.readFileSync(enc);
    const flipped = Buffer.from(bytes);
    flipped[flipped.length - 100] = (flipped[flipped.length - 100]! ^ 1) & 255;
    fs.writeFileSync(path.join(dir, 'f.bhrc'), flipped);
    expect(await openRecoveryFile(path.join(dir, 'f.bhrc'), path.join(dir, 'f.db'), key)).toBe(false);

    // Cut at a frame boundary: every frame left is genuine but none is marked last.
    const headerEnd = (await readRecoveryHeader(enc)).offset;
    const firstLen = bytes.readUInt32BE(headerEnd);
    fs.writeFileSync(path.join(dir, 'c.bhrc'), bytes.subarray(0, headerEnd + 4 + firstLen));
    expect(await openRecoveryFile(path.join(dir, 'c.bhrc'), path.join(dir, 'c.db'), key)).toBe(false);
    expect(fs.existsSync(path.join(dir, 'c.db'))).toBe(false);
  });

  it('refuses something that is not a recovery file, and never overwrites a target', async () => {
    fs.writeFileSync(path.join(dir, 'x.bin'), 'hello world, not a recovery file');
    await expect(readRecoveryHeader(path.join(dir, 'x.bin'))).rejects.toBeInstanceOf(RecoveryFileError);
    const src = bigFile('src.db', 1000);
    const enc = path.join(dir, 'a.bhrc');
    await writeRecoveryFile(src, enc, key, meta);
    fs.writeFileSync(path.join(dir, 'there.db'), 'mine');
    await expect(openRecoveryFile(enc, path.join(dir, 'there.db'), key)).rejects.toBeInstanceOf(RecoveryFileError);
    expect(fs.readFileSync(path.join(dir, 'there.db'), 'utf8')).toBe('mine');
  });

  it('a new laptop opens it with only the passphrase', async () => {
    const old = new VaultService({ db, dataDir: path.join(dir, 'data'), protector: fakeProtector(), kdf: FAST });
    expect(old.recoveryKit()).toBeNull(); // no passphrase yet: no recovery file
    old.putSecret('x', 'y');
    expect((await old.setPassphrase(PASS)).ok).toBe(true);
    const kit = old.recoveryKit();
    expect(kit).not.toBeNull();
    const src = bigFile('src.db', 50_000);
    const enc = path.join(dir, 'a.bhrc');
    await writeRecoveryFile(src, enc, kit!.key, { ...meta, vault: kit!.record });

    // Another computer: a different data folder and protector; nothing but the file and the passphrase.
    const other = new VaultService({ db, dataDir: path.join(dir, 'data'), protector: fakeProtector(), kdf: FAST });
    const { header } = await readRecoveryHeader(enc);
    expect(await other.keyFromRecord(header.vault, 'wrong passphrase here')).toBeNull();
    const dk = await other.keyFromRecord(header.vault, PASS);
    expect(dk?.equals(kit!.key)).toBe(true);
    expect(await openRecoveryFile(enc, path.join(dir, 'out.db'), dk!)).toBe(true);
  });
});

// ---- The job --------------------------------------------------------------------------------------------------------------

interface Fake {
  uploaded: { name: string; bytes: Buffer }[];
  existing: number;
  folderCreated: number;
  corrupt: boolean;
  failWith: Error | null;
  chunks: number;
}

function makeDeps(fake: Fake, kit: { key: Buffer; record: unknown } | null, over: Partial<RecoveryJobDeps> = {}): RecoveryJobDeps {
  let session: { name: string; parts: Buffer[] } | null = null;
  return {
    db,
    settings,
    vault: { recoveryKit: () => (kit ? { key: Buffer.from(kit.key), record: kit.record } : null) },
    uploader: {
      findFolder: () => Promise.resolve(fake.folderCreated > 0 ? 'folder1' : null),
      createFolder: () => {
        fake.folderCreated += 1;
        return Promise.resolve('folder1');
      },
      listChildren: () => Promise.resolve(Array.from({ length: fake.existing }, (_, i) => ({ id: `e${i}`, name: `${RECOVERY_PREFIX}old${i}.bhrc`, size: 1 }))),
      startSession: (_p, name) => {
        if (fake.failWith) return Promise.reject(fake.failWith);
        session = { name, parts: [] };
        return Promise.resolve('https://upload.example/session');
      },
      putChunk: (_p, _uri, bytes, offset, total) => {
        fake.chunks += 1;
        session!.parts.push(Buffer.from(bytes));
        const got = offset + bytes.length;
        if (got < total) return Promise.resolve({ done: false as const, confirmed: got });
        const all = Buffer.concat(session!.parts);
        fake.uploaded.push({ name: session!.name, bytes: all });
        return Promise.resolve({ done: true as const, file: { id: 'f1', md5: fake.corrupt ? 'deadbeef' : createHash('md5').update(all).digest('hex'), size: all.length } });
      },
      status: () => Promise.resolve({ done: false as const, confirmed: 0 }),
    },
    auth: { assertVaultReady: () => {}, hasRefreshToken: () => true },
    http: { wait: () => Promise.resolve() },
    room: () => Promise.resolve({ limit: 15e9, usage: 1e9 }),
    isGoogleAccount: (id) => id === 'g1',
    freeBytes: () => 100e9,
    scratchRoot: path.join(dir, 'scratch'),
    appVersion: '0.1.0',
    log: silent,
    now: () => Date.UTC(2026, 10, 3, 12, 0, 0),
    chunkBytes: 256 * 1024,
    ...over,
  };
}

async function runJob(deps: RecoveryJobDeps, params: unknown = {}): Promise<{ message: string; warns: string[]; error: unknown }> {
  const out = { message: '', warns: [] as string[], error: null as unknown };
  const ctx: JobContext = {
    jobId: 1,
    params,
    resume: null,
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
    warn: (t) => void out.warns.push(t),
    needsYou: () => Promise.resolve('Stop'),
    checkpoint: () => {},
    yield: () => Promise.resolve(),
  };
  try {
    const r = await recoveryHandler(deps).run(ctx);
    out.message = typeof r === 'string' ? r : (r?.message ?? '');
  } catch (err) {
    out.error = err;
  }
  return out;
}

const newFake = (): Fake => ({ uploaded: [], existing: 0, folderCreated: 0, corrupt: false, failWith: null, chunks: 0 });
const kit = { key: randomBytes(32), record: { v: 1, mode: 'passphrase' } };
const enable = (): void => {
  settings.set('recoveryToGoogle', true);
  settings.set('recoveryGoogleAccount', 'g1');
};

describe('the recovery copy to Google Drive (fakes only)', () => {
  it('is off by default and sends nothing', async () => {
    const fake = newFake();
    const r = await runJob(makeDeps(fake, kit));
    expect(r.message).toMatch(/switched off/);
    expect(fake.uploaded).toHaveLength(0);
    expect(settings.get().recoveryToGoogle).toBe(false);
    expect(settings.get().recoveryGoogleAccount).toBeNull();
  });

  it('needs a chosen Google account, even when switched on', async () => {
    settings.set('recoveryToGoogle', true);
    const r = await runJob(makeDeps(newFake(), kit));
    expect(r.error).toBeInstanceOf(JobFailure);
    expect((r.error as JobFailure).plain).toMatch(/No Google account is chosen/);
    settings.set('recoveryGoogleAccount', 'not-an-account');
    expect((await runJob(makeDeps(newFake(), kit))).error).toBeInstanceOf(JobFailure);
  });

  it('refuses without a recovery passphrase and says what to do', async () => {
    enable();
    const fake = newFake();
    const r = await runJob(makeDeps(fake, null));
    expect((r.error as JobFailure).plain).toMatch(/recovery passphrase/);
    expect(fake.uploaded).toHaveLength(0);
  });

  it('uploads an encrypted copy that opens with the key, checks it against Drive, and cleans up', async () => {
    enable();
    const fake = newFake();
    const deps = makeDeps(fake, kit);
    const r = await runJob(deps);
    expect(r.error).toBeNull();
    expect(r.message).toMatch(/Saved an encrypted recovery copy/);
    expect(r.message).toMatch(new RegExp(`1 of 7`));
    expect(fake.folderCreated).toBe(1);
    expect(fake.uploaded).toHaveLength(1);
    expect(fake.uploaded[0]!.name).toBe(recoveryFileName(new Date(Date.UTC(2026, 10, 3, 12, 0, 0))));
    expect(fake.uploaded[0]!.name.startsWith(RECOVERY_PREFIX)).toBe(true);
    const enc = path.join(dir, 'got.bhrc');
    fs.writeFileSync(enc, fake.uploaded[0]!.bytes);
    const out = path.join(dir, 'got.db');
    expect(await openRecoveryFile(enc, out, kit.key)).toBe(true);
    expect(fs.readFileSync(out).subarray(0, 15).toString()).toBe('SQLite format 3');
    expect(fs.readdirSync(path.join(dir, 'scratch'))).toEqual([]);
    expect(RECOVERY_FOLDER).toBe('BackupHub Recovery');
  });

  it('does not send again within 7 days, but Save now (force) does', async () => {
    enable();
    const fake = newFake();
    await runJob(makeDeps(fake, kit));
    const again = await runJob(makeDeps(fake, kit));
    expect(again.message).toMatch(/less than 7 days/);
    expect(fake.uploaded).toHaveLength(1);
    await runJob(makeDeps(fake, kit), { force: true });
    expect(fake.uploaded).toHaveLength(2);
    expect(recoveryIsDue(null, 1)).toBe(true);
    expect(recoveryIsDue(1, 1 + 6 * 86_400_000)).toBe(false);
    expect(recoveryIsDue(1, 1 + 7 * 86_400_000)).toBe(true);
  });

  it('stops at 7 copies in Drive (it never deletes there) and says how to go on', async () => {
    enable();
    const fake = newFake();
    fake.existing = 7;
    const r = await runJob(makeDeps(fake, kit));
    expect(r.error).toBeNull();
    expect(r.message).toMatch(/7 recovery copies are already in Drive/);
    expect(r.warns.join(' ')).toMatch(/never deletes in Drive/);
    expect(fake.uploaded).toHaveLength(0);
  });

  it('does not count a copy whose checksum Drive reports differently', async () => {
    enable();
    const fake = newFake();
    fake.corrupt = true;
    const r = await runJob(makeDeps(fake, kit));
    expect((r.error as JobFailure).plain).toMatch(/does not match/);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'recovery.drive.last'").get()).toBeUndefined();
    expect(fs.readdirSync(path.join(dir, 'scratch'))).toEqual([]);
  });

  it('sends nothing when the account has no room, is signed out, or the disk is too full', async () => {
    enable();
    const full = newFake();
    expect((await runJob(makeDeps(full, kit, { room: () => Promise.resolve({ limit: 15e9, usage: 15e9 - 10 }) }))).error).toBeInstanceOf(JobFailure);
    expect(full.uploaded).toHaveLength(0);
    const out = newFake();
    expect(((await runJob(makeDeps(out, kit, { auth: { assertVaultReady: () => {}, hasRefreshToken: () => false } }))).error as JobFailure).plain).toMatch(/signed out/);
    const tight = newFake();
    expect(((await runJob(makeDeps(tight, kit, { freeBytes: () => 10 }))).error as JobFailure).plain).toMatch(/enough free space/);
    expect(fs.readdirSync(path.join(dir, 'scratch'))).toEqual([]);
  });

  it('turns a sign-in problem or a full account into a plain failure', async () => {
    enable();
    const a = newFake();
    a.failWith = new NeedsSignInError('g1');
    expect((await runJob(makeDeps(a, kit))).error).toBeInstanceOf(JobFailure);
    const b = newFake();
    b.failWith = new GoogleApiError(403, 'storageQuotaExceeded', 'quota');
    expect(((await runJob(makeDeps(b, kit))).error as JobFailure).plain).toMatch(/full/);
  });
});
