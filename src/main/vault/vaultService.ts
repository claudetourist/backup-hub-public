import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  characterCount,
  MAX_PASSPHRASE_LENGTH,
  MIN_PASSPHRASE_LENGTH,
  passphraseHint,
  type VaultErrorCode,
  type VaultResult,
  type VaultStatus,
} from '../../shared/vault';
import type { Db } from '../db';
import { assertWritable, writeFileAtomic } from '../fsutil';
import {
  deriveKey,
  hmacHex,
  KEY_BYTES,
  open,
  safeEqualHex,
  SALT_BYTES,
  SCRYPT_PARAMS,
  seal,
  validKdf,
  type KdfParams,
  type Sealed,
} from './vaultCrypto';
import { ownRemove } from '../danger/ownFiles';

/** Protects a small blob for THIS Windows user on THIS computer (Electron safeStorage; fakes in tests). */
export interface KeyProtector {
  isAvailable(): boolean;
  protect(plain: Buffer): Buffer;
  /** Throws when the blob cannot be decrypted here. */
  unprotect(blob: Buffer): Buffer;
}

export const VAULT_META_KEY = 'vault.v1';
export const KEY_FILE_NAME = 'vault-key.bin';
const KEY_FILE_MAGIC = Buffer.from('BHVK1');
const DK_CHECK_LABEL = 'backuphub-vault-dk-check-v1';
const AAD_WRAP = 'backuphub-vault-datakey-wrap-v1';
const AAD_CHECK = 'backuphub-vault-passphrase-check-v1';
const CHECK_PLAINTEXT = Buffer.from('backuphub-vault-ok', 'utf8');

export class VaultError extends Error {
  constructor(
    readonly code: VaultErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VaultError';
  }
}

interface StoredSealed {
  nonce: string;
  ct: string;
}

interface VaultRecord {
  v: 1;
  mode: 'device' | 'passphrase';
  createdAt: number;
  /** HMAC of a label under the data key: tells a correct cached key from a stale one. */
  dkCheck: string;
  kdf?: KdfParams & { name: 'scrypt'; salt: string };
  /** The data key, encrypted under the passphrase-derived key. */
  wrappedDk?: StoredSealed;
  /** A known plaintext encrypted under the passphrase-derived key: checks a typed passphrase. */
  keyCheck?: StoredSealed;
}

const toStored = (s: Sealed): StoredSealed => ({ nonce: s.nonce.toString('base64'), ct: s.ciphertext.toString('base64') });
const fromStored = (s: StoredSealed): Sealed => ({ nonce: Buffer.from(s.nonce, 'base64'), ciphertext: Buffer.from(s.ct, 'base64') });

export interface VaultDeps {
  db: Db;
  dataDir: string;
  protector: KeyProtector;
  now?: () => number;
  /** Tests use a cheap scrypt cost; the app always uses the plan's N = 2^17. */
  kdf?: KdfParams;
}

function failure(code: VaultErrorCode, message: string): VaultResult {
  return { ok: false, code, message };
}

/**
 * The vault: `secrets` rows encrypted with AES-256-GCM under a random data key (envelope
 * encryption). The data key is cached on this computer by the OS-protected store; when the user sets
 * a recovery passphrase it is ALSO stored wrapped by a scrypt key from that passphrase, so another
 * computer can unlock it by typing the passphrase once. Changing the passphrase re-wraps only the
 * data key. The app works fully without a passphrase.
 *
 * Passphrases arrive as strings, are converted to bytes, used, and the bytes are zeroed straight
 * away. They are never logged or stored. (A JavaScript string cannot be zeroed; it is dropped.)
 */
export class VaultService {
  private readonly db: Db;
  private readonly keyFile: string;
  private readonly protector: KeyProtector;
  private readonly now: () => number;
  private readonly kdf: KdfParams;
  private dataKey: Buffer | null = null;

  constructor(deps: VaultDeps) {
    this.db = deps.db;
    this.keyFile = path.join(deps.dataDir, KEY_FILE_NAME);
    this.protector = deps.protector;
    this.now = deps.now ?? Date.now;
    this.kdf = deps.kdf ?? SCRYPT_PARAMS;
  }

  // ---- Status ------------------------------------------------------------------------------

  /** Where the vault stands. Never writes anything. */
  status(): VaultStatus {
    const record = this.loadRecord();
    if (record) this.tryCache(record);
    const secretCount = (this.db.prepare('SELECT count(*) AS n FROM secrets').get() as { n: number }).n;
    let state: VaultStatus['state'] = 'unlocked';
    if (record && !this.dataKey) state = record.mode === 'passphrase' ? 'locked' : 'unavailable';
    return {
      hasPassphrase: record?.mode === 'passphrase',
      state,
      secretCount,
      protectedStorageAvailable: this.protector.isAvailable(),
    };
  }

  private result(): VaultResult {
    return { ok: true, status: this.status() };
  }

  // ---- Secrets -----------------------------------------------------------------------------

  /** Save (or replace) a secret. Creates the vault on first use. Throws VaultError. */
  putSecret(name: string, value: string | Buffer): void {
    const key = this.requireKey(true);
    const sealed = seal(key, Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8'), `secret:${name}`);
    this.db
      .prepare(
        `INSERT INTO secrets (name, ciphertext, nonce, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, nonce = excluded.nonce, created_at = excluded.created_at`,
      )
      .run(name, sealed.ciphertext, sealed.nonce, this.now());
  }

  /** Read a secret, or null when there is none. Throws VaultError('locked'|'unavailable') or ('failed') if tampered with. */
  getSecret(name: string): Buffer | null {
    const row = this.db.prepare('SELECT ciphertext, nonce FROM secrets WHERE name = ?').get(name) as
      | { ciphertext: Buffer; nonce: Buffer }
      | undefined;
    if (!row) return null;
    const key = this.requireKey(false);
    const plain = open(key, { nonce: row.nonce, ciphertext: row.ciphertext }, `secret:${name}`);
    if (!plain) {
      throw new VaultError('failed', 'A saved sign-in could not be read: it was changed, or the key is wrong. Sign in again.');
    }
    return plain;
  }

  getSecretText(name: string): string | null {
    return this.getSecret(name)?.toString('utf8') ?? null;
  }

  /** Remove one secret (the app's own row). */
  deleteSecret(name: string): boolean {
    return this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name).changes > 0;
  }

  listSecretNames(): string[] {
    return (this.db.prepare('SELECT name FROM secrets ORDER BY name').all() as { name: string }[]).map((r) => r.name);
  }

  // ---- Passphrase --------------------------------------------------------------------------

  /** Protect the data key with a recovery passphrase (migrating from this-laptop-only protection). */
  async setPassphrase(passphrase: unknown): Promise<VaultResult> {
    return this.guarded(async () => {
      const bytes = this.passphraseBytes(passphrase, true);
      try {
        const record = this.loadRecord();
        if (record?.mode === 'passphrase') return failure('already-set', 'A recovery passphrase is already set. Use Change instead.');
        const dk = this.requireKey(true);
        const next = await this.wrap(dk, bytes, this.loadRecord());
        this.saveRecord(next);
        return this.result();
      } finally {
        bytes.fill(0);
      }
    });
  }

  /** Check the current passphrase, then protect the data key with a new one. Secrets are not re-encrypted. */
  async changePassphrase(current: unknown, next: unknown): Promise<VaultResult> {
    return this.guarded(async () => {
      const currentBytes = this.passphraseBytes(current, false);
      let nextBytes: Buffer | null = null;
      try {
        const record = this.loadRecord();
        if (record?.mode !== 'passphrase') return failure('not-set', 'No recovery passphrase is set.');
        nextBytes = this.passphraseBytes(next, true);
        const dk = await this.unwrap(record, currentBytes);
        if (!dk) return failure('wrong-passphrase', 'That is not the current passphrase.');
        this.adopt(dk);
        this.saveRecord(await this.wrap(dk, nextBytes, record));
        return this.result();
      } finally {
        currentBytes.fill(0);
        nextBytes?.fill(0);
      }
    });
  }

  /** Check the passphrase, then go back to this-laptop-only protection. */
  async removePassphrase(current: unknown): Promise<VaultResult> {
    return this.guarded(async () => {
      const bytes = this.passphraseBytes(current, false);
      try {
        const record = this.loadRecord();
        if (record?.mode !== 'passphrase') return failure('not-set', 'No recovery passphrase is set.');
        if (!this.protector.isAvailable()) {
          return failure('protected-storage', "Windows' protected storage is not available, so the key could not be kept on this laptop. Nothing was changed.");
        }
        const dk = await this.unwrap(record, bytes);
        if (!dk) return failure('wrong-passphrase', 'That is not the current passphrase.');
        this.adopt(dk);
        this.saveRecord({ v: 1, mode: 'device', createdAt: record.createdAt, dkCheck: record.dkCheck });
        return this.result();
      } finally {
        bytes.fill(0);
      }
    });
  }

  /** On a computer that does not have the key yet: type the passphrase once. */
  async unlock(passphrase: unknown): Promise<VaultResult> {
    return this.guarded(async () => {
      const bytes = this.passphraseBytes(passphrase, false);
      try {
        const record = this.loadRecord();
        if (record?.mode !== 'passphrase') return failure('not-set', 'No recovery passphrase is set.');
        const dk = await this.unwrap(record, bytes);
        if (!dk) return failure('wrong-passphrase', 'That is not the right passphrase.');
        this.adopt(dk);
        return this.result();
      } finally {
        bytes.fill(0);
      }
    });
  }

  /**
   * For the recovery file: the data key and the vault record (the key wrapped by the passphrase), only when a recovery passphrase
   * is set and the key is available on this computer. Null otherwise: a file made without a passphrase could not be opened on
   * another computer. The caller must wipe `key` after use.
   */
  recoveryKit(): { key: Buffer; record: unknown } | null {
    const record = this.loadRecord();
    if (record?.mode !== 'passphrase') return null;
    this.tryCache(record);
    return this.dataKey ? { key: Buffer.from(this.dataKey), record } : null;
  }

  /** Opens a vault record found in a recovery file with the typed passphrase: the data key, or null when it is wrong or the record is unusable. */
  async keyFromRecord(record: unknown, passphrase: unknown): Promise<Buffer | null> {
    const parsed = record as VaultRecord | null;
    if (!parsed || parsed.v !== 1 || parsed.mode !== 'passphrase' || typeof parsed.dkCheck !== 'string') return null;
    const bytes = this.passphraseBytes(passphrase, false);
    try {
      return await this.unwrap(parsed, bytes);
    } catch {
      return null;
    } finally {
      bytes.fill(0);
    }
  }

  /**
   * "Forgot passphrase" (or the protected key was lost): delete ONLY the app's own secrets rows, the
   * vault record in `meta` and the cached key file, so the vault starts over. The user signs in again.
   * No files, backups or other data are touched. `confirmed` must be true (the UI asks first).
   */
  forgetEverything(confirmed: unknown): VaultResult {
    if (confirmed !== true) return failure('needs-confirmation', 'Please confirm first. Nothing was deleted.');
    assertWritable(this.keyFile); // T7 write ban (the key cache lives in the data folder)
    const wipe = this.db.transaction(() => {
      this.db.prepare('DELETE FROM secrets').run();
      this.db.prepare('DELETE FROM meta WHERE key = ?').run(VAULT_META_KEY);
    });
    wipe();
    ownRemove(this.keyFile);
    this.dataKey?.fill(0);
    this.dataKey = null;
    return this.result();
  }

  /** Drop the key from memory (the app is closing). */
  close(): void {
    this.dataKey?.fill(0);
    this.dataKey = null;
  }

  // ---- Internals ---------------------------------------------------------------------------

  private async guarded(fn: () => Promise<VaultResult>): Promise<VaultResult> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof VaultError) return failure(err.code, err.message);
      // Never include arguments (they may hold a passphrase); the type and message are enough.
      return failure('failed', `Something went wrong (${err instanceof Error ? err.name : 'error'}). Nothing was changed.`);
    }
  }

  private passphraseBytes(value: unknown, mustBeNew: boolean): Buffer {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PASSPHRASE_LENGTH) {
      throw new VaultError('invalid', 'Please type the passphrase.');
    }
    // The same typing on another keyboard layout or computer should give the same bytes.
    const normalised = value.normalize('NFKC');
    if (mustBeNew) {
      if (characterCount(normalised) < MIN_PASSPHRASE_LENGTH) {
        throw new VaultError('too-short', `The passphrase needs at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      }
      if (!passphraseHint(normalised).acceptable) throw new VaultError('too-short', passphraseHint(normalised).text);
    }
    return Buffer.from(normalised, 'utf8');
  }

  private loadRecord(): VaultRecord | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(VAULT_META_KEY) as { value: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as VaultRecord;
      if (parsed.v !== 1 || (parsed.mode !== 'device' && parsed.mode !== 'passphrase') || typeof parsed.dkCheck !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private saveRecord(record: VaultRecord): void {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(VAULT_META_KEY, JSON.stringify(record));
  }

  /** Remember a data key in memory and, when possible, in this computer's protected cache. */
  private adopt(dk: Buffer): void {
    this.dataKey = Buffer.from(dk);
    this.writeCache(dk);
  }

  private writeCache(dk: Buffer): void {
    if (!this.protector.isAvailable()) return;
    assertWritable(this.keyFile); // T7 write ban
    writeFileAtomic(this.keyFile, Buffer.concat([KEY_FILE_MAGIC, this.protector.protect(dk)]));
  }

  /** Try to load the data key from the protected cache; verified against the record's check value. */
  private tryCache(record: VaultRecord): void {
    if (this.dataKey) return;
    try {
      const blob = fs.readFileSync(this.keyFile);
      if (blob.length <= KEY_FILE_MAGIC.length || !blob.subarray(0, KEY_FILE_MAGIC.length).equals(KEY_FILE_MAGIC)) return;
      if (!this.protector.isAvailable()) return;
      const dk = this.protector.unprotect(blob.subarray(KEY_FILE_MAGIC.length));
      if (dk.length === KEY_BYTES && safeEqualHex(hmacHex(dk, DK_CHECK_LABEL), record.dkCheck)) this.dataKey = dk;
    } catch {
      // No cache, or it cannot be decrypted here: the vault stays locked/unavailable.
    }
  }

  /** The data key, creating the vault first when `create` is set and nothing exists yet. */
  private requireKey(create: boolean): Buffer {
    const record = this.loadRecord();
    if (record) {
      this.tryCache(record);
      if (this.dataKey) return this.dataKey;
      if (record.mode === 'passphrase') {
        throw new VaultError('locked', 'Type your recovery passphrase once on this computer to unlock the saved sign-ins.');
      }
      throw new VaultError('unavailable', "This computer's protected key is missing, so the saved sign-ins cannot be read. Sign in again, or use \"Forgot passphrase\" to start over.");
    }
    if (!create) throw new VaultError('unavailable', 'There are no saved sign-ins.');
    if (!this.protector.isAvailable()) {
      throw new VaultError('protected-storage', "Windows' protected storage is not available, so sign-ins cannot be saved safely yet.");
    }
    const dk = randomBytes(KEY_BYTES);
    this.writeCache(dk);
    this.saveRecord({ v: 1, mode: 'device', createdAt: this.now(), dkCheck: hmacHex(dk, DK_CHECK_LABEL) });
    this.dataKey = dk;
    return dk;
  }

  /** Wrap the data key under a key from `passphrase` (fresh salt and nonces). */
  private async wrap(dk: Buffer, passphrase: Buffer, previous: VaultRecord | null): Promise<VaultRecord> {
    const salt = randomBytes(SALT_BYTES);
    const kek = await deriveKey(passphrase, salt, this.kdf);
    try {
      return {
        v: 1,
        mode: 'passphrase',
        createdAt: previous?.createdAt ?? this.now(),
        dkCheck: hmacHex(dk, DK_CHECK_LABEL),
        kdf: { name: 'scrypt', N: this.kdf.N, r: this.kdf.r, p: this.kdf.p, salt: salt.toString('base64') },
        wrappedDk: toStored(seal(kek, dk, AAD_WRAP)),
        keyCheck: toStored(seal(kek, CHECK_PLAINTEXT, AAD_CHECK)),
      };
    } finally {
      kek.fill(0);
    }
  }

  /** The data key if `passphrase` is right, otherwise null. */
  private async unwrap(record: VaultRecord, passphrase: Buffer): Promise<Buffer | null> {
    if (!record.kdf || !record.wrappedDk || !record.keyCheck || !validKdf(record.kdf)) {
      throw new VaultError('failed', 'The stored passphrase settings are damaged. Use "Forgot passphrase" to start over.');
    }
    const kek = await deriveKey(passphrase, Buffer.from(record.kdf.salt, 'base64'), record.kdf);
    try {
      const check = open(kek, fromStored(record.keyCheck), AAD_CHECK);
      if (!check || !check.equals(CHECK_PLAINTEXT)) return null;
      const dk = open(kek, fromStored(record.wrappedDk), AAD_WRAP);
      if (!dk || dk.length !== KEY_BYTES || !safeEqualHex(hmacHex(dk, DK_CHECK_LABEL), record.dkCheck)) return null;
      return dk;
    } finally {
      kek.fill(0);
    }
  }
}
