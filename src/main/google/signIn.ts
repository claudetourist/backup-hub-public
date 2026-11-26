/**
 * "Sign in again" for a Google account (user-started only). Loopback sign-in like Fleet Manager
 * v1: a tiny web server on 127.0.0.1 (random port) waits for Google to send the browser back,
 * PKCE (S256) and a random `state` protect the exchange, the system browser opens Google's page,
 * and the result is only saved when Google says the person signed in as the account on the card.
 * The server is always closed. This file makes no network calls of its own: the code exchange and
 * the e-mail check go through GoogleHttp (the allowlist).
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DriveSignInResult } from '../../shared/drive';
import type { Db } from '../db';
import { refreshTokenSecretName, VaultNotReadyError, type GoogleAuth, type GoogleVault } from './auth';
import { GoogleApiError, NetworkError, TOKEN_URL, USERINFO_URL, type GoogleHttp } from './googleHttp';
import { forgetSecret, registerSecret, safeMessage } from './redact';

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
/** The same scopes as Fleet Manager v1, so its consent screen and project setup apply. */
export const SCOPES = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/userinfo.email', 'openid'];
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export interface SignInDeps {
  db: Db;
  vault: GoogleVault;
  auth: GoogleAuth;
  http: GoogleHttp;
  /** Opens the address in the person's own browser (Electron shell.openExternal). */
  openBrowser: (url: string) => Promise<void>;
  timeoutMs?: number;
  /** Fixed random values for tests. */
  random?: (bytes: number) => Buffer;
}

const b64url = (buf: Buffer): string => buf.toString('base64url');

export function pkceChallenge(verifier: string): string {
  return b64url(createHash('sha256').update(verifier).digest());
}

const PAGE = (text: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Backup Hub</title></head><body style="font-family:sans-serif;margin:3em"><p>${text}</p></body></html>`;

interface Outcome {
  code?: string;
  error?: string;
}

export async function signInAgain(deps: SignInDeps, placeId: string): Promise<DriveSignInResult> {
  const place = deps.db.prepare("SELECT label, identity_json FROM places WHERE id = ? AND kind = 'gdrive'").get(placeId) as { label: string; identity_json: string } | undefined;
  if (!place) return { ok: false, message: 'That Google account no longer exists.' };
  let email: string | null = null;
  try {
    const parsed = JSON.parse(place.identity_json) as { email?: unknown };
    email = typeof parsed.email === 'string' ? parsed.email : null;
  } catch {
    email = null;
  }
  if (!email) return { ok: false, message: 'Backup Hub does not know the e-mail address of this account, so it cannot check who signs in.' };

  let creds;
  try {
    creds = deps.auth.clientCredentials();
  } catch (err) {
    if (err instanceof VaultNotReadyError) return { ok: false, message: err.message };
    throw err;
  }

  return withBrowserSignIn(deps, creds, email, (grant) => finish(deps, placeId, place.label, email, creds, grant));
}

/** What the browser sends back: the code, and what was made to protect it (PKCE verifier, the address the browser was sent to). */
export interface BrowserGrant {
  code: string;
  verifier: string;
  redirectUri: string;
}

/**
 * Opens Google's sign-in page in the person's browser and waits (at most 5 minutes) for the browser to come back to a tiny server on 127.0.0.1 (a random port),
 * checking `state` and PKCE. `loginHint` pre-selects the account ("sign in again"), null lets the person pick (a new account). `then` gets the grant and
 * finishes the sign-in; the server is always closed afterwards.
 */
export async function withBrowserSignIn(
  deps: SignInDeps,
  creds: { clientId: string; clientSecret: string },
  loginHint: string | null,
  then: (grant: BrowserGrant) => Promise<DriveSignInResult>,
): Promise<DriveSignInResult> {
  const random = deps.random ?? randomBytes;
  const verifier = b64url(random(32));
  const state = b64url(random(16));
  registerSecret(verifier);

  let redirectUri = '';
  let server: http.Server | null = null;
  let timer: NodeJS.Timeout | null = null;
  try {
    const outcome = await new Promise<Outcome>((resolve, reject) => {
      let settled = false;
      const done = (o: Outcome) => {
        if (settled) return;
        settled = true;
        resolve(o);
      };
      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        if (url.searchParams.get('state') !== state) {
          // Not our sign-in (a stray request, or a forged one): ignore it and keep waiting.
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(PAGE('This page is not part of the sign-in. You can close it.'));
          return;
        }
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (error) {
          res.end(PAGE('Sign-in was cancelled. You can close this tab and go back to Backup Hub.'));
          done({ error: 'The sign-in was cancelled.' });
        } else if (code) {
          registerSecret(code);
          res.end(PAGE('Signed in. You can close this tab and go back to Backup Hub.'));
          done({ code });
        } else {
          res.end(PAGE('Nothing arrived. You can close this tab.'));
        }
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = (server!.address() as AddressInfo).port;
        const redirect = `http://127.0.0.1:${port}`;
        timer = setTimeout(() => done({ error: 'Nobody signed in within 5 minutes, so the sign-in was closed. Nothing was changed.' }), deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
        const authUrl = new URL(AUTH_URL);
        authUrl.search = new URLSearchParams({
          client_id: creds.clientId,
          redirect_uri: redirect,
          response_type: 'code',
          scope: SCOPES.join(' '),
          state,
          code_challenge: pkceChallenge(verifier),
          code_challenge_method: 'S256',
          access_type: 'offline',
          prompt: 'consent',
          ...(loginHint !== null ? { login_hint: loginHint } : {}),
        }).toString();
        void (async () => {
          try {
            await deps.openBrowser(authUrl.toString());
          } catch {
            done({ error: 'Backup Hub could not open your web browser to sign in.' });
          }
        })();
        redirectUri = redirect;
      });
    });
    if (outcome.error || !outcome.code) return { ok: false, message: outcome.error ?? 'The sign-in did not finish.' };
    return await then({ code: outcome.code, verifier, redirectUri });
  } catch (err) {
    return { ok: false, message: `The sign-in could not be started: ${safeMessage(err)}` };
  } finally {
    if (timer) clearTimeout(timer);
    const s = server as http.Server | null;
    if (s) {
      s.close();
      s.closeAllConnections();
    }
    forgetSecret(verifier);
  }
}

/** What Google gave for the code: the lasting sign-in, a short pass, and the address of the account that signed in. */
export type Exchanged = { ok: true; refreshToken: string; accessToken: string; signedInAs: string | null } | { ok: false; message: string };

/** Trades the code for tokens, checks the Drive permission was ticked, and asks Google which account signed in. Saves nothing. */
export async function exchangeGrant(deps: SignInDeps, creds: { clientId: string; clientSecret: string }, grant: BrowserGrant): Promise<Exchanged> {
  let json: Record<string, unknown>;
  try {
    ({ json } = await deps.http.request({
      method: 'POST',
      url: TOKEN_URL,
      form: {
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        code: grant.code,
        code_verifier: grant.verifier,
        redirect_uri: grant.redirectUri,
        grant_type: 'authorization_code',
      },
    }));
  } catch (err) {
    if (err instanceof NetworkError) return { ok: false, message: 'No internet connection, so the sign-in could not be finished. Nothing was changed.' };
    if (err instanceof GoogleApiError) return { ok: false, message: `Google did not accept the sign-in (${err.reason ?? err.status}). Nothing was changed.` };
    throw err;
  }
  const refreshToken = json['refresh_token'];
  const accessToken = json['access_token'];
  if (typeof refreshToken === 'string') registerSecret(refreshToken);
  if (typeof accessToken === 'string') registerSecret(accessToken);
  if (typeof refreshToken !== 'string' || typeof accessToken !== 'string') {
    return {
      ok: false,
      message:
        'Google did not give Backup Hub a lasting sign-in. If you signed in here before, remove Backup Hub at myaccount.google.com/permissions and try again. Nothing was changed.',
    };
  }
  const granted = typeof json['scope'] === 'string' ? json['scope'].split(' ') : [];
  if (!granted.includes(SCOPES[0]!)) {
    return { ok: false, message: 'The Google Drive permission was not ticked on the permissions screen. Sign in again and keep every box ticked. Nothing was changed.' };
  }

  let signedInAs: string | null = null;
  try {
    const info = await deps.http.request({ method: 'GET', url: USERINFO_URL, bearer: accessToken });
    signedInAs = typeof info.json['email'] === 'string' ? info.json['email'] : null;
  } catch (err) {
    if (err instanceof NetworkError) return { ok: false, message: 'No internet connection, so the sign-in could not be checked. Nothing was changed.' };
    return { ok: false, message: 'Google would not say which account signed in, so nothing was saved.' };
  }
  return { ok: true, refreshToken, accessToken, signedInAs };
}

async function finish(deps: SignInDeps, placeId: string, label: string, email: string, creds: { clientId: string; clientSecret: string }, grant: BrowserGrant): Promise<DriveSignInResult> {
  const exchanged = await exchangeGrant(deps, creds, grant);
  if (!exchanged.ok) return exchanged;
  const { refreshToken, accessToken, signedInAs } = exchanged;
  if (!signedInAs || signedInAs.toLowerCase() !== email.toLowerCase()) {
    return {
      ok: false,
      message: `You signed in as ${signedInAs ?? 'another account'}, but this card is for ${label}. Nothing was saved. Try again and pick the right account.`,
    };
  }

  try {
    deps.vault.putSecret(refreshTokenSecretName(placeId), refreshToken);
  } catch (err) {
    return { ok: false, message: err instanceof Error && err.message ? `The new sign-in could not be saved securely: ${safeMessage(err)}` : 'The new sign-in could not be saved securely.' };
  }
  deps.auth.invalidate(placeId);
  // Not "connected" yet: the next refresh checks it with Google and sets that.
  // `signedInAt` also tells a later v1 import that this sign-in is newer than the archive and must not be replaced.
  const row = deps.db.prepare('SELECT identity_json FROM places WHERE id = ?').get(placeId) as { identity_json: string } | undefined;
  let identity: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row?.identity_json ?? '{}');
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) identity = parsed as Record<string, unknown>;
  } catch {
    // An unreadable identity is replaced by just the sign-in time.
  }
  identity['signedInAt'] = Date.now();
  deps.db.prepare("UPDATE places SET status = 'unknown', identity_json = ? WHERE id = ?").run(JSON.stringify(identity), placeId);
  forgetSecret(typeof accessToken === 'string' ? accessToken : null);
  return { ok: true, message: `${label} is signed in again. Choose Refresh to look at its files.` };
}
