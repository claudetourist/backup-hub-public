import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCOUNTS_FULL_MESSAGE, accountRoomBytes, chooseAccount, DEFAULT_GOOGLE_KINDS, GOOGLE_COPY_AT_ONCE, GOOGLE_COPY_JOB_KIND, GOOGLE_COPY_PER_ACCOUNT, GOOGLE_KEEP_FREE_PERCENT, googleKindPattern, kindRank, Placer, suggestAccounts, type GoogleCopyStartRequest } from '../../shared/googleCopy';
import type { FileKind } from '../../shared/fileKinds';
import { closeDatabase, initDatabase, type Db } from '../db';
import { GoogleAuth, type GoogleVault } from '../google/auth';
import { DriveApi } from '../google/driveApi';
import { DriveUploader } from '../google/driveUpload';
import { FakeAccount, FakeGoogle } from '../google/fakeGoogle.testutil';
import { GoogleHttp } from '../google/googleHttp';
import { JobAborted, JobFailure, type JobContext, type JobHandler } from '../jobs/jobService';
import { RulesStore } from '../rules/rulesStore';
import { readChunk } from './chunkRead';
import { GoogleCopyService, type GoogleCopyJobs } from './googleCopyService';
import { FolderMaker } from './folderMaker';
import { leftOutKinds, loadJobAccounts, loadReport } from './googleCopyStore';
import type { HashResult } from './googleCopyRun';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const CHUNK = 256 * 1024;

let dir: string;
let t7: string;
let db: Db;
let fake: FakeGoogle;
let sleeps: number[];
let secrets: Map<string, string>;
let plugged: boolean;
let created: { kind: string; title: string; params: unknown }[];
let chunkReads: { file: string; offset: number; buffer: Buffer }[];
let clock: number;
/** How many times the whole-file hashing fallback was used (a normal copy never needs it: the hashes are made while the chunks are read). */
let hashCalls: number;
/** The copy jobs that wait for the person (what the job service would list). */
let waiting: { id: number; kind: string; state: string; message: string }[];

const vault: GoogleVault = {
  status: () => ({ state: 'unlocked' }),
  getSecretText: (name) => secrets.get(name) ?? null,
  putSecret: (name, value) => void secrets.set(name, value.toString()),
};

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex');
const bytes = (n: number, seed: number): Buffer => {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) b[i] = (i * 31 + seed) % 251;
  return b;
};

/** The hashing the app does on its worker, as a plain stream (the real one needs the built worker). */
async function hashFile(file: string): Promise<HashResult> {
  const s = createHash('sha256');
  const m = createHash('md5');
  let n = 0;
  await pipeline(
    fs.createReadStream(file),
    new Writable({
      write(chunk: Buffer, _e, done) {
        s.update(chunk);
        m.update(chunk);
        n += chunk.length;
        done();
      },
    }),
  );
  return { sha256: s.digest('hex'), md5: m.digest('hex'), bytes: n };
}

const ROOT = 'Backups/POCO';

function addAccount(id: string, email: string, limit: number, usage: number, extra: { status?: string; profile?: number } = {}): FakeAccount {
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES (?, ?, 'gdrive', ?, ?, ?, 1)").run(id, extra.profile ?? 1, id.toUpperCase(), JSON.stringify({ email, quotaLimit: limit, quotaUsage: usage }), extra.status ?? 'connected');
  secrets.set(`gdrive.refreshToken.${id}`, `1//rt-${id}`);
  const account = fake.add(new FakeAccount(email, `1//rt-${id}`));
  account.quota = { limit: String(limit), usage: String(usage), usageInDrive: '0', usageInDriveTrash: '0' };
  return account;
}

interface Seed {
  rel: string;
  size: number;
  seed?: number;
  kind?: FileKind | null;
  sha?: string | null;
}

/** A file in the backup folder on the T7: really on disk and in the file list with its checksum. Returns its row id and bytes. */
function addT7(s: Seed): { id: number; data: Buffer; abs: string } {
  const data = bytes(s.size, s.seed ?? s.size);
  const abs = path.join(t7, ...(ROOT + '/' + s.rel).split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  const id = Number(
    db
      .prepare("INSERT INTO files (place_id, rel_path, size, mtime, sha256, first_seen_at, last_seen_at, kind) VALUES ('t7', ?, ?, 1000, ?, 1, 1, ?)")
      .run(ROOT + '/' + s.rel, s.size, s.sha === undefined ? sha(data) : s.sha, s.kind === undefined ? null : s.kind).lastInsertRowid,
  );
  return { id, data, abs };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-gcopy-'));
  t7 = path.join(dir, 't7');
  fs.mkdirSync(t7, { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const opened = initDatabase(path.join(dir, 'data'), silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  fake = new FakeGoogle();
  sleeps = [];
  created = [];
  chunkReads = [];
  plugged = true;
  clock = 9_000_000;
  hashCalls = 0;
  waiting = [];
  secrets = new Map([
    ['google.clientId', 'client-id-123'],
    ['google.clientSecret', 'GOCSPX-client-secret-abc'],
  ]);
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('t7', 1, 'drive', 'T7', '{}', 'connected', 1)").run();
  db.prepare("INSERT INTO backup_profiles (id, person_id, name, source_kind, source_root, folder_prefix, change_rule, created_at) VALUES (5, 1, 'POCO', 'phone', '/sdcard', 'poco', 'size_and_date', 1)").run();
  db.prepare("INSERT INTO backup_destinations (backup_profile_id, place_id, root, role) VALUES (5, 't7', ?, 'primary')").run(ROOT);
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Made {
  service: GoogleCopyService;
  handler: JobHandler;
}

function make(options: { chunkBytes?: number; onDriveRoot?: () => void } = {}): Made {
  const http = new GoogleHttp({ fetchFn: fake.fetchFn, sleep: (ms) => Promise.resolve(void sleeps.push(ms)) });
  const auth = new GoogleAuth(vault, http);
  const api = new DriveApi(http, auth);
  const jobs: GoogleCopyJobs = {
    create: (kind, title, params) => {
      created.push({ kind, title, params });
      return created.length;
    },
    list: () => waiting as never,
  };
  const service = new GoogleCopyService({
    db,
    log: silent,
    uploader: new DriveUploader(http, auth),
    auth,
    http,
    room: async (placeId, signal) => {
      const about = await api.about(placeId, signal);
      return { limit: about.limit, usage: about.usage };
    },
    driveRoot: async () => {
      options.onDriveRoot?.();
      return plugged ? t7 : null;
    },
    hashFile: (file) => {
      hashCalls += 1;
      return hashFile(file);
    },
    fileSize: async (file) => (fs.existsSync(file) ? fs.statSync(file).size : null),
    readChunk: async (file, offset, length, signal) => {
      const buffer = await readChunk(file, offset, length, signal);
      chunkReads.push({ file, offset, buffer });
      return buffer;
    },
    chunkBytes: options.chunkBytes ?? CHUNK,
    now: () => clock,
    jobs,
    pluggedPlaces: async () => new Set(plugged ? ['t7'] : []),
  });
  return { service, handler: service.handlers()[0]! };
}

interface Out {
  message: string;
  warns: string[];
  logs: string[];
  checkpoint: unknown;
  /** `confirmed`: the bytes Google has taken since this run began (its own sessions), at the moment of the call. */
  progress: { done: number; total: number; bytesDone?: number; bytesTotal?: number; confirmed: number }[];
  error: unknown;
  /** The questions the run asked the person. */
  asked: string[];
}

interface RunOptions {
  resume?: unknown;
  yieldFn?: (n: number) => Promise<void>;
  /** The ticked accounts (default: every Google account in the database). */
  accounts?: string[] | null;
  jobId?: number;
  /** The answer to the question "the accounts you picked are full" (default: the person stops the copy). */
  needsYou?: (message: string) => Promise<string>;
  afterFile?: () => void;
  /** The job's stop signal (default: one that never fires). */
  signal?: AbortSignal;
  /** The two switches of a phone backup's copy (what the start puts in the job's parameters). */
  flags?: { onlyOnPhone?: boolean; fitBiggest?: boolean };
  /** Gets the function the run asked the job service to call before a Pause holds the job. */
  onBeforeHold?: (save: () => void | Promise<void>) => void;
}

async function runJob(m: Made, kinds: FileKind[], o: RunOptions = {}): Promise<Out> {
  const out: Out = { message: '', warns: [], logs: [], checkpoint: null, progress: [], error: null, asked: [] };
  const confirmedNow = (): number => [...fake.sessions.values()].reduce((s, x) => s + x.received, 0);
  const confirmedBase = confirmedNow();
  let yields = 0;
  const ctx: JobContext = {
    jobId: o.jobId ?? 7,
    params: { backupId: 5, kinds, placeIds: ['t7'], ...o.flags, ...(o.accounts === null ? {} : { accountIds: o.accounts ?? (db.prepare("SELECT id FROM places WHERE kind = 'gdrive' ORDER BY id").pluck().all() as string[]) }) },
    resume: o.resume ?? null,
    signal: o.signal ?? new AbortController().signal,
    progress: (done, total, extras) =>
      void out.progress.push({ done, total, confirmed: confirmedNow() - confirmedBase, ...(extras?.bytesDone !== undefined ? { bytesDone: extras.bytesDone } : {}), ...(extras?.bytesTotal !== undefined ? { bytesTotal: extras.bytesTotal } : {}) }),
    log: (_l, text) => void out.logs.push(text),
    warn: (text) => void out.warns.push(text),
    needsYou: o.needsYou ? (message) => o.needsYou!(message) : (message) => (out.asked.push(message), Promise.reject(new JobAborted())),
    checkpoint: (value) => {
      out.checkpoint = JSON.parse(JSON.stringify(value));
      o.afterFile?.();
    },
    yield: async () => {
      yields += 1;
      await o.yieldFn?.(yields);
    },
    beforeHold: (save) => o.onBeforeHold?.(save),
  };
  try {
    const result = await m.handler.run(ctx);
    out.message = typeof result === 'string' ? result : '';
  } catch (err) {
    out.error = err;
  }
  return out;
}

const googleRows = (placeId: string) =>
  db.prepare('SELECT id, rel_path, size, md5, sha256, ext_id, origin_file_id, verified_at, verified_how, kind, gone_at FROM files WHERE place_id = ? ORDER BY rel_path').all(placeId) as {
    id: number;
    rel_path: string;
    size: number;
    md5: string;
    sha256: string;
    ext_id: string;
    origin_file_id: number;
    verified_at: number;
    verified_how: string;
    kind: string;
    gone_at: number | null;
  }[];
const uploads = (): number => fake.calls.filter((c) => c.path === '/upload/drive/v3/files' && c.method === 'POST').length;

describe('the rules for placing a file', () => {
  it('an account keeps 25% free and a file is never split', () => {
    expect(GOOGLE_KEEP_FREE_PERCENT).toBe(25);
    expect(accountRoomBytes(1000, 700)).toBe(50);
    expect(accountRoomBytes(1000, 900)).toBe(0);
    expect(accountRoomBytes(null, 5)).toBe(0);
    expect(accountRoomBytes(1000, null)).toBe(0);
    const pool = [
      { placeId: 'a', room: 50 },
      { placeId: 'b', room: 750 },
    ];
    expect(chooseAccount(40, pool)?.placeId).toBe('a'); // the one with the least room that still fits
    expect(chooseAccount(100, pool)?.placeId).toBe('b');
    expect(chooseAccount(751, pool)).toBeNull(); // no account has room for the whole file: it is not split
  });

  it('the list is camera videos, WhatsApp videos, other videos, screenshots, photos, the rest', () => {
    const order: FileKind[] = ['photo-camera', 'document' as never, 'video-other', 'photo-screenshot', 'video-whatsapp', 'video-camera'].filter((k) => k !== 'document') as FileKind[];
    expect(order.toSorted((a, b) => kindRank(a) - kindRank(b))).toEqual(['video-camera', 'video-whatsapp', 'video-other', 'photo-screenshot', 'photo-camera']);
    expect(DEFAULT_GOOGLE_KINDS).toEqual(['video-camera', 'video-whatsapp', 'video-other', 'photo-screenshot', 'photo-camera', 'photo-whatsapp']);
  });
});

describe('copy to Google', () => {
  it('sends a file, checks Google\'s checksum and writes the row the clean-up relies on', async () => {
    const acc = addAccount('g1', 'a@example.com', 100_000_000, 1_000);
    const f = addT7({ rel: 'DCIM/Camera/VID_0001.mp4', size: 700_000, kind: 'video-camera' });
    const m = make();
    const out = await runJob(m, ['video-camera']);
    expect(out.error).toBeNull();
    // The folders were made first, top folder "Backup Hub", then the backup, then the phone's folders (never the root).
    const folder = (name: string) => [...acc.items.values()].find((i) => i.name === name && i.mimeType === 'application/vnd.google-apps.folder')!;
    expect(folder('Backup Hub').parents).toEqual(['ROOT']);
    expect(folder('POCO').parents).toEqual([folder('Backup Hub').id]);
    expect(folder('DCIM').parents).toEqual([folder('POCO').id]);
    expect(folder('Camera').parents).toEqual([folder('DCIM').id]);
    const sent = fake.filesNamed(acc, 'VID_0001.mp4');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.parents).toEqual([folder('Camera').id]);
    expect(fake.stored.get(sent[0]!.id)!.equals(f.data)).toBe(true);
    // The row: THE contract.
    const rows = googleRows('g1');
    expect(rows).toEqual([
      {
        id: expect.any(Number),
        rel_path: 'My Drive/Backup Hub/POCO/DCIM/Camera/VID_0001.mp4',
        size: 700_000,
        md5: md5(f.data),
        sha256: sha(f.data),
        ext_id: sent[0]!.id,
        origin_file_id: f.id,
        verified_at: 9_000_000,
        verified_how: 'google-md5',
        kind: 'video-camera',
        gone_at: null,
      },
    ]);
    // The folder of the copy is known, so Free up phone space can ask Google about this exact file again.
    expect(db.prepare('SELECT parent_ext_id, name FROM drive_items WHERE place_id = ? AND ext_id = ?').get('g1', sent[0]!.id)).toEqual({ parent_ext_id: folder('Camera').id, name: 'VID_0001.mp4' });
    // The T7 row learned its MD5.
    expect((db.prepare('SELECT md5 FROM files WHERE id = ?').get(f.id) as { md5: string }).md5).toBe(md5(f.data));
    const report = loadReport(db, 7)!;
    expect(report.copied).toEqual({ files: 1, bytes: 700_000 });
    expect(report.perAccount).toEqual([{ label: 'G1', files: 1, bytes: 700_000 }]);
    expect(out.message).toMatch(/Sent 1 files/);
    // Nothing is ever changed or removed in Google: only GET, POST and PUT were sent.
    expect(new Set(fake.calls.map((c) => c.method))).toEqual(new Set(['GET', 'POST', 'PUT']));
  });

  it('sends each content once (a repeat in the same list is only counted), and skips what is already on Google from an earlier copy', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    addT7({ rel: 'DCIM/Camera/a.jpg', size: 3000, seed: 4, kind: 'photo-camera' });
    addT7({ rel: 'DCIM/Camera/same-as-a.jpg', size: 3000, seed: 4, kind: 'photo-camera' }); // the same content
    addT7({ rel: 'DCIM/Camera/b.jpg', size: 4000, seed: 9, kind: 'photo-camera' });
    const m = make();
    const first = await runJob(m, ['photo-camera']);
    expect(first.error).toBeNull();
    expect(uploads()).toBe(2);
    // The repeat (same picture again, as in an older phone backup) is named as a repeat, not as "already on Google".
    expect(loadReport(db, 7)).toMatchObject({ copied: { files: 2, bytes: 7000 }, repeats: 1, alreadyThere: 0 });
    const second = await runJob(m, ['photo-camera']);
    expect(second.error).toBeNull();
    expect(uploads()).toBe(2); // nothing new
    expect(googleRows('g1')).toHaveLength(2);
    const status = await m.service.status(5);
    expect(status).toEqual({ ok: true, status: { backupId: 5, filesOnGoogle: 2, bytesOnGoogle: 7000, filesToGo: 0, bytesToGo: 0 } });
  });

  it('places each file in an account where it fits while the account stays at or below 75% used, never splits a file, and asks the person when nothing fits', async () => {
    const small = addAccount('g1', 'a@example.com', 1000, 700); // room 50
    const big = addAccount('g2', 'b@example.com', 1000, 0); // room 750
    addT7({ rel: 'DCIM/Camera/v1.mp4', size: 400, kind: 'video-camera' });
    addT7({ rel: 'DCIM/Camera/v2.mp4', size: 300, kind: 'video-camera' });
    addT7({ rel: 'DCIM/Camera/v3.mp4', size: 40, kind: 'video-camera' });
    addT7({ rel: 'DCIM/Camera/v4.mp4', size: 60, kind: 'video-camera' });
    addT7({ rel: 'DCIM/Camera/v5.mp4', size: 51, kind: 'video-camera' });
    const m = make({ chunkBytes: CHUNK });
    const out = await runJob(m, ['video-camera']);
    // 400 and 300 go to the big account (750); the 60 fits nowhere (50 and 50 left): the copy asks the person, it does not send it anywhere else.
    expect(out.asked).toEqual([ACCOUNTS_FULL_MESSAGE]);
    expect(out.error).toBeInstanceOf(JobAborted);
    expect(googleRows('g1')).toEqual([]);
    expect(googleRows('g2').map((r) => r.size).toSorted((a, b) => a - b)).toEqual([300, 400]);
    expect(Number(small.quota.usage)).toBe(700);
    expect(Number(big.quota.usage)).toBeLessThanOrEqual(750);
    expect(uploads()).toBe(2);
  });

  it('the files go in the order camera videos, WhatsApp videos, other videos, screenshots, photos; biggest first', async () => {
    addAccount('g1', 'a@example.com', 1_000_000_000, 0);
    addT7({ rel: 'p/IMG_1.jpg', size: 900, kind: 'photo-camera' });
    addT7({ rel: 'p/Screenshot_1.png', size: 800, kind: 'photo-screenshot' });
    addT7({ rel: 'v/other-small.mp4', size: 100, kind: 'video-other' });
    addT7({ rel: 'v/other-big.mp4', size: 5000, kind: 'video-other' });
    addT7({ rel: 'v/wa.mp4', size: 700, kind: 'video-whatsapp' });
    addT7({ rel: 'v/cam-small.mp4', size: 600, kind: 'video-camera' });
    addT7({ rel: 'v/cam-big.mp4', size: 2000, kind: 'video-camera' });
    const out = await runJob(make(), ['photo-camera', 'photo-screenshot', 'video-other', 'video-whatsapp', 'video-camera']);
    expect(out.error).toBeNull();
    const names = [...fake.sessions.values()].map((s) => s.name);
    expect(names).toEqual(['cam-big.mp4', 'cam-small.mp4', 'wa.mp4', 'other-big.mp4', 'other-small.mp4', 'Screenshot_1.png', 'IMG_1.jpg']);
  });

  it('a file whose copy on the T7 does not match its saved checksum is held back and never sent', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    const f = addT7({ rel: 'DCIM/Camera/bad.jpg', size: 5000, kind: 'photo-camera' });
    fs.writeFileSync(f.abs, bytes(5000, 99)); // the drive's file changed (same size) after the checksum was saved
    addT7({ rel: 'DCIM/Camera/good.jpg', size: 6000, kind: 'photo-camera' });
    const out = await runJob(make(), ['photo-camera']);
    expect(out.error).toBeNull();
    expect(uploads()).toBe(1);
    expect(googleRows('g1').map((r) => r.rel_path)).toEqual(['My Drive/Backup Hub/POCO/DCIM/Camera/good.jpg']);
    const report = loadReport(db, 7)!;
    expect(report.heldBack).toEqual([{ reason: expect.stringContaining('does not match its saved checksum'), count: 1, examples: ['DCIM/Camera/bad.jpg'] }]);
    expect(out.warns.join(' ')).toMatch(/bad\.jpg/);
    // The T7 row did not get an md5 from a file that did not match.
    expect((db.prepare('SELECT md5 FROM files WHERE id = ?').get(f.id) as { md5: string | null }).md5).toBeNull();
  });

  it('a file that is gone from the drive, or changed in size, is held back with a plain reason', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    const gone = addT7({ rel: 'x/gone.jpg', size: 100, kind: 'photo-camera' });
    const grown = addT7({ rel: 'x/grown.jpg', size: 100, kind: 'photo-camera', seed: 3 });
    fs.rmSync(gone.abs);
    fs.appendFileSync(grown.abs, 'more');
    const out = await runJob(make(), ['photo-camera']);
    expect(out.error).toBeInstanceOf(JobFailure); // nothing was sent: the job says so
    expect(uploads()).toBe(0);
    const report = loadReport(db, 7)!;
    expect(report.heldBack.map((r) => r.reason).join('|')).toMatch(/not on T7 any more.*|changed on T7/s);
    expect(report.heldBack.reduce((s, r) => s + r.count, 0)).toBe(2);
  });

  it('when the folder cannot be made the file is stopped: nothing is sent and nothing goes into the root', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    addT7({ rel: 'DCIM/Camera/a.jpg', size: 3000, kind: 'photo-camera' });
    fake.override = (call) => (call.method === 'POST' && call.path === '/drive/v3/files' ? new Response(JSON.stringify({ error: { code: 403, message: 'nope', errors: [{ reason: 'forbidden' }] } }), { status: 403, headers: { 'Content-Type': 'application/json' } }) : null);
    const out = await runJob(make(), ['photo-camera']);
    expect(uploads()).toBe(0);
    expect(fake.sessions.size).toBe(0);
    expect(googleRows('g1')).toEqual([]);
    const report = loadReport(db, 7)!;
    expect(report.failed).toEqual([{ reason: expect.stringContaining('folder could not be made'), count: 1, examples: ['DCIM/Camera/a.jpg'] }]);
    expect(out.error).toBeInstanceOf(JobFailure); // nothing was sent at all: the job says so
  });

  it('a copy that comes back different in Google is not counted, nothing is deleted, the report says so', async () => {
    const acc = addAccount('g1', 'a@example.com', 100_000_000, 0);
    const f = addT7({ rel: 'DCIM/Camera/a.jpg', size: 3000, kind: 'photo-camera' });
    fake.corruptMd5 = true;
    const out = await runJob(make(), ['photo-camera']);
    expect(googleRows('g1')).toEqual([]);
    const report = loadReport(db, 7)!;
    expect(report.mismatches).toBe(1);
    expect(report.failed[0]!.reason).toMatch(/came back different/);
    expect(out.warns.join(' ')).toMatch(/does not match. Nothing was deleted/);
    expect(fake.filesNamed(acc, 'a.jpg')).toHaveLength(1); // still in Google: Backup Hub never deletes
    expect((db.prepare('SELECT md5 FROM files WHERE id = ?').get(f.id) as { md5: string | null }).md5).toBeNull();
    expect(fake.calls.some((c) => c.method === 'DELETE' || c.method === 'PATCH')).toBe(false);
  });

  it('a lost chunk is retried: the wait honours Retry-After, Google is asked how far it got, and every try reads a NEW stream', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    const f = addT7({ rel: 'DCIM/Camera/big.mp4', size: CHUNK * 2 + 1234, kind: 'video-camera' });
    let n = 0;
    fake.override = (call) => {
      if (call.method === 'PUT' && call.bytes && (call.headers['Content-Range'] ?? '').startsWith('bytes ' + CHUNK + '-')) {
        n += 1;
        if (n === 1) return new Response(JSON.stringify({ error: { code: 503, message: 'busy', errors: [{ reason: 'backendError' }] } }), { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '7' } });
      }
      return null;
    };
    const out = await runJob(make(), ['video-camera']);
    expect(out.error).toBeNull();
    expect(sleeps).toContain(7000); // Retry-After 7 s wins over the 1 s backoff
    expect(fake.calls.filter((c) => c.method === 'PUT' && c.headers['Content-Range'] === `bytes */${f.data.length}`).length).toBeGreaterThanOrEqual(1); // asked how far it got
    const atSecond = chunkReads.filter((r) => r.offset === CHUNK);
    expect(atSecond.length).toBe(2); // the second chunk was read twice, each time through a new stream
    expect(atSecond[0]!.buffer).not.toBe(atSecond[1]!.buffer);
    expect(atSecond[0]!.buffer.equals(atSecond[1]!.buffer)).toBe(true);
    const sent = [...fake.stored.values()][0]!;
    expect(sent.equals(f.data)).toBe(true);
    expect(googleRows('g1')).toHaveLength(1);
  });

  it('waits 1 s, 2 s, 4 s after failures in a row and gives the file up after five', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    addT7({ rel: 'a.jpg', size: 3000, kind: 'photo-camera' });
    fake.putFault = () => 'fail';
    const out = await runJob(make(), ['photo-camera']);
    expect(sleeps.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(googleRows('g1')).toEqual([]);
    expect(loadReport(db, 7)!.failed[0]!.reason).toMatch(/kept failing/);
    expect(out.error).toBeInstanceOf(JobFailure);
  });

  it('an account that Google says is full is left alone for the rest of the run and the file goes to the next one', async () => {
    addAccount('g1', 'a@example.com', 1_000_000, 0);
    addAccount('g2', 'b@example.com', 1_000_000, 100);
    fake.fullAtStart.add('a@example.com');
    addT7({ rel: 'a.jpg', size: 3000, kind: 'photo-camera' });
    const out = await runJob(make(), ['photo-camera']);
    expect(out.error).toBeNull();
    expect(googleRows('g1')).toEqual([]);
    expect(googleRows('g2')).toHaveLength(1);
  });

  it('a stop leaves what was sent in place; starting again sends only the rest (no file twice)', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    for (let i = 0; i < 6; i += 1) addT7({ rel: `DCIM/Camera/v${i}.mp4`, size: 2000 + i, kind: 'video-camera', seed: i });
    const m = make();
    const stopped = await runJob(m, ['video-camera'], {
      yieldFn: async () => {
        if (googleRows('g1').length >= 3) throw new JobAborted();
      },
    });
    expect(stopped.error).toBeInstanceOf(JobAborted);
    expect(googleRows('g1')).toHaveLength(3);
    expect(loadReport(db, 7)).toMatchObject({ stopped: true, copied: { files: 3 } });
    const resumed = await runJob(m, ['video-camera'], { resume: stopped.checkpoint });
    expect(resumed.error).toBeNull();
    expect(uploads()).toBe(6);
    expect(googleRows('g1')).toHaveLength(6);
    expect(loadReport(db, 7)).toMatchObject({ stopped: false, copied: { files: 6 } });
  });

  it('a pause holds everything: no request goes out until it is released', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    for (let i = 0; i < 3; i += 1) addT7({ rel: `v${i}.mp4`, size: 2000 + i, kind: 'video-camera', seed: i });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let paused = false;
    let callsWhilePaused = -1;
    const out = runJob(make(), ['video-camera'], {
      // Like the job service: once paused, EVERY yield (the dispatcher's and each file's) waits for the release.
      yieldFn: async () => {
        if (uploads() >= 1 && !paused) {
          paused = true;
          const before = fake.calls.length;
          setTimeout(() => {
            callsWhilePaused = fake.calls.length - before;
            release();
          }, 30);
        }
        if (paused) await gate;
      },
    });
    const done = await out;
    expect(done.error).toBeNull();
    expect(callsWhilePaused).toBe(0);
    expect(googleRows('g1')).toHaveLength(3);
  });

  it('reports speed-friendly progress: bytes done grow and end at the total', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    addT7({ rel: 'a.mp4', size: CHUNK * 3, kind: 'video-camera' });
    const out = await runJob(make(), ['video-camera']);
    const done = out.progress.map((p) => p.bytesDone ?? 0);
    expect(Math.max(...done)).toBe(CHUNK * 3);
    expect(done).toEqual(done.toSorted((a, b) => a - b));
  });

  it('progress bytes and speed count only what Google confirmed: a file that is held back adds none and leaves the total', async () => {
    const S = CHUNK;
    addAccount('g1', 'g1@example.com', 100_000_000, 0);
    const held = addT7({ rel: 'DCIM/Camera/a.mp4', size: S * 5, kind: 'video-camera', seed: 1 });
    addT7({ rel: 'DCIM/Camera/b.mp4', size: S * 2, kind: 'video-camera', seed: 2 });
    fs.writeFileSync(held.abs, bytes(S * 5 + 7, 1)); // changed after the list was made: held back, never read or sent
    const out = await runJob(make(), ['video-camera']);
    expect(out.error).toBeNull();
    for (const p of out.progress) expect(p.bytesDone ?? 0).toBeLessThanOrEqual(p.confirmed); // never more than Google took
    const last = out.progress.at(-1)!;
    expect(last).toMatchObject({ bytesDone: S * 2, bytesTotal: S * 2 }); // the held 5 chunks are neither done nor to do
    expect(out.progress.some((p) => p.bytesDone === S * 5)).toBe(false);
  });
});

describe('the capacity screen and the start', () => {
  it('lists the kinds videos first, ticks the defaults and counts the room keeping 25% free', async () => {
    addAccount('g1', 'a@example.com', 1000, 100);
    addAccount('g2', 'b@example.com', 2000, 0);
    addAccount('g3', 'c@example.com', 1000, 900); // no room
    addAccount('g4', 'd@example.com', 1000, 0, { status: 'needs_signin' }); // not used
    secrets.delete('gdrive.refreshToken.g4');
    db.prepare("INSERT INTO profiles (id, name, color, created_at) VALUES (2, 'Other', '#000000', 1)").run();
    addAccount('g5', 'e@example.com', 1000, 0, { profile: 2 }); // another person's
    addT7({ rel: 'a/IMG_1.jpg', size: 100, kind: 'photo-camera' });
    addT7({ rel: 'a/Screenshot_1.png', size: 50, kind: 'photo-screenshot' });
    addT7({ rel: 'a/v.mp4', size: 400, kind: 'video-camera' });
    addT7({ rel: 'a/doc.pdf', size: 30, kind: 'documents' });
    addT7({ rel: 'a/nosha.jpg', size: 30, kind: 'photo-camera', sha: null });
    const r = await make().service.preview(5);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.preview;
    expect(p.kinds.map((k) => [k.kind, k.ticked, k.files, k.bytes])).toEqual([
      ['video-camera', true, 1, 400],
      ['photo-screenshot', true, 1, 50],
      ['photo-camera', true, 1, 100],
      ['documents', false, 1, 30],
    ]);
    expect(p.room).toEqual({ accounts: 2, roomBytes: 650 + 1500 });
    // Every owned account is a row (the other person's is not); the signed-out one is greyed and not asked.
    expect(p.accounts.map((a) => [a.placeId, a.canTake, a.reason, a.room, a.checkedNow])).toEqual([
      ['g1', true, null, 650, true],
      ['g2', true, null, 1500, true],
      ['g3', false, 'full: keeps 25% free', 0, true],
      ['g4', false, 'needs signing in', 0, false],
    ]);
    expect(p.accounts.every((a) => !a.ticked)).toBe(true);
    expect(fake.calls.filter((c) => c.path === '/drive/v3/about').map((c) => c.account).toSorted()).toEqual(['a@example.com', 'b@example.com', 'c@example.com']);
    expect(p.noChecksumFiles).toBe(1);
    expect(p.blocker).toBeNull();
    expect(p.driveConnected).toBe(true);
  });

  it('start saves "leave out of Google" for the kinds that are not ticked and makes the job; nothing is sent by it', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    addT7({ rel: 'a/IMG_1.jpg', size: 100, kind: 'photo-camera' });
    addT7({ rel: 'a/v.mp4', size: 400, kind: 'video-camera' });
    addT7({ rel: 'a/doc.pdf', size: 30, kind: 'documents' });
    const m = make();
    const r = await m.service.start(startReq({ kinds: ['video-camera'] }));
    expect(r).toEqual({ ok: true, jobId: 1, message: '' });
    expect(created).toHaveLength(1);
    expect(created[0]!.kind).toBe(GOOGLE_COPY_JOB_KIND);
    expect(created[0]!.params).toMatchObject({ backupId: 5, kinds: ['video-camera'], placeIds: ['t7'], accountIds: ['g1'] });
    expect(uploads()).toBe(0);
    expect(fake.calls.filter((c) => c.method !== 'GET' && c.path !== '/token')).toEqual([]);
    const rows = db.prepare('SELECT backup_id, scope, pattern, choice, destination FROM backup_rules WHERE destination IS NOT NULL ORDER BY pattern').all();
    expect(rows).toEqual([
      { backup_id: 5, scope: 'pattern', pattern: googleKindPattern('documents'), choice: 'leave_out', destination: 'google' },
      { backup_id: 5, scope: 'pattern', pattern: googleKindPattern('photo-camera'), choice: 'leave_out', destination: 'google' },
    ]);
    expect([...leftOutKinds(db, 5)].toSorted()).toEqual(['documents', 'photo-camera']);
    // The older code that reads "your choices" does not see them, and does not count them as leave-outs of the phone backup.
    const store = new RulesStore(db);
    expect(store.list(5)).toEqual([]);
    expect(store.count(5)).toBe(0);
    expect(store.countLeftOut(5)).toBe(0);
    // Next time the screen opens with the left-out kinds unticked, and ticking one again removes its rule.
    const again = await m.service.preview(5);
    expect(again.ok && again.preview.kinds.filter((k) => k.ticked).map((k) => k.kind)).toEqual(['video-camera']);
    await m.service.start(startReq({ kinds: ['video-camera', 'photo-camera'] }));
    expect([...leftOutKinds(db, 5)]).toEqual(['documents']);
  });

  it('refuses to start without the drive, without the Google app key, without an account of the owner, or with nothing ticked', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    addT7({ rel: 'a/v.mp4', size: 400, kind: 'video-camera' });
    const m = make();
    plugged = false;
    expect((await m.service.start(startReq())).ok).toBe(false);
    plugged = true;
    expect((await m.service.start(startReq({ kinds: [] }))).ok).toBe(false);
    expect((await m.service.start(startReq({ kinds: ['no-such-kind'] }))).ok).toBe(false);
    expect((await m.service.start(startReq({ backupId: 99 }))).ok).toBe(false);
    secrets.delete('google.clientSecret');
    const noKey = await m.service.start(startReq());
    expect(noKey).toMatchObject({ ok: false, message: expect.stringContaining('Google app key') });
    secrets.set('google.clientSecret', 'x');
    db.prepare("INSERT INTO profiles (id, name, color, created_at) VALUES (2, 'Other', '#000000', 1)").run();
    db.prepare("UPDATE places SET profile_id = 2 WHERE id = 'g1'").run();
    const none = await m.service.start(startReq());
    expect(none).toMatchObject({ ok: false, message: expect.stringContaining('No Google account') });
    expect(created).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

const startReq = (over: Partial<GoogleCopyStartRequest> = {}): GoogleCopyStartRequest => ({ backupId: 5, kinds: ['video-camera'], accountIds: ['g1'], confirmedAccounts: true, seenRoom: {}, ...over });

type OkPreview = Extract<Awaited<ReturnType<GoogleCopyService['preview']>>, { ok: true }>['preview'];
const previewOf = async (m: Made): Promise<OkPreview> => {
  const r = await m.service.preview(5);
  if (!r.ok) throw new Error(r.message);
  return r.preview;
};
const rowOf = (p: OkPreview, id: string) => p.accounts.find((a) => a.placeId === id)!;
const callsBy = (email: string) => fake.calls.filter((c) => c.account === email);
const aboutBy = (email: string) => fake.calls.filter((c) => c.account === email && c.path === '/drive/v3/about').length;

describe('which accounts: live numbers, the person\'s confirmed choice, and nothing else', () => {
  it('the screen asks Google for EVERY account now: a stale saved size is replaced by the live one and saved like the refresh does', async () => {
    const a = addAccount('g1', 'a@example.com', 1000, 100); // saved: 1000 / 100
    a.quota = { ...a.quota, limit: '2000', usage: '400' }; // real now
    const p = await previewOf(make());
    expect(rowOf(p, 'g1')).toMatchObject({ limit: 2000, usage: 400, free: 1600, room: 1100, percent: 20, checkedNow: true, canTake: true, email: 'a@example.com' });
    expect(p.room).toEqual({ accounts: 1, roomBytes: 1100 });
    const saved = JSON.parse((db.prepare("SELECT identity_json FROM places WHERE id = 'g1'").pluck().get() as string)) as Record<string, unknown>;
    expect(saved).toMatchObject({ email: 'a@example.com', quotaLimit: 2000, quotaUsage: 400, lastQuotaAt: 9_000_000 });
  });

  it('an account whose size was never saved (new, never refreshed) is usable at once', async () => {
    addAccount('g1', 'n@example.com', 1000, 0);
    db.prepare("UPDATE places SET identity_json = ? WHERE id = 'g1'").run(JSON.stringify({ email: 'n@example.com' }));
    const p = await previewOf(make());
    expect(rowOf(p, 'g1')).toMatchObject({ canTake: true, room: 750, checkedNow: true });
  });

  it('a failed check greys the row and shows no old numbers; a signed-out account says it needs signing in; neither can take files', async () => {
    addAccount('g1', 'a@example.com', 1000, 0);
    addAccount('g2', 'b@example.com', 1000, 0);
    addAccount('g3', 'c@example.com', 1000, 0).revoked = true;
    fake.override = (call) => (call.path === '/drive/v3/about' && call.account === 'b@example.com' ? new Response('{}', { status: 500 }) : null);
    const m = make();
    const p = await previewOf(m);
    expect(rowOf(p, 'g1').canTake).toBe(true);
    expect(rowOf(p, 'g2')).toMatchObject({ canTake: false, reason: 'could not check: Google said no', limit: null, usage: null, room: 0, checkedNow: false });
    expect(rowOf(p, 'g3')).toMatchObject({ canTake: false, reason: 'needs signing in' });
    expect(p.room.accounts).toBe(1);
    // The saved numbers of the account that could not be checked stay as they were.
    expect(JSON.parse(db.prepare("SELECT identity_json FROM places WHERE id = 'g2'").pluck().get() as string)).toMatchObject({ quotaLimit: 1000, quotaUsage: 0 });
    // A greyed account cannot be used: the start refuses it with the fresh check too.
    addT7({ rel: 'v.mp4', size: 100, kind: 'video-camera' });
    const r = await m.service.start(startReq({ accountIds: ['g2'], seenRoom: { g2: 750 } }));
    expect(r).toMatchObject({ ok: false, changed: true, message: expect.stringContaining('could not be checked') });
    expect(created).toEqual([]);
  });

  it('nothing is remembered the first time; the start remembers exactly the confirmed accounts; an account added later is not among them', async () => {
    addAccount('g1', 'a@example.com', 1000, 0);
    addAccount('g2', 'b@example.com', 1000, 0);
    addT7({ rel: 'v.mp4', size: 100, kind: 'video-camera' });
    const m = make();
    expect((await previewOf(m)).accounts.map((a) => a.ticked)).toEqual([false, false]);
    expect((await m.service.start(startReq({ accountIds: ['g2'], seenRoom: { g2: 750 } }))).ok).toBe(true);
    addAccount('g3', 'c@example.com', 1000, 0); // a new account
    const after = await previewOf(m);
    expect(after.accounts.map((a) => [a.placeId, a.ticked])).toEqual([['g1', false], ['g2', true], ['g3', false]]);
  });

  it('a start that was refused remembers nothing', async () => {
    addAccount('g1', 'a@example.com', 1000, 0);
    addT7({ rel: 'v.mp4', size: 100, kind: 'video-camera' });
    const m = make();
    expect((await m.service.start(startReq({ seenRoom: { g1: 99999 }, confirmedAccounts: false }))).ok).toBe(false);
    expect((await m.service.start(startReq({ seenRoom: { g1: 99999 } }))).ok).toBe(false);
    expect((await previewOf(m)).accounts.map((a) => a.ticked)).toEqual([false]);
    expect(created).toEqual([]);
  });

  it('the start needs the confirmed accounts: without the confirmation nothing starts and Google is not even asked', async () => {
    addAccount('g1', 'a@example.com', 1000, 0);
    addT7({ rel: 'v.mp4', size: 100, kind: 'video-camera' });
    const m = make();
    const r = await m.service.start({ ...startReq(), confirmedAccounts: false });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('not confirmed') });
    const missing = await m.service.start({ backupId: 5, kinds: ['video-camera'] } as unknown as GoogleCopyStartRequest);
    expect(missing.ok).toBe(false);
    expect(created).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('refuses accounts that are not this person\'s, unknown, signed out, taken off the list, or none at all', async () => {
    addAccount('g1', 'a@example.com', 1000, 0);
    db.prepare("INSERT INTO profiles (id, name, color, created_at) VALUES (2, 'Other', '#000000', 1)").run();
    addAccount('g5', 'e@example.com', 1000, 0, { profile: 2 });
    addAccount('g4', 'd@example.com', 1000, 0, { status: 'needs_signin' });
    addAccount('g6', 'f@example.com', 1000, 0);
    db.prepare("UPDATE places SET identity_json = json_set(identity_json, '$.removedAt', 5) WHERE id = 'g6'").run();
    addT7({ rel: 'v.mp4', size: 100, kind: 'video-camera' });
    const m = make();
    for (const accountIds of [['g5'], ['g1', 'g5'], ['no-such-account'], ['g4'], ['g6'], [], [7 as unknown as string]]) {
      const r = await m.service.start(startReq({ accountIds }));
      expect(r.ok, JSON.stringify(accountIds)).toBe(false);
    }
    expect(created).toEqual([]);
    expect(fake.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(await m.service.plan({ backupId: 5, kinds: ['video-camera'], accountIds: ['g5'] })).toMatchObject({ ok: false });
    expect(await m.service.plan({ backupId: 5, kinds: ['video-camera'], accountIds: [] })).toMatchObject({ ok: false });
  });

  it('the start asks the ticked accounts again: less room than on the screen stops it and says so; with the new number it starts', async () => {
    const a = addAccount('g1', 'a@example.com', 1000, 0); // room 750
    addT7({ rel: 'v.mp4', size: 100, kind: 'video-camera' });
    const m = make();
    await previewOf(m);
    const before = aboutBy('a@example.com');
    a.quota = { ...a.quota, usage: '600' }; // someone used space: room 150
    const refused = await m.service.start(startReq({ seenRoom: { g1: 750 } }));
    expect(refused).toMatchObject({ ok: false, changed: true, message: expect.stringMatching(/less room now: 0 MB instead of 0 MB|less room now/) });
    expect(aboutBy('a@example.com')).toBeGreaterThan(before);
    expect(created).toEqual([]);
    // The plan was updated: the same ticks with the new numbers go.
    expect((await m.service.start(startReq({ seenRoom: { g1: 150 } }))).ok).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('less room by a rounding amount (under 1 MB) does not stop the start', async () => {
    const a = addAccount('g1', 'a@example.com', 1_000_000_000, 0);
    addT7({ rel: 'v.mp4', size: 100, kind: 'video-camera' });
    a.quota = { ...a.quota, usage: '500000' };
    expect((await make().service.start(startReq({ seenRoom: { g1: 750_000_000 } }))).ok).toBe(true);
  });

  it('the start is off while a file does not fit: also when the totals fit but a file cannot be split; more room makes it go', async () => {
    addAccount('g1', 'a@example.com', 1000, 680); // room 70
    addAccount('g2', 'b@example.com', 1000, 680); // room 70
    addT7({ rel: 'big.mp4', size: 100, kind: 'video-camera' });
    addT7({ rel: 'small.mp4', size: 20, kind: 'video-camera' });
    const m = make();
    // 120 bytes into 140 bytes of room: the totals fit, but the 100-byte file fits in neither account.
    const plan = await m.service.plan({ backupId: 5, kinds: ['video-camera'], accountIds: ['g1', 'g2'] });
    expect(plan).toEqual({
      ok: true,
      plan: { lines: [{ placeId: 'g1', label: 'G1', email: 'a@example.com', files: 1, bytes: 20, endsPercent: 70 }], toPlaceFiles: 2, toPlaceBytes: 120, unplacedFiles: 1, unplacedBytes: 100 },
    });
    const refused = await m.service.start(startReq({ accountIds: ['g1', 'g2'], seenRoom: { g1: 70, g2: 70 } }));
    expect(refused).toMatchObject({ ok: false, changed: true, message: expect.stringMatching(/Short by .*: tick more accounts or fewer kinds\. Nothing was sent\./) });
    expect(created).toEqual([]);
    addAccount('g3', 'c@example.com', 1000, 0); // room 750
    const ok = await m.service.start(startReq({ accountIds: ['g1', 'g2', 'g3'], seenRoom: { g1: 70, g2: 70, g3: 750 } }));
    expect(ok.ok).toBe(true);
  });

  it('the plan puts each file where the run would: the account with the least room that fits, biggest files first', async () => {
    addAccount('g1', 'a@example.com', 1000, 700); // room 50
    addAccount('g2', 'b@example.com', 1000, 0); // room 750
    addT7({ rel: 'a.mp4', size: 400, kind: 'video-camera' });
    addT7({ rel: 'b.mp4', size: 300, kind: 'video-camera' });
    addT7({ rel: 'c.mp4', size: 40, kind: 'video-camera' });
    addT7({ rel: 'p.jpg', size: 10, kind: 'photo-camera' });
    const r = await make().service.plan({ backupId: 5, kinds: ['photo-camera', 'video-camera', 'not-a-kind'], accountIds: ['g1', 'g2'] });
    expect(r).toMatchObject({
      ok: true,
      plan: {
        lines: [
          { placeId: 'g1', files: 2, bytes: 50, endsPercent: 75 }, // the 40 (least room that fits), then the 10
          { placeId: 'g2', files: 2, bytes: 700, endsPercent: 70 },
        ],
        unplacedFiles: 0,
        toPlaceFiles: 4,
      },
    });
  });

  it('the run uses ONLY the ticked accounts, and an account added after the start is never used', async () => {
    addAccount('g1', 'a@example.com', 1_000_000, 0);
    addAccount('g2', 'b@example.com', 1_000_000, 0);
    addT7({ rel: 'a.jpg', size: 3000, kind: 'photo-camera' });
    addT7({ rel: 'b.jpg', size: 2000, kind: 'photo-camera' });
    const m = make();
    expect((await m.service.start(startReq({ kinds: ['photo-camera'], accountIds: ['g1'], seenRoom: { g1: 750_000 } }))).ok).toBe(true);
    addAccount('g3', 'c@example.com', 1_000_000, 0); // new, not ticked
    const params = created[0]!.params as { accountIds: string[] };
    expect(params.accountIds).toEqual(['g1']);
    const out = await runJob(m, ['photo-camera'], { accounts: params.accountIds });
    expect(out.error).toBeNull();
    expect(googleRows('g1')).toHaveLength(2);
    expect(googleRows('g2')).toEqual([]);
    expect(googleRows('g3')).toEqual([]);
    expect(callsBy('b@example.com')).toEqual([]);
    expect(callsBy('c@example.com')).toEqual([]);
  });

  it('a job that has no ticked accounts, or only ones that are not allowed any more, sends nothing', async () => {
    addAccount('g1', 'a@example.com', 1_000_000, 0);
    db.prepare("INSERT INTO profiles (id, name, color, created_at) VALUES (2, 'Other', '#000000', 1)").run();
    addAccount('g5', 'e@example.com', 1_000_000, 0, { profile: 2 });
    addT7({ rel: 'a.jpg', size: 3000, kind: 'photo-camera' });
    const m = make();
    for (const accounts of [[], ['g5'], ['nope']]) {
      const out = await runJob(m, ['photo-camera'], { accounts });
      expect(out.error).toBeInstanceOf(JobFailure);
      expect(String((out.error as Error).message)).toMatch(/Nothing was sent/);
    }
    // A job made before this change (no accounts in its params) is refused too: it never picks accounts on its own.
    const old = await runJob(m, ['photo-camera'], { accounts: null });
    expect(old.error).toBeInstanceOf(JobFailure);
    expect(String((old.error as Error).message)).toMatch(/No Google account was ticked/);
    expect(uploads()).toBe(0);
    expect(callsBy('a@example.com')).toEqual([]);
  });

  it('a ticked account that Google refuses as full is left alone and the file waits for the person; an unticked account with room is not used', async () => {
    addAccount('g1', 'a@example.com', 1_000_000, 0);
    addAccount('g2', 'b@example.com', 1_000_000, 0);
    fake.fullAtStart.add('a@example.com');
    addT7({ rel: 'a.jpg', size: 3000, kind: 'photo-camera' });
    const out = await runJob(make(), ['photo-camera'], { accounts: ['g1'] });
    expect(out.asked).toEqual([ACCOUNTS_FULL_MESSAGE]);
    expect(googleRows('g1')).toEqual([]);
    expect(googleRows('g2')).toEqual([]);
    expect(callsBy('b@example.com')).toEqual([]);
  });

  it('the screen of a person with no Google account: no rows and the plain blocker; the plan and the start refuse', async () => {
    addT7({ rel: 'v.mp4', size: 100, kind: 'video-camera' });
    const m = make();
    const p = await previewOf(m);
    expect(p.accounts).toEqual([]);
    expect(p.blocker).toMatch(/No Google account/);
    expect((await m.service.start(startReq())).ok).toBe(false);
    expect(await m.service.plan({ backupId: 5, kinds: ['video-camera'], accountIds: ['g1'] })).toMatchObject({ ok: false });
    expect(fake.calls).toEqual([]);
  });

  it('a request that is not valid is refused without touching anything', async () => {
    addAccount('g1', 'a@example.com', 1_000_000, 0);
    const m = make();
    for (const bad of [null, undefined, {}, { backupId: 0 }, { backupId: 5, kinds: 'x', accountIds: [] }] as unknown[]) {
      expect((await m.service.plan(bad as never)).ok).toBe(false);
      expect((await m.service.start(bad as never)).ok).toBe(false);
      expect((await m.service.addAccounts(bad as never)).ok).toBe(false);
    }
    expect((await m.service.more('x')).ok).toBe(false);
    expect((await m.service.more(-1)).ok).toBe(false);
    expect(created).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('when the ticked accounts are full the copy waits with the exact question, uses no other account, and Stop leaves the file unsent', async () => {
    addAccount('g1', 'a@example.com', 1000, 0); // room 750
    addAccount('g2', 'b@example.com', 1_000_000, 0); // plenty of room, but not ticked
    addT7({ rel: 'a.mp4', size: 400, kind: 'video-camera' });
    addT7({ rel: 'b.mp4', size: 300, kind: 'video-camera' });
    const m = make();
    expect((await m.service.start(startReq({ accountIds: ['g1'], seenRoom: { g1: 750 } }))).ok).toBe(true);
    db.prepare("UPDATE places SET identity_json = json_set(identity_json, '$.quotaUsage', 300) WHERE id = 'g1'").run();
    fake.accounts[0]!.quota = { ...fake.accounts[0]!.quota, usage: '300' }; // 450 left: only one of the two files fits
    const out = await runJob(m, ['video-camera'], { accounts: ['g1'], jobId: 1 });
    expect(out.asked).toEqual([ACCOUNTS_FULL_MESSAGE]);
    expect(out.error).toBeInstanceOf(JobAborted);
    expect(googleRows('g1').map((r) => r.size)).toEqual([400]);
    expect(googleRows('g2')).toEqual([]);
    expect(callsBy('b@example.com')).toEqual([]);
    const report = loadReport(db, 1) ?? loadReport(db, 7);
    expect(report).toMatchObject({ copied: { files: 1, bytes: 400 }, stopped: true });
  });

  it('the person adds accounts and the copy carries on: the new account is used only after that, and the choice is remembered', async () => {
    addAccount('g1', 'a@example.com', 1000, 0);
    addAccount('g2', 'b@example.com', 1000, 0);
    addT7({ rel: 'a.mp4', size: 400, kind: 'video-camera' });
    addT7({ rel: 'b.mp4', size: 300, kind: 'video-camera' });
    const m = make();
    expect((await m.service.start(startReq({ accountIds: ['g1'], seenRoom: { g1: 750 } }))).ok).toBe(true);
    fake.accounts[0]!.quota = { ...fake.accounts[0]!.quota, usage: '300' };
    const seen: { before: number; picker: unknown }[] = [];
    const out = await runJob(m, ['video-camera'], {
      accounts: ['g1'],
      jobId: 1,
      needsYou: async (message) => {
        waiting = [{ id: 1, kind: GOOGLE_COPY_JOB_KIND, state: 'needs_you', message }];
        seen.push({ before: callsBy('b@example.com').length, picker: await m.service.more(1) });
        const added = await m.service.addAccounts({ jobId: 1, accountIds: ['g1', 'g2'], confirmedAccounts: true });
        expect(added).toEqual({ ok: true, message: '' });
        waiting = [];
        return 'Continue';
      },
    });
    expect(out.error).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.before).toBe(0); // g2 was never touched before the person confirmed it
    expect(seen[0]!.picker).toMatchObject({ ok: true, inUse: ['g1'], kinds: ['video-camera'], needBytes: 300 });
    expect(googleRows('g1').map((r) => r.size)).toEqual([400]);
    expect(googleRows('g2').map((r) => r.size)).toEqual([300]);
    expect(loadJobAccounts(db, 1)).toMatchObject({ accountIds: ['g1'], moreIds: ['g2'] });
    expect((await previewOf(m)).accounts.map((a) => [a.placeId, a.ticked])).toEqual([['g1', true], ['g2', true]]);
  });

  it('a copy that carries on after a restart still uses the accounts the person added', async () => {
    addAccount('g1', 'a@example.com', 1000, 0);
    addAccount('g2', 'b@example.com', 1000, 0);
    addT7({ rel: 'a.mp4', size: 400, kind: 'video-camera' });
    const m = make();
    expect((await m.service.start(startReq({ accountIds: ['g1'], seenRoom: { g1: 750 } }))).ok).toBe(true);
    fake.accounts[0]!.quota = { ...fake.accounts[0]!.quota, usage: '700' }; // g1 has 50 left
    waiting = [{ id: 1, kind: GOOGLE_COPY_JOB_KIND, state: 'needs_you', message: ACCOUNTS_FULL_MESSAGE }];
    expect((await m.service.addAccounts({ jobId: 1, accountIds: ['g1', 'g2'], confirmedAccounts: true })).ok).toBe(true);
    waiting = [];
    const out = await runJob(m, ['video-camera'], { accounts: ['g1'], jobId: 1 });
    expect(out.error).toBeNull();
    expect(googleRows('g2').map((r) => r.size)).toEqual([400]);
  });

  it('adding accounts is refused when the copy is not waiting, when not confirmed, for foreign or unknown accounts, and when the files still would not fit', async () => {
    addAccount('g1', 'a@example.com', 1000, 0);
    addAccount('g2', 'b@example.com', 1000, 650); // room 100
    db.prepare("INSERT INTO profiles (id, name, color, created_at) VALUES (2, 'Other', '#000000', 1)").run();
    addAccount('g5', 'e@example.com', 1_000_000, 0, { profile: 2 });
    addT7({ rel: 'a.mp4', size: 400, kind: 'video-camera' });
    addT7({ rel: 'b.mp4', size: 300, kind: 'video-camera' });
    const m = make();
    expect((await m.service.start(startReq({ accountIds: ['g1'], seenRoom: { g1: 750 } }))).ok).toBe(true);
    const ask = (over: Record<string, unknown> = {}) => m.service.addAccounts({ jobId: 1, accountIds: ['g2'], confirmedAccounts: true, ...over } as never);
    expect(await ask()).toMatchObject({ ok: false, message: expect.stringContaining('not waiting') });
    expect(await m.service.more(1)).toMatchObject({ ok: false });
    waiting = [{ id: 1, kind: GOOGLE_COPY_JOB_KIND, state: 'needs_you', message: ACCOUNTS_FULL_MESSAGE }];
    fake.accounts[0]!.quota = { ...fake.accounts[0]!.quota, usage: '700' }; // g1: 50 left; 700 bytes still to go
    expect(await ask({ confirmedAccounts: false })).toMatchObject({ ok: false, message: expect.stringContaining('not confirmed') });
    expect(await ask({ accountIds: ['g5'] })).toMatchObject({ ok: false });
    expect(await ask({ accountIds: ['unknown'] })).toMatchObject({ ok: false });
    expect(await ask({ accountIds: [] })).toMatchObject({ ok: false });
    expect(await ask({ jobId: 99 })).toMatchObject({ ok: false });
    expect(await ask({ accountIds: ['g2'] })).toMatchObject({ ok: false, message: expect.stringMatching(/Short by/) }); // 50 + 100 room for 700 bytes
    expect(loadJobAccounts(db, 1)).toMatchObject({ moreIds: [] });
    // A waiting job of another kind is not ours.
    waiting = [{ id: 1, kind: 'something.else', state: 'needs_you', message: ACCOUNTS_FULL_MESSAGE }];
    expect(await ask()).toMatchObject({ ok: false });
    // A waiting copy with another question is not "accounts full".
    waiting = [{ id: 1, kind: GOOGLE_COPY_JOB_KIND, state: 'needs_you', message: 'Plug it back in.' }];
    expect(await ask()).toMatchObject({ ok: false });
    expect(await m.service.more(1)).toMatchObject({ ok: false });
  });

  it('the room of an account is asked from Google again before a file goes into it when the last answer is older than 2 minutes; the files on their way are taken off the answer', async () => {
    const a = addAccount('g1', 'a@example.com', 1000, 0); // room 750
    for (let i = 0; i < 5; i += 1) addT7({ rel: `v${i}.mp4`, size: 100, kind: 'video-camera', seed: i + 1 });
    const m = make();
    let sent = 0;
    const out = await runJob(m, ['video-camera'], {
      accounts: ['g1'],
      afterFile: () => {
        sent += 1;
        if (sent === 1) {
          clock += 3 * 60_000; // three minutes later: the 4 files on their way already hold 400 of the room
          a.quota = { ...a.quota, usage: '700' }; // somebody filled the account: 50 left, and the files on their way need more than that
        }
      },
    });
    expect(out.asked).toEqual([ACCOUNTS_FULL_MESSAGE]); // the fifth file would have gone in on the old number
    expect(googleRows('g1')).toHaveLength(4);
    expect(aboutBy('a@example.com')).toBeGreaterThanOrEqual(2);
  });

  it('within 2 minutes the last answer is used: no extra question to Google per file', async () => {
    const a = addAccount('g1', 'a@example.com', 1000, 0);
    addT7({ rel: 'a.mp4', size: 300, kind: 'video-camera' });
    addT7({ rel: 'b.mp4', size: 290, kind: 'video-camera' });
    const out = await runJob(make(), ['video-camera'], {
      accounts: ['g1'],
      afterFile: () => {
        clock += 60_000;
        a.quota = { ...a.quota, usage: '740' };
      },
    });
    expect(out.error).toBeNull();
    expect(googleRows('g1')).toHaveLength(2);
    expect(aboutBy('a@example.com')).toBe(1);
  });

  it('an account that needs signing in during the run is left out and the file waits for the person instead of going elsewhere', async () => {
    const a = addAccount('g1', 'a@example.com', 1000, 0);
    addAccount('g2', 'b@example.com', 1_000_000, 0);
    for (let i = 0; i < 5; i += 1) addT7({ rel: `v${i}.mp4`, size: 100, kind: 'video-camera', seed: i + 1 });
    const out = await runJob(make(), ['video-camera'], {
      accounts: ['g1'],
      afterFile: () => {
        if (googleRows('g1').length === 0) return; // the checkpoint is also written when a file's upload session starts: wait for the first recorded file
        clock += 3 * 60_000;
        a.revoked = true;
        fake.expireTokens();
      },
    });
    expect(out.asked).toEqual([ACCOUNTS_FULL_MESSAGE]);
    expect(googleRows('g1').length).toBeGreaterThanOrEqual(1);
    expect(googleRows('g1').length).toBeLessThan(5);
    expect(googleRows('g2')).toEqual([]);
  });

  it('the placement rules: least room that fits, never split; the suggestion is the fewest accounts, most room first', () => {
    const placer = new Placer([
      { placeId: 'a', label: 'A', email: null, limit: 100, usage: 0, room: 75 },
      { placeId: 'b', label: 'B', email: null, limit: 100, usage: 50, room: 25 },
    ]);
    for (const size of [30, 20, 20, 60]) placer.put(size);
    expect(placer.result()).toMatchObject({ toPlaceFiles: 4, toPlaceBytes: 130, unplacedFiles: 1, unplacedBytes: 60, lines: [{ placeId: 'a', files: 2, bytes: 50, endsPercent: 50 }, { placeId: 'b', files: 1, bytes: 20, endsPercent: 70 }] });
    const pick = (id: string, room: number) => ({ placeId: id, label: id, canTake: room > 0, room }) as never;
    expect(suggestAccounts([pick('a', 10), pick('b', 50), pick('c', 30)], 60)).toEqual(['b', 'c']);
    expect(suggestAccounts([pick('a', 10), pick('b', 50)], 0)).toEqual([]);
    expect(suggestAccounts([pick('a', 0)], 5)).toEqual([]);
    expect(suggestAccounts([pick('a', 10), pick('b', 50)], 5, new Set(['b']))).toEqual(['a']);
  });
});

// ---- three files at once, each into a different ticked account ---------------------------------------------------------------------------------

/** Every upload the fake sees, with the time it began and the time its last chunk was answered (the fake answers every request after the same wait). */
interface Window {
  account: string;
  from: number;
  to: number;
}

function trackUploads(waitMs: number, afterChunk?: (chunkCalls: number) => void): { windows(): Window[]; open(): number } {
  const starts: { account: string; t: number }[] = [];
  const finals: { account: string; t: number }[] = [];
  let chunkCalls = 0;
  fake.delayMs = (call) => {
    if (call.path === '/upload/drive/v3/files') {
      const account = call.account ?? '?';
      if (call.method === 'POST') starts.push({ account, t: Date.now() });
      else {
        const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(call.headers['Content-Range'] ?? '');
        if (m) {
          chunkCalls += 1;
          afterChunk?.(chunkCalls);
          if (Number(m[2]) + 1 === Number(m[3])) finals.push({ account, t: Date.now() + waitMs });
        }
      }
    }
    return waitMs;
  };
  return {
    /** One window per finished file: its start paired with the next last chunk of the same account. */
    windows: () => {
      const out: Window[] = [];
      for (const s of starts) {
        const f = finals.filter((x) => x.account === s.account && x.t >= s.t).toSorted((a, b) => a.t - b.t)[0];
        if (f) out.push({ account: s.account, from: s.t, to: f.t });
      }
      return out;
    },
    open: () => starts.length - finals.length,
  };
}

const folderPosts = (email: string): number => fake.calls.filter((c) => c.method === 'POST' && c.path === '/drive/v3/files' && c.account === email).length;
const allRows = (): number => (db.prepare("SELECT COUNT(*) FROM files WHERE place_id LIKE 'g%'").pluck().get() as number);

describe('the plan thinks like the run: files go together, up to 4 into one account and 6 in all', () => {
  const acct = (placeId: string, room: number) => ({ placeId, label: placeId, email: null, limit: null, usage: null, room });

  it('the limits are 4 files into one account and 6 in all', () => {
    expect(GOOGLE_COPY_PER_ACCOUNT).toBe(4);
    expect(GOOGLE_COPY_AT_ONCE).toBe(6);
  });

  it('one account takes several files at once, never more than 4 together: the fifth waits for a free place', () => {
    const one = new Placer([acct('a', 1e9)]);
    for (let i = 0; i < 9; i += 1) expect(one.put(100)).toBe(true);
    expect(one.result().lines).toMatchObject([{ placeId: 'a', files: 9, bytes: 900 }]);
    expect(one.result().unplacedFiles).toBe(0);
  });

  it('with room to spare the files fill the account with the least room first, 4 at a time, then the next (6 in all)', () => {
    const placer = new Placer([acct('a', 1e9), acct('b', 1e9), acct('c', 1e9)]);
    for (let i = 0; i < 6; i += 1) placer.put(100);
    expect(placer.result().lines.map((l) => [l.placeId, l.files, l.bytes])).toEqual([['a', 4, 400], ['b', 2, 200]]);
    expect(placer.result().unplacedFiles).toBe(0);
  });

  it('the room is reserved as files are picked, also several into one account: the last room takes what fits and the rest is unplaced', () => {
    const placer = new Placer([acct('a', 250), acct('b', 150)]);
    for (let i = 0; i < 5; i += 1) placer.put(100);
    const r = placer.result();
    expect(r.lines.map((l) => [l.placeId, l.files])).toEqual([['a', 2], ['b', 1]]);
    expect(r.unplacedFiles).toBe(2);
    const full = new Placer([acct('a', 1000)]);
    for (let i = 0; i < 12; i += 1) full.put(100); // 10 fit, however many are on their way together
    expect(full.result()).toMatchObject({ unplacedFiles: 2, lines: [{ files: 10, bytes: 1000 }] });
  });

  it('fit mode takes what fits (biggest first as given) and leaves the rest waiting, never unplaced', () => {
    const placer = new Placer([acct('a', 250), acct('b', 150)], true);
    const taken = [300, 200, 100, 100, 100, 50].map((s) => placer.put(s));
    expect(taken).toEqual([false, true, true, false, false, true]); // 300 fits nowhere; 200 and 100 and 50 fit; the 100s that come when 50 and 50 are left wait
    expect(placer.result()).toMatchObject({ fit: true, toPlaceFiles: 3, toPlaceBytes: 350, waitingFiles: 3, waitingBytes: 500, unplacedFiles: 0 });
  });
});

describe('copy to Google: several files at once, up to 4 into one account and 6 in all', () => {
  const seedFiles = (n: number, size: number): void => {
    for (let i = 0; i < n; i += 1) addT7({ rel: `DCIM/Camera/v${String(i).padStart(2, '0')}.mp4`, size, kind: 'video-camera', seed: i + 1 });
  };

  /** The most files on their way at one moment (all, and in any one account): counted from the sessions the fake sees begin and the last chunk it answers. */
  function trackConcurrency(waitMs: number): { max(): { all: number; perAccount: number } } {
    const open = new Map<string, number>();
    let all = 0;
    let maxAll = 0;
    let maxPer = 0;
    fake.delayMs = (call) => {
      if (call.path === '/upload/drive/v3/files') {
        const account = call.account ?? '?';
        if (call.method === 'POST') {
          open.set(account, (open.get(account) ?? 0) + 1);
          all += 1;
          maxAll = Math.max(maxAll, all);
          maxPer = Math.max(maxPer, open.get(account)!);
        } else {
          const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(call.headers['Content-Range'] ?? '');
          if (m && Number(m[2]) + 1 === Number(m[3])) {
            setTimeout(() => {
              open.set(account, open.get(account)! - 1);
              all -= 1;
            }, waitMs);
          }
        }
      }
      return waitMs;
    };
    return { max: () => ({ all: maxAll, perAccount: maxPer }) };
  }

  it('one account takes 4 files at once, never a fifth; every file is checked and recorded', async () => {
    addAccount('g1', 'g1@example.com', 100_000_000, 0);
    seedFiles(10, CHUNK * 2);
    const tracker = trackConcurrency(12);
    const out = await runJob(make(), ['video-camera']);
    expect(out.error).toBeNull();
    expect(allRows()).toBe(10);
    expect(tracker.max()).toEqual({ all: GOOGLE_COPY_PER_ACCOUNT, perAccount: GOOGLE_COPY_PER_ACCOUNT });
    for (const row of googleRows('g1')) expect(row.verified_how).toBe('google-md5');
    expect(loadReport(db, 7)).toMatchObject({ copied: { files: 10, bytes: 10 * CHUNK * 2 } });
  });

  it('three accounts: 6 files at once in all and never more than 4 into one account', async () => {
    for (const id of ['g1', 'g2', 'g3']) addAccount(id, `${id}@example.com`, 100_000_000, 0);
    seedFiles(18, CHUNK * 2);
    const tracker = trackConcurrency(12);
    const out = await runJob(make(), ['video-camera']);
    expect(out.error).toBeNull();
    expect(allRows()).toBe(18);
    const max = tracker.max();
    expect(max.all).toBe(GOOGLE_COPY_AT_ONCE);
    expect(max.perAccount).toBeLessThanOrEqual(GOOGLE_COPY_PER_ACCOUNT);
    expect(new Set(['g1', 'g2', 'g3'].flatMap((id) => googleRows(id).map((r) => r.rel_path))).size).toBe(18); // each file in exactly one account
  });

  it('two accounts: 6 at once at most too (4 and 2); the room reserved for every file on its way is never overfilled', async () => {
    // g1 can take 5 files (room 5.5), g2 can take 2 (room 2.5): of 10 files 7 fit, however many are on their way together.
    const S = CHUNK;
    addAccount('g1', 'g1@example.com', Math.ceil((S * 5.5) / 0.75), 0);
    addAccount('g2', 'g2@example.com', Math.ceil((S * 2.5) / 0.75), 0);
    seedFiles(10, S);
    const tracker = trackConcurrency(12);
    const out = await runJob(make(), ['video-camera']);
    expect(out.asked).toEqual([ACCOUNTS_FULL_MESSAGE]);
    expect(googleRows('g1').length + googleRows('g2').length).toBe(7);
    expect(googleRows('g1').reduce((s, r) => s + r.size, 0)).toBeLessThanOrEqual(5.5 * S);
    expect(googleRows('g2').reduce((s, r) => s + r.size, 0)).toBeLessThanOrEqual(2.5 * S);
    expect(tracker.max().perAccount).toBeLessThanOrEqual(GOOGLE_COPY_PER_ACCOUNT);
  });

  it('the upload sessions are asked for in the order the files were handed out (biggest first)', async () => {
    addAccount('g1', 'g1@example.com', 100_000_000, 0);
    for (let i = 0; i < 6; i += 1) addT7({ rel: `DCIM/Camera/v${i}.mp4`, size: 1000 * (i + 1), kind: 'video-camera', seed: i + 1 });
    trackConcurrency(5);
    expect((await runJob(make(), ['video-camera'])).error).toBeNull();
    expect([...fake.sessions.values()].map((s) => s.name)).toEqual(['v5.mp4', 'v4.mp4', 'v3.mp4', 'v2.mp4', 'v1.mp4', 'v0.mp4']);
  });

  it('every file is read once: the checksums are made while the chunks are read, never by a second read of the whole file', async () => {
    addAccount('g1', 'g1@example.com', 100_000_000, 0);
    seedFiles(3, CHUNK * 3);
    const out = await runJob(make(), ['video-camera']);
    expect(out.error).toBeNull();
    expect(allRows()).toBe(3);
    expect(hashCalls).toBe(0);
    expect(chunkReads).toHaveLength(9); // 3 files x 3 chunks, each read once
    expect(loadReport(db, 7)).toMatchObject({ copied: { files: 3 } });
  });

  it('a small file that does not match its saved checksum is never sent; a big one is sent, but not counted and not recorded', async () => {
    addAccount('g1', 'g1@example.com', 100_000_000, 0);
    addT7({ rel: 'DCIM/Camera/small.jpg', size: 5000, kind: 'photo-camera', sha: 'a'.repeat(64) }); // the saved checksum is wrong
    addT7({ rel: 'DCIM/Camera/big.mp4', size: CHUNK * 3 + 7, kind: 'video-camera', sha: 'b'.repeat(64) });
    addT7({ rel: 'DCIM/Camera/fine.mp4', size: CHUNK * 3 + 9, kind: 'video-camera' });
    const out = await runJob(make(), ['photo-camera', 'video-camera']);
    expect(out.error).toBeNull();
    const names = [...fake.sessions.values()].map((s) => s.name).toSorted();
    expect(names).toEqual(['big.mp4', 'fine.mp4']); // the small damaged one never left the drive
    expect(googleRows('g1').map((r) => r.rel_path)).toEqual(['My Drive/Backup Hub/POCO/DCIM/Camera/fine.mp4']);
    const report = loadReport(db, 7)!;
    expect(report.heldBack).toEqual([{ reason: expect.stringContaining('does not match its saved checksum'), count: 1, examples: ['DCIM/Camera/small.jpg'] }]);
    expect(report.failed).toEqual([{ reason: expect.stringMatching(/did not match its saved checksum when it was read for sending.*not counted.*nothing was deleted/s), count: 1, examples: ['DCIM/Camera/big.mp4'] }]);
    expect(report.copied.files).toBe(1);
    // Nothing was written for the big one: no row in any account, no md5 on the T7 row.
    expect(db.prepare("SELECT COUNT(*) FROM files WHERE place_id = 'g1' AND rel_path LIKE '%big.mp4'").pluck().get()).toBe(0);
    expect((db.prepare("SELECT md5 FROM files WHERE place_id = 't7' AND rel_path LIKE '%big.mp4'").get() as { md5: string | null }).md5).toBeNull();
  });

  it('logs one line per sent file with where the time went (no addresses or tokens)', async () => {
    addAccount('g1', 'g1@example.com', 100_000_000, 0);
    seedFiles(2, 3000);
    const out = await runJob(make(), ['video-camera']);
    expect(out.error).toBeNull();
    const lines = out.logs.filter((l) => l.startsWith('Sent '));
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).toMatch(/^Sent v0[01]\.mp4 \(3000 bytes\) to G1: read and hash \d+ ms, folders \d+ ms, session start \d+ ms, upload \d+ ms, \d+ ms in all$/);
      expect(l).not.toMatch(/https?:|upload_id|Bearer|1\/\/rt-/);
    }
  });

  it('asks where the drive is once, not for every file', async () => {
    addAccount('g1', 'g1@example.com', 100_000_000, 0);
    seedFiles(6, 2000);
    let asked = 0;
    const m = make({ onDriveRoot: () => void (asked += 1) });
    expect((await runJob(m, ['video-camera'])).error).toBeNull();
    expect(asked).toBe(1);
  });

  it('files picked together can never overfill the keep-free line: the last room takes what fits, then the copy waits, after the files on their way finish', async () => {
    const S = CHUNK;
    // g1 can take 2 files (room 2.5 files), g2 can take 1 (room 1.5 files): 3 of the 5 files fit.
    addAccount('g1', 'g1@example.com', Math.ceil((S * 2.5) / 0.75), 0);
    addAccount('g2', 'g2@example.com', Math.ceil((S * 1.5) / 0.75), 0);
    seedFiles(5, S);
    const tracker = trackUploads(15);
    let rowsWhenAsked = -1;
    let openWhenAsked = -1;
    const out = await runJob(make(), ['video-camera'], {
      needsYou: async () => {
        rowsWhenAsked = allRows();
        openWhenAsked = tracker.open();
        throw new JobAborted();
      },
    });
    expect(out.error).toBeInstanceOf(JobAborted);
    expect(rowsWhenAsked).toBe(3); // asked only after the files on their way were finished and recorded
    expect(openWhenAsked).toBe(0);
    expect(googleRows('g1').length).toBeLessThanOrEqual(2);
    expect(googleRows('g2').length).toBeLessThanOrEqual(1);
    expect(googleRows('g1').length + googleRows('g2').length).toBe(3);
    for (const [id, cap] of [['g1', 2.5 * S], ['g2', 1.5 * S]] as const) expect(googleRows(id).reduce((s, r) => s + r.size, 0)).toBeLessThanOrEqual(cap);
    expect(out.asked).toEqual([]); // the needsYou above threw before pushing; the job did stop in the question
  });

  it('a file that is not sent gives its room back: the next file takes it', async () => {
    const S = CHUNK;
    addAccount('g1', 'g1@example.com', Math.ceil((S * 1.5) / 0.75), 0);
    const first = addT7({ rel: 'DCIM/Camera/a.mp4', size: S + 5, kind: 'video-camera', seed: 1 });
    addT7({ rel: 'DCIM/Camera/b.mp4', size: S, kind: 'video-camera', seed: 2 });
    fs.writeFileSync(first.abs, bytes(S + 7, 1)); // changed after the list was made: held back, never sent
    const out = await runJob(make(), ['video-camera']);
    expect(out.error).toBeNull();
    expect(out.asked).toEqual([]);
    expect(googleRows('g1').map((r) => r.rel_path)).toEqual(['My Drive/Backup Hub/POCO/DCIM/Camera/b.mp4']);
    expect(loadReport(db, 7)).toMatchObject({ copied: { files: 1 }, heldBack: [{ count: 1 }] });
  });

  it('one folder per path per account, even when several ask at the same moment', async () => {
    const acc = addAccount('g1', 'g1@example.com', 100_000_000, 0);
    const http = new GoogleHttp({ fetchFn: fake.fetchFn, sleep: () => Promise.resolve() });
    const auth = new GoogleAuth(vault, http);
    const maker = new FolderMaker(new DriveUploader(http, auth), async () => undefined);
    fake.delayMs = () => 10;
    const signal = new AbortController().signal;
    const ids = await Promise.all(Array.from({ length: 6 }, () => maker.ensure('g1', ['Backup Hub', 'POCO', 'DCIM'], signal)));
    expect(new Set(ids).size).toBe(1);
    const folders = [...acc.items.values()].filter((i) => i.mimeType === 'application/vnd.google-apps.folder');
    expect(folders.map((f) => f.name).toSorted()).toEqual(['Backup Hub', 'DCIM', 'POCO']);
    expect(folderPosts('g1@example.com')).toBe(3);
  });

  it('in a run, every account that is used gets each folder made once', async () => {
    for (const id of ['g1', 'g2', 'g3']) addAccount(id, `${id}@example.com`, 100_000_000, 0);
    seedFiles(18, CHUNK);
    trackUploads(8);
    expect((await runJob(make(), ['video-camera'])).error).toBeNull();
    const used = ['g1', 'g2', 'g3'].filter((id) => googleRows(id).length > 0);
    expect(used.length).toBeGreaterThanOrEqual(2); // 18 files do not fit 4 places of one account
    for (const id of used) expect(folderPosts(`${id}@example.com`)).toBe(4); // Backup Hub, POCO, DCIM, Camera
  });

  it('a stop aborts the files on their way: nothing is recorded for them, and Continue sends them whole', async () => {
    for (const id of ['g1', 'g2', 'g3']) addAccount(id, `${id}@example.com`, 100_000_000, 0);
    seedFiles(3, CHUNK * 4);
    const stop = new AbortController();
    trackUploads(20, (n) => {
      if (n === 4) stop.abort(); // three files have begun and each has sent about one chunk: none can be finished
    });
    const m = make();
    const stopped = await runJob(m, ['video-camera'], { signal: stop.signal });
    expect(stopped.error).toBeInstanceOf(JobAborted);
    expect(allRows()).toBe(0);
    expect(loadReport(db, 7)).toMatchObject({ stopped: true, copied: { files: 0 } });
    const callsAtStop = fake.calls.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(fake.calls.length).toBe(callsAtStop); // nothing goes out after the stop
    fake.delayMs = null;
    const resumed = await runJob(m, ['video-camera'], { resume: stopped.checkpoint });
    expect(resumed.error).toBeNull();
    expect(allRows()).toBe(3);
    for (const id of ['g1', 'g2', 'g3']) for (const row of googleRows(id)) expect(fake.stored.get(row.ext_id)!.length).toBe(CHUNK * 4);
    expect(new Set(['g1', 'g2', 'g3'].flatMap((id) => googleRows(id).map((r) => r.rel_path))).size).toBe(3);
  });

  it('a pause holds the files on their way and starts no new one; letting go finishes everything', async () => {
    for (const id of ['g1', 'g2']) addAccount(id, `${id}@example.com`, 100_000_000, 0);
    seedFiles(6, CHUNK * 2);
    trackUploads(8);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let before = 0;
    let held = false;
    let paused = false;
    let callsWhilePaused = -1;
    const done = await runJob(make(), ['video-camera'], {
      // Like the job service: once paused, EVERY yield (the dispatcher's and each file's) waits for the release.
      yieldFn: async () => {
        if (allRows() >= 2 && !held) {
          held = true;
          paused = true;
          before = fake.calls.length;
          setTimeout(() => {
            callsWhilePaused = fake.calls.length - before;
            paused = false;
            release();
          }, 60);
        }
        if (paused) await gate;
      },
    });
    expect(done.error).toBeNull();
    expect(callsWhilePaused).toBeLessThanOrEqual(3); // at most the requests that were already out when the pause began
    expect(allRows()).toBe(6);
  });

  it('shows each account live: "60 MB of 144 MB" while copying, and rebuilds the numbers after a restart', async () => {
    for (const id of ['g1', 'g2', 'g3']) addAccount(id, `${id}@example.com`, 100_000_000, 0);
    seedFiles(9, CHUNK * 2);
    trackUploads(8);
    const m = make();
    const seen: { placeId: string; bytes: number; toSend: number; files: number }[][] = [];
    const out = await runJob(m, ['video-camera'], {
      yieldFn: async () => {
        const lines = m.service.sent(7);
        if (lines.length > 0) seen.push(lines.map((l) => ({ placeId: l.placeId, bytes: l.bytes, toSend: l.toSend, files: l.files })));
      },
    });
    expect(out.error).toBeNull();
    // While it ran: every ticked account was planned to get its share (the plan fills 4 places of one account, then the next), and the live number moved in steps.
    const first = seen[0]!;
    expect(first.map((l) => l.placeId).toSorted()).toEqual(['g1', 'g2', 'g3']);
    expect(first.reduce((s, l) => s + l.toSend, 0)).toBe(9 * CHUNK * 2);
    const ups = seen.flatMap((s) => s.filter((l) => l.bytes > 0 && l.bytes < l.toSend));
    expect(ups.length).toBeGreaterThan(0);
    const partial = seen.flatMap((s) => s.filter((l) => l.bytes % (CHUNK * 2) !== 0));
    expect(partial.length).toBeGreaterThan(0); // a file on its way is counted as far as Google confirmed it
    for (const s of seen) for (const l of s) expect(l.bytes).toBeLessThanOrEqual(l.toSend);
    // After the run, and for a service started fresh (a restart): the numbers come from what was written down.
    const after = make().service.sent(7);
    expect(after.map((l) => [l.placeId, l.bytes, l.files]).toSorted()).toEqual(['g1', 'g2', 'g3'].map((id) => [id, googleRows(id).reduce((s, r) => s + r.size, 0), googleRows(id).length]));
    expect(after.reduce((s, l) => s + l.bytes, 0)).toBe(9 * CHUNK * 2);
    expect(make().service.sent('x')).toEqual([]);
    expect(make().service.sent(999)).toEqual([]);
  });

  it('after a stop, a restart shows only the checked files of each account', async () => {
    for (const id of ['g1', 'g2']) addAccount(id, `${id}@example.com`, 100_000_000, 0);
    seedFiles(6, CHUNK);
    trackUploads(8);
    const m = make();
    const stopped = await runJob(m, ['video-camera'], {
      yieldFn: async () => {
        if (allRows() >= 3) throw new JobAborted();
      },
    });
    expect(stopped.error).toBeInstanceOf(JobAborted);
    const lines = make().service.sent(7);
    expect(lines.reduce((s, l) => s + l.files, 0)).toBe(allRows());
    expect(lines.reduce((s, l) => s + l.bytes, 0)).toBe(allRows() * CHUNK);
  });
});

// ---- phone backups: only what is still on the phone, and fit what I have room for, biggest first -----------------------------------------------

/** The phone's own listing: a place 'ph' (the backup's source) with the files the phone holds. */
function seedPhone(): { add(rel: string, data: Buffer, opts?: { gone?: boolean; sha?: string | null }): number } {
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, created_at) VALUES ('ph', 1, 'phone', 'POCO', '{}', 'connected', 1)").run();
  db.prepare("UPDATE backup_profiles SET source_place_id = 'ph' WHERE id = 5").run();
  return {
    add: (rel, data, opts = {}) =>
      Number(
        db
          .prepare("INSERT INTO files (place_id, rel_path, size, mtime, sha256, first_seen_at, last_seen_at, gone_at) VALUES ('ph', ?, ?, 1000, ?, 1, 1, ?)")
          .run('/sdcard/' + rel, data.length, opts.sha === undefined ? sha(data) : opts.sha, opts.gone ? 2 : null).lastInsertRowid,
      ),
  };
}

describe('only what is still on the phone', () => {
  it('counts only files whose content is on the phone now (same rule as Free up phone space: a live phone row, linked or with the same checksum)', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    const phone = seedPhone();
    const a = addT7({ rel: 'DCIM/Camera/a.jpg', size: 1000, seed: 1, kind: 'photo-camera' });
    addT7({ rel: 'DCIM/Camera/b.jpg', size: 2000, seed: 2, kind: 'photo-camera' });
    const c = addT7({ rel: 'DCIM/Camera/c.jpg', size: 3000, seed: 3, kind: 'photo-camera' });
    addT7({ rel: 'DCIM/Camera/d.jpg', size: 4000, seed: 4, kind: 'photo-camera' });
    phone.add('DCIM/Camera/a.jpg', a.data); // same checksum
    phone.add('DCIM/Camera/b.jpg', bytes(2000, 2), { gone: true }); // taken off the phone: not counted
    const cRow = phone.add('DCIM/Camera/c.jpg', c.data, { sha: null }); // no checksum on the phone row: found by the link
    db.prepare('UPDATE files SET origin_file_id = ? WHERE id = ?').run(cRow, c.id);
    // d is on the T7 only.
    const m = make();
    const all = await m.service.preview(5);
    const on = await m.service.preview(5, true);
    expect(all.ok && on.ok).toBe(true);
    if (!all.ok || !on.ok) return;
    expect(all.preview).toMatchObject({ isPhone: true, onlyOnPhone: false });
    expect(all.preview.kinds.map((k) => [k.kind, k.files, k.bytes])).toEqual([['photo-camera', 4, 10_000]]);
    expect(on.preview).toMatchObject({ isPhone: true, onlyOnPhone: true });
    expect(on.preview.kinds.map((k) => [k.kind, k.files, k.bytes, k.toGoFiles, k.toGoBytes])).toEqual([['photo-camera', 2, 4000, 2, 4000]]);
  });

  it('with no phone listing nothing is "on the phone"; another kind of backup ignores the switch', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    addT7({ rel: 'a.jpg', size: 100, kind: 'photo-camera' });
    const m = make();
    const none = await m.service.preview(5, true);
    expect(none.ok && none.preview.kinds).toEqual([]);
    expect(none.ok && none.preview.onlyOnPhone).toBe(true);
    db.prepare("UPDATE backup_profiles SET source_kind = 'folder' WHERE id = 5").run();
    const folder = await m.service.preview(5, true);
    expect(folder.ok && folder.preview).toMatchObject({ isPhone: false, onlyOnPhone: false });
    expect(folder.ok && folder.preview.kinds.map((k) => k.files)).toEqual([1]);
  });

  it('the plan, the start and the run all use only those files', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    const phone = seedPhone();
    const on = addT7({ rel: 'DCIM/Camera/on.mp4', size: 3000, seed: 1, kind: 'video-camera' });
    addT7({ rel: 'DCIM/Camera/off.mp4', size: 5000, seed: 2, kind: 'video-camera' });
    phone.add('DCIM/Camera/on.mp4', on.data);
    const m = make();
    const planAll = await m.service.plan({ backupId: 5, kinds: ['video-camera'], accountIds: ['g1'] });
    const planOn = await m.service.plan({ backupId: 5, kinds: ['video-camera'], accountIds: ['g1'], onlyOnPhone: true });
    expect(planAll.ok && [planAll.plan.toPlaceFiles, planAll.plan.toPlaceBytes]).toEqual([2, 8000]);
    expect(planOn.ok && [planOn.plan.toPlaceFiles, planOn.plan.toPlaceBytes]).toEqual([1, 3000]);
    const started = await m.service.start(startReq({ onlyOnPhone: true }));
    expect(started.ok).toBe(true);
    expect(created[0]!.params).toMatchObject({ onlyOnPhone: true });
    expect(created[0]!.title).toMatch(/\(1 file, /);
    expect(loadJobAccounts(db, 1)).toMatchObject({ onlyOnPhone: true });
    const out = await runJob(m, ['video-camera'], { flags: { onlyOnPhone: true } });
    expect(out.error).toBeNull();
    expect([...fake.sessions.values()].map((s) => s.name)).toEqual(['on.mp4']);
    expect(loadReport(db, 7)).toMatchObject({ copied: { files: 1, bytes: 3000 } });
  });
});

describe('fit what I have room for, biggest first', () => {
  const sizes = [400, 300, 200, 100];

  it('the plan takes the files that fit, the biggest first whatever their kind, and says what waits; without it the same selection is short', async () => {
    addAccount('g1', 'a@example.com', 600, 0); // room 450
    addT7({ rel: 'v/small.mp4', size: 100, kind: 'video-camera', seed: 1 });
    addT7({ rel: 'p/big.jpg', size: 400, kind: 'photo-camera', seed: 2 });
    const m = make();
    const fit = await m.service.plan({ backupId: 5, kinds: ['video-camera', 'photo-camera'], accountIds: ['g1'], fitBiggest: true });
    expect(fit).toMatchObject({ ok: true, plan: { fit: true, toPlaceFiles: 1, toPlaceBytes: 400, waitingFiles: 1, waitingBytes: 100, unplacedFiles: 0, lines: [{ placeId: 'g1', files: 1, bytes: 400 }] } });
    const strict = await m.service.plan({ backupId: 5, kinds: ['video-camera', 'photo-camera'], accountIds: ['g1'] });
    expect(strict).toMatchObject({ ok: true, plan: { toPlaceFiles: 2, unplacedFiles: 1 } });
    expect(strict.ok && strict.plan.fit).toBeUndefined();
  });

  it('keeps going past a file that does not fit: a smaller one may still fit (never into an account that was not ticked)', async () => {
    addAccount('g1', 'a@example.com', 1000, 0); // room 750
    addAccount('g2', 'b@example.com', 1_000_000, 0); // not ticked: lots of room that must stay unused
    for (const [i, s] of [900, 400, 300, 200, 100].entries()) addT7({ rel: `v/${s}.mp4`, size: s, kind: 'video-camera', seed: i + 1 });
    const r = await make().service.plan({ backupId: 5, kinds: ['video-camera'], accountIds: ['g1'], fitBiggest: true });
    // 900 fits nowhere; 400 + 300 fit; 200 and 100 do not (50 left).
    expect(r).toMatchObject({ ok: true, plan: { fit: true, toPlaceFiles: 2, toPlaceBytes: 700, waitingFiles: 3, waitingBytes: 1200, lines: [{ placeId: 'g1' }] } });
    expect(r.ok && r.plan.lines.map((l) => l.placeId)).toEqual(['g1']);
  });

  it('the start with fit goes ahead although not everything fits, and the job says what it will send; without fit it is refused as before', async () => {
    addAccount('g1', 'a@example.com', 1000, 0); // room 750
    for (const [i, s] of sizes.entries()) addT7({ rel: `v/${s}.mp4`, size: s, kind: 'video-camera', seed: i + 1 });
    const m = make();
    const refused = await m.service.start(startReq());
    expect(refused).toMatchObject({ ok: false, message: expect.stringMatching(/^Short by /) });
    expect(created).toEqual([]);
    const ok = await m.service.start(startReq({ fitBiggest: true }));
    expect(ok).toEqual({ ok: true, jobId: 1, message: '' });
    expect(created[0]!.params).toMatchObject({ fitBiggest: true, kinds: ['video-camera'], accountIds: ['g1'] });
    expect(created[0]!.title).toMatch(/\(2 files, /);
    expect(loadJobAccounts(db, 1)).toMatchObject({ fitBiggest: true });
  });

  it('the start with fit is refused when not even the smallest file fits', async () => {
    addAccount('g1', 'a@example.com', 100, 0); // room 75
    addT7({ rel: 'v/a.mp4', size: 400, kind: 'video-camera' });
    const r = await make().service.start(startReq({ fitBiggest: true }));
    expect(r).toMatchObject({ ok: false, changed: true, message: expect.stringContaining('Not even the smallest file fits') });
    expect(created).toEqual([]);
  });

  it('the run sends the biggest first and only the files that were planned; the rest stays for later and nothing asks for more accounts', async () => {
    addAccount('g1', 'a@example.com', 1000, 0); // room 750
    for (const [i, s] of sizes.entries()) addT7({ rel: `v/${s}.mp4`, size: s, kind: 'video-camera', seed: i + 1 });
    const out = await runJob(make(), ['video-camera'], { flags: { fitBiggest: true } });
    expect(out.error).toBeNull();
    expect(out.asked).toEqual([]);
    expect([...fake.sessions.values()].map((s) => s.name)).toEqual(['400.mp4', '300.mp4']);
    expect(loadReport(db, 7)).toMatchObject({ copied: { files: 2, bytes: 700 }, noRoom: { files: 0 } });
    expect(out.logs.join(' ')).toMatch(/2 of 4 files; 2 wait for another account/);
    // Started again later (more room): the rest goes, still biggest first.
    db.prepare("UPDATE places SET identity_json = ? WHERE id = 'g1'").run(JSON.stringify({ email: 'a@example.com', quotaLimit: 100_000, quotaUsage: 0 }));
    fake.accounts[0]!.quota = { limit: '100000', usage: '0', usageInDrive: '0', usageInDriveTrash: '0' };
    const again = await runJob(make(), ['video-camera'], { flags: { fitBiggest: true }, jobId: 8 });
    expect(again.error).toBeNull();
    expect([...fake.sessions.values()].map((s) => s.name)).toEqual(['400.mp4', '300.mp4', '200.mp4', '100.mp4']);
  });

  it('sends only into the ticked accounts', async () => {
    addAccount('g1', 'a@example.com', 1000, 0);
    addAccount('g2', 'b@example.com', 1_000_000, 0);
    for (const [i, s] of sizes.entries()) addT7({ rel: `v/${s}.mp4`, size: s, kind: 'video-camera', seed: i + 1 });
    const out = await runJob(make(), ['video-camera'], { accounts: ['g1'], flags: { fitBiggest: true } });
    expect(out.error).toBeNull();
    expect(googleRows('g2')).toEqual([]);
    expect(googleRows('g1')).toHaveLength(2);
  });
});

describe('repeats from older phone backups are counted once', () => {
  it('the capacity screen counts each content once and says how many repeats there are; the run sends each once', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    // The same picture in three dated folders of the backup, and one different picture.
    addT7({ rel: '2026-09/Screenshots/s1.png', size: 3000, seed: 7, kind: 'photo-screenshot' });
    addT7({ rel: '2026-10/Screenshots/s1.png', size: 3000, seed: 7, kind: 'photo-screenshot' });
    addT7({ rel: '2026-11/Screenshots/s1.png', size: 3000, seed: 7, kind: 'photo-screenshot' });
    addT7({ rel: '2026-11/Screenshots/s2.png', size: 2000, seed: 8, kind: 'photo-screenshot' });
    const m = make();
    const r = await m.service.preview(5);
    if (!r.ok) throw new Error(r.message);
    expect(r.preview.kinds.map((k) => [k.kind, k.files, k.bytes, k.toGoFiles, k.toGoBytes, k.repeatFiles])).toEqual([['photo-screenshot', 2, 5000, 2, 5000, 2]]);
    const plan = await m.service.plan({ backupId: 5, kinds: ['photo-screenshot'], accountIds: ['g1'] });
    expect(plan).toMatchObject({ ok: true, plan: { toPlaceFiles: 2, toPlaceBytes: 5000 } });
    const started = await m.service.start(startReq({ kinds: ['photo-screenshot'] }));
    expect(started.ok).toBe(true);
    expect(created[0]!.title).toMatch(/\(2 files, /);
    const out = await runJob(m, ['photo-screenshot']);
    expect(out.error).toBeNull();
    expect(uploads()).toBe(2);
    expect(out.progress.at(-1)).toMatchObject({ done: 2, total: 2 }); // "2 of 2", not "4 of 4"
    expect(loadReport(db, 7)).toMatchObject({ copied: { files: 2, bytes: 5000 }, repeats: 2, alreadyThere: 0 });
    // Later, a repeat of something already in Google is not a "repeat of this copy": it is simply there already.
    addT7({ rel: '2026-12/Screenshots/s1.png', size: 3000, seed: 7, kind: 'photo-screenshot' });
    const second = await runJob(m, ['photo-screenshot'], { jobId: 8 });
    expect(second.error).toBeNull();
    expect(uploads()).toBe(2);
    expect(loadReport(db, 8)).toMatchObject({ copied: { files: 0 }, repeats: 0 });
  });
});


describe('safe pause: the upload carries on after the app was closed', () => {
  const FILE = CHUNK * 4;
  /** The start byte of every chunk the fake was sent (status questions are not chunks). */
  const putStarts = (): number[] =>
    fake.calls.filter((c) => c.method === 'PUT' && c.path === '/upload/drive/v3/files').flatMap((c) => {
      const m = /bytes (\d+)-/.exec(c.headers['Content-Range'] ?? '');
      return m ? [Number(m[1])] : [];
    });
  const uploadIdOf = (uri: string): string => new URL(uri).searchParams.get('upload_id') ?? '';
  type Cp = { inFlight: { key: number; accountId: string; sessionUri: string; size: number; sent: number }[] };
  /** Closes the app (the run ends) once Google has confirmed this many chunks; the clock moves so the checkpoint is written with every chunk. */
  const closeAfter = (chunks: number) => async (): Promise<void> => {
    clock += 5000;
    if (putStarts().length >= chunks) throw new JobAborted();
  };

  it('keeps the session and the confirmed bytes of the file on its way in the checkpoint', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    const f = addT7({ rel: 'DCIM/Camera/big.mp4', size: FILE, kind: 'video-camera' });
    const first = await runJob(make(), ['video-camera'], { yieldFn: closeAfter(2) });
    expect(first.error).toBeInstanceOf(JobAborted);
    const cp = first.checkpoint as Cp;
    expect(cp.inFlight).toHaveLength(1);
    expect(cp.inFlight[0]).toMatchObject({ key: f.id, accountId: 'g1', size: FILE, sent: CHUNK * 2 });
    expect(uploadIdOf(cp.inFlight[0]!.sessionUri)).not.toBe('');
    expect(fake.sessions.has(uploadIdOf(cp.inFlight[0]!.sessionUri))).toBe(true);
  });

  it('after a restart it asks Google how far it got, sends only the rest, and the checksums are right (nothing is sent twice)', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    const f = addT7({ rel: 'DCIM/Camera/big.mp4', size: FILE, kind: 'video-camera' });
    const first = await runJob(make(), ['video-camera'], { yieldFn: closeAfter(2) });
    expect(googleRows('g1')).toHaveLength(0);
    expect(putStarts()).toEqual([0, CHUNK]);
    chunkReads.length = 0;
    hashCalls = 0;
    const second = await runJob(make(), ['video-camera'], { resume: first.checkpoint });
    expect(second.error).toBeNull();
    expect(uploads()).toBe(1); // no new session: the saved one was used
    expect(putStarts()).toEqual([0, CHUNK, CHUNK * 2, CHUNK * 3]); // only the missing chunks went out in the second part
    // The part Google had was read again from the T7 only to work out the checksums.
    expect(chunkReads.map((c) => c.offset)).toEqual([0, CHUNK, CHUNK * 2, CHUNK * 3]);
    expect(hashCalls).toBe(0); // no whole-file fallback read
    const rows = googleRows('g1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sha256: sha(f.data), md5: md5(f.data), size: FILE, origin_file_id: f.id, verified_how: 'google-md5' });
    expect(fake.stored.get(rows[0]!.ext_id)!.equals(f.data)).toBe(true);
    expect((second.checkpoint as Cp).inFlight).toEqual([]);
    expect(loadReport(db, 7)).toMatchObject({ copied: { files: 1, bytes: FILE }, stopped: false });
  });

  it('after a restart the bytes Google already held are not progress or speed of this part: they leave the total', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    addT7({ rel: 'DCIM/Camera/big.mp4', size: FILE, kind: 'video-camera' });
    const first = await runJob(make(), ['video-camera'], { yieldFn: closeAfter(2) });
    const second = await runJob(make(), ['video-camera'], { resume: first.checkpoint });
    expect(second.error).toBeNull();
    for (const p of second.progress) expect(p.bytesDone ?? 0).toBeLessThanOrEqual(p.confirmed);
    expect(second.progress.at(-1)).toMatchObject({ bytesDone: CHUNK * 2, bytesTotal: CHUNK * 2 }); // only the two chunks sent in this part
    expect(Math.max(...second.progress.map((p) => p.bytesTotal ?? 0))).toBeLessThanOrEqual(FILE);
  });

  it('Google already has the whole file when the app opens again: nothing is sent, the file is read once to check it, and it is recorded', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    const f = addT7({ rel: 'DCIM/Camera/big.mp4', size: FILE, kind: 'video-camera' });
    const first = await runJob(make(), ['video-camera'], { yieldFn: closeAfter(2) });
    const session = fake.sessions.get(uploadIdOf((first.checkpoint as Cp).inFlight[0]!.sessionUri))!;
    // The rest reached Google while the app was closing.
    session.chunks.push(f.data.subarray(session.received));
    session.received = session.total;
    (fake as unknown as { finish(s: unknown): void }).finish(session);
    const before = putStarts().length;
    const second = await runJob(make(), ['video-camera'], { resume: first.checkpoint });
    expect(second.error).toBeNull();
    expect(putStarts().length).toBe(before);
    expect(uploads()).toBe(1);
    expect(googleRows('g1')).toHaveLength(1);
    expect(googleRows('g1')[0]).toMatchObject({ sha256: sha(f.data), md5: md5(f.data) });
  });

  it('a session Google forgot (404) starts that file fresh; the checks are the same', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    const f = addT7({ rel: 'DCIM/Camera/big.mp4', size: FILE, kind: 'video-camera' });
    const first = await runJob(make(), ['video-camera'], { yieldFn: closeAfter(2) });
    fake.forgetSession(uploadIdOf((first.checkpoint as Cp).inFlight[0]!.sessionUri));
    const second = await runJob(make(), ['video-camera'], { resume: first.checkpoint });
    expect(second.error).toBeNull();
    expect(uploads()).toBe(2); // a new session
    expect(putStarts().slice(2)).toEqual([0, CHUNK, CHUNK * 2, CHUNK * 3]); // the whole file again
    const rows = googleRows('g1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sha256: sha(f.data), md5: md5(f.data) });
    expect(fake.stored.get(rows[0]!.ext_id)!.equals(f.data)).toBe(true);
  });

  it('a saved upload whose size no longer matches the file is not used: that file starts fresh', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    addT7({ rel: 'DCIM/Camera/big.mp4', size: FILE, kind: 'video-camera' });
    const first = await runJob(make(), ['video-camera'], { yieldFn: closeAfter(2) });
    const cp = JSON.parse(JSON.stringify(first.checkpoint)) as Cp;
    const oldId = uploadIdOf(cp.inFlight[0]!.sessionUri);
    cp.inFlight[0]!.size += 1;
    const statusCallsBefore = fake.calls.filter((c) => c.method === 'PUT' && c.query['upload_id'] === oldId).length;
    const second = await runJob(make(), ['video-camera'], { resume: cp });
    expect(second.error).toBeNull();
    expect(uploads()).toBe(2);
    expect(fake.calls.filter((c) => c.method === 'PUT' && c.query['upload_id'] === oldId).length).toBe(statusCallsBefore); // the old session was not touched
    expect(googleRows('g1')).toHaveLength(1);
  });

  it('the file goes back into the SAME account when it still has room (room reserved again)', async () => {
    addAccount('g1', 'g1@example.com', FILE * 4, 0); // room: 75% of 4 MiB = 3 MiB
    addAccount('g2', 'g2@example.com', 100_000_000, 0);
    addT7({ rel: 'DCIM/Camera/big.mp4', size: FILE, kind: 'video-camera' });
    const first = await runJob(make(), ['video-camera'], { yieldFn: closeAfter(2) });
    expect((first.checkpoint as Cp).inFlight[0]!.accountId).toBe('g1'); // the account with the least room that fits
    const again = await runJob(make(), ['video-camera'], { resume: first.checkpoint });
    expect(again.error).toBeNull();
    expect(googleRows('g1')).toHaveLength(1);
    expect(googleRows('g2')).toHaveLength(0);
    expect(uploads()).toBe(1); // the saved session, no new one
  });

  it('when that account has no room any more the file starts fresh in another ticked account and the old session is left alone', async () => {
    const g1 = addAccount('g1', 'g1@example.com', FILE * 4, 0);
    addAccount('g2', 'g2@example.com', 100_000_000, 0);
    const f = addT7({ rel: 'DCIM/Camera/big.mp4', size: FILE, kind: 'video-camera' });
    const first = await runJob(make(), ['video-camera'], { yieldFn: closeAfter(2) });
    const cp = first.checkpoint as Cp;
    expect(cp.inFlight[0]!.accountId).toBe('g1');
    g1.quota = { ...g1.quota, usage: String(FILE * 3) }; // g1 filled up while the app was closed: no room left under the 75% line
    const oldId = uploadIdOf(cp.inFlight[0]!.sessionUri);
    const putsToOld = (): number => fake.calls.filter((c) => c.method === 'PUT' && c.query['upload_id'] === oldId).length;
    const before = putsToOld();
    const second = await runJob(make(), ['video-camera'], { resume: cp });
    expect(second.error).toBeNull();
    expect(putsToOld()).toBe(before);
    expect(googleRows('g1')).toHaveLength(0);
    const rows = googleRows('g2');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sha256: sha(f.data), md5: md5(f.data) });
    expect(fake.stored.get(rows[0]!.ext_id)!.equals(f.data)).toBe(true);
  });

  it('a Pause saves the place first (session and exact offset), whatever the throttle says', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    addT7({ rel: 'DCIM/Camera/big.mp4', size: FILE, kind: 'video-camera' });
    let hold: (() => void | Promise<void>) | null = null;
    // The clock does not move, so the normal throttle writes nothing after the session start; the pause save must.
    const out = await runJob(make(), ['video-camera'], {
      onBeforeHold: (save) => (hold = save),
      yieldFn: async () => {
        if (putStarts().length === 3) {
          await hold!();
          throw new JobAborted(); // the app is closed while the job is held
        }
      },
    });
    expect(out.error).toBeInstanceOf(JobAborted);
    const cp = out.checkpoint as Cp;
    expect(cp.inFlight).toHaveLength(1);
    expect(cp.inFlight[0]).toMatchObject({ sent: CHUNK * 3, size: FILE });
  });

  it('Stop drops the files on their way from the checkpoint (abrupt, as today) and the session addresses are not kept', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    addT7({ rel: 'DCIM/Camera/big.mp4', size: FILE, kind: 'video-camera' });
    const first = await runJob(make(), ['video-camera'], { yieldFn: closeAfter(2) });
    const kept = make().handler.onStop!(first.checkpoint) as Cp & { copied: unknown };
    expect(kept.inFlight).toEqual([]);
    expect(kept.copied).toEqual((first.checkpoint as { copied: unknown }).copied); // the counts stay
    expect(JSON.stringify(kept)).not.toContain('upload_id');
  });

  it('session addresses never reach the log or the warnings', async () => {
    addAccount('g1', 'a@example.com', 100_000_000, 0);
    addT7({ rel: 'DCIM/Camera/big.mp4', size: FILE, kind: 'video-camera' });
    const first = await runJob(make(), ['video-camera'], { yieldFn: closeAfter(2) });
    const second = await runJob(make(), ['video-camera'], { resume: first.checkpoint });
    for (const line of [...first.logs, ...first.warns, ...second.logs, ...second.warns]) {
      expect(line).not.toContain('upload_id');
      expect(line).not.toContain('googleapis.com/upload');
    }
    expect(second.logs.some((l) => /where Google has it/.test(l))).toBe(true);
  });
});
