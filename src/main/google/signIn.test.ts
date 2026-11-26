import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, type Db } from '../db';
import { GoogleAuth, type GoogleVault } from './auth';
import { GoogleHttp } from './googleHttp';
import { SCOPES, signInAgain, type SignInDeps } from './signIn';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const PLACE = 'place-a';

let dir: string;
let db: Db;
let secrets: Map<string, string>;
let tokenForm: Record<string, string> | null;
let tokenAnswer: () => Response;
let userinfoEmail: string | null;
let requests: { method: string; url: string }[];
let opened: URL | null;

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-signin-'));
  const o = initDatabase(dir, silent);
  if (!o.ok) throw new Error('db');
  db = o.db;
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES (?, 1, 'gdrive', 'Alice', ?, 'needs_signin', 1)").run(PLACE, JSON.stringify({ email: 'Alice@Example.com' }));
  secrets = new Map([
    ['google.clientId', 'client-id-123'],
    ['google.clientSecret', 'GOCSPX-secret'],
    [`gdrive.refreshToken.${PLACE}`, '1//old-refresh'],
  ]);
  tokenForm = null;
  userinfoEmail = 'alice@example.com';
  requests = [];
  opened = null;
  tokenAnswer = () => json(200, { access_token: 'ya29.new-access', refresh_token: '1//new-refresh', expires_in: 3600, scope: SCOPES.join(' ') });
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

const vault: GoogleVault = {
  status: () => ({ state: 'unlocked' }),
  getSecretText: (name) => secrets.get(name) ?? null,
  putSecret: (name, value) => void secrets.set(name, value.toString()),
};

/** Talks to the sign-in server on this computer (loopback only), like the browser would. */
function loopbackGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent: false }, (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

function deps(browser: (url: URL) => Promise<void>, extra: Partial<SignInDeps> = {}): SignInDeps {
  const googleHttp = new GoogleHttp({
    fetchFn: (input, init) => {
      const url = new URL(input);
      requests.push({ method: init.method ?? 'GET', url: url.origin + url.pathname });
      if (url.pathname === '/token') {
        tokenForm = Object.fromEntries(new URLSearchParams(init.body as string));
        return Promise.resolve(tokenAnswer());
      }
      if (url.pathname === '/v1/userinfo') return Promise.resolve(userinfoEmail ? json(200, { email: userinfoEmail }) : json(200, {}));
      return Promise.resolve(json(404, {}));
    },
  });
  return {
    db,
    vault,
    auth: new GoogleAuth(vault, googleHttp),
    http: googleHttp,
    openBrowser: (url) => {
      opened = new URL(url);
      return browser(opened);
    },
    ...extra,
  };
}

/** A browser that comes back to the sign-in page with the given code (and the state from the address, unless overridden). */
const comesBack = (params: (url: URL) => Record<string, string>) => async (url: URL) => {
  const redirect = new URL(url.searchParams.get('redirect_uri')!);
  for (const [k, v] of Object.entries(params(url))) redirect.searchParams.set(k, v);
  await loopbackGet(redirect.toString());
};

const savedToken = (): string | undefined => secrets.get(`gdrive.refreshToken.${PLACE}`);
const status = (): string => (db.prepare('SELECT status FROM places WHERE id = ?').get(PLACE) as { status: string }).status;

describe('Sign in again', () => {
  it('opens Google with PKCE, a state, the account as login hint and the same scopes as v1; saves the new sign-in', async () => {
    const result = await signInAgain(deps(comesBack((u) => ({ code: '4/0AfakeCode123456', state: u.searchParams.get('state')! }))), PLACE);
    expect(result).toMatchObject({ ok: true });

    expect(opened!.origin + opened!.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = opened!.searchParams;
    expect(q.get('client_id')).toBe('client-id-123');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe('https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email openid');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
    expect(q.get('login_hint')).toBe('Alice@Example.com');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toMatch(/^[\w-]{16,}$/);
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // The code exchange proves the verifier that belongs to the challenge, with the same redirect address.
    expect(tokenForm).toMatchObject({ grant_type: 'authorization_code', code: '4/0AfakeCode123456', client_id: 'client-id-123', client_secret: 'GOCSPX-secret', redirect_uri: q.get('redirect_uri') });
    expect(createHash('sha256').update(tokenForm!['code_verifier']!).digest('base64url')).toBe(q.get('code_challenge'));

    expect(savedToken()).toBe('1//new-refresh');
    expect(status()).toBe('unknown');
    // The time is kept so a later v1 import knows this sign-in is newer than the archive.
    const identity = JSON.parse((db.prepare('SELECT identity_json FROM places WHERE id = ?').get(PLACE) as { identity_json: string }).identity_json);
    expect(typeof identity.signedInAt).toBe('number');
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(['POST https://oauth2.googleapis.com/token', 'GET https://openidconnect.googleapis.com/v1/userinfo']);
  });

  it('ignores a request with a wrong state and keeps waiting for the real one', async () => {
    let stray = { status: 0, body: '' };
    const result = await signInAgain(
      deps(async (url) => {
        const redirect = new URL(url.searchParams.get('redirect_uri')!);
        const bad = new URL(redirect);
        bad.searchParams.set('code', '4/0Aforged-code-123456');
        bad.searchParams.set('state', 'not-the-state');
        stray = await loopbackGet(bad.toString());
        const missing = await loopbackGet(redirect.toString());
        expect(missing.status).toBe(400);
        redirect.searchParams.set('code', '4/0Agood-code-1234567');
        redirect.searchParams.set('state', url.searchParams.get('state')!);
        await loopbackGet(redirect.toString());
      }),
      PLACE,
    );
    expect(stray.status).toBe(400);
    expect(result).toMatchObject({ ok: true });
    expect(tokenForm!['code']).toBe('4/0Agood-code-1234567'); // the forged code was never used
  });

  it('times out when nobody comes back, saves nothing and closes the server', async () => {
    let port = 0;
    const result = await signInAgain(
      deps(
        async (url) => {
          port = Number(new URL(url.searchParams.get('redirect_uri')!).port);
          await loopbackGet(`http://127.0.0.1:${port}/?state=wrong&code=x`);
        },
        { timeoutMs: 150 },
      ),
      PLACE,
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { message: string }).message).toMatch(/within 5 minutes/);
    expect(savedToken()).toBe('1//old-refresh');
    expect(status()).toBe('needs_signin');
    expect(requests).toHaveLength(0);
    await expect(loopbackGet(`http://127.0.0.1:${port}/?state=x`)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('closes the server after success too', async () => {
    let port = 0;
    await signInAgain(
      deps(async (url) => {
        port = Number(new URL(url.searchParams.get('redirect_uri')!).port);
        await comesBack((u) => ({ code: '4/0Acode-1234567890', state: u.searchParams.get('state')! }))(url);
      }),
      PLACE,
    );
    await expect(loopbackGet(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('a cancelled sign-in saves nothing', async () => {
    const result = await signInAgain(deps(comesBack((u) => ({ error: 'access_denied', state: u.searchParams.get('state')! }))), PLACE);
    expect(result).toMatchObject({ ok: false, message: 'The sign-in was cancelled.' });
    expect(savedToken()).toBe('1//old-refresh');
    expect(requests).toHaveLength(0);
  });

  it('a different account signs in: nothing is saved and the person is told which account it was', async () => {
    userinfoEmail = 'someone.else@example.com';
    const result = await signInAgain(deps(comesBack((u) => ({ code: '4/0Acode-1234567890', state: u.searchParams.get('state')! }))), PLACE);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('someone.else@example.com');
    expect(result.message).toContain('Alice');
    expect(savedToken()).toBe('1//old-refresh');
    expect(status()).toBe('needs_signin');
  });

  it('the e-mail comparison ignores upper and lower case', async () => {
    userinfoEmail = 'ALICE@EXAMPLE.COM';
    expect((await signInAgain(deps(comesBack((u) => ({ code: '4/0Acode-1234567890', state: u.searchParams.get('state')! }))), PLACE)).ok).toBe(true);
  });

  it('no lasting sign-in from Google: nothing is saved', async () => {
    tokenAnswer = () => json(200, { access_token: 'ya29.only-access', expires_in: 3600, scope: SCOPES.join(' ') });
    const result = await signInAgain(deps(comesBack((u) => ({ code: '4/0Acode-1234567890', state: u.searchParams.get('state')! }))), PLACE);
    expect(result.ok).toBe(false);
    expect(savedToken()).toBe('1//old-refresh');
  });

  it('the Drive permission was not ticked: nothing is saved', async () => {
    tokenAnswer = () => json(200, { access_token: 'ya29.a', refresh_token: '1//r', expires_in: 3600, scope: 'openid https://www.googleapis.com/auth/userinfo.email' });
    const result = await signInAgain(deps(comesBack((u) => ({ code: '4/0Acode-1234567890', state: u.searchParams.get('state')! }))), PLACE);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Drive permission/);
    expect(savedToken()).toBe('1//old-refresh');
    expect(requests.some((r) => r.url.endsWith('/userinfo'))).toBe(false);
  });

  it('the browser cannot be opened: the person is told and the server is closed', async () => {
    const result = await signInAgain(deps(() => Promise.reject(new Error('no browser'))), PLACE);
    expect(result).toMatchObject({ ok: false, message: 'Backup Hub could not open your web browser to sign in.' });
  });

  it('refuses when the client details are missing or the vault is locked', async () => {
    secrets.delete('google.clientSecret');
    expect((await signInAgain(deps(() => Promise.resolve()), PLACE)).ok).toBe(false);
    expect(opened).toBeNull();
  });

  it('never repeats the code, verifier or tokens in the messages', async () => {
    tokenAnswer = () => json(400, { error: 'invalid_grant', error_description: 'bad code 4/0Acode-1234567890' });
    const result = await signInAgain(deps(comesBack((u) => ({ code: '4/0Acode-1234567890', state: u.searchParams.get('state')! }))), PLACE);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain('4/0A');
    expect(result.message).not.toContain(tokenForm!['code_verifier']!);
  });
});
