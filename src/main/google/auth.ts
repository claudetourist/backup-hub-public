/**
 * Access tokens for Google accounts. Client id/secret and refresh tokens come from the vault
 * (`google.clientId`, `google.clientSecret`, `gdrive.refreshToken.<placeId>`); access tokens live
 * in memory only, are refreshed when they expire (or after a 401, once), and are never logged.
 */
import { GoogleApiError, GoogleHttp, TOKEN_URL } from './googleHttp';
import { forgetSecret, registerSecret } from './redact';

export const SECRET_CLIENT_ID = 'google.clientId';
export const SECRET_CLIENT_SECRET = 'google.clientSecret';
export const refreshTokenSecretName = (placeId: string): string => `gdrive.refreshToken.${placeId}`;

export const LOCKED_MESSAGE = 'The saved sign-ins are locked. Type your recovery passphrase in Settings > Security first.';
export const UNAVAILABLE_MESSAGE = 'Backup Hub cannot read the saved sign-ins on this computer right now. Open Settings > Security, then try again.';
export const NO_CLIENT_MESSAGE = 'The Google app details (client id and secret) are not saved yet. Bring the accounts in from Fleet Manager v1 in Settings first.';

/** The vault is locked or cannot be read: nothing can be done for any account. */
export class VaultNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultNotReadyError';
  }
}

/** Google no longer accepts this account's saved sign-in (or none was saved). */
export class NeedsSignInError extends Error {
  constructor(
    readonly placeId: string,
    message = 'Google no longer accepts the saved sign-in.',
  ) {
    super(message);
    this.name = 'NeedsSignInError';
  }
}

/** The slice of the vault the Google code needs (the real VaultService fits). */
export interface GoogleVault {
  status(): { state: string };
  getSecretText(name: string): string | null;
  putSecret(name: string, value: string | Buffer): void;
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

/** Refresh a little early so a token never expires in the middle of a request. */
const EXPIRY_MARGIN_MS = 60_000;

export class GoogleAuth {
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly vault: GoogleVault,
    private readonly http: GoogleHttp,
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws VaultNotReadyError with a plain sentence unless the vault can be read. */
  assertVaultReady(): void {
    const state = this.vault.status().state;
    if (state === 'locked') throw new VaultNotReadyError(LOCKED_MESSAGE);
    if (state !== 'unlocked') throw new VaultNotReadyError(UNAVAILABLE_MESSAGE);
  }

  /** Client id and secret from the vault; registers them for redaction. */
  clientCredentials(): ClientCredentials {
    this.assertVaultReady();
    const clientId = this.read(SECRET_CLIENT_ID);
    const clientSecret = this.read(SECRET_CLIENT_SECRET);
    if (!clientId || !clientSecret) throw new VaultNotReadyError(NO_CLIENT_MESSAGE);
    registerSecret(clientSecret);
    return { clientId, clientSecret };
  }

  hasRefreshToken(placeId: string): boolean {
    try {
      return this.read(refreshTokenSecretName(placeId)) !== null;
    } catch {
      return false;
    }
  }

  private read(name: string): string | null {
    try {
      const value = this.vault.getSecretText(name);
      return value === null || value === '' ? null : value;
    } catch (err) {
      throw new VaultNotReadyError(err instanceof Error ? err.message : UNAVAILABLE_MESSAGE);
    }
  }

  /** A valid access token for the account (cached in memory). `force` skips the cache (after a 401). */
  async accessToken(placeId: string, signal?: AbortSignal, force = false): Promise<string> {
    const cached = this.cache.get(placeId);
    if (!force && cached && cached.expiresAt - EXPIRY_MARGIN_MS > this.now()) return cached.token;
    if (cached) {
      forgetSecret(cached.token);
      this.cache.delete(placeId);
    }
    const { clientId, clientSecret } = this.clientCredentials();
    const refreshToken = this.read(refreshTokenSecretName(placeId));
    if (!refreshToken) throw new NeedsSignInError(placeId, 'No saved sign-in for this account.');
    registerSecret(refreshToken);
    let json: Record<string, unknown>;
    try {
      ({ json } = await this.http.request({
        method: 'POST',
        url: TOKEN_URL,
        form: { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' },
        signal,
      }));
    } catch (err) {
      if (err instanceof GoogleApiError && (err.reason === 'invalid_grant' || err.reason === 'unauthorized_client')) throw new NeedsSignInError(placeId);
      throw err;
    }
    const token = json['access_token'];
    if (typeof token !== 'string' || token === '') throw new GoogleApiError(200, null, 'Google did not return an access token.');
    const lifetime = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600;
    registerSecret(token);
    this.cache.set(placeId, { token, expiresAt: this.now() + lifetime * 1000 });
    return token;
  }

  /** Forget the in-memory token (for example after a new sign-in). */
  invalidate(placeId: string): void {
    const cached = this.cache.get(placeId);
    if (cached) forgetSecret(cached.token);
    this.cache.delete(placeId);
  }
}
