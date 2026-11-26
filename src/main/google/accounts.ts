/**
 * Google accounts, from the Devices page and Settings (G1, G2): add an account (browser sign-in, the same flow as "Sign in again"), sign out (the
 * saved sign-in is given back to Google and forgotten here), take an account off the list, and save the Google app key (client id and secret).
 * Nothing here deletes or changes anything in a Google account except giving back this app's own permission, and nothing deletes a file row:
 * "Remove from the list" only hides the account and is refused while the account holds copies of backups.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db';
import { GOOGLE_VERIFIED_HOW, type GoogleAccountActionResult, type GoogleAddResult, type GoogleKeyInput, type GoogleKeyStatus } from '../../shared/googleCopy';
import { refreshTokenSecretName, SECRET_CLIENT_ID, SECRET_CLIENT_SECRET, VaultNotReadyError, type GoogleAuth, type GoogleVault } from './auth';
import { REVOKE_URL, type GoogleHttp } from './googleHttp';
import { forgetSecret, registerSecret, safeMessage } from './redact';
import { exchangeGrant, withBrowserSignIn } from './signIn';

export interface AccountVault extends GoogleVault {
  deleteSecret(name: string): boolean;
}

export interface GoogleAccountsDeps {
  db: Db;
  vault: AccountVault;
  auth: GoogleAuth;
  http: GoogleHttp;
  /** Opens the address in the person's own browser (Electron shell.openExternal). */
  openBrowser: (url: string) => Promise<void>;
  /** True while a job works with this account (a refresh, a copy): it cannot be signed out then. */
  busy?: (placeId: string) => boolean;
  /** The list of places changed: tell the window. */
  changed?: () => void;
  now?: () => number;
  uuid?: () => string;
  timeoutMs?: number;
  random?: (bytes: number) => Buffer;
}

interface PlaceRow {
  id: string;
  label: string;
  status: string;
  identity_json: string;
}

function parseIdentity(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const MAX_KEY_LENGTH = 400;

export class GoogleAccountsService {
  private signingIn = false;
  private readonly now: () => number;

  constructor(private readonly deps: GoogleAccountsDeps) {
    this.now = deps.now ?? Date.now;
  }

  private place(placeId: unknown): PlaceRow | null {
    if (typeof placeId !== 'string') return null;
    return (this.deps.db.prepare("SELECT id, label, status, identity_json FROM places WHERE id = ? AND kind = 'gdrive'").get(placeId) as PlaceRow | undefined) ?? null;
  }

  // ---- the Google app key (G2) -------------------------------------------------------------------------------------------------------------

  keyStatus(): GoogleKeyStatus {
    try {
      this.deps.auth.assertVaultReady();
    } catch (err) {
      if (err instanceof VaultNotReadyError) return { saved: false, problem: err.message };
      throw err;
    }
    try {
      const id = this.deps.vault.getSecretText(SECRET_CLIENT_ID);
      const secret = this.deps.vault.getSecretText(SECRET_CLIENT_SECRET);
      return { saved: !!id && !!secret, problem: null };
    } catch {
      return { saved: false, problem: 'Backup Hub cannot read the saved sign-ins on this computer right now. Open Settings > Security, then try again.' };
    }
  }

  /** Saves the client id and secret (kept like every other secret: locked on this computer). Replaces the old ones. */
  saveKey(input: GoogleKeyInput): GoogleAccountActionResult {
    const id = typeof input?.clientId === 'string' ? input.clientId.trim() : '';
    const secret = typeof input?.clientSecret === 'string' ? input.clientSecret.trim() : '';
    if (id === '' || secret === '') return { ok: false, message: 'Both boxes are needed: the client ID and the client secret from Google. Nothing was saved.' };
    if (/\s/.test(id) || /\s/.test(secret) || id.length > MAX_KEY_LENGTH || secret.length > MAX_KEY_LENGTH) return { ok: false, message: 'That does not look like a Google key (it has spaces or is too long). Copy it again from Google. Nothing was saved.' };
    try {
      this.deps.auth.assertVaultReady();
    } catch (err) {
      if (err instanceof VaultNotReadyError) return { ok: false, message: `${err.message} Nothing was saved.` };
      throw err;
    }
    registerSecret(secret);
    try {
      this.deps.vault.putSecret(SECRET_CLIENT_ID, id);
      this.deps.vault.putSecret(SECRET_CLIENT_SECRET, secret);
    } catch (err) {
      return { ok: false, message: `The key could not be saved securely: ${safeMessage(err)}` };
    }
    return { ok: true, message: 'The Google app key is saved.' };
  }

  // ---- add an account (G1) -----------------------------------------------------------------------------------------------------------------

  /** "Add a Google account": opens the browser, waits for the person to sign in, makes the account (its owner is `profileId`, else the first person). */
  async addAccount(profileId?: number): Promise<GoogleAddResult> {
    const { deps } = this;
    if (this.signingIn) return { ok: false, message: 'A sign-in is already open. Finish or close it first.' };
    let owner = profileId;
    if (owner !== undefined && !deps.db.prepare('SELECT 1 FROM profiles WHERE id = ?').pluck().get(owner)) return { ok: false, message: 'That person is not known. Nothing was added.' };
    owner ??= deps.db.prepare('SELECT min(id) FROM profiles').pluck().get() as number;
    let creds;
    try {
      creds = deps.auth.clientCredentials();
    } catch (err) {
      if (err instanceof VaultNotReadyError) return { ok: false, message: err.message };
      throw err;
    }
    this.signingIn = true;
    let added: { placeId: string; label: string } | null = null;
    try {
      const result = await withBrowserSignIn(
        { db: deps.db, vault: deps.vault, auth: deps.auth, http: deps.http, openBrowser: deps.openBrowser, ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}), ...(deps.random ? { random: deps.random } : {}) },
        creds,
        null,
        async (grant) => {
          const exchanged = await exchangeGrant({ db: deps.db, vault: deps.vault, auth: deps.auth, http: deps.http, openBrowser: deps.openBrowser }, creds, grant);
          if (!exchanged.ok) return exchanged;
          try {
            const email = exchanged.signedInAs;
            if (!email) return { ok: false, message: 'Google would not say which account signed in, so nothing was saved.' };
            const made = this.save(email, exchanged.refreshToken, owner);
            if (!made.ok) return made;
            added = made;
            return { ok: true, message: made.message };
          } finally {
            forgetSecret(exchanged.accessToken);
          }
        },
      );
      if (!result.ok || added === null) return { ok: false, message: result.message };
      deps.changed?.();
      const placed: { placeId: string; label: string } = added;
      return { ok: true, placeId: placed.placeId, label: placed.label, message: result.message };
    } catch (err) {
      return { ok: false, message: `The sign-in could not be finished: ${safeMessage(err)}` };
    } finally {
      this.signingIn = false;
    }
  }

  /** Makes the account's row (or brings back one that was taken off the list) and keeps its sign-in. */
  private save(email: string, refreshToken: string, owner: number): { ok: true; placeId: string; label: string; message: string } | { ok: false; message: string } {
    const { deps } = this;
    const rows = deps.db.prepare("SELECT id, label, status, identity_json FROM places WHERE kind = 'gdrive'").all() as PlaceRow[];
    const same = rows.find((r) => typeof parseIdentity(r.identity_json)['email'] === 'string' && (parseIdentity(r.identity_json)['email'] as string).toLowerCase() === email.toLowerCase());
    if (same) {
      const identity = parseIdentity(same.identity_json);
      if (typeof identity['removedAt'] !== 'number') {
        return { ok: false, message: `${email} is already in the list as "${same.label}". If it says it needs signing in, use "Sign in again" on it. Nothing was added.` };
      }
      delete identity['removedAt'];
      identity['signedInAt'] = this.now();
      deps.vault.putSecret(refreshTokenSecretName(same.id), refreshToken);
      deps.auth.invalidate(same.id);
      deps.db.prepare("UPDATE places SET identity_json = ?, status = 'unknown', profile_id = ? WHERE id = ?").run(JSON.stringify(identity), owner, same.id);
      return { ok: true, placeId: same.id, label: same.label, message: `${same.label} is back in the list. Choose Refresh to look at its files.` };
    }
    const id = (deps.uuid ?? randomUUID)();
    deps.vault.putSecret(refreshTokenSecretName(id), refreshToken);
    deps.db
      .prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, root_hint, last_looked_at, status, created_at) VALUES (?, ?, 'gdrive', ?, ?, NULL, NULL, 'unknown', ?)")
      .run(id, owner, email.slice(0, 60), JSON.stringify({ email, signedInAt: this.now() }), this.now());
    return { ok: true, placeId: id, label: email.slice(0, 60), message: `${email} is added. Choose Refresh to look at its files, and say whose account it is.` };
  }

  // ---- sign out, remove ---------------------------------------------------------------------------------------------------------------------

  /** Gives this app's permission back to Google and forgets the saved sign-in here. The account stays in the list ("needs signing in"). Nothing in the account is changed. */
  async signOut(placeId: unknown): Promise<GoogleAccountActionResult> {
    const place = this.place(placeId);
    if (!place) return { ok: false, message: 'That Google account is not in the list.' };
    if (this.deps.busy?.(place.id)) return { ok: false, message: `${place.label} is being used by a job right now. Stop the job first, then sign out.` };
    return this.forget(place, `${place.label} is signed out.`);
  }

  private async forget(place: PlaceRow, done: string): Promise<GoogleAccountActionResult> {
    const { deps } = this;
    let token: string | null = null;
    try {
      token = deps.vault.getSecretText(refreshTokenSecretName(place.id));
    } catch {
      token = null;
    }
    let revoked = token === null;
    if (token !== null) {
      registerSecret(token);
      try {
        await deps.http.request({ method: 'POST', url: REVOKE_URL, form: { token } });
        revoked = true;
      } catch {
        // Google could not be reached (or said no): the sign-in is still forgotten here, and the person is told.
        revoked = false;
      }
    }
    try {
      deps.vault.deleteSecret(refreshTokenSecretName(place.id));
    } catch (err) {
      return { ok: false, message: `The saved sign-in could not be removed: ${safeMessage(err)}` };
    }
    deps.auth.invalidate(place.id);
    if (token !== null) forgetSecret(token);
    deps.db.prepare("UPDATE places SET status = 'needs_signin' WHERE id = ?").run(place.id);
    deps.changed?.();
    return { ok: true, message: revoked ? done : `${done} Google could not be reached, so Backup Hub may still have access to the account: you can take that away at myaccount.google.com/permissions.` };
  }

  /** "Remove from the list": signs out and hides the account. Nothing in Google and no file row is deleted; refused while the account holds copies of backups. */
  async remove(placeId: unknown, confirmed: unknown): Promise<GoogleAccountActionResult> {
    const place = this.place(placeId);
    if (!place) return { ok: false, message: 'That Google account is not in the list.' };
    if (confirmed !== true) return { ok: false, message: 'Please confirm first. Nothing was changed.' };
    if (this.deps.busy?.(place.id)) return { ok: false, message: `${place.label} is being used by a job right now. Stop the job first.` };
    const held = this.deps.db.prepare(`SELECT count(*) FROM files WHERE place_id = ? AND verified_how = '${GOOGLE_VERIFIED_HOW}' AND gone_at IS NULL`).pluck().get(place.id) as number;
    if (held > 0) return { ok: false, message: `${place.label} holds ${held.toLocaleString('en-US')} ${held === 1 ? 'copy' : 'copies'} of your backups, so it stays in the list. Nothing was changed.` };
    const signedOut = await this.forget(place, '');
    if (!signedOut.ok) return signedOut;
    const identity = parseIdentity(place.identity_json);
    identity['removedAt'] = this.now();
    this.deps.db.prepare('UPDATE places SET identity_json = ? WHERE id = ?').run(JSON.stringify(identity), place.id);
    this.deps.changed?.();
    const note = signedOut.message.trim();
    return { ok: true, message: `${place.label} is taken off the list. Nothing in the Google account was deleted.${note ? ' ' + note : ''}` };
  }
}
