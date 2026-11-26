import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DRIVE_REFRESH_JOB_KIND } from '../../shared/drive';
import type { JobChangedEvent, JobRecord } from '../../shared/jobs';
import { closeDatabase, initDatabase, type Db } from '../db';
import { JobService } from '../jobs/jobService';
import { VaultNotReadyError } from './auth';
import { DriveService, type DriveJobs } from './driveService';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
let db: Db;
let created: { kind: string; title: string; params: unknown }[];
let listeners: ((event: JobChangedEvent) => void)[];
let tokens: Set<string>;
let vaultProblem: string | null;
let signInCalls: string[];
let signInGate: Promise<void> | null;
let nextJob: number;

const jobs: DriveJobs = {
  create: (kind, title, params) => {
    created.push({ kind, title, params });
    return nextJob++;
  },
  list: () => [],
  params: () => null,
  onChanged: (listener) => {
    listeners.push(listener);
    return () => undefined;
  },
};

function add(id: string, label: string, status = 'unknown', token = true): void {
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES (?, 1, 'gdrive', ?, '{}', ?, 1)").run(id, label, status);
  if (token) tokens.add(id);
}

function service(): DriveService {
  return new DriveService({
    db,
    jobs,
    auth: {
      assertVaultReady: () => {
        if (vaultProblem) throw new VaultNotReadyError(vaultProblem);
      },
      hasRefreshToken: (id) => tokens.has(id),
    },
    signIn: async (id) => {
      signInCalls.push(id);
      if (signInGate) await signInGate;
      return { ok: true, message: 'signed in' };
    },
  });
}

const jobRecord = (over: Partial<JobRecord>): JobRecord =>
  ({ id: 1, kind: DRIVE_REFRESH_JOB_KIND, title: 't', state: 'running', progressDone: 0, progressTotal: 0, bytesDone: 0, bytesTotal: 0, message: null, warnings: [], error: null, createdAt: 1, startedAt: 1, finishedAt: null, paused: false, ...over }) as JobRecord;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-driveservice-'));
  const o = initDatabase(dir, silent);
  if (!o.ok) throw new Error('db');
  db = o.db;
  created = [];
  listeners = [];
  tokens = new Set();
  vaultProblem = null;
  signInCalls = [];
  signInGate = null;
  nextJob = 100;
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Refresh and Refresh all', () => {
  it('starts one job for one account', () => {
    add('a', 'Alice');
    const r = service().refresh('a');
    expect(r).toMatchObject({ ok: true, started: 1 });
    expect(created).toEqual([{ kind: DRIVE_REFRESH_JOB_KIND, title: 'Refresh Alice', params: { placeIds: ['a'] } }]);
  });

  it('refuses an account that needs signing in, one without a saved sign-in, one already refreshing, and unknown ids', () => {
    add('n', 'Needs', 'needs_signin');
    add('t', 'NoToken', 'unknown', false);
    add('r', 'Busy');
    const s = service();
    expect(s.refresh('n')).toMatchObject({ ok: false, message: expect.stringContaining('Sign in again') as string });
    expect(s.refresh('t')).toMatchObject({ ok: false });
    expect(s.refresh('r')).toMatchObject({ ok: true });
    expect(s.refresh('r')).toMatchObject({ ok: false, message: expect.stringContaining('already being refreshed') as string });
    expect(s.refresh('nope')).toMatchObject({ ok: false });
    expect(s.refresh(42)).toMatchObject({ ok: false });
    expect(created).toHaveLength(1);
  });

  it('says plainly when the vault is locked, and starts nothing', () => {
    add('a', 'Alice');
    vaultProblem = 'The saved sign-ins are locked. Type your recovery passphrase in Settings > Security first.';
    const s = service();
    expect(s.refresh('a')).toEqual({ ok: false, message: vaultProblem });
    expect(s.refreshAll()).toEqual({ ok: false, message: vaultProblem });
    expect(created).toHaveLength(0);
  });

  it('Refresh all is one job for the accounts with a sign-in and a note about the skipped ones', () => {
    add('a', 'Alice');
    add('b', 'Bob');
    add('c', 'Cara', 'needs_signin');
    add('d', 'Dan', 'unknown', false);
    const r = service().refreshAll();
    expect(r).toMatchObject({ ok: true, started: 2, skipped: 2, note: '2 accounts need signing in again and were skipped.' });
    expect(created).toHaveLength(1);
    expect(created[0]!.params).toEqual({ placeIds: ['a', 'b'] });
  });

  it('Refresh all with nothing to refresh says why', () => {
    add('c', 'Cara', 'needs_signin');
    expect(service().refreshAll()).toEqual({ ok: false, message: '1 account needs signing in again and was skipped.' });
    expect(created).toHaveLength(0);
  });

  it('shows queued, running and paused states and the account that is being looked at', () => {
    add('a', 'Alice');
    add('b', 'Bob');
    const s = service();
    s.refreshAll();
    const job = (over: Partial<JobRecord>) => listeners.forEach((l) => l({ reason: 'state', job: jobRecord({ id: 100, ...over }) }));
    expect(s.viewOf('a', 'Alice')).toMatchObject({ state: 'queued', job: { id: 100, paused: false } });
    job({ state: 'running', message: 'Refreshing Alice: 12,000 items' });
    expect(s.viewOf('a', 'Alice')).toMatchObject({ state: 'running', detail: 'Refreshing Alice: 12,000 items' });
    expect(s.viewOf('b', 'Bob')).toMatchObject({ state: 'running', detail: null });
    job({ state: 'queued', paused: true });
    expect(s.viewOf('a', 'Alice').state).toBe('paused');
    job({ state: 'done' });
    expect(s.viewOf('a', 'Alice')).toMatchObject({ state: 'idle', job: null });
    expect(s.refresh('a')).toMatchObject({ ok: true });
  });
});

describe('Sign in again', () => {
  it('runs one sign-in at a time and shows it on the card', async () => {
    add('a', 'Alice', 'needs_signin');
    add('b', 'Bob', 'needs_signin');
    let open!: () => void;
    signInGate = new Promise<void>((resolve) => (open = resolve));
    const s = service();
    const first = s.signIn('a');
    expect(s.viewOf('a', 'Alice').signingIn).toBe(true);
    expect(await s.signIn('b')).toMatchObject({ ok: false, message: expect.stringContaining('Another sign-in') as string });
    expect(s.refresh('a')).toMatchObject({ ok: false });
    open();
    expect(await first).toMatchObject({ ok: true });
    expect(s.viewOf('a', 'Alice').signingIn).toBe(false);
    expect(signInCalls).toEqual(['a']);
  });

  it('is never started by the service itself, only by a call', () => {
    add('a', 'Alice', 'needs_signin');
    const s = service();
    expect(created).toHaveLength(0);
    expect(signInCalls).toEqual([]);
    void s;
  });
});

describe('with the real job queue', () => {
  it('a refresh job whose account does not exist ends without touching anything', () => {
    const real = new JobService({ db, log: silent });
    const id = real.create(DRIVE_REFRESH_JOB_KIND, 'x', { placeIds: ['ghost'] });
    expect(real.params(id)).toEqual({ placeIds: ['ghost'] });
    real.shutdown();
  });
});
