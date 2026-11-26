import { safeStorage } from 'electron';
import type { KeyProtector } from './vaultService';

/**
 * Electron safeStorage as the vault's machine-bound protector (DPAPI via Chromium's OSCrypt key in
 * the default userData `Local State`). The blob is only readable by this Windows user on this
 * computer, which is exactly why a typed passphrase is needed on another one.
 */
export const electronProtector: KeyProtector = {
  isAvailable: () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  },
  // The key is stored as base64 text because safeStorage works on strings.
  protect: (plain) => safeStorage.encryptString(plain.toString('base64')),
  unprotect: (blob) => Buffer.from(safeStorage.decryptString(blob), 'base64'),
};
