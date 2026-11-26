/**
 * A small world for the Free up phone space tests: a real database in a temp folder, a phone made of a temp folder, two drives made of temp
 * folders (T7 and Seagate2TB), and Google as the fake Google behind the real `DriveGoogleAsk`. The real adb and the real Google are never used.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PhoneDevice } from '../../shared/phone';
import { closeDatabase, initDatabase, type Db } from '../db';
import { JobAborted, type JobContext } from '../jobs/jobService';
import { GoogleAuth, type GoogleVault } from '../google/auth';
import { FakeAccount, FakeGoogle } from '../google/fakeGoogle.testutil';
import { GoogleHttp } from '../google/googleHttp';
import type { Sha256Batch } from '../adb/phoneModel';
import { removeCommand, removeManyCommand, type RemoveManyItem, type RemoveManyStatus } from '../danger/adbRm';
import { scanMediaCommands } from '../cleanup/adbClean';
import { DriveGoogleAsk } from './googleAsk';
import { FreeUpResults, type DriveHash, type FreeUpAdb, type FreeUpDeps, type HashFile } from './freeUpCheck';
import type { FreeUpRemoveDeps } from './freeUpRemove';

export const silent = { info: () => {}, warn: () => {}, error: () => {} };
export const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
export const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex');
export const content = (size: number, seed: string): Buffer => {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i += 32) createHash('sha256').update(`${seed}:${i}`).digest().copy(b, i, 0, Math.min(32, size - i));
  return b;
};

/** A phone made of a temporary folder (remote /sdcard/x is <phone>/x). */
export class FakePhoneAdb implements FreeUpAdb {
  devicesList: PhoneDevice[] = [{ serial: 'S1', model: 'POCO F4', state: 'device' }];
  removed: string[] = [];
  pushed: string[] = [];
  scanned: string[] = [];
  shaCalls = 0;
  batches: string[][] = [];
  killed = 0;
  failScan = false;
  beforeRemove: (remote: string) => void = () => {};
  /** Every phone call that reads or changes the phone's files, by method name (one per adb call). */
  adbCalls: string[] = [];
  constructor(readonly root: string) {}
  local(remote: string): string {
    return path.join(this.root, ...remote.split('/').slice(2));
  }
  available(): boolean {
    return true;
  }
  devices(): Promise<PhoneDevice[]> {
    return Promise.resolve(this.devicesList);
  }
  listCalls: string[][] = [];
  /** Like the phone's find: every file below the folders, with the phone's own paths. */
  listFiles(_serial: string, folders: readonly string[]): Promise<{ path: string; size: number; mtimeSec: number }[]> {
    this.listCalls.push([...folders]);
    const out: { path: string; size: number; mtimeSec: number }[] = [];
    const walk = (remote: string): void => {
      const local = this.local(remote);
      if (!fs.existsSync(local)) return;
      for (const e of fs.readdirSync(local, { withFileTypes: true })) {
        const r = `${remote}/${e.name}`;
        if (e.isDirectory()) walk(r);
        else {
          const st = fs.statSync(this.local(r));
          out.push({ path: r, size: st.size, mtimeSec: Math.floor(st.mtimeMs / 1000) });
        }
      }
    };
    for (const f of folders) walk(f);
    return Promise.resolve(out);
  }
  sha256(_serial: string, remotePath: string): Promise<string | null> {
    this.shaCalls += 1;
    this.adbCalls.push('sha256');
    const f = this.local(remotePath);
    return Promise.resolve(fs.existsSync(f) ? sha(fs.readFileSync(f)) : null);
  }
  sha256Many(_serial: string, remotePaths: readonly string[]): Promise<Sha256Batch> {
    this.batches.push([...remotePaths]);
    this.adbCalls.push('sha256Many');
    const answers: Sha256Batch['answers'] = new Map();
    for (const p of remotePaths) {
      const f = this.local(p);
      answers.set(p, fs.existsSync(f) ? { kind: 'sha256', sha256: sha(fs.readFileSync(f)) } : { kind: 'missing' });
    }
    return Promise.resolve({ answers, adbError: null });
  }
  pull(): Promise<void> {
    throw new Error('pull is not used here');
  }
  statSizes(_serial: string, remotePaths: readonly string[]): Promise<(number | null)[]> {
    this.adbCalls.push('statSizes');
    return Promise.resolve(remotePaths.map((p) => (fs.existsSync(this.local(p)) ? fs.statSync(this.local(p)).size : null)));
  }
  /** Like the phone's batch line: for each file in turn, the size is looked at right before its remove. */
  removeMany(_serial: string, items: readonly RemoveManyItem[]): Promise<RemoveManyStatus[]> {
    this.adbCalls.push('removeMany');
    removeManyCommand(items); // the real command builder refuses an unsafe path or size
    return Promise.resolve(
      items.map((i): RemoveManyStatus => {
        this.beforeRemove(i.path);
        const f = this.local(i.path);
        if (!fs.existsSync(f)) return 'missing';
        if (fs.statSync(f).size !== i.size) return 'changed';
        this.removed.push(i.path);
        fs.rmSync(f);
        return 'removed';
      }),
    );
  }
  statSize(_serial: string, remotePath: string): Promise<number | null> {
    this.adbCalls.push('statSize');
    const f = this.local(remotePath);
    return Promise.resolve(fs.existsSync(f) ? fs.statSync(f).size : null);
  }
  remove(_serial: string, remotePath: string): Promise<void> {
    this.adbCalls.push('remove');
    removeCommand(remotePath);
    this.beforeRemove(remotePath);
    this.removed.push(remotePath);
    fs.rmSync(this.local(remotePath));
    return Promise.resolve();
  }
  push(_serial: string, localPath: string, remotePath: string): Promise<void> {
    const dest = this.local(remotePath);
    if (fs.existsSync(dest)) return Promise.reject(new Error('exists'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, fs.readFileSync(localPath));
    this.pushed.push(remotePath);
    return Promise.resolve();
  }
  scanMedia(_serial: string, remotePaths: readonly string[]): Promise<void> {
    this.adbCalls.push('scanMedia');
    scanMediaCommands(remotePaths); // the real command builder refuses an unsafe path
    if (this.failScan) return Promise.reject(new Error('the phone said no'));
    this.scanned.push(...remotePaths);
    return Promise.resolve();
  }
  killServer(): Promise<void> {
    this.killed += 1;
    return Promise.resolve();
  }
}

export type CopyState = 'ok' | 'none' | 'imported' | 'namesize';
export type GoogleState = 'ok' | 'none' | 'unverified';

export interface MadeFile {
  remote: string;
  data: Buffer;
  rowId: number;
  t7Abs: string;
  seaAbs: string;
  googleId: string;
}

export const ROOT = 'MyData/POCO';
/** The date of every phone file the world makes (the index row and the phone's file agree). */
export const PHONE_MTIME_MS = 1_700_000_000_000;

export class FreeUpWorld {
  readonly dir: string;
  readonly phoneDir: string;
  readonly t7: string;
  readonly sea: string;
  readonly db: Db;
  readonly adb: FakePhoneAdb;
  readonly fake = new FakeGoogle();
  readonly account: FakeAccount;
  readonly results = new FreeUpResults();
  plugged = { t7: true, sea: true };
  googleDown = false;
  backupId = 0;
  /** Every file a drive read touched (the reads of the checks). */
  readonly reads: string[] = [];
  onRead: (abs: string) => void = () => {};
  private readonly secrets = new Map<string, string>([
    ['google.clientId', 'client-id-123'],
    ['google.clientSecret', 'GOCSPX-client-secret-abc'],
    ['gdrive.refreshToken.g1', '1//refresh-token-alice'],
  ]);

  constructor() {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-freeup-'));
    this.phoneDir = path.join(this.dir, 'phone');
    this.t7 = path.join(this.dir, 'T7');
    this.sea = path.join(this.dir, 'SEA');
    for (const d of [this.phoneDir, this.t7, this.sea, path.join(this.dir, 'data')]) fs.mkdirSync(d, { recursive: true });
    const opened = initDatabase(path.join(this.dir, 'data'), silent);
    if (!opened.ok) throw new Error('db did not open');
    this.db = opened.db;
    this.adb = new FakePhoneAdb(this.phoneDir);
    this.account = this.fake.add(new FakeAccount('alice@example.com', '1//refresh-token-alice'));
    this.account.folder('fold-1', 'POCO');
    const place = this.db.prepare('INSERT INTO places (id, profile_id, kind, label, identity_json, status, last_looked_at, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, 1)');
    place.run('ph', 'phone', 'POCO F4', '{}', 'connected', 1);
    place.run('t7', 'drive', 'T7', '{}', 'connected', 1);
    place.run('sea', 'drive', 'Seagate2TB', '{}', 'connected', 1);
    place.run('g1', 'gdrive', 'Google 1', JSON.stringify({ email: 'alice@example.com' }), 'connected', 1);
    this.backupId = Number(
      this.db.prepare("INSERT INTO backup_profiles (person_id, name, source_kind, source_place_id, source_root, phone_serial, folder_prefix, change_rule, created_at) VALUES (1, 'POCO F4', 'phone', 'ph', '', 'S1', 'POCO', 'size_and_date', 1)").run().lastInsertRowid,
    );
    const dest = this.db.prepare("INSERT INTO backup_destinations (backup_profile_id, place_id, root, role, position) VALUES (?, ?, ?, ?, ?)");
    dest.run(this.backupId, 't7', ROOT, 'primary', 1);
    dest.run(this.backupId, 'sea', ROOT, 'copy', 2);
  }

  dispose(): void {
    closeDatabase(this.db, silent);
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  baseOf = (placeId: string): Promise<string | null> => Promise.resolve(placeId === 't7' ? (this.plugged.t7 ? this.t7 : null) : placeId === 'sea' ? (this.plugged.sea ? this.sea : null) : null);

  hashFile: HashFile = (abs, opts): Promise<DriveHash> => {
    this.reads.push(abs);
    this.onRead(abs);
    const b = fs.readFileSync(abs);
    return Promise.resolve({ sha256: sha(b), md5: opts.md5 ? md5(b) : null, bytes: b.length });
  };

  private http(): GoogleHttp {
    return new GoogleHttp({ fetchFn: (input, init) => (this.googleDown ? Promise.reject(new TypeError('fetch failed')) : this.fake.fetchFn(input, init)), sleep: () => Promise.resolve() });
  }

  google(): DriveGoogleAsk {
    const vault: GoogleVault = { status: () => ({ state: 'unlocked' }), getSecretText: (name) => this.secrets.get(name) ?? null, putSecret: () => undefined };
    const http = this.http();
    return new DriveGoogleAsk(http, new GoogleAuth(vault, http));
  }

  deps(over: Partial<FreeUpDeps> = {}): FreeUpRemoveDeps {
    return { db: this.db, adb: this.adb, baseOf: this.baseOf, google: this.google(), results: this.results, hashFile: this.hashFile, log: silent, ...over };
  }

  /**
   * A phone file and its copies. `remote` defaults to a camera photo; the copies sit in the backup's folder on each drive.
   * Rows are made like the real backup makes them (origin link, read_both, expected checksum; Google: google-md5).
   */
  make(name: string, size: number, opts: { remote?: string; t7?: CopyState; sea?: CopyState; google?: GoogleState; seed?: string; phoneSha?: boolean } = {}): MadeFile {
    const data = content(size, opts.seed ?? name);
    const remote = opts.remote ?? `/sdcard/DCIM/Camera/${name}`;
    const phoneFile = this.adb.local(remote);
    fs.mkdirSync(path.dirname(phoneFile), { recursive: true });
    fs.writeFileSync(phoneFile, data);
    fs.utimesSync(phoneFile, PHONE_MTIME_MS / 1000, PHONE_MTIME_MS / 1000);
    const ins = this.db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, first_seen_at, last_seen_at, origin_file_id, expected_sha256, verified_at, verified_how, ext_id) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)');
    // Like the real index: phone rows have no leading slash and (usually) no checksum.
    const rowId = Number(ins.run('ph', remote.replace(/^\/+/, ''), size, PHONE_MTIME_MS, opts.phoneSha === true ? sha(data) : null, null, null, null, null, null, null).lastInsertRowid);
    const rel = `${ROOT}/${remote.split('/').slice(2).join('/')}`;
    const drive = (placeId: string, base: string, state: CopyState): string => {
      const abs = path.join(base, ...rel.split('/'));
      if (state === 'none') return abs;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, data);
      const how = state === 'ok' ? 'read_both' : state === 'imported' ? 'imported' : 'name_size';
      ins.run(placeId, rel, size, 1_700_000_000_000, state === 'namesize' ? null : sha(data), null, state === 'imported' ? null : rowId, sha(data), 1, how, null);
      return abs;
    };
    const t7Abs = drive('t7', this.t7, opts.t7 ?? 'ok');
    const seaAbs = drive('sea', this.sea, opts.sea ?? 'ok');
    const googleId = `gid-${name}`;
    const g = opts.google ?? 'ok';
    if (g !== 'none') {
      const grel = `Backup Hub/POCO/${remote.split('/').slice(2).join('/')}`;
      ins.run('g1', grel, size, null, sha(data), md5(data), null, null, 1, g === 'ok' ? 'google-md5' : null, googleId);
      this.db.prepare('INSERT INTO drive_items (place_id, ext_id, parent_ext_id, name, is_folder) VALUES (?, ?, ?, ?, 0)').run('g1', googleId, 'fold-1', name);
      this.account.file(googleId, name, 'fold-1', { size: String(size), md5Checksum: md5(data) });
    }
    return { remote, data, rowId, t7Abs, seaAbs, googleId };
  }
}

export interface Ctx {
  ctx: JobContext;
  warns: string[];
  logs: string[];
  progress: { done: number; total: number; message: string | undefined }[];
}

/** A job context for tests. `abortAfterYields`: the job is stopped at that turn. */
export function ctxFor(params: unknown, options: { abortAfterYields?: number; jobId?: number } = {}): Ctx {
  const warns: string[] = [];
  const logs: string[] = [];
  const progress: Ctx['progress'] = [];
  let yields = 0;
  const abort = options.abortAfterYields ?? Infinity;
  const ctx: JobContext = {
    jobId: options.jobId ?? 7,
    params,
    resume: null,
    signal: new AbortController().signal,
    progress: (done, total, extras) => void progress.push({ done, total, message: extras?.message }),
    log: (_l, t) => void logs.push(t),
    warn: (t) => void warns.push(t),
    needsYou: () => Promise.resolve('continue'),
    checkpoint: () => {},
    yield: () => {
      yields += 1;
      return yields > abort ? Promise.reject(new JobAborted()) : Promise.resolve();
    },
  };
  return { ctx, warns, logs, progress };
}
