import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, type Db } from '../db';
import { PlaceService } from '../places/placeService';
import { GoogleAccountsService, type AccountVault } from './accounts';
import { GoogleAuth, NO_CLIENT_MESSAGE } from './auth';
import { GoogleHttp } from './googleHttp';
import { SCOPES } from './signIn';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
let db: Db;
let secrets: Map<string, string>;
let vaultState: string;
let requests: { method: string; url: string; form: Record<string, string> }[];
let revokeFails: boolean;
let userinfoEmail: string;
let opened: URL | null;
let changes: number;
let busy: Set<string>;

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

const vault: AccountVault = {
  status: () => ({ state: vaultState }),
  getSecretText: (name) => secrets.get(name) ?? null,
  putSecret: (name, value) => void secrets.set(name, value.toString()),
  deleteSecret: (name) => secrets.delete(name),
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-accounts-'));
  const o = initDatabase(dir, silent);
  if (!o.ok) throw new Error('db');
  db = o.db;
  vaultState = 'unlocked';
  secrets = new Map([
    ['google.clientId', 'client-id-123'],
    ['google.clientSecret', 'GOCSPX-secret'],
  ]);
  requests = [];
  revokeFails = false;
  userinfoEmail = 'new.person@example.com';
  opened = null;
  changes = 0;
  busy = new Set();
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

function loopbackGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get(url, { agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      })
      .on('error', reject);
  });
}

type Browser = (url: URL) => Promise<void>;
const signsIn: Browser = async (url) => {
  const redirect = new URL(url.searchParams.get('redirect_uri')!);
  redirect.searchParams.set('code', '4/0AfakeCode123456');
  redirect.searchParams.set('state', url.searchParams.get('state')!);
  await loopbackGet(redirect.toString());
};

function make(browser: Browser = signsIn, uuids: string[] = ['uuid-1', 'uuid-2']): GoogleAccountsService {
  const googleHttp = new GoogleHttp({
    fetchFn: (input, init) => {
      const url = new URL(input);
      const form = typeof init.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : {};
      requests.push({ method: init.method ?? 'GET', url: url.origin + url.pathname, form });
      if (url.pathname === '/token') return Promise.resolve(json(200, { access_token: 'ya29.new-access', refresh_token: '1//new-refresh', expires_in: 3600, scope: SCOPES.join(' ') }));
      if (url.pathname === '/v1/userinfo') return Promise.resolve(json(200, { email: userinfoEmail }));
      if (url.pathname === '/revoke') return revokeFails ? Promise.reject(new TypeError('fetch failed')) : Promise.resolve(json(200, {}));
      return Promise.resolve(json(404, {}));
    },
    sleep: () => Promise.resolve(),
  });
  return new GoogleAccountsService({
    db,
    vault,
    auth: new GoogleAuth(vault, googleHttp),
    http: googleHttp,
    openBrowser: (url) => {
      opened = new URL(url);
      return browser(opened);
    },
    busy: (id) => busy.has(id),
    changed: () => void (changes += 1),
    now: () => 5_000,
    uuid: () => uuids.shift() ?? 'uuid-x',
  });
}

const placeRow = (id: string) => db.prepare('SELECT id, profile_id, kind, label, status, identity_json FROM places WHERE id = ?').get(id) as { id: string; profile_id: number; kind: string; label: string; status: string; identity_json: string } | undefined;

describe('Add a Google account', () => {
  it('opens Google to pick an account (no login hint), makes the account for the first person, keeps the sign-in, and names no secret', async () => {
    const r = await make().addAccount();
    expect(r).toEqual({ ok: true, placeId: 'uuid-1', label: 'new.person@example.com', message: expect.stringContaining('new.person@example.com is added') });
    expect(opened!.searchParams.get('login_hint')).toBeNull();
    expect(opened!.searchParams.get('prompt')).toBe('consent');
    expect(opened!.searchParams.get('scope')).toBe(SCOPES.join(' '));
    expect(placeRow('uuid-1')).toMatchObject({ profile_id: 1, kind: 'gdrive', label: 'new.person@example.com', status: 'unknown' });
    expect(JSON.parse(placeRow('uuid-1')!.identity_json)).toEqual({ email: 'new.person@example.com', signedInAt: 5000 });
    expect(secrets.get('gdrive.refreshToken.uuid-1')).toBe('1//new-refresh');
    expect(changes).toBe(1);
    expect(r.message).not.toMatch(/new-refresh|GOCSPX/);
  });

  it('gives the account to the person who was chosen, and refuses a person that does not exist', async () => {
    db.prepare("INSERT INTO profiles (id, name, color, created_at) VALUES (2, 'Mum', '#123456', 1)").run();
    expect(await make().addAccount(2)).toMatchObject({ ok: true, placeId: 'uuid-1' });
    expect(placeRow('uuid-1')!.profile_id).toBe(2);
    const bad = await make().addAccount(77);
    expect(bad).toMatchObject({ ok: false });
    expect(opened).not.toBeNull(); // the first add opened it; the refused one never did
    expect(db.prepare("SELECT count(*) FROM places WHERE kind = 'gdrive'").pluck().get()).toBe(1);
  });

  it('does not add an account that is already in the list, and brings back one that was taken off', async () => {
    const accounts = make();
    await accounts.addAccount();
    const again = await make(signsIn, ['uuid-2']).addAccount();
    expect(again).toMatchObject({ ok: false, message: expect.stringContaining('already in the list') });
    expect(db.prepare("SELECT count(*) FROM places WHERE kind = 'gdrive'").pluck().get()).toBe(1);
    expect(await accounts.remove('uuid-1', true)).toMatchObject({ ok: true });
    expect(secrets.has('gdrive.refreshToken.uuid-1')).toBe(false);
    const back = await make().addAccount();
    expect(back).toMatchObject({ ok: true, placeId: 'uuid-1', message: expect.stringContaining('back in the list') });
    expect(JSON.parse(placeRow('uuid-1')!.identity_json).removedAt).toBeUndefined();
    expect(secrets.get('gdrive.refreshToken.uuid-1')).toBe('1//new-refresh');
  });

  it('says so and opens nothing when the Google app key is missing or the saved sign-ins are locked', async () => {
    secrets.delete('google.clientSecret');
    expect(await make().addAccount()).toEqual({ ok: false, message: NO_CLIENT_MESSAGE });
    expect(opened).toBeNull();
    secrets.set('google.clientSecret', 'x');
    vaultState = 'locked';
    expect(await make().addAccount()).toMatchObject({ ok: false, message: expect.stringContaining('locked') });
    expect(opened).toBeNull();
    expect(db.prepare("SELECT count(*) FROM places WHERE kind = 'gdrive'").pluck().get()).toBe(0);
  });

  it('adds nothing when the person closes the Google page', async () => {
    const r = await make(async (url) => {
      const redirect = new URL(url.searchParams.get('redirect_uri')!);
      redirect.searchParams.set('error', 'access_denied');
      redirect.searchParams.set('state', url.searchParams.get('state')!);
      await loopbackGet(redirect.toString());
    }).addAccount();
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('cancelled') });
    expect(db.prepare("SELECT count(*) FROM places WHERE kind = 'gdrive'").pluck().get()).toBe(0);
    expect([...secrets.keys()].filter((k) => k.startsWith('gdrive.'))).toEqual([]);
  });
});

describe('Sign out and Remove from the list', () => {
  async function added(): Promise<GoogleAccountsService> {
    const s = make();
    await s.addAccount();
    requests = [];
    return s;
  }

  it('sign out gives the permission back to Google (only the token is sent), forgets the sign-in here and marks the account "needs sign-in"', async () => {
    const s = await added();
    const r = await s.signOut('uuid-1');
    expect(r).toEqual({ ok: true, message: 'new.person@example.com is signed out.' });
    expect(requests).toEqual([{ method: 'POST', url: 'https://oauth2.googleapis.com/revoke', form: { token: '1//new-refresh' } }]);
    expect(secrets.has('gdrive.refreshToken.uuid-1')).toBe(false);
    expect(placeRow('uuid-1')!.status).toBe('needs_signin');
  });

  it('sign out still works with no internet and says Google may still list the app', async () => {
    const s = await added();
    revokeFails = true;
    const r = await s.signOut('uuid-1');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('myaccount.google.com/permissions');
    expect(secrets.has('gdrive.refreshToken.uuid-1')).toBe(false);
  });

  it('refuses while a job is using the account, and for an account that is not there', async () => {
    const s = await added();
    busy.add('uuid-1');
    expect(await s.signOut('uuid-1')).toMatchObject({ ok: false, message: expect.stringContaining('used by a job') });
    expect(await s.remove('uuid-1', true)).toMatchObject({ ok: false });
    expect(secrets.has('gdrive.refreshToken.uuid-1')).toBe(true);
    expect(await s.signOut('nope')).toMatchObject({ ok: false });
    expect(await s.remove(5, true)).toMatchObject({ ok: false });
  });

  it('remove needs a real confirmation, hides the account, signs it out and deletes no row and nothing in Google', async () => {
    const s = await added();
    db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('uuid-1', 'My Drive/a.txt', 3, 1, 1)").run();
    expect(await s.remove('uuid-1', false)).toMatchObject({ ok: false, message: expect.stringContaining('confirm') });
    expect(placeRow('uuid-1')!.status).toBe('unknown');
    const r = await s.remove('uuid-1', true);
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining('Nothing in the Google account was deleted') });
    expect(typeof JSON.parse(placeRow('uuid-1')!.identity_json).removedAt).toBe('number');
    expect(db.prepare("SELECT count(*) FROM files WHERE place_id = 'uuid-1'").pluck().get()).toBe(1);
    expect(requests.map((q) => q.method + ' ' + new URL(q.url).pathname)).toEqual(['POST /revoke']);
  });

  it('remove is refused while the account holds copies of backups', async () => {
    const s = await added();
    db.prepare("INSERT INTO files (place_id, rel_path, size, sha256, verified_how, first_seen_at, last_seen_at) VALUES ('uuid-1', 'My Drive/Backup Hub/POCO/a.jpg', 3, 'abc', 'google-md5', 1, 1)").run();
    const r = await s.remove('uuid-1', true);
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('holds 1 copy of your backups') });
    expect(placeRow('uuid-1')!.status).toBe('unknown');
    expect(secrets.has('gdrive.refreshToken.uuid-1')).toBe(true);
  });

  it('a removed account is no longer in the places list the window shows', async () => {
    const s = await added();
    const places = new PlaceService({ db, dataDir: dir, hostname: 'X', appVersion: '0.1.0', systemDrive: 'C:', listVolumes: () => Promise.resolve([]), rootOf: (l: string) => l + '\\', log: silent });
    places.init();
    expect(places.snapshot().places.some((p) => p.id === 'uuid-1')).toBe(true);
    await s.remove('uuid-1', true);
    expect(places.snapshot().places.some((p) => p.id === 'uuid-1')).toBe(false);
  });
});

describe('the Google app key', () => {
  it('says whether it is saved without ever returning it, and saves a new one (client id and secret) in the vault', () => {
    secrets.clear();
    const s = make();
    expect(s.keyStatus()).toEqual({ saved: false, problem: null });
    expect(s.saveKey({ clientId: '  123-abc.apps.googleusercontent.com ', clientSecret: ' GOCSPX-secret-1 ' })).toEqual({ ok: true, message: 'The Google app key is saved.' });
    expect(secrets.get('google.clientId')).toBe('123-abc.apps.googleusercontent.com');
    expect(secrets.get('google.clientSecret')).toBe('GOCSPX-secret-1');
    const status = s.keyStatus();
    expect(status).toEqual({ saved: true, problem: null });
    expect(JSON.stringify(status)).not.toMatch(/GOCSPX|123-abc/);
    expect(s.saveKey({ clientId: 'second.apps.googleusercontent.com', clientSecret: 'GOCSPX-new' }).ok).toBe(true);
    expect(secrets.get('google.clientSecret')).toBe('GOCSPX-new');
  });

  it('refuses an empty, spaced or too long key and a locked vault, and saves nothing', () => {
    secrets.clear();
    const s = make();
    expect(s.saveKey({ clientId: '', clientSecret: 'x' }).ok).toBe(false);
    expect(s.saveKey({ clientId: 'a b', clientSecret: 'x' }).ok).toBe(false);
    expect(s.saveKey({ clientId: 'a'.repeat(401), clientSecret: 'x' }).ok).toBe(false);
    vaultState = 'locked';
    expect(s.saveKey({ clientId: 'a', clientSecret: 'b' })).toMatchObject({ ok: false, message: expect.stringContaining('locked') });
    expect(s.keyStatus()).toMatchObject({ saved: false, problem: expect.stringContaining('locked') });
    expect(secrets.size).toBe(0);
  });
});
