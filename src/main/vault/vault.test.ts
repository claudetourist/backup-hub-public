import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIN_PASSPHRASE_LENGTH, passphraseHint } from '../../shared/vault';
import { closeDatabase, initDatabase, type Db } from '../db';
import { deriveKey, open, seal, SCRYPT_PARAMS, validKdf } from './vaultCrypto';
import { KEY_FILE_NAME, VAULT_META_KEY, VaultError, VaultService, type KeyProtector } from './vaultService';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const FAST = { N: 1024, r: 8, p: 1 };
const PASS = 'correct horse battery staple';
const PASS2 = 'another quite different phrase';

/** A fake "this computer": its own key, so a blob protected on one cannot be opened on another. */
function fakeProtector(available = true): KeyProtector & { available: boolean } {
  const machineKey = randomBytes(32);
  const p = {
    available,
    isAvailable: () => p.available,
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
  return p;
}

let dir: string;
let db: Db;
let protector: ReturnType<typeof fakeProtector>;
let vault: VaultService;

function makeVault(overrides: { dataDir?: string; db?: Db; protector?: KeyProtector; kdf?: typeof FAST } = {}): VaultService {
  return new VaultService({
    db: overrides.db ?? db,
    dataDir: overrides.dataDir ?? dir,
    protector: overrides.protector ?? protector,
    kdf: overrides.kdf ?? FAST,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-vault-test-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  protector = fakeProtector();
  vault = makeVault();
});
afterEach(() => {
  vault.close();
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

const record = () => JSON.parse((db.prepare('SELECT value FROM meta WHERE key = ?').get(VAULT_META_KEY) as { value: string }).value);

describe('crypto helpers', () => {
  it('uses the plan scrypt cost and rejects silly parameters', () => {
    expect(SCRYPT_PARAMS).toEqual({ N: 131072, r: 8, p: 1 });
    expect(validKdf(SCRYPT_PARAMS)).toBe(true);
    expect(validKdf({ N: 1000, r: 8, p: 1 })).toBe(false);
    expect(validKdf({ N: 2 ** 30, r: 8, p: 1 })).toBe(false);
    expect(validKdf({ N: 1024, r: 0, p: 1 })).toBe(false);
  });

  it('derives the same 32-byte key for the same inputs only', async () => {
    const salt = Buffer.alloc(16, 7);
    const a = await deriveKey(Buffer.from('pw'), salt, FAST);
    const b = await deriveKey(Buffer.from('pw'), salt, FAST);
    const c = await deriveKey(Buffer.from('px'), salt, FAST);
    expect(a).toHaveLength(32);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it('seals with a fresh nonce each time and binds the aad', () => {
    const key = randomBytes(32);
    const one = seal(key, Buffer.from('hello'), 'a');
    const two = seal(key, Buffer.from('hello'), 'a');
    expect(one.nonce.equals(two.nonce)).toBe(false);
    expect(open(key, one, 'a')?.toString()).toBe('hello');
    expect(open(key, one, 'b')).toBeNull();
    expect(open(randomBytes(32), one, 'a')).toBeNull();
  });
});

describe('real scrypt cost', () => {
  it('a vault created with the default cost stores N=2^17, r=8, p=1 and a 16-byte salt', async () => {
    const real = new VaultService({ db, dataDir: dir, protector });
    expect((await real.setPassphrase(PASS)).ok).toBe(true);
    const r = record();
    expect(r.kdf).toMatchObject({ name: 'scrypt', N: 131072, r: 8, p: 1 });
    expect(Buffer.from(r.kdf.salt, 'base64')).toHaveLength(16);
    const again = new VaultService({ db, dataDir: dir, protector });
    expect((await again.changePassphrase(PASS, PASS2)).ok).toBe(true);
    expect((await again.unlock('wrong wrong wrong')).ok).toBe(false);
  }, 30_000);
});

describe('secrets, no passphrase (this laptop only)', () => {
  it('round-trips and creates nothing until a secret is written', () => {
    expect(vault.status()).toMatchObject({ hasPassphrase: false, state: 'unlocked', secretCount: 0 });
    expect(fs.existsSync(path.join(dir, KEY_FILE_NAME))).toBe(false);
    expect(db.prepare('SELECT 1 FROM meta WHERE key = ?').get(VAULT_META_KEY)).toBeUndefined();

    vault.putSecret('google:one', 'refresh-token-1');
    vault.putSecret('google:two', Buffer.from([1, 2, 3, 250]));
    expect(vault.getSecretText('google:one')).toBe('refresh-token-1');
    expect([...vault.getSecret('google:two')!]).toEqual([1, 2, 3, 250]);
    expect(vault.getSecret('missing')).toBeNull();
    expect(vault.listSecretNames()).toEqual(['google:one', 'google:two']);
    expect(vault.status()).toMatchObject({ hasPassphrase: false, state: 'unlocked', secretCount: 2 });
    expect(record().mode).toBe('device');
    // The data key is only in the protected cache file, never in the database or in clear.
    expect(JSON.stringify(record())).not.toMatch(/wrappedDk/);
  });

  it('stores ciphertext, a 12-byte nonce per write, and replaces a secret with a new nonce', () => {
    vault.putSecret('s', 'plain-text-value');
    const first = db.prepare('SELECT ciphertext, nonce FROM secrets WHERE name = ?').get('s') as { ciphertext: Buffer; nonce: Buffer };
    expect(first.nonce).toHaveLength(12);
    expect(first.ciphertext.toString('latin1')).not.toContain('plain-text-value');
    vault.putSecret('s', 'plain-text-value');
    const second = db.prepare('SELECT ciphertext, nonce FROM secrets WHERE name = ?').get('s') as { ciphertext: Buffer; nonce: Buffer };
    expect(second.nonce.equals(first.nonce)).toBe(false);
    expect(vault.getSecretText('s')).toBe('plain-text-value');
  });

  it('survives an app restart (key comes back from the protected cache)', () => {
    vault.putSecret('s', 'value');
    vault.close();
    const restarted = makeVault();
    expect(restarted.status().state).toBe('unlocked');
    expect(restarted.getSecretText('s')).toBe('value');
  });

  it('detects tampering with the ciphertext, the nonce, or a swap between names', () => {
    vault.putSecret('a', 'alpha');
    vault.putSecret('b', 'beta');
    const row = db.prepare('SELECT ciphertext, nonce FROM secrets WHERE name = ?').get('a') as { ciphertext: Buffer; nonce: Buffer };

    const flipped = Buffer.from(row.ciphertext);
    flipped[0] = flipped[0]! ^ 1;
    db.prepare('UPDATE secrets SET ciphertext = ? WHERE name = ?').run(flipped, 'a');
    expect(() => vault.getSecret('a')).toThrow(VaultError);

    db.prepare('UPDATE secrets SET ciphertext = ? WHERE name = ?').run(row.ciphertext, 'a');
    expect(vault.getSecretText('a')).toBe('alpha');

    const badNonce = Buffer.from(row.nonce);
    badNonce[0] = badNonce[0]! ^ 1;
    db.prepare('UPDATE secrets SET nonce = ? WHERE name = ?').run(badNonce, 'a');
    expect(() => vault.getSecret('a')).toThrow(/changed|wrong/);
    db.prepare('UPDATE secrets SET nonce = ? WHERE name = ?').run(row.nonce, 'a');

    // Copy b's ciphertext over a: valid GCM data, but bound to the other name.
    const b = db.prepare('SELECT ciphertext, nonce FROM secrets WHERE name = ?').get('b') as { ciphertext: Buffer; nonce: Buffer };
    db.prepare('UPDATE secrets SET ciphertext = ?, nonce = ? WHERE name = ?').run(b.ciphertext, b.nonce, 'a');
    expect(() => vault.getSecret('a')).toThrow(VaultError);
  });

  it('truncated ciphertext is rejected, not crashed on', () => {
    vault.putSecret('a', 'alpha');
    db.prepare('UPDATE secrets SET ciphertext = ? WHERE name = ?').run(Buffer.from([1, 2, 3]), 'a');
    expect(() => vault.getSecret('a')).toThrow(VaultError);
  });

  it('cannot save when protected storage is unavailable, and says so', () => {
    const none = fakeProtector(false);
    const v = makeVault({ protector: none });
    expect(() => v.putSecret('s', 'x')).toThrow(/protected storage/);
    expect(v.status().protectedStorageAvailable).toBe(false);
  });

  it('shows "unavailable" when the protected key copy is lost, and never invents a new key over old secrets', () => {
    vault.putSecret('s', 'value');
    fs.rmSync(path.join(dir, KEY_FILE_NAME));
    const restarted = makeVault();
    expect(restarted.status()).toMatchObject({ state: 'unavailable', hasPassphrase: false, secretCount: 1 });
    expect(() => restarted.getSecret('s')).toThrow(/protected key is missing/);
    expect(() => restarted.putSecret('t', 'y')).toThrow(VaultError);
    expect(db.prepare('SELECT count(*) AS n FROM secrets').get()).toEqual({ n: 1 });
  });

  it('treats a cache written by another computer (or a corrupt one) as unavailable', () => {
    vault.putSecret('s', 'value');
    const otherMachine = makeVault({ protector: fakeProtector() });
    expect(otherMachine.status().state).toBe('unavailable');
    fs.writeFileSync(path.join(dir, KEY_FILE_NAME), 'garbage');
    expect(makeVault().status().state).toBe('unavailable');
  });
});

describe('passphrase', () => {
  it('migrates from this-laptop-only to passphrase protection without touching the secrets', async () => {
    vault.putSecret('google:one', 'token');
    const before = db.prepare('SELECT ciphertext, nonce FROM secrets').all();
    const result = await vault.setPassphrase(PASS);
    expect(result).toMatchObject({ ok: true, status: { hasPassphrase: true, state: 'unlocked', secretCount: 1 } });
    expect(db.prepare('SELECT ciphertext, nonce FROM secrets').all()).toEqual(before);
    expect(vault.getSecretText('google:one')).toBe('token');
    const r = record();
    expect(r.mode).toBe('passphrase');
    expect(r.wrappedDk).toBeDefined();
    expect(r.keyCheck).toBeDefined();
    expect(Buffer.from(r.kdf.salt, 'base64')).toHaveLength(16);
    // The passphrase appears nowhere in storage.
    const everything = JSON.stringify(db.prepare('SELECT * FROM meta').all()) + fs.readFileSync(path.join(dir, KEY_FILE_NAME)).toString('latin1');
    expect(everything).not.toContain(PASS);
  });

  it('can set a passphrase on an empty vault too, and new secrets work afterwards', async () => {
    expect((await vault.setPassphrase(PASS)).ok).toBe(true);
    vault.putSecret('x', 'y');
    expect(vault.getSecretText('x')).toBe('y');
  });

  it('enforces the minimum length and rejects trivially repetitive passphrases', async () => {
    expect(MIN_PASSPHRASE_LENGTH).toBe(12);
    expect(await vault.setPassphrase('short')).toMatchObject({ ok: false, code: 'too-short' });
    expect(await vault.setPassphrase('elevenchars')).toMatchObject({ ok: false, code: 'too-short' });
    expect(await vault.setPassphrase('aaaaaaaaaaaaaaaa')).toMatchObject({ ok: false });
    expect(await vault.setPassphrase(42)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await vault.setPassphrase('')).toMatchObject({ ok: false, code: 'invalid' });
    expect(vault.status().hasPassphrase).toBe(false);
    expect(db.prepare('SELECT 1 FROM meta WHERE key = ?').get(VAULT_META_KEY)).toBeUndefined();
  });

  it('refuses to set twice, and unlock/change/remove need a passphrase to exist', async () => {
    expect(await vault.unlock(PASS)).toMatchObject({ ok: false, code: 'not-set' });
    expect(await vault.changePassphrase(PASS, PASS2)).toMatchObject({ ok: false, code: 'not-set' });
    expect(await vault.removePassphrase(PASS)).toMatchObject({ ok: false, code: 'not-set' });
    await vault.setPassphrase(PASS);
    expect(await vault.setPassphrase(PASS2)).toMatchObject({ ok: false, code: 'already-set' });
  });

  it('wrong passphrase is rejected everywhere and changes nothing', async () => {
    vault.putSecret('s', 'v');
    await vault.setPassphrase(PASS);
    const stored = JSON.stringify(record());
    expect(await vault.changePassphrase('not the passphrase', PASS2)).toMatchObject({ ok: false, code: 'wrong-passphrase' });
    expect(await vault.removePassphrase('not the passphrase')).toMatchObject({ ok: false, code: 'wrong-passphrase' });
    expect(JSON.stringify(record())).toBe(stored);
    // Case and whitespace matter.
    expect(await vault.unlock(PASS.toUpperCase())).toMatchObject({ ok: false, code: 'wrong-passphrase' });
    expect(await vault.unlock(`${PASS} `)).toMatchObject({ ok: false, code: 'wrong-passphrase' });
  });

  it('changing the passphrase keeps secrets readable without re-encrypting them, and the old one stops working', async () => {
    vault.putSecret('s', 'value');
    await vault.setPassphrase(PASS);
    const cipherBefore = db.prepare('SELECT ciphertext, nonce FROM secrets').all();
    const oldRecord = record();

    expect(await vault.changePassphrase(PASS, PASS2)).toMatchObject({ ok: true, status: { hasPassphrase: true, state: 'unlocked' } });
    expect(db.prepare('SELECT ciphertext, nonce FROM secrets').all()).toEqual(cipherBefore);
    const newRecord = record();
    expect(newRecord.kdf.salt).not.toBe(oldRecord.kdf.salt);
    expect(newRecord.wrappedDk).not.toEqual(oldRecord.wrappedDk);
    expect(newRecord.dkCheck).toBe(oldRecord.dkCheck);
    expect(vault.getSecretText('s')).toBe('value');

    // On a new computer only the NEW passphrase opens it.
    const other = makeVault({ dataDir: fs.mkdtempSync(path.join(dir, 'b-')), protector: fakeProtector() });
    expect(other.status().state).toBe('locked');
    expect(await other.unlock(PASS)).toMatchObject({ ok: false, code: 'wrong-passphrase' });
    expect(await other.unlock(PASS2)).toMatchObject({ ok: true, status: { state: 'unlocked' } });
    expect(other.getSecretText('s')).toBe('value');
  });

  it('on another computer: locked until the passphrase is typed once, then cached there', async () => {
    vault.putSecret('s', 'value');
    await vault.setPassphrase(PASS);
    const bDir = fs.mkdtempSync(path.join(dir, 'b-'));
    const bProtector = fakeProtector();
    const b = makeVault({ dataDir: bDir, protector: bProtector });
    expect(b.status()).toMatchObject({ hasPassphrase: true, state: 'locked' });
    expect(() => b.getSecret('s')).toThrow(/recovery passphrase/);
    expect(() => b.putSecret('t', 'x')).toThrow(VaultError);
    expect((await b.unlock(PASS)).ok).toBe(true);
    expect(b.getSecretText('s')).toBe('value');
    expect(fs.existsSync(path.join(bDir, KEY_FILE_NAME))).toBe(true);
    // Restart on B: no passphrase needed any more.
    b.close();
    const b2 = makeVault({ dataDir: bDir, protector: bProtector });
    expect(b2.status().state).toBe('unlocked');
    expect(b2.getSecretText('s')).toBe('value');
  });

  it('remove returns to this-laptop-only protection and keeps secrets readable', async () => {
    vault.putSecret('s', 'value');
    await vault.setPassphrase(PASS);
    expect(await vault.removePassphrase(PASS)).toMatchObject({ ok: true, status: { hasPassphrase: false, state: 'unlocked', secretCount: 1 } });
    const r = record();
    expect(r.mode).toBe('device');
    expect(r.wrappedDk).toBeUndefined();
    expect(r.kdf).toBeUndefined();
    expect(vault.getSecretText('s')).toBe('value');
    expect(makeVault().getSecretText('s')).toBe('value');
  });

  it('remove on a locked computer unlocks with the passphrase and caches the key here', async () => {
    vault.putSecret('s', 'value');
    await vault.setPassphrase(PASS);
    const b = makeVault({ dataDir: fs.mkdtempSync(path.join(dir, 'b-')), protector: fakeProtector() });
    expect((await b.removePassphrase(PASS)).ok).toBe(true);
    expect(b.getSecretText('s')).toBe('value');
  });

  it('will not remove the passphrase when protected storage is unavailable (the key would be stranded)', async () => {
    await vault.setPassphrase(PASS);
    protector.available = false;
    expect(await vault.removePassphrase(PASS)).toMatchObject({ ok: false, code: 'protected-storage' });
    expect(record().mode).toBe('passphrase');
  });

  it('survives a damaged passphrase record with a plain message instead of crashing', async () => {
    await vault.setPassphrase(PASS);
    const r = record();
    r.kdf.N = 12345;
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(r), VAULT_META_KEY);
    const other = makeVault({ dataDir: fs.mkdtempSync(path.join(dir, 'b-')), protector: fakeProtector() });
    expect(await other.unlock(PASS)).toMatchObject({ ok: false, code: 'failed' });
  });

  it('a tampered wrapped key or check value is treated as a wrong passphrase, not accepted', async () => {
    await vault.setPassphrase(PASS);
    const r = record();
    const ct = Buffer.from(r.wrappedDk.ct, 'base64');
    ct[0] = ct[0]! ^ 1;
    r.wrappedDk.ct = ct.toString('base64');
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(r), VAULT_META_KEY);
    const other = makeVault({ dataDir: fs.mkdtempSync(path.join(dir, 'b-')), protector: fakeProtector() });
    expect(await other.unlock(PASS)).toMatchObject({ ok: false, code: 'wrong-passphrase' });
  });
});

describe('forgot passphrase', () => {
  it('needs explicit confirmation', async () => {
    vault.putSecret('s', 'v');
    expect(vault.forgetEverything(false)).toMatchObject({ ok: false, code: 'needs-confirmation' });
    expect(vault.forgetEverything('yes')).toMatchObject({ ok: false, code: 'needs-confirmation' });
    expect(vault.status().secretCount).toBe(1);
  });

  it('removes only the secrets rows, the vault record and the cached key: nothing else', async () => {
    vault.putSecret('a', '1');
    vault.putSecret('b', '2');
    await vault.setPassphrase(PASS);
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('p', 1, 'drive', 'T7', 'unknown', 1)").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('theme', '\"dark\"')").run();
    db.prepare("INSERT INTO jobs (kind, title, created_at) VALUES ('x', 'y', 1)").run();
    const metaOthers = db.prepare('SELECT * FROM meta WHERE key != ? ORDER BY key').all(VAULT_META_KEY);
    const tables = ['profiles', 'places', 'files', 'collections', 'collection_roots', 'jobs', 'job_events', 'settings'];
    const snapshot = () => tables.map((t) => db.prepare(`SELECT * FROM ${t}`).all());
    const before = snapshot();
    const marker = path.join(dir, 'this-device.json');
    fs.writeFileSync(marker, '{}');

    expect(vault.forgetEverything(true)).toMatchObject({ ok: true, status: { hasPassphrase: false, state: 'unlocked', secretCount: 0 } });
    expect(db.prepare('SELECT count(*) AS n FROM secrets').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT 1 FROM meta WHERE key = ?').get(VAULT_META_KEY)).toBeUndefined();
    expect(fs.existsSync(path.join(dir, KEY_FILE_NAME))).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(db.prepare('SELECT * FROM meta WHERE key != ? ORDER BY key').all(VAULT_META_KEY)).toEqual(metaOthers);
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'backuphub.db'))).toBe(true);
  });

  it('starts over cleanly: a new secret works and a new passphrase can be set', async () => {
    vault.putSecret('a', '1');
    await vault.setPassphrase(PASS);
    vault.forgetEverything(true);
    vault.putSecret('fresh', 'new');
    expect(vault.getSecretText('fresh')).toBe('new');
    expect((await vault.setPassphrase(PASS2)).ok).toBe(true);
  });

  it('also rescues a vault whose protected key was lost', () => {
    vault.putSecret('a', '1');
    fs.rmSync(path.join(dir, KEY_FILE_NAME));
    const restarted = makeVault();
    expect(restarted.status().state).toBe('unavailable');
    restarted.forgetEverything(true);
    expect(restarted.status()).toMatchObject({ state: 'unlocked', secretCount: 0 });
    restarted.putSecret('b', '2');
    expect(restarted.getSecretText('b')).toBe('2');
  });
});

describe('passphrase never leaks', () => {
  it('is not in console output, errors, results or the database, even on failure', async () => {
    const logged: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of ['log', 'warn', 'error', 'info'] as const) console[k] = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
    try {
      const secretPhrase = 'unique-needle-passphrase-123';
      const results = [
        await vault.setPassphrase(secretPhrase),
        await vault.changePassphrase('wrong wrong wrong wrong', secretPhrase),
        await vault.unlock('x'.repeat(2000)),
        await vault.removePassphrase(secretPhrase),
      ];
      const text = JSON.stringify(results) + JSON.stringify(db.prepare('SELECT * FROM meta').all()) + logged.join('\n');
      expect(text).not.toContain('unique-needle');
    } finally {
      Object.assign(console, orig);
    }
  });
});

describe('passphraseHint', () => {
  it('counts down to the minimum, flags repetition, and praises length', () => {
    expect(passphraseHint('').level).toBe('empty');
    expect(passphraseHint('abc')).toMatchObject({ level: 'short', acceptable: false, text: expect.stringContaining('9 more') });
    expect(passphraseHint('abcdefghijk').text).toContain('1 more character');
    expect(passphraseHint('aaaaaaaaaaaaaa')).toMatchObject({ level: 'weak', acceptable: false });
    expect(passphraseHint('abcabcabcabcabc')).toMatchObject({ level: 'weak', acceptable: false });
    expect(passphraseHint('blue river stones')).toMatchObject({ level: 'ok', acceptable: true });
    expect(passphraseHint('blue river stones under 4 old moons!')).toMatchObject({ level: 'strong', acceptable: true });
  });
});
