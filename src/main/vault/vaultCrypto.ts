import { createHmac, createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** scrypt cost from the plan: N = 2^17, r = 8, p = 1, 32-byte key. */
export const SCRYPT_PARAMS = { N: 131072, r: 8, p: 1 } as const;
export const KEY_BYTES = 32;
export const SALT_BYTES = 16;
export const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface KdfParams {
  N: number;
  r: number;
  p: number;
}

/** Accept only sane scrypt parameters read back from the database (a power of two, bounded cost). */
export function validKdf(params: KdfParams): boolean {
  const { N, r, p } = params;
  return (
    Number.isInteger(N) && N >= 1024 && N <= 2 ** 20 && (N & (N - 1)) === 0 &&
    Number.isInteger(r) && r >= 1 && r <= 32 &&
    Number.isInteger(p) && p >= 1 && p <= 16
  );
}

/** Derive a 32-byte key from a passphrase (as bytes) with scrypt. Asynchronous: the UI is not blocked. */
export function deriveKey(passphrase: Buffer, salt: Buffer, params: KdfParams = SCRYPT_PARAMS): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      KEY_BYTES,
      { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * params.p + 4 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export interface Sealed {
  nonce: Buffer;
  /** Ciphertext with the 16-byte GCM tag appended. */
  ciphertext: Buffer;
}

/** AES-256-GCM with a fresh random 12-byte nonce for every call. `aad` binds the ciphertext to its purpose. */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext: Buffer.concat([body, cipher.getAuthTag()]) };
}

/** Returns the plaintext, or null when the key is wrong or the data, nonce or aad was altered. */
export function open(key: Buffer, sealed: Sealed, aad: string): Buffer | null {
  if (sealed.nonce.length !== NONCE_BYTES || sealed.ciphertext.length < TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES)), decipher.final()]);
  } catch {
    return null;
  }
}

/** HMAC-SHA256 hex, used to tell whether a cached data key is still the right one. */
export function hmacHex(key: Buffer, label: string): string {
  return createHmac('sha256', key).update(label, 'utf8').digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
