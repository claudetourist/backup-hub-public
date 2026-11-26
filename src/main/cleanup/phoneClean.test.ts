import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeButtonText, type CleanDestination, type PhoneCleanJobParams, type PhoneCleanPlan } from '../../shared/cleanup';
import type { PhoneDevice } from '../../shared/phone';
import { closeDatabase, initDatabase, type Db } from '../db';
import { JobAborted, JobFailure, type JobContext } from '../jobs/jobService';
import type { AdbCleanPort } from './adbClean';
import { hashConfirmed } from '../danger';
import { phoneConfirmed } from './phoneCleanJob';
import { parseSize, statSizeCommand } from './adbClean';
import { removeCommand } from '../danger/adbRm';
import { CleanStore } from './cleanStore';
import { CleanupService } from './cleanupService';
import { diskSizeFor } from './diskAccess';
import { phoneCleanHandler, putBackHandler } from './phoneCleanJob';
import { buildPhoneCleanPlan, type PhoneCleanPlannerDeps } from './phoneCleanPlanner';
import { listCommand, sha256Command } from '../adb/phoneModel';
import { phoneCleanDestinations } from './phoneRule';
import { phoneFoldersFor } from './cleanupService';
import { recheckDestinationVouchers } from './safety';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = Date.now();

/** A phone made of a temporary folder (remote /sdcard/x is <phone>/x). The real adb is never run by these tests. */
class FakeCleanAdb implements AdbCleanPort {
  devicesList: PhoneDevice[] = [{ serial: 'S1', model: 'POCO F4', state: 'device' }];
  commands: string[] = [];
  removed: string[] = [];
  pushed: string[] = [];
  killed = 0;
  failRemove = new Set<string>();
  corruptPush = new Set<string>();
  beforeRemove: (remote: string) => void = () => {};
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
  listFiles(_serial: string, folders: readonly string[]): Promise<{ path: string; size: number; mtimeSec: number }[]> {
    const out: { path: string; size: number; mtimeSec: number }[] = [];
    for (const folder of folders) {
      this.commands.push(listCommand(folder));
      const walk = (dir: string, remote: string): void => {
        if (!fs.existsSync(dir)) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) walk(path.join(dir, e.name), `${remote}/${e.name}`);
          else {
            const st = fs.statSync(path.join(dir, e.name));
            out.push({ path: `${remote}/${e.name}`, size: st.size, mtimeSec: Math.floor(st.mtimeMs / 1000) });
          }
        }
      };
      walk(this.local(folder), folder);
    }
    return Promise.resolve(out);
  }
  sha256(_serial: string, remotePath: string): Promise<string | null> {
    this.commands.push(sha256Command(remotePath));
    const f = this.local(remotePath);
    return Promise.resolve(fs.existsSync(f) ? createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null);
  }
  pull(): Promise<void> {
    throw new Error('pull is not used by clean up');
  }
  statSize(_serial: string, remotePath: string): Promise<number | null> {
    this.commands.push(statSizeCommand(remotePath));
    const f = this.local(remotePath);
    return Promise.resolve(fs.existsSync(f) ? fs.statSync(f).size : null);
  }
  remove(_serial: string, remotePath: string): Promise<void> {
    this.commands.push(removeCommand(remotePath));
    this.beforeRemove(remotePath);
    if (this.failRemove.has(remotePath)) return Promise.reject(new Error('Permission denied'));
    this.removed.push(remotePath);
    fs.rmSync(this.local(remotePath));
    return Promise.resolve();
  }
  push(_serial: string, localPath: string, remotePath: string): Promise<void> {
    this.commands.push(`push ${remotePath}`);
    const dest = this.local(remotePath);
    if (fs.existsSync(dest)) return Promise.reject(new Error('exists'));
    const data = fs.readFileSync(localPath);
    if (this.corruptPush.has(remotePath)) data[0] = (data[0]! + 1) % 256;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    this.pushed.push(remotePath);
    return Promise.resolve();
  }
  killServer(): Promise<void> {
    this.killed += 1;
    return Promise.resolve();
  }
}

let dir: string;
let phoneDir: string;
let drive: string;
let db: Db;
let adb: FakeCleanAdb;
let plugged: boolean;

const baseOf = (placeId: string): Promise<string | null> => Promise.resolve(placeId === 't7' && plugged ? drive : null);
const plannerDeps = (): PhoneCleanPlannerDeps => ({ db, adb, baseOf, diskSize: diskSizeFor(db, baseOf), now: () => NOW, yieldNow: () => Promise.resolve() });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-clean-'));
  phoneDir = path.join(dir, 'phone');
  drive = path.join(dir, 'T7');
  fs.mkdirSync(path.join(phoneDir, 'DCIM', 'Camera'), { recursive: true });
  fs.mkdirSync(drive, { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  adb = new FakeCleanAdb(phoneDir);
  plugged = true;
  const opened = initDatabase(path.join(dir, 'data'), silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  const ins = db.prepare('INSERT INTO places (id, profile_id, kind, label, identity_json, status, last_looked_at, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, 1)');
  ins.run('t7', 'drive', 'T7', '{}', 'connected', NOW - 1000);
  ins.run('g1', 'gdrive', 'Google 1', '{}', 'connected', NOW - 1000);
  ins.run('od', 'onedrive', 'OneDrive', '{}', 'connected', NOW - 1000);
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

const content = (size: number, seed: string): Buffer => {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i += 32) createHash('sha256').update(`${seed}:${i}`).digest().copy(b, i, 0, Math.min(32, size - i));
  return b;
};
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex');

interface Made {
  remote: string;
  data: Buffer;
  t7Rel: string;
  t7Abs: string;
}

/** A phone file and (optionally) its copy on the T7 and in the cloud, with catalog rows. */
function makeFile(name: string, size: number, opts: { t7?: boolean; cloud?: 'g1' | 'od' | null; seed?: string } = {}): Made {
  const data = content(size, opts.seed ?? name);
  const remote = `/sdcard/DCIM/Camera/${name}`;
  fs.writeFileSync(path.join(phoneDir, 'DCIM', 'Camera', name), data);
  const t7Rel = `BackupHub/Phone/POCO F4/DCIM/Camera/${name}`;
  const t7Abs = path.join(drive, ...t7Rel.split('/'));
  const row = db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, hashed_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)');
  if (opts.t7 !== false) {
    fs.mkdirSync(path.dirname(t7Abs), { recursive: true });
    fs.writeFileSync(t7Abs, data);
    row.run('t7', t7Rel, size, Math.trunc(fs.statSync(t7Abs).mtimeMs), sha(data), md5(data), 1);
  }
  if (opts.cloud === 'g1' || opts.cloud === undefined) row.run('g1', `Backup Hub/Phone/${name}`, size, null, null, md5(data), 1);
  if (opts.cloud === 'od') row.run('od', `Pictures/${name}`, size, 1, sha(data), md5(data), 1);
  return { remote, data, t7Rel, t7Abs };
}

async function makePlan(): Promise<PhoneCleanPlan> {
  const r = await buildPhoneCleanPlan(plannerDeps(), 'S1');
  if (!r.ok) throw new Error(r.message);
  return r.plan;
}

/** Adds the confirmed-list fields the service adds when a job is made (unless the test gives its own). */
function withList(params: unknown): unknown {
  const p = params as { serial?: unknown; files?: unknown; listHash?: unknown } | null;
  if (p === null || typeof p !== 'object' || typeof p.serial !== 'string' || !Array.isArray(p.files) || p.listHash !== undefined) return params;
  return { ...p, listId: 'test-list', listHash: hashConfirmed(phoneConfirmed(p.serial, p.files as PhoneCleanJobParams['files'])) };
}

function ctxFor(rawParams: unknown, abortAfterYields = Infinity): { ctx: JobContext; warns: string[]; logs: string[] } {
  const params = withList(rawParams);
  const warns: string[] = [];
  const logs: string[] = [];
  let yields = 0;
  const ctx: JobContext = {
    jobId: 7,
    params,
    resume: null,
    signal: new AbortController().signal,
    progress: () => {},
    log: (_l, t) => void logs.push(t),
    warn: (t) => void warns.push(t),
    needsYou: () => Promise.resolve('continue'),
    checkpoint: () => {},
    yield: () => {
      yields += 1;
      return yields > abortAfterYields ? Promise.reject(new JobAborted()) : Promise.resolve();
    },
  };
  return { ctx, warns, logs };
}

const text = (r: unknown): string => (typeof r === 'string' ? r : '');
const handlerDeps = () => ({ db, log: silent, adb, baseOf, diskSize: diskSizeFor(db, baseOf), now: () => NOW });
const paramsOf = (plan: PhoneCleanPlan, names: string[]) => ({
  serial: 'S1',
  model: 'POCO F4',
  files: plan.files.filter((f) => names.includes(f.name)).map((f) => ({ path: f.path, size: f.size, sha256: f.sha256!, vouchers: f.vouchers })),
});

describe('adb commands', () => {
  it('has exactly one-file rm and stat, and refuses unsafe paths', () => {
    expect(removeCommand('/sdcard/DCIM/Camera/a.jpg')).toBe("rm '/sdcard/DCIM/Camera/a.jpg'");
    expect(statSizeCommand('/sdcard/DCIM/Camera/a.jpg')).toBe("stat -c %s '/sdcard/DCIM/Camera/a.jpg'");
    for (const bad of ['/sdcard', '/sdcard/DCIM', '/sdcard/DCIM/', "/sdcard/DCIM/a'; rm -rf /; '", '/data/a/b', '/sdcard/DCIM/../x', '/sdcard/a.jpg']) {
      expect(() => removeCommand(bad), bad).toThrow();
    }
    expect(parseSize('1234\n')).toBe(1234);
    expect(parseSize('stat: no such file')).toBeNull();
  });
});

describe('the plan', () => {
  it('sorts files into safe, waiting and only-on-phone, and fingerprints only same-size candidates', async () => {
    makeFile('safe.jpg', 4096);
    makeFile('waiting.jpg', 4100, { cloud: null });
    fs.writeFileSync(path.join(phoneDir, 'DCIM', 'Camera', 'only.jpg'), content(5000, 'only'));
    const plan = await makePlan();
    expect(plan.safe).toEqual({ files: 1, bytes: 4096 });
    expect(plan.waiting).toEqual({ files: 1, bytes: 4100 });
    expect(plan.onlyOnPhone).toEqual({ files: 1, bytes: 5000 });
    expect(plan.files.map((f) => `${f.name}:${f.verdict}`)).toEqual(['safe.jpg:safe', 'waiting.jpg:waiting']);
    expect(adb.commands.some((c) => c.includes('only.jpg'))).toBe(false);
    expect(plan.files[0]!.vouchers.map((v) => v.placeKind)).toEqual(['drive', 'gdrive']);
    expect(plan.files[0]!.month).toMatch(/^\d{4}-\d{2}$/);
    expect(adb.commands.filter((c) => c.startsWith('rm')).length).toBe(0);
  });

  it('a OneDrive copy also makes a file safe', async () => {
    makeFile('od.jpg', 4096, { cloud: 'od' });
    expect((await makePlan()).safe.files).toBe(1);
  });

  it('a same-named file with different content is not matched', async () => {
    const m = makeFile('x.jpg', 4096);
    fs.writeFileSync(m.t7Abs, content(4096, 'other'));
    db.prepare("UPDATE files SET sha256 = ?, md5 = ? WHERE place_id = 't7'").run(sha(content(4096, 'other')), md5(content(4096, 'other')));
    const plan = await makePlan();
    expect(plan.safe.files).toBe(0);
    expect(plan.onlyOnPhone.files).toBe(1);
  });

  it('a place not looked at in 24 hours makes the files stale and names the place', async () => {
    makeFile('a.jpg', 4096);
    db.prepare("UPDATE places SET last_looked_at = ? WHERE id = 't7'").run(NOW - 25 * 3600 * 1000);
    const plan = await makePlan();
    expect(plan.safe.files).toBe(0);
    expect(plan.stale.files).toBe(1);
    expect(plan.stalePlaces.map((p) => p.label)).toEqual(['T7']);
  });

  it('an unplugged T7 or a Google account never checked is stale', async () => {
    makeFile('a.jpg', 4096);
    plugged = false;
    expect((await makePlan()).stale.files).toBe(1);
    plugged = true;
    db.prepare("UPDATE places SET last_looked_at = NULL WHERE id = 'g1'").run();
    const p = await makePlan();
    expect(p.stale.files).toBe(1);
    expect(p.stalePlaces.map((s) => s.label)).toEqual(['Google 1']);
  });

  it('a T7 copy missing on the disk is stale, not safe', async () => {
    const m = makeFile('a.jpg', 4096);
    fs.rmSync(m.t7Abs);
    expect((await makePlan()).safe.files).toBe(0);
  });

  it('remembers fingerprints and respects the limit per plan', async () => {
    makeFile('a.jpg', 4096);
    makeFile('b.jpg', 4097);
    const cache = new Map<string, string | null>();
    await buildPhoneCleanPlan({ ...plannerDeps(), cache }, 'S1');
    const first = adb.commands.filter((c) => c.startsWith('sha256sum')).length;
    await buildPhoneCleanPlan({ ...plannerDeps(), cache }, 'S1');
    expect(adb.commands.filter((c) => c.startsWith('sha256sum')).length).toBe(first);
  });

  it('says plainly when the phone is not ready', async () => {
    adb.devicesList = [{ serial: 'S1', model: 'POCO F4', state: 'unauthorized' }];
    const r = await buildPhoneCleanPlan(plannerDeps(), 'S1');
    expect(r.ok).toBe(false);
  });
});

describe('the service start rules', () => {
  const created: { kind: string; title: string; params: unknown }[] = [];
  let t = NOW;
  const service = (): CleanupService =>
    new CleanupService({
      db,
      phone: plannerDeps(),
      laptop: { db, oneDriveRoots: () => [], driveRoots: () => Promise.resolve([]) },
      jobs: { create: (kind, title, params) => (created.push({ kind, title, params }), created.length), list: () => [] },
      now: () => t,
    });
  beforeEach(() => {
    created.length = 0;
    t = NOW;
  });

  it('the phone is let go after the plan is made, and when the plan fails', async () => {
    makeFile('a.jpg', 4096);
    expect((await service().phonePlan('S1', 'camera')).ok).toBe(true);
    expect(adb.killed).toBe(1);
    adb.devicesList = [];
    expect((await service().phonePlan('S1', 'camera')).ok).toBe(false);
    expect(adb.killed).toBe(2);
  });

  it('starts only with confirm, a known plan and hash, and the exact count and size', async () => {
    makeFile('a.jpg', 4096);
    makeFile('b.jpg', 4100);
    const svc = service();
    const r = await svc.phonePlan('S1');
    if (!r.ok) throw new Error(r.message);
    const plan = r.plan;
    const base = { planId: plan.id, hash: plan.hash, indexes: [0, 1], expectCount: 2, expectBytes: 8196 };
    expect(svc.phoneStart({ ...base, confirmed: false }).ok).toBe(false);
    expect(svc.phoneStart({ ...base, confirmed: 'yes' }).ok).toBe(false);
    expect(svc.phoneStart({ ...base, hash: 'x', confirmed: true }).ok).toBe(false);
    expect(svc.phoneStart({ ...base, planId: 'nope', confirmed: true }).ok).toBe(false);
    expect(svc.phoneStart({ ...base, expectCount: 3, confirmed: true }).ok).toBe(false);
    expect(svc.phoneStart({ ...base, expectBytes: 1, confirmed: true }).ok).toBe(false);
    expect(svc.phoneStart({ ...base, indexes: [], confirmed: true }).ok).toBe(false);
    expect(svc.phoneStart(null).ok).toBe(false);
    expect(created).toHaveLength(0);
    const ok = svc.phoneStart({ ...base, confirmed: true });
    expect(ok.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]!.kind).toBe('clean.phone');
    expect(svc.phoneStart({ ...base, confirmed: true }).ok).toBe(false); // one plan, one start
  });

  it('refuses a plan older than 30 minutes and a waiting file', async () => {
    makeFile('a.jpg', 4096);
    makeFile('w.jpg', 4100, { cloud: null });
    const svc = service();
    const r = await svc.phonePlan('S1');
    if (!r.ok) throw new Error(r.message);
    const w = r.plan.files.find((f) => f.verdict === 'waiting')!;
    expect(svc.phoneStart({ planId: r.plan.id, hash: r.plan.hash, indexes: [w.index], expectCount: 1, expectBytes: 4100, confirmed: true }).ok).toBe(false);
    t = NOW + 31 * 60 * 1000;
    expect(svc.phoneStart({ planId: r.plan.id, hash: r.plan.hash, indexes: [0], expectCount: 1, expectBytes: 4096, confirmed: true }).ok).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('the button text carries the count and size', () => {
    expect(removeButtonText(12, 3_400_000_000)).toBe('Remove 12 files (3.4 GB)');
    expect(removeButtonText(1, 5_000_000)).toBe('Remove 1 file (5 MB)');
  });
});

describe('the removal job', () => {
  it('removes exactly the ticked files, locks the vouching copies, logs, and stops adb', async () => {
    makeFile('a.jpg', 4096);
    makeFile('b.jpg', 4100);
    makeFile('c.jpg', 4200);
    const plan = await makePlan();
    adb.commands.length = 0;
    const { ctx } = ctxFor(paramsOf(plan, ['a.jpg', 'b.jpg']));
    const result = await phoneCleanHandler(handlerDeps()).run(ctx);
    expect(text(result)).toContain('Removed 2 files');
    expect(fs.existsSync(path.join(phoneDir, 'DCIM', 'Camera', 'a.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(phoneDir, 'DCIM', 'Camera', 'b.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(phoneDir, 'DCIM', 'Camera', 'c.jpg'))).toBe(true);
    expect(adb.removed).toEqual(['/sdcard/DCIM/Camera/a.jpg', '/sdcard/DCIM/Camera/b.jpg']);
    expect(adb.commands.filter((c) => c.startsWith('rm ')).toSorted()).toEqual(["rm '/sdcard/DCIM/Camera/a.jpg'", "rm '/sdcard/DCIM/Camera/b.jpg'"]);
    expect(adb.killed).toBe(1);
    const store = new CleanStore(db, () => NOW);
    expect(store.activeLocks()).toHaveLength(4); // T7 + Google copy for each of 2 files
    const log = db.prepare('SELECT kind, path, sha256, vouchers_json FROM removal_log ORDER BY id').all() as { kind: string; path: string; sha256: string; vouchers_json: string }[];
    expect(log.map((l) => l.path)).toEqual(['/sdcard/DCIM/Camera/a.jpg', '/sdcard/DCIM/Camera/b.jpg']);
    expect(log[0]!.vouchers_json).toContain('T7');
    // The T7 copy files themselves are untouched.
    expect(fs.existsSync(path.join(drive, 'BackupHub', 'Phone', 'POCO F4', 'DCIM', 'Camera', 'a.jpg'))).toBe(true);
  });

  it('skips a file whose content changed on the phone (same size, other fingerprint) and removes the rest', async () => {
    const a = makeFile('a.jpg', 4096);
    makeFile('b.jpg', 4100);
    const plan = await makePlan();
    fs.writeFileSync(adb.local(a.remote), content(4096, 'changed'));
    const { ctx, warns } = ctxFor(paramsOf(plan, ['a.jpg', 'b.jpg']));
    const result = await phoneCleanHandler(handlerDeps()).run(ctx);
    expect(text(result)).toContain('Removed 1 file');
    expect(adb.removed).toEqual(['/sdcard/DCIM/Camera/b.jpg']);
    expect(warns.join(' ')).toContain('checksum on the phone changed');
    expect(fs.existsSync(adb.local(a.remote))).toBe(true);
  });

  it('skips a file whose size changed or that vanished from the phone', async () => {
    const a = makeFile('a.jpg', 4096);
    const b = makeFile('b.jpg', 4100);
    const plan = await makePlan();
    fs.appendFileSync(adb.local(a.remote), 'x');
    fs.rmSync(adb.local(b.remote));
    const { ctx } = ctxFor(paramsOf(plan, ['a.jpg', 'b.jpg']));
    await expect(phoneCleanHandler(handlerDeps()).run(ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(adb.removed).toEqual([]);
  });

  it('skips when a vouching copy changed in Backup Hub\'s list after the plan', async () => {
    makeFile('a.jpg', 4096);
    makeFile('b.jpg', 4100);
    const plan = await makePlan();
    db.prepare("UPDATE files SET sha256 = ? WHERE place_id = 't7' AND rel_path LIKE '%a.jpg'").run('f'.repeat(64));
    const { ctx, warns } = ctxFor(paramsOf(plan, ['a.jpg', 'b.jpg']));
    await phoneCleanHandler(handlerDeps()).run(ctx);
    expect(adb.removed).toEqual(['/sdcard/DCIM/Camera/b.jpg']);
    expect(warns.join(' ')).toContain('checksum of the copy on T7 changed');
  });

  it('skips when the cloud copy disappeared or the T7 copy is gone from the drive', async () => {
    const a = makeFile('a.jpg', 4096);
    makeFile('b.jpg', 4100);
    makeFile('c.jpg', 4200);
    const plan = await makePlan();
    db.prepare("UPDATE files SET gone_at = 5 WHERE place_id = 'g1' AND rel_path LIKE '%b.jpg'").run();
    fs.rmSync(a.t7Abs);
    const { ctx } = ctxFor(paramsOf(plan, ['a.jpg', 'b.jpg', 'c.jpg']));
    await phoneCleanHandler(handlerDeps()).run(ctx);
    expect(adb.removed).toEqual(['/sdcard/DCIM/Camera/c.jpg']);
  });

  it('refuses everything once a vouching place has gone stale (24 h) or the T7 is unplugged', async () => {
    makeFile('a.jpg', 4096);
    const plan = await makePlan();
    db.prepare("UPDATE places SET last_looked_at = ? WHERE id = 'g1'").run(NOW - 26 * 3600 * 1000);
    const { ctx, warns } = ctxFor(paramsOf(plan, ['a.jpg']));
    await expect(phoneCleanHandler(handlerDeps()).run(ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(warns.join(' ')).toContain('Check it first');
    db.prepare("UPDATE places SET last_looked_at = ? WHERE id = 'g1'").run(NOW);
    plugged = false;
    const again = ctxFor(paramsOf(plan, ['a.jpg']));
    await expect(phoneCleanHandler(handlerDeps()).run(again.ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(adb.removed).toEqual([]);
    expect(db.prepare('SELECT count(*) AS n FROM removal_log').get()).toEqual({ n: 0 });
  });

  it('a mismatch between the re-check and the removal (changed while fingerprinting) never removes', async () => {
    makeFile('a.jpg', 4096);
    const plan = await makePlan();
    // The T7 row changes just before rm is reached (the second re-check catches it only if it ran after the fingerprint).
    const params = paramsOf(plan, ['a.jpg']);
    const realSha = adb.sha256.bind(adb);
    adb.sha256 = async (s: string, p: string) => {
      const r = await realSha(s, p);
      db.prepare("UPDATE files SET sha256 = ? WHERE place_id = 't7'").run('e'.repeat(64));
      return r;
    };
    const { ctx } = ctxFor(params);
    await expect(phoneCleanHandler(handlerDeps()).run(ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(adb.removed).toEqual([]);
  });

  it('a phone that refuses rm leaves the file and takes the log line back', async () => {
    const a = makeFile('a.jpg', 4096);
    makeFile('b.jpg', 4100);
    const plan = await makePlan();
    adb.failRemove.add(a.remote);
    const { ctx, warns } = ctxFor(paramsOf(plan, ['a.jpg', 'b.jpg']));
    await phoneCleanHandler(handlerDeps()).run(ctx);
    expect(fs.existsSync(adb.local(a.remote))).toBe(true);
    expect(warns.join(' ')).toContain('would not remove');
    expect((db.prepare('SELECT path FROM removal_log').all() as { path: string }[]).map((r) => r.path)).toEqual(['/sdcard/DCIM/Camera/b.jpg']);
  });

  it('rejects odd params: no files, bad path, bad fingerprint, a set with no cloud voucher', async () => {
    makeFile('a.jpg', 4096);
    const plan = await makePlan();
    const good = paramsOf(plan, ['a.jpg']);
    await expect(phoneCleanHandler(handlerDeps()).run(ctxFor({ serial: 'S1', files: [] }).ctx)).rejects.toBeInstanceOf(JobFailure);
    const bads = [
      { ...good, files: [{ ...good.files[0]!, path: '/sdcard/DCIM' }] },
      { ...good, files: [{ ...good.files[0]!, sha256: 'zz' }] },
      { ...good, files: [{ ...good.files[0]!, vouchers: [good.files[0]!.vouchers[0]!] }] },
      { ...good, files: [{ ...good.files[0]!, vouchers: [] }] },
    ];
    for (const params of bads) await expect(phoneCleanHandler(handlerDeps()).run(ctxFor(params).ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(adb.removed).toEqual([]);
  });

  it('refuses a list that is not the confirmed one, and a copy that no longer has its checksum when it is read again now', async () => {
    const made = makeFile('a.jpg', 4096);
    const plan = await makePlan();
    const good = paramsOf(plan, ['a.jpg']);
    for (const bad of [{ ...good, listHash: '0'.repeat(64) }, { ...good, listHash: null }, { ...good, listId: null, listHash: hashConfirmed(phoneConfirmed('S1', good.files)) }]) {
      await expect(phoneCleanHandler(handlerDeps()).run(ctxFor(bad).ctx)).rejects.toThrow(/not the one that was confirmed/);
    }
    expect(adb.removed).toEqual([]);
    // The T7 copy is damaged after the plan, same size: the catalog still says it is fine, the fresh read says it is not.
    fs.writeFileSync(made.t7Abs, Buffer.alloc(made.data.length, 1));
    const { ctx, warns } = ctxFor(good);
    await expect(phoneCleanHandler(handlerDeps()).run(ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(warns.join(' ')).toContain('surviving copies');
    expect(adb.removed).toEqual([]);
    expect(db.prepare("SELECT outcome FROM danger_log WHERE action = 'adb-rm'").all()).toEqual([{ outcome: 'refused' }]);
  });

  it('stops at once when cancelled and still stops adb', async () => {
    makeFile('a.jpg', 4096);
    makeFile('b.jpg', 4100);
    const plan = await makePlan();
    const { ctx } = ctxFor(paramsOf(plan, ['a.jpg', 'b.jpg']), 0);
    await expect(phoneCleanHandler(handlerDeps()).run(ctx)).rejects.toBeInstanceOf(JobAborted);
    expect(adb.removed).toEqual([]);
    expect(adb.killed).toBe(1);
  });

  it('refuses without a ready phone', async () => {
    makeFile('a.jpg', 4096);
    const plan = await makePlan();
    adb.devicesList = [];
    await expect(phoneCleanHandler(handlerDeps()).run(ctxFor(paramsOf(plan, ['a.jpg'])).ctx)).rejects.toBeInstanceOf(JobFailure);
  });
});

describe('put back on phone', () => {
  async function removeOne(name: string): Promise<{ made: Made; plan: PhoneCleanPlan }> {
    const made = makeFile(name, 4096);
    const plan = await makePlan();
    await phoneCleanHandler(handlerDeps()).run(ctxFor(paramsOf(plan, [name])).ctx);
    return { made, plan };
  }
  const logId = (): number => (db.prepare('SELECT id FROM removal_log ORDER BY id DESC LIMIT 1').get() as { id: number }).id;

  it('copies the file back from the T7 and checks it', async () => {
    const { made } = await removeOne('a.jpg');
    expect(fs.existsSync(adb.local(made.remote))).toBe(false);
    const { ctx } = ctxFor({ serial: 'S1', removalIds: [logId()] });
    const result = await putBackHandler(handlerDeps()).run(ctx);
    expect(text(result)).toContain('Put 1 file back');
    expect(fs.readFileSync(adb.local(made.remote))).toEqual(made.data);
    expect((db.prepare('SELECT undone_at FROM removal_log').get() as { undone_at: number | null }).undone_at).not.toBeNull();
    expect(adb.killed).toBe(2);
  });

  it('does nothing when the T7 is not plugged in, the T7 copy changed, or a different file is on the phone', async () => {
    const { made } = await removeOne('a.jpg');
    plugged = false;
    await expect(putBackHandler(handlerDeps()).run(ctxFor({ serial: 'S1', removalIds: [logId()] }).ctx)).rejects.toBeInstanceOf(JobFailure);
    plugged = true;
    fs.writeFileSync(made.t7Abs, content(4096, 'tampered'));
    await expect(putBackHandler(handlerDeps()).run(ctxFor({ serial: 'S1', removalIds: [logId()] }).ctx)).rejects.toBeInstanceOf(JobFailure);
    fs.writeFileSync(made.t7Abs, made.data);
    fs.writeFileSync(adb.local(made.remote), 'something else');
    await expect(putBackHandler(handlerDeps()).run(ctxFor({ serial: 'S1', removalIds: [logId()] }).ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(fs.readFileSync(adb.local(made.remote), 'utf8')).toBe('something else');
    expect(adb.pushed).toEqual([]);
  });

  it('removes its own bad copy when what arrived does not match', async () => {
    const { made } = await removeOne('a.jpg');
    adb.corruptPush.add(made.remote);
    await expect(putBackHandler(handlerDeps()).run(ctxFor({ serial: 'S1', removalIds: [logId()] }).ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(fs.existsSync(adb.local(made.remote))).toBe(false);
    expect((db.prepare('SELECT undone_at FROM removal_log').get() as { undone_at: number | null }).undone_at).toBeNull();
  });

  it('only puts back removed phone files (not unknown ids), and the service checks them', async () => {
    await removeOne('a.jpg');
    const svc = new CleanupService({ db, phone: plannerDeps(), laptop: { db, oneDriveRoots: () => [], driveRoots: () => Promise.resolve([]) }, jobs: { create: () => 1, list: () => [] }, now: () => NOW });
    expect(svc.putBack({ serial: 'S1', removalIds: [logId()], confirmed: false }).ok).toBe(false);
    expect(svc.putBack({ serial: 'S1', removalIds: [999], confirmed: true }).ok).toBe(false);
    expect(svc.putBack({ serial: 'S1', removalIds: [], confirmed: true }).ok).toBe(false);
    expect(svc.putBack({ serial: 'S1', removalIds: [logId()], confirmed: true }).ok).toBe(true);
  });
});

describe('locks', () => {
  it('stay for 30 days and then end', async () => {
    makeFile('a.jpg', 4096);
    const plan = await makePlan();
    await phoneCleanHandler(handlerDeps()).run(ctxFor(paramsOf(plan, ['a.jpg'])).ctx);
    expect(new CleanStore(db, () => NOW + 29 * 86_400_000).activeLocks()).toHaveLength(2);
    expect(new CleanStore(db, () => NOW + 31 * 86_400_000).activeLocks()).toHaveLength(0);
  });
});

describe('no retry of a removal', () => {
  it('a finished clean-up job cannot be retried: it must be planned and confirmed again', async () => {
    const { JobService } = await import('../jobs/jobService');
    const service = new JobService({ db, log: silent, now: () => NOW });
    try {
      service.register({ kind: 'clean.phone', heavy: true, resumable: false, run: () => Promise.reject(new JobFailure('nothing')) });
      service.start();
      const id = service.create('clean.phone', 'Free up space', { serial: 'S1', files: [] });
      for (let i = 0; i < 100 && service.list({ states: ['failed'] }).length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(service.list({ states: ['failed'] })).toHaveLength(1);
      expect(() => service.retry(id)).toThrow(/cannot be retried/);
    } finally {
      service.shutdown();
    }
  });
});

// ---- Batch 10a: the Phone backup rule (every place of the backup must hold a verified copy) ---------------------------------

describe('the Phone backup rule', () => {
  let sg: string;
  let folder: string;
  let pluggedSg: boolean;
  let dests: CleanDestination[];
  const baseOfAll = (placeId: string): Promise<string | null> => Promise.resolve(placeId === 't7' && plugged ? drive : placeId === 'sg' && pluggedSg ? sg : null);
  const deps = (): PhoneCleanPlannerDeps => ({ db, adb, baseOf: baseOfAll, diskSize: diskSizeFor(db, baseOfAll), now: () => NOW, yieldNow: () => Promise.resolve(), destinations: () => dests });
  const handler = () => phoneCleanHandler({ db, log: silent, adb, baseOf: baseOfAll, diskSize: diskSizeFor(db, baseOfAll), now: () => NOW, destinations: () => dests });
  const T7_DEST: CleanDestination = { id: 1, kind: 'drive', label: 'T7', placeId: 't7', accounts: [], folder: null };
  const SG_DEST: CleanDestination = { id: 2, kind: 'drive', label: 'Seagate2TB', placeId: 'sg', accounts: [], folder: null };
  const G_DEST: CleanDestination = { id: 3, kind: 'google', label: 'Google', placeId: null, accounts: ['g1'], folder: null };
  const folderDest = (): CleanDestination => ({ id: 4, kind: 'laptop', label: 'Laptop folder', placeId: null, accounts: [], folder });

  beforeEach(() => {
    sg = path.join(dir, 'SG');
    folder = path.join(dir, 'laptop-folder');
    fs.mkdirSync(sg, { recursive: true });
    fs.mkdirSync(folder, { recursive: true });
    pluggedSg = true;
    db.prepare('INSERT INTO places (id, profile_id, kind, label, identity_json, status, last_looked_at, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, 1)').run('sg', 'drive', 'Seagate2TB', '{}', 'connected', NOW - 1000);
    dests = [T7_DEST, SG_DEST];
  });

  /** A copy of the phone file on the second drive (a catalog row with both fingerprints, and the file itself). */
  function onSeagate(m: Made, name: string): void {
    const rel = `BackupHub/Phone/POCO F4/DCIM/Camera/${name}`;
    const abs = path.join(sg, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, m.data);
    db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, hashed_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)').run('sg', rel, m.data.length, Math.trunc(fs.statSync(abs).mtimeMs), sha(m.data), md5(m.data));
  }
  const plan = async (): Promise<PhoneCleanPlan> => {
    const r = await buildPhoneCleanPlan(deps(), 'S1');
    if (!r.ok) throw new Error(r.message);
    return r.plan;
  };

  it('is safe only when EVERY place holds it: T7 alone makes a file wait, T7 and Seagate make it safe', async () => {
    const both = makeFile('both.jpg', 4096, { cloud: null });
    onSeagate(both, 'both.jpg');
    makeFile('t7only.jpg', 4100, { cloud: null });
    const p = await plan();
    expect(p.requires).toEqual(['T7', 'Seagate2TB']);
    expect(p.files.map((f) => `${f.name}:${f.verdict}`)).toEqual(['both.jpg:safe', 't7only.jpg:waiting']);
    expect(p.files[0]!.vouchers.map((v) => [v.placeLabel, v.destinationId])).toEqual([
      ['T7', 1],
      ['Seagate2TB', 2],
    ]);
    expect(p.files[1]!.reason).toContain('Seagate2TB');
  });

  it('the old "T7 and cloud" rule is gone for this backup: a Google copy alone does not matter when Seagate is missing', async () => {
    makeFile('g.jpg', 4096); // T7 + Google, no Seagate
    const p = await plan();
    expect(p.safe.files).toBe(0);
    expect(p.waiting.files).toBe(1);
  });

  it('a Google place needs its own copy in one of its accounts (MD5 and size of a verified copy)', async () => {
    dests = [T7_DEST, G_DEST];
    makeFile('has-google.jpg', 4096);
    makeFile('no-google.jpg', 4100, { cloud: null });
    const p = await plan();
    expect(p.files.map((f) => `${f.name}:${f.verdict}`)).toEqual(['has-google.jpg:safe', 'no-google.jpg:waiting']);
    expect(p.files[0]!.vouchers.map((v) => v.placeKind)).toEqual(['drive', 'gdrive']);
  });

  it('a place that is not plugged in or not looked at for 24 hours makes the file stale, never safe', async () => {
    const m = makeFile('a.jpg', 4096, { cloud: null });
    onSeagate(m, 'a.jpg');
    pluggedSg = false;
    expect((await plan()).stale.files).toBe(1);
    pluggedSg = true;
    db.prepare("UPDATE places SET last_looked_at = ? WHERE id = 'sg'").run(NOW - 25 * 3600 * 1000);
    const p = await plan();
    expect(p.stale.files).toBe(1);
    expect(p.stalePlaces.map((s) => s.label)).toEqual(['Seagate2TB']);
  });

  it('a backup with no place to copy to has nothing that is safe', async () => {
    makeFile('a.jpg', 4096);
    dests = [];
    const p = await plan();
    expect(p.safe.files).toBe(0);
    expect(p.onlyOnPhone.files).toBe(1);
  });

  it('a laptop folder holds a copy only when a file there has the same size and the same SHA-256 (hashed now)', async () => {
    dests = [T7_DEST, folderDest()];
    const good = makeFile('good.jpg', 4096, { cloud: null });
    fs.mkdirSync(path.join(folder, 'BackupHub', 'Phone'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'BackupHub', 'Phone', 'good.jpg'), good.data);
    makeFile('bad.jpg', 4100, { cloud: null });
    fs.writeFileSync(path.join(folder, 'BackupHub', 'Phone', 'bad.jpg'), content(4100, 'different')); // same size, other content
    const p = await plan();
    expect(p.files.map((f) => `${f.name}:${f.verdict}`)).toEqual(['good.jpg:safe', 'bad.jpg:waiting']);
    const v = p.files[0]!.vouchers.find((x) => x.placeKind === 'folder')!;
    expect(v.relPath).toBe(path.join(folder, 'BackupHub', 'Phone', 'good.jpg'));
    expect(v.destinationId).toBe(4);
  });

  it('the job removes a safe file with a folder copy (no lock row for the folder), and checks the folder file again', async () => {
    dests = [T7_DEST, folderDest()];
    const a = makeFile('a.jpg', 4096, { cloud: null });
    const b = makeFile('b.jpg', 4100, { cloud: null });
    fs.writeFileSync(path.join(folder, 'a.jpg'), a.data);
    fs.writeFileSync(path.join(folder, 'b.jpg'), b.data);
    const p = await plan();
    expect(p.safe.files).toBe(2);
    fs.writeFileSync(path.join(folder, 'b.jpg'), content(4100, 'rotted')); // the folder copy goes bad after the plan
    const { ctx, warns } = ctxFor(paramsOf(p, ['a.jpg', 'b.jpg']));
    const result = await handler().run(ctx);
    expect(text(result)).toContain('Removed 1 file');
    expect(adb.removed).toEqual(['/sdcard/DCIM/Camera/a.jpg']);
    expect(warns.join(' ')).toContain('does not match the checksum');
    expect(new CleanStore(db, () => NOW).activeLocks()).toHaveLength(1); // only T7's copy of a.jpg; a laptop folder is not in the catalog
  });

  it('a place added to the backup after the plan makes the job skip the file', async () => {
    const a = makeFile('a.jpg', 4096, { cloud: null });
    onSeagate(a, 'a.jpg');
    const p = await plan();
    expect(p.safe.files).toBe(1);
    dests = [T7_DEST, SG_DEST, G_DEST]; // Google was added: it holds no copy
    const { ctx, warns } = ctxFor(paramsOf(p, ['a.jpg']));
    await expect(handler().run(ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(warns.join(' ')).toContain('Google does not hold a verified copy');
    expect(adb.removed).toEqual([]);
  });

  it('removes when every place still holds it', async () => {
    const a = makeFile('a.jpg', 4096, { cloud: null });
    onSeagate(a, 'a.jpg');
    const { ctx } = ctxFor(paramsOf(await plan(), ['a.jpg']));
    expect(text(await handler().run(ctx))).toContain('Removed 1 file');
    expect(new CleanStore(db, () => NOW).activeLocks()).toHaveLength(2);
  });

  // ---- Batch 12: the Start rule (T7 AND Seagate AND Google, current Backups layout) ----

  describe('the Start rule', () => {
    /** A copy on a drive at `rel` (a catalog row with both fingerprints, and the file itself). */
    function putOn(placeId: 't7' | 'sg', m: Made, rel: string): void {
      const root = placeId === 't7' ? drive : sg;
      const abs = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, m.data);
      db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, hashed_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)').run(placeId, rel, m.data.length, Math.trunc(fs.statSync(abs).mtimeMs), sha(m.data), md5(m.data));
    }
    const NEW_T7 = (name: string): string => `Backups/Phone/POCO F4/DCIM/Camera/${name}`;
    beforeEach(() => {
      dests = phoneCleanDestinations(db);
    });

    it('the places are the T7, the Seagate and Google, found by name', () => {
      expect(dests.map((d) => [d.kind, d.label, d.placeId, d.backupsLayout ?? false])).toEqual([
        ['drive', 'T7', 't7', true],
        ['drive', 'Seagate2TB', 'sg', true],
        ['google', 'Google', null, false],
      ]);
      expect(dests[2]!.accounts).toEqual(['g1']);
    });

    it('is safe with a copy on the T7, on the Seagate and in Google, all as the plan describes', async () => {
      const m = makeFile('ok.jpg', 4096, { t7: false });
      putOn('t7', m, NEW_T7('ok.jpg'));
      putOn('sg', m, NEW_T7('ok.jpg'));
      const p = await plan();
      expect(p.files.map((f) => `${f.name}:${f.verdict}`)).toEqual(['ok.jpg:safe']);
      expect(p.files[0]!.vouchers.map((v) => v.placeLabel)).toEqual(['T7', 'Seagate2TB', 'Google 1']);
    });

    it.each([
      ['no copy on the T7', { t7: false, sg: true, google: true }],
      ['no copy on the Seagate', { t7: true, sg: false, google: true }],
      ['no copy in Google', { t7: true, sg: true, google: false }],
    ])('%s: the file waits and is never offered', async (_name, have) => {
      const m = makeFile('w.jpg', 4096, { t7: false, cloud: have.google ? 'g1' : null });
      if (have.t7) putOn('t7', m, NEW_T7('w.jpg'));
      if (have.sg) putOn('sg', m, NEW_T7('w.jpg'));
      const p = await plan();
      expect(p.safe.files).toBe(0);
      expect(p.files.map((f) => f.verdict)).toEqual(['waiting']);
    });

    it('a copy in the old BackupHub/Phone folder or in _old-versions does not count', async () => {
      const m = makeFile('old.jpg', 4096); // T7 copy in the old layout, Google copy
      putOn('sg', m, NEW_T7('old.jpg'));
      expect((await plan()).safe.files).toBe(0);
      putOn('t7', m, `Backups/_old-versions/Phone/POCO F4/DCIM/Camera/old.jpg.2026-11-09_1630`);
      expect((await plan()).safe.files).toBe(0);
      putOn('t7', m, NEW_T7('old.jpg'));
      expect((await plan()).safe.files).toBe(1);
    });

    it('a Seagate copy that is gone or has another size is stale or waiting, never safe', async () => {
      const m = makeFile('x.jpg', 4096, { t7: false });
      putOn('t7', m, NEW_T7('x.jpg'));
      putOn('sg', m, NEW_T7('x.jpg'));
      fs.writeFileSync(path.join(sg, ...NEW_T7('x.jpg').split('/')), 'cut');
      const p = await plan();
      expect(p.safe.files).toBe(0);
      expect(p.stale.files).toBe(1);
    });

    it('the job checks the layout again: a voucher outside Backups fails the re-check', () => {
      const v = (placeLabel: string, relPath: string, destinationId: number) => ({ placeId: 'x', placeLabel, placeKind: 'drive', relPath, size: 1, sha256: 'a', md5: 'b', destinationId });
      const never = () => ({ row: null, lastLookedAt: null });
      const outside = recheckDestinationVouchers([v('T7', 'BackupHub/Phone/a.jpg', 1), v('Seagate2TB', NEW_T7('a.jpg'), 2)], dests.slice(0, 2), never, NOW);
      expect(outside).toEqual({ ok: false, reason: 'The copy on T7 is not in the Backups folder.' });
    });

    it('the camera folder is offered first: its own plan holds only DCIM, the other plan the rest', () => {
      expect(phoneFoldersFor('camera')).toEqual(['/sdcard/DCIM']);
      expect(phoneFoldersFor('others')).not.toContain('/sdcard/DCIM');
      expect(phoneFoldersFor('others')!.length).toBeGreaterThan(3);
      expect(phoneFoldersFor(undefined)).toBeUndefined();
    });

    it('files removed from the phone never cause a red error or a drive change', async () => {
      const m = makeFile('gone.jpg', 4096, { t7: false });
      putOn('t7', m, NEW_T7('gone.jpg'));
      putOn('sg', m, NEW_T7('gone.jpg'));
      const before = db.prepare('SELECT count(*) FROM files WHERE gone_at IS NULL').pluck().get();
      const { ctx } = ctxFor(paramsOf(await plan(), ['gone.jpg']));
      expect(text(await handler().run(ctx))).toContain('Removed 1 file');
      expect(db.prepare('SELECT count(*) FROM start_errors').pluck().get()).toBe(0);
      expect(db.prepare('SELECT count(*) FROM files WHERE gone_at IS NULL').pluck().get()).toBe(before);
      expect(fs.existsSync(path.join(drive, ...NEW_T7('gone.jpg').split('/')))).toBe(true);
      expect(fs.existsSync(path.join(sg, ...NEW_T7('gone.jpg').split('/')))).toBe(true);
    });
  });
});
