import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DecryptError, decryptV10, dpapiUnprotectWindows, readOsCryptKey } from './decrypt';
import { encryptV10 } from './fixture.testutil';

const key = randomBytes(32);

describe('decryptV10', () => {
  it('round-trips a value encrypted the way Electron safeStorage does', () => {
    const enc = encryptV10('1//synthetic-refresh-token', key);
    expect(decryptV10(enc, key).toString('utf8')).toBe('1//synthetic-refresh-token');
  });

  it('fails with the wrong key', () => {
    const enc = encryptV10('PLAINTEXT-123', key);
    expect(() => decryptV10(enc, randomBytes(32))).toThrow(DecryptError);
    try {
      decryptV10(enc, randomBytes(32));
    } catch (err) {
      expect((err as DecryptError).code).toBe('auth');
      expect((err as Error).message).not.toContain('PLAINTEXT-123');
    }
  });

  it('fails on a changed, truncated or foreign blob', () => {
    const raw = Buffer.from(encryptV10('value', key), 'base64');
    const flipped = Buffer.from(raw);
    flipped[flipped.length - 20] = (flipped[flipped.length - 20] ?? 0) ^ 0xff;
    expect(() => decryptV10(flipped.toString('base64'), key)).toThrow(/wrong key or damaged/);
    expect(() => decryptV10(raw.subarray(0, 20).toString('base64'), key)).toThrow(/too short/);
    const foreign = Buffer.concat([Buffer.from('v11'), raw.subarray(3)]);
    expect(() => decryptV10(foreign.toString('base64'), key)).toThrow(/format/);
    expect(() => decryptV10('not base64 at all !!!', key)).toThrow(DecryptError);
  });
});

describe('readOsCryptKey', () => {
  const localState = (encryptedKey: unknown) => JSON.stringify({ os_crypt: { encrypted_key: encryptedKey } });
  const wrap = (blob: Buffer) => Buffer.concat([Buffer.from('DPAPI'), blob]).toString('base64');

  it('unwraps the DPAPI blob after the DPAPI prefix', async () => {
    const blob = randomBytes(30);
    const seen: Buffer[] = [];
    const got = await readOsCryptKey(localState(wrap(blob)), async (b) => {
      seen.push(b);
      return Buffer.from(key);
    });
    expect(got.equals(key)).toBe(true);
    expect(seen[0]?.equals(blob)).toBe(true);
  });

  it('accepts a byte-order mark', async () => {
    const got = await readOsCryptKey(`\uFEFF${localState(wrap(randomBytes(8)))}`, async () => Buffer.from(key));
    expect(got.length).toBe(32);
  });

  it('reports a missing key, bad JSON, another format, a Windows failure and a wrong size', async () => {
    const ok = async () => Buffer.from(key);
    await expect(readOsCryptKey('{}', ok)).rejects.toMatchObject({ code: 'no-key' });
    await expect(readOsCryptKey('{ not json', ok)).rejects.toMatchObject({ code: 'bad-key-file' });
    await expect(readOsCryptKey(localState(Buffer.from('v20abcdef').toString('base64')), ok)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      readOsCryptKey(localState(wrap(randomBytes(8))), async () => {
        throw new Error('Key not valid for use in specified state.');
      }),
    ).rejects.toMatchObject({ code: 'dpapi' });
    await expect(readOsCryptKey(localState(wrap(randomBytes(8))), async () => randomBytes(16))).rejects.toMatchObject({ code: 'dpapi' });
  });
});

describe.skipIf(process.platform !== 'win32')('real Windows DPAPI', () => {
  it('unprotects a blob made for this user (PowerShell, no native modules)', async () => {
    const secret = randomBytes(32);
    const ps = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const protectedB64 = execFileSync(
      ps,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Security; $b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ' +
          '[Console]::Out.Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)))',
      ],
      { input: secret.toString('base64'), encoding: 'utf8', windowsHide: true },
    );
    const plain = await dpapiUnprotectWindows(Buffer.from(protectedB64, 'base64'));
    expect(plain.equals(secret)).toBe(true);
  }, 30_000);

  it('rejects garbage with a short message that holds no input', async () => {
    const garbage = randomBytes(40);
    await expect(dpapiUnprotectWindows(garbage)).rejects.toSatisfy((err: unknown) => {
      const message = (err as Error).message;
      return err instanceof DecryptError && !message.includes(garbage.toString('base64')) && message.length < 300;
    });
  }, 30_000);
});
