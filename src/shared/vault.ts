/**
 * Vault types shared by main, preload and renderer. Pure data and pure functions only.
 * Nothing here ever holds a passphrase or key.
 */

export const MIN_PASSPHRASE_LENGTH = 12;
export const MAX_PASSPHRASE_LENGTH = 1024;

export type VaultState =
  /** Secrets can be read and written (or there are none yet). */
  | 'unlocked'
  /** A passphrase is set and this computer does not have the key yet: type it once. */
  | 'locked'
  /** No passphrase, and this computer's protected key copy is missing or unreadable. */
  | 'unavailable';

export interface VaultStatus {
  hasPassphrase: boolean;
  state: VaultState;
  /** How many saved sign-ins/secrets the vault holds. */
  secretCount: number;
  /** False when Windows' protected storage cannot be used right now (very rare). */
  protectedStorageAvailable: boolean;
}

export type VaultErrorCode =
  | 'too-short'
  | 'wrong-passphrase'
  | 'already-set'
  | 'not-set'
  | 'locked'
  | 'unavailable'
  | 'protected-storage'
  | 'needs-confirmation'
  | 'invalid'
  | 'failed';

export type VaultResult = { ok: true; status: VaultStatus } | { ok: false; code: VaultErrorCode; message: string };

export type PassphraseLevel = 'empty' | 'short' | 'weak' | 'ok' | 'strong';

export interface PassphraseHint {
  level: PassphraseLevel;
  text: string;
  /** True when the passphrase may be used (long enough and not trivially repetitive). */
  acceptable: boolean;
}

/** Characters as a person counts them (an emoji is one), not UTF-16 units. */
export function characterCount(text: string): number {
  return Array.from(text).length;
}

/** Plain-language strength hint. A rough guide, not a guarantee: length matters most. */
export function passphraseHint(passphrase: string): PassphraseHint {
  const length = characterCount(passphrase);
  if (length === 0) return { level: 'empty', text: `At least ${MIN_PASSPHRASE_LENGTH} characters. A few unrelated words or a sentence is easy to remember.`, acceptable: false };
  if (length < MIN_PASSPHRASE_LENGTH) {
    const more = MIN_PASSPHRASE_LENGTH - length;
    return { level: 'short', text: `Too short: ${more} more ${more === 1 ? 'character' : 'characters'} needed.`, acceptable: false };
  }
  const unique = new Set(passphrase).size;
  if (unique < 6 || /^(.{1,3})\1+$/.test(passphrase)) {
    return { level: 'weak', text: 'Too repetitive. Use different words or characters.', acceptable: false };
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(passphrase)).length;
  const strong = length >= 20 || (length >= 16 && classes >= 3);
  return strong
    ? { level: 'strong', text: 'Strong. Keep it somewhere safe: nobody, including this app, can recover it.', acceptable: true }
    : { level: 'ok', text: 'Long enough. Longer is better, and a short sentence works well.', acceptable: true };
}
