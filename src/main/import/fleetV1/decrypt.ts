import { createDecipheriv } from 'node:crypto';
import path from 'node:path';
import { powershellArgs, runChild } from '../../lifecycle/childProcesses';
import { parseJsonLoose } from '../../fsutil';

/**
 * Reading Fleet Manager v1's secrets. v1 used Electron safeStorage on Windows:
 * - each value is base64 of  "v10" + 12-byte nonce + AES-256-GCM ciphertext + 16-byte tag;
 * - the AES key is `os_crypt.encrypted_key` in the "Local State" JSON: base64 of "DPAPI" + a
 *   Windows DPAPI blob (current user) that unwraps to the 32-byte key.
 * Nothing here logs or returns text that contains a secret.
 */

export const DPAPI_PREFIX = 'DPAPI';
export const V10_PREFIX = 'v10';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type DecryptErrorCode = 'no-key' | 'bad-key-file' | 'dpapi' | 'bad-blob' | 'unsupported' | 'auth';

export class DecryptError extends Error {
  constructor(
    readonly code: DecryptErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DecryptError';
  }
}

/** Unwraps a DPAPI (current user) blob. Real: PowerShell. Tests inject a fake. */
export type DpapiUnprotect = (blob: Buffer) => Promise<Buffer>;

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'Add-Type -AssemblyName System.Security',
  '$text = [Console]::In.ReadToEnd().Trim()',
  '$bytes = [Convert]::FromBase64String($text)',
  '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($plain))',
].join('; ');

function powershellPath(): string {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Run a hidden PowerShell, feed `input` on stdin, return stdout. Rejects with a short, secret-free message. */
function runPowershell(script: string, input: string, timeoutMs: number): Promise<string> {
  return runChild(powershellPath(), powershellArgs(script), { timeoutMs, maxBuffer: 1024 * 1024, input }).then(
    ({ stdout }) => stdout,
    (error: Error & { stderr?: string }) => {
      const line = (error.stderr || error.message).split(/\r?\n/).find((l) => l.trim() !== '') ?? 'unknown error';
      throw new DecryptError('dpapi', `Windows could not unlock the saved key (${line.trim().slice(0, 140)})`);
    },
  );
}

/** Real DPAPI unprotect for the current Windows user (no native modules). */
export const dpapiUnprotectWindows: DpapiUnprotect = async (blob) => {
  const out = await runPowershell(SCRIPT, blob.toString('base64'), 30_000);
  const plain = Buffer.from(out.trim(), 'base64');
  if (plain.length === 0) throw new DecryptError('dpapi', 'Windows returned an empty key');
  return plain;
};

/** The AES key from the text of v1's "Local State" file. */
export async function readOsCryptKey(localStateText: string, unprotect: DpapiUnprotect): Promise<Buffer> {
  let encryptedKey: unknown;
  try {
    const parsed = parseJsonLoose(localStateText) as { os_crypt?: { encrypted_key?: unknown } } | null;
    encryptedKey = parsed?.os_crypt?.encrypted_key;
  } catch {
    throw new DecryptError('bad-key-file', 'The "Local State" file is not readable JSON');
  }
  if (typeof encryptedKey !== 'string' || encryptedKey === '') {
    throw new DecryptError('no-key', 'The "Local State" file has no saved key');
  }
  const wrapped = Buffer.from(encryptedKey, 'base64');
  if (wrapped.subarray(0, DPAPI_PREFIX.length).toString('latin1') !== DPAPI_PREFIX) {
    throw new DecryptError('unsupported', 'The saved key is in a format this version does not understand');
  }
  let key: Buffer;
  try {
    key = await unprotect(wrapped.subarray(DPAPI_PREFIX.length));
  } catch (err) {
    if (err instanceof DecryptError) throw err;
    throw new DecryptError('dpapi', 'Windows could not unlock the saved key');
  }
  if (key.length !== KEY_BYTES) {
    key.fill(0);
    throw new DecryptError('dpapi', 'The unlocked key has an unexpected size');
  }
  return key;
}

/** Decrypt one v1 value (base64 text in the database). The caller should zero the returned buffer after use. */
export function decryptV10(valueBase64: string, key: Buffer): Buffer {
  const blob = Buffer.from(valueBase64, 'base64');
  if (blob.length < V10_PREFIX.length + NONCE_BYTES + TAG_BYTES) throw new DecryptError('bad-blob', 'The saved value is too short');
  if (blob.subarray(0, V10_PREFIX.length).toString('latin1') !== V10_PREFIX) {
    throw new DecryptError('unsupported', 'The saved value is in a format this version does not understand');
  }
  const nonce = blob.subarray(V10_PREFIX.length, V10_PREFIX.length + NONCE_BYTES);
  const rest = blob.subarray(V10_PREFIX.length + NONCE_BYTES);
  const tag = rest.subarray(rest.length - TAG_BYTES);
  const body = rest.subarray(0, rest.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new DecryptError('auth', 'The saved value could not be unlocked (wrong key or damaged)');
  }
}
