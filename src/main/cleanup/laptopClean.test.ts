import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS, type LaptopCleanJobParams, type LaptopCleanPlan } from '../../shared/cleanup';
import { closeDatabase, initDatabase, type Db } from '../db';
import { JobAborted, JobFailure, type JobContext } from '../jobs/jobService';
import { CleanStore } from './cleanStore';
import { CleanupService } from './cleanupService';
import { hashConfirmed } from '../danger';
import { laptopCleanHandler, laptopConfirmed } from './laptopCleanJob';
import { buildLaptopCleanPlan, type LaptopCleanPlannerDeps } from './laptopCleanPlanner';
import { emptyQuarantine, undoLaptopRemoval, type QuarantineDeps } from './quarantine';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = Date.now();

let dir: string;
let docs: string;
let qroot: string;
let db: Db;
let oneDrive: string[];
let driveRoots: string[];

/** Forward-slash absolute path, as the laptop catalog stores it. */
const rel = (...parts: string[]): string => path.join(docs, ...parts).replaceAll('\\', '/');
const quarantine = (): QuarantineDeps => ({ rootFor: () => qroot, now: () => NOW });
const plannerDeps = (): LaptopCleanPlannerDeps => ({ db, oneDriveRoots: () => oneDrive, driveRoots: () => Promise.resolve(driveRoots), now: () => NOW, yieldNow: () => Promise.resolve() });
const text = (r: unknown): string => (typeof r === 'string' ? r : '');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-dups-'));
  docs = path.join(dir, 'laptop');
  qroot = path.join(dir, 'quarantine');
  fs.mkdirSync(docs, { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  oneDrive = [];
  driveRoots = [];
  const opened = initDatabase(path.join(dir, 'data'), silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, status, last_looked_at, created_at) VALUES ('lap', 1, 'laptop', 'This laptop', '{}', 'connected', ?, 1)").run(NOW - 1000);
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

const bytes = (size: number, seed: string): Buffer => {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i += 32) createHash('sha256').update(`${seed}:${i}`).digest().copy(b, i, 0, Math.min(32, size - i));
  return b;
};

/** A real file with its catalog row (fingerprinted). `age` sets the modified time (seconds before now). */
function addFile(parts: string[], seed: string, size = 2048, age = 0): string {
  const abs = path.join(docs, ...parts);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const data = bytes(size, seed);
  fs.writeFileSync(abs, data);
  const t = new Date(NOW - age * 1000);
  fs.utimesSync(abs, t, t);
  const st = fs.statSync(abs);
  db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, hashed_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)').run(
    'lap',
    rel(...parts),
    size,
    Math.trunc(st.mtimeMs),
    createHash('sha256').update(data).digest('hex'),
    createHash('md5').update(data).digest('hex'),
  );
  return abs;
}

const sha = (seed: string, size = 2048): string => createHash('sha256').update(bytes(size, seed)).digest('hex');

async function makePlan(): Promise<LaptopCleanPlan> {
  const r = await buildLaptopCleanPlan(plannerDeps());
  if (!r.ok) throw new Error(r.message);
  return r.plan;
}

/** Adds the confirmed-list fields the service adds when a job is made (unless the test gives its own). */
function withList(params: unknown): unknown {
  const p = params as { files?: unknown; listHash?: unknown } | null;
  if (p === null || typeof p !== 'object' || !Array.isArray(p.files) || p.listHash !== undefined) return params;
  return { ...p, listId: 'test-list', listHash: hashConfirmed(laptopConfirmed(p.files as LaptopCleanJobParams['files'])) };
}

function ctxFor(rawParams: unknown, abortAfterYields = Infinity): { ctx: JobContext; warns: string[] } {
  const params = withList(rawParams);
  const warns: string[] = [];
  let yields = 0;
  const ctx: JobContext = {
    jobId: 9,
    params,
    resume: null,
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
    warn: (t) => void warns.push(t),
    needsYou: () => Promise.resolve('continue'),
    checkpoint: () => {},
    yield: () => {
      yields += 1;
      return yields > abortAfterYields ? Promise.reject(new JobAborted()) : Promise.resolve();
    },
  };
  return { ctx, warns };
}

const jobDeps = () => ({ db, log: silent, quarantine: quarantine(), oneDriveRoots: () => oneDrive, driveRoots: () => Promise.resolve(driveRoots), now: () => NOW });
const handler = () => laptopCleanHandler(jobDeps());
const allFiles = (root: string): string[] =>
  fs.existsSync(root)
    ? fs
        .readdirSync(root, { recursive: true, encoding: 'utf8' })
        .filter((f) => fs.statSync(path.join(root, f)).isFile())
        .toSorted()
    : [];

/** Job params for removing `remove` while keeping `keep` (both relative to the laptop folder). */
function paramsFor(plan: LaptopCleanPlan, keepName: string, removeNames: string[]) {
  const g = plan.groups.find((x) => x.members.some((m) => m.relPath.endsWith(`/${keepName}`)))!;
  const keepM = g.members.find((m) => m.relPath.endsWith(`/${keepName}`))!;
  return {
    files: g.members
      .filter((m) => removeNames.some((n) => m.relPath.endsWith(`/${n}`)))
      .map((m) => ({ relPath: m.relPath, size: g.size, sha256: g.id, mtime: m.mtime, keep: keepM.relPath, keepSize: g.size, keepMtime: keepM.mtime })),
  };
}

describe('the plan', () => {
  it('groups identical files, ignores singles, empty files and different content', async () => {
    addFile(['a', 'x.jpg'], 'same');
    addFile(['b', 'x-copy.jpg'], 'same');
    addFile(['c', 'solo.jpg'], 'solo');
    addFile(['d', 'e1.txt'], 'empty', 0);
    addFile(['d', 'e2.txt'], 'empty', 0);
    addFile(['e', 'n1.jpg'], 'near1');
    addFile(['e', 'n2.jpg'], 'near2');
    const plan = await makePlan();
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({ id: sha('same'), size: 2048, freeable: 2048 });
    expect(plan.total).toEqual({ files: 1, bytes: 2048 });
  });

  it('keeps the copy in a collection, else the oldest, else the shortest path', async () => {
    addFile(['a', 'new.jpg'], 'k1', 2048, 10);
    addFile(['b', 'old.jpg'], 'k1', 2048, 5000);
    expect((await makePlan()).groups[0]!.keep).toBe(rel('b', 'old.jpg'));
    db.prepare("INSERT INTO collections (profile_id, name, tier) VALUES (1, 'Photos', 'important')").run();
    db.prepare("INSERT INTO collection_roots (collection_id, place_id, rel_path) VALUES (1, 'lap', ?)").run(rel('a'));
    const plan = await makePlan();
    expect(plan.groups[0]!.keep).toBe(rel('a', 'new.jpg'));
    expect(plan.groups[0]!.members.find((m) => m.relPath === rel('a', 'new.jpg'))!.collection).toBe('Photos');
  });

  it('shortest path wins a tie', async () => {
    addFile(['aaaa', 'x.jpg'], 'k2', 2048, 100);
    addFile(['b', 'x.jpg'], 'k2', 2048, 100);
    const g = (await makePlan()).groups[0]!;
    expect(g.keep).toBe(rel('b', 'x.jpg'));
  });

  it('protected folders, OneDrive, named drives and locked files are never removable', async () => {
    addFile(['MyData', 'p.jpg'], 'prot');
    addFile(['Documents', 'p.jpg'], 'prot');
    addFile(['OneDrive', 'q.jpg'], 'syn');
    addFile(['Documents', 'q.jpg'], 'syn');
    addFile(['Sync', 'r.jpg'], 'syn2');
    addFile(['Documents', 'r.jpg'], 'syn2');
    addFile(['Locked', 's.jpg'], 'lock');
    addFile(['Documents', 's.jpg'], 'lock');
    oneDrive = [path.join(docs, 'Sync')];
    new CleanStore(db, () => NOW).addLocks([{ placeId: 'lap', placeLabel: 'This laptop', placeKind: 'laptop', relPath: rel('Locked', 's.jpg'), size: 2048, sha256: sha('lock'), md5: null }], 'test');
    const plan = await makePlan();
    const byKeep = (name: string) => plan.groups.find((g) => g.members.some((m) => m.relPath.endsWith(name)))!;
    for (const [folder, file] of [['MyData', 'p.jpg'], ['OneDrive', 'q.jpg'], ['Sync', 'r.jpg'], ['Locked', 's.jpg']] as const) {
      const g = byKeep(`/${folder}/${file}`);
      const m = g.members.find((x) => x.relPath === rel(folder, file))!;
      expect(m.removable, `${folder} must not be removable`).toBe(false);
      expect(m.why).not.toBeNull();
      // the removable copy goes, this one stays whatever the default keeper was
      expect(g.keep).toBe(rel(folder, file));
    }
  });

  it('a group whose copies are all protected is not offered at all', async () => {
    addFile(['MyData', 'a.jpg'], 'allprot');
    addFile(['Archive', 'BackupHub', 'a.jpg'], 'allprot');
    await expect(buildLaptopCleanPlan(plannerDeps())).resolves.toMatchObject({ ok: false });
  });

  it('a laptop not looked at in 24 h gives a stale plan that cannot be started', async () => {
    addFile(['a', 'x.jpg'], 'st');
    addFile(['b', 'x.jpg'], 'st');
    db.prepare("UPDATE places SET last_looked_at = ? WHERE id = 'lap'").run(NOW - 25 * 3600 * 1000);
    const r = await buildLaptopCleanPlan(plannerDeps());
    expect(r.ok && r.plan.stale).toBe(true);
    const created: unknown[] = [];
    const svc = new CleanupService({ db, phone: { db, adb: undefined as never, baseOf: () => Promise.resolve(null), diskSize: () => Promise.resolve(null) }, laptop: plannerDeps(), quarantine: quarantine(), jobs: { create: (...a) => (created.push(a), 1), list: () => [] }, now: () => NOW });
    const plan = await svc.laptopPlan();
    if (!plan.ok) throw new Error(plan.message);
    const g = plan.plan.groups[0]!;
    expect(svc.laptopStart({ planId: plan.plan.id, hash: plan.plan.hash, confirmed: true, expectCount: 1, expectBytes: 2048, groups: [{ id: g.id, keep: g.keep }] }).ok).toBe(false);
    expect(created).toHaveLength(0);
  });
});

describe('the service start rules', () => {
  const created: { kind: string; params: unknown }[] = [];
  const service = (): CleanupService =>
    new CleanupService({ db, phone: { db, adb: undefined as never, baseOf: () => Promise.resolve(null), diskSize: () => Promise.resolve(null) }, laptop: plannerDeps(), quarantine: quarantine(), jobs: { create: (kind, _t, params) => (created.push({ kind, params }), created.length), list: () => [] }, now: () => NOW });
  beforeEach(() => {
    created.length = 0;
  });

  it('needs confirm, a known plan, its hash, a member as keeper and the exact count and size', async () => {
    addFile(['a', 'x.jpg'], 'g1');
    addFile(['b', 'x.jpg'], 'g1');
    addFile(['c', 'x.jpg'], 'g1');
    const svc = service();
    const r = await svc.laptopPlan();
    if (!r.ok) throw new Error(r.message);
    const g = r.plan.groups[0]!;
    const base = { planId: r.plan.id, hash: r.plan.hash, expectCount: 2, expectBytes: 4096, groups: [{ id: g.id, keep: g.keep }] };
    expect(svc.laptopStart({ ...base, confirmed: false }).ok).toBe(false);
    expect(svc.laptopStart({ ...base, hash: 'x', confirmed: true }).ok).toBe(false);
    expect(svc.laptopStart({ ...base, expectCount: 3, confirmed: true }).ok).toBe(false);
    expect(svc.laptopStart({ ...base, expectBytes: 1, confirmed: true }).ok).toBe(false);
    expect(svc.laptopStart({ ...base, groups: [{ id: g.id, keep: '/nowhere/x.jpg' }], confirmed: true }).ok).toBe(false);
    expect(svc.laptopStart({ ...base, groups: [], confirmed: true }).ok).toBe(false);
    expect(created).toHaveLength(0);
    expect(svc.laptopStart({ ...base, confirmed: true }).ok).toBe(true);
    expect(created).toHaveLength(1);
    const params = created[0]!.params as { files: { relPath: string; keep: string }[] };
    expect(params.files).toHaveLength(2);
    expect(params.files.every((f) => f.keep === g.keep && f.relPath !== g.keep)).toBe(true);
    expect(svc.laptopStart({ ...base, confirmed: true }).ok).toBe(false);
  });

  it('the person can switch the copy to keep', async () => {
    addFile(['a', 'x.jpg'], 'g2', 2048, 5000);
    addFile(['b', 'x.jpg'], 'g2', 2048, 10);
    const svc = service();
    const r = await svc.laptopPlan();
    if (!r.ok) throw new Error(r.message);
    const g = r.plan.groups[0]!;
    expect(g.keep).toBe(rel('a', 'x.jpg'));
    const other = g.members.find((m) => m.relPath !== g.keep)!.relPath;
    expect(svc.laptopStart({ planId: r.plan.id, hash: r.plan.hash, confirmed: true, expectCount: 1, expectBytes: 2048, groups: [{ id: g.id, keep: other }] }).ok).toBe(true);
    expect((created[0]!.params as { files: { relPath: string }[] }).files[0]!.relPath).toBe(g.keep);
  });
});

describe('the move job', () => {
  it('moves only the duplicate into the quarantine, keeps the other, deletes nothing and logs it', async () => {
    const keep = addFile(['a', 'x.jpg'], 'm1', 2048, 5000);
    const dup = addFile(['b', 'x.jpg'], 'm1', 2048, 10);
    const other = addFile(['c', 'y.jpg'], 'other');
    const plan = await makePlan();
    const before = allFiles(dir).length;
    const result = await handler().run(ctxFor({ files: paramsFor(plan, 'x.jpg', ['x.jpg']).files.filter((f) => f.relPath === rel('b', 'x.jpg')) }).ctx);
    expect(text(result)).toContain('Moved 1 duplicate');
    expect(fs.existsSync(dup)).toBe(false);
    expect(fs.existsSync(keep)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    const moved = allFiles(qroot).filter((f) => f.endsWith('x.jpg'));
    expect(moved).toHaveLength(1);
    expect(fs.readFileSync(path.join(qroot, moved[0]!)).equals(bytes(2048, 'm1'))).toBe(true);
    expect(allFiles(dir).length).toBe(before); // nothing disappeared: the same number of files, one of them moved
    const log = db.prepare("SELECT path, quarantine_path, sha256 FROM removal_log WHERE kind = 'laptop'").all() as { path: string; quarantine_path: string; sha256: string }[];
    expect(log).toEqual([{ path: rel('b', 'x.jpg'), quarantine_path: path.join(qroot, moved[0]!), sha256: sha('m1') }]);
    expect((db.prepare('SELECT gone_at FROM files WHERE rel_path = ?').get(rel('b', 'x.jpg')) as { gone_at: number | null }).gone_at).not.toBeNull();
    expect(new CleanStore(db, () => NOW).activeLocks().map((l) => l.relPath)).toEqual([rel('a', 'x.jpg')]);
  });

  it('skips a file edited since the last look, a missing keeper and a changed keeper', async () => {
    const keepA = addFile(['a', 'one.jpg'], 'e1', 2048, 5000);
    const dupA = addFile(['b', 'one.jpg'], 'e1', 2048, 10);
    const keepB = addFile(['a', 'two.jpg'], 'e2', 2048, 5000);
    const dupB = addFile(['b', 'two.jpg'], 'e2', 2048, 10);
    const keepC = addFile(['a', 'three.jpg'], 'e3', 2048, 5000);
    const dupC = addFile(['b', 'three.jpg'], 'e3', 2048, 10);
    const plan = await makePlan();
    fs.appendFileSync(dupA, 'edited');
    fs.rmSync(keepB);
    fs.utimesSync(keepC, new Date(), new Date(Date.now() - 99_000));
    const files = [...paramsFor(plan, 'one.jpg', ['one.jpg']).files, ...paramsFor(plan, 'two.jpg', ['two.jpg']).files, ...paramsFor(plan, 'three.jpg', ['three.jpg']).files].filter((f) => f.relPath.includes('/b/'));
    expect(files).toHaveLength(3);
    await expect(handler().run(ctxFor({ files }).ctx)).rejects.toBeInstanceOf(JobFailure);
    expect([dupA, dupB, dupC].every((f) => fs.existsSync(f))).toBe(true);
    expect(allFiles(qroot)).toEqual([]);
    expect(fs.existsSync(keepA)).toBe(true);
  });

  it('refuses protected, OneDrive and locked files even when asked directly', async () => {
    const keepP = addFile(['Documents', 'p.jpg'], 'p1', 2048, 5000);
    const prot = addFile(['MyData', 'p.jpg'], 'p1', 2048, 10);
    const keepO = addFile(['Documents', 'o.jpg'], 'p2', 2048, 5000);
    const syn = addFile(['OneDrive', 'o.jpg'], 'p2', 2048, 10);
    const keepL = addFile(['Documents', 'l.jpg'], 'p3', 2048, 5000);
    const lock = addFile(['Locked', 'l.jpg'], 'p3', 2048, 10);
    new CleanStore(db, () => NOW).addLocks([{ placeId: 'lap', placeLabel: 'x', placeKind: 'laptop', relPath: rel('Locked', 'l.jpg'), size: 2048, sha256: sha('p3'), md5: null }], 'test');
    const mk = (keep: string, removeAbs: string, seed: string) => {
      const st = fs.statSync(removeAbs);
      const k = fs.statSync(keep);
      return { relPath: removeAbs.replaceAll('\\', '/'), size: 2048, sha256: sha(seed), mtime: Math.trunc(st.mtimeMs), keep: keep.replaceAll('\\', '/'), keepSize: 2048, keepMtime: Math.trunc(k.mtimeMs) };
    };
    const files = [mk(keepP, prot, 'p1'), mk(keepO, syn, 'p2'), mk(keepL, lock, 'p3')];
    const { ctx, warns } = ctxFor({ files });
    await expect(handler().run(ctx)).rejects.toBeInstanceOf(JobFailure);
    expect([prot, syn, lock].every((f) => fs.existsSync(f))).toBe(true);
    expect(warns.join(' ')).toContain('MyData');
    expect(warns.join(' ')).toContain('OneDrive');
    expect(warns.join(' ')).toContain('locked');
    expect(warns).toHaveLength(3);
    expect(allFiles(qroot)).toEqual([]);
  });

  it('refuses two names of the same file (hard link) and the kept copy itself', async () => {
    const keep = addFile(['a', 'h.jpg'], 'hl', 2048, 5000);
    const link = path.join(docs, 'b', 'h.jpg');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.linkSync(keep, link);
    const st = fs.statSync(link);
    db.prepare('INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, hashed_at, first_seen_at, last_seen_at) VALUES (?, ?, 2048, ?, ?, ?, 1, 1, 1)').run('lap', rel('b', 'h.jpg'), Math.trunc(st.mtimeMs), sha('hl'), 'x'.repeat(32));
    const k = fs.statSync(keep);
    const files = [
      { relPath: rel('b', 'h.jpg'), size: 2048, sha256: sha('hl'), mtime: Math.trunc(st.mtimeMs), keep: rel('a', 'h.jpg'), keepSize: 2048, keepMtime: Math.trunc(k.mtimeMs) },
      { relPath: rel('a', 'h.jpg'), size: 2048, sha256: sha('hl'), mtime: Math.trunc(k.mtimeMs), keep: rel('a', 'h.jpg'), keepSize: 2048, keepMtime: Math.trunc(k.mtimeMs) },
    ];
    await expect(handler().run(ctxFor({ files }).ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(fs.existsSync(keep) && fs.existsSync(link)).toBe(true);
  });

  it('refuses when the laptop was not checked in 24 h, and when cancelled moves nothing', async () => {
    const keep = addFile(['a', 'x.jpg'], 'f1', 2048, 5000);
    const dup = addFile(['b', 'x.jpg'], 'f1', 2048, 10);
    const plan = await makePlan();
    const params = { files: paramsFor(plan, 'x.jpg', ['x.jpg']).files.filter((f) => f.relPath === rel('b', 'x.jpg')) };
    await expect(handler().run(ctxFor(params, 0).ctx)).rejects.toBeInstanceOf(JobAborted);
    expect(fs.existsSync(dup)).toBe(true);
    db.prepare("UPDATE places SET last_looked_at = ? WHERE id = 'lap'").run(NOW - 25 * 3600 * 1000);
    await expect(handler().run(ctxFor(params).ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(fs.existsSync(dup) && fs.existsSync(keep)).toBe(true);
  });

  it('refuses a list that is not the confirmed one, and a kept copy that no longer has the checksum when read now', async () => {
    const keep = addFile(['a', 'x.jpg'], 'o1', 2048, 5000);
    const dup = addFile(['b', 'x.jpg'], 'o1', 2048, 10);
    const plan = await makePlan();
    const good = paramsFor(plan, 'x.jpg', ['x.jpg']).files.filter((f) => f.relPath === rel('b', 'x.jpg'));
    for (const bad of [{ files: good, listId: 'l', listHash: '0'.repeat(64) }, { files: good, listId: 'l', listHash: null }]) {
      await expect(handler().run(ctxFor(bad).ctx)).rejects.toThrow(/not the one that was confirmed/);
    }
    expect(fs.existsSync(dup)).toBe(true);
    // The kept copy changes after the plan but keeps its size and date: only the fresh read can see it.
    const st = fs.statSync(keep);
    fs.writeFileSync(keep, Buffer.alloc(st.size, 3));
    fs.utimesSync(keep, st.atime, st.mtime);
    const { ctx, warns } = ctxFor({ files: good });
    await expect(handler().run(ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(warns.join(' ')).toContain('surviving copies');
    expect(fs.existsSync(dup)).toBe(true);
  });

  it('rejects odd params', async () => {
    addFile(['a', 'x.jpg'], 'o1');
    await expect(handler().run(ctxFor({ files: [] }).ctx)).rejects.toBeInstanceOf(JobFailure);
    await expect(handler().run(ctxFor({ files: [{ relPath: 'x', keep: 'y', sha256: 'z', size: 1 }] }).ctx)).rejects.toBeInstanceOf(JobFailure);
    await expect(handler().run(ctxFor({ files: [{ relPath: '../../etc/x', keep: rel('a', 'x.jpg'), sha256: sha('o1'), size: 2048, mtime: 1, keepSize: 2048, keepMtime: 1 }] }).ctx)).rejects.toBeInstanceOf(JobFailure);
  });
});

describe('undo and emptying', () => {
  async function moveOne(): Promise<{ dup: string; q: string; id: number }> {
    addFile(['a', 'x.jpg'], 'u1', 2048, 5000);
    const dup = addFile(['b', 'x.jpg'], 'u1', 2048, 10);
    const plan = await makePlan();
    await handler().run(ctxFor({ files: paramsFor(plan, 'x.jpg', ['x.jpg']).files.filter((f) => f.relPath === rel('b', 'x.jpg')) }).ctx);
    const row = db.prepare("SELECT id, quarantine_path AS q FROM removal_log WHERE kind = 'laptop'").get() as { id: number; q: string };
    return { dup, q: row.q, id: row.id };
  }
  const store = (now = NOW): CleanStore => new CleanStore(db, () => now);

  it('Undo puts the file back and Backup Hub\'s list row is live again', async () => {
    const { dup, q, id } = await moveOne();
    const r = await undoLaptopRemoval(quarantine(), store(), id);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(dup).equals(bytes(2048, 'u1'))).toBe(true);
    expect(fs.existsSync(q)).toBe(false);
    expect((db.prepare('SELECT gone_at FROM files WHERE rel_path = ?').get(rel('b', 'x.jpg')) as { gone_at: number | null }).gone_at).toBeNull();
    expect((await undoLaptopRemoval(quarantine(), store(), id)).ok).toBe(false); // already put back
  });

  it('Undo never overwrites and leaves a changed file alone', async () => {
    const { dup, q, id } = await moveOne();
    fs.writeFileSync(dup, 'something new');
    expect((await undoLaptopRemoval(quarantine(), store(), id)).ok).toBe(false);
    expect(fs.readFileSync(dup, 'utf8')).toBe('something new');
    expect(fs.existsSync(q)).toBe(true);
    fs.rmSync(dup);
    fs.appendFileSync(q, 'x');
    expect((await undoLaptopRemoval(quarantine(), store(), id)).ok).toBe(false);
    expect(fs.existsSync(dup)).toBe(false);
  });

  it('Undo refuses a log line whose quarantine path is outside the quarantine', async () => {
    const { id } = await moveOne();
    const outside = path.join(dir, 'elsewhere.jpg');
    fs.writeFileSync(outside, bytes(2048, 'u1'));
    db.prepare('UPDATE removal_log SET quarantine_path = ? WHERE id = ?').run(outside, id);
    expect((await undoLaptopRemoval(quarantine(), store(), id)).ok).toBe(false);
    expect((await emptyQuarantine({ ...quarantine(), now: () => NOW + 40 * DAY_MS }, store(NOW + 40 * DAY_MS), '2000-01-01', 1, 1)).ok).toBe(false);
  });

  it('emptying waits 30 days, needs the exact numbers, and deletes only quarantine files', async () => {
    const { q } = await moveOne();
    const date = db.prepare("SELECT removed_at AS t FROM removal_log").get() as { t: number };
    const day = new Date(date.t);
    const dateText = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    expect((await emptyQuarantine(quarantine(), store(), dateText, 1, 2048)).ok).toBe(false); // too early
    expect(fs.existsSync(q)).toBe(true);
    const late = { ...quarantine(), now: () => NOW + 31 * DAY_MS };
    expect((await emptyQuarantine(late, store(NOW + 31 * DAY_MS), dateText, 2, 2048)).ok).toBe(false);
    expect((await emptyQuarantine(late, store(NOW + 31 * DAY_MS), dateText, 1, 1)).ok).toBe(false);
    expect((await emptyQuarantine(late, store(NOW + 31 * DAY_MS), 'not-a-date', 1, 2048)).ok).toBe(false);
    expect(fs.existsSync(q)).toBe(true);
    const keepFiles = allFiles(path.join(docs)).length;
    const r = await emptyQuarantine(late, store(NOW + 31 * DAY_MS), dateText, 1, 2048);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(q)).toBe(false);
    expect(allFiles(docs).length).toBe(keepFiles); // nothing outside the quarantine was touched
    expect((db.prepare('SELECT emptied_at FROM removal_log').get() as { emptied_at: number | null }).emptied_at).not.toBeNull();
    expect((await emptyQuarantine(late, store(NOW + 31 * DAY_MS), dateText, 1, 2048)).ok).toBe(false); // nothing left
  });

  it('a file changed inside the quarantine is left alone when emptying', async () => {
    const { q } = await moveOne();
    fs.appendFileSync(q, 'x');
    const date = db.prepare('SELECT removed_at AS t FROM removal_log').get() as { t: number };
    const day = new Date(date.t);
    const dateText = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const late = { ...quarantine(), now: () => NOW + 31 * DAY_MS };
    expect((await emptyQuarantine(late, store(NOW + 31 * DAY_MS), dateText, 1, 2048)).ok).toBe(false);
    expect(fs.existsSync(q)).toBe(true);
  });

  it('the overview offers the 30-day question only after 30 days and never by itself', async () => {
    await moveOne();
    const early = store(NOW + 5 * DAY_MS).overview();
    expect(early.quarantine).toHaveLength(1);
    expect(early.quarantine[0]!.canAskToEmpty).toBe(false);
    expect(store(NOW + 31 * DAY_MS).overview().quarantine[0]!.canAskToEmpty).toBe(true);
    expect(early.removals[0]!.canUndo).toBe(false); // the default quarantine root is the real drive root, not the test folder
  });
});

describe('"Also look for duplicates in my C: folders" (off by default)', () => {
  const planWith = async (roots: string[]): Promise<LaptopCleanPlan | null> => {
    const r = await buildLaptopCleanPlan({ ...plannerDeps(), userFolderRoots: () => roots });
    return r.ok ? r.plan : null;
  };

  it('with the setting off, files inside the user folders are never offered for moving and a group of only those is not shown', async () => {
    addFile(['Documents', 'a.jpg'], 'uf');
    addFile(['Pictures', 'b.jpg'], 'uf');
    expect(await planWith([docs])).toBeNull();
    const on = await planWith([]);
    expect(on?.groups).toHaveLength(1);
    expect(on?.groups[0]?.members.every((m) => m.removable)).toBe(true);
  });

  it('a copy outside the user folders can still be moved, and the one inside can only be kept, with a plain reason', async () => {
    const profile = path.join(docs, 'Users', 'me');
    addFile(['Users', 'me', 'Downloads', 'a.jpg'], 'mix', 2048, 5000);
    addFile(['elsewhere', 'a-copy.jpg'], 'mix', 2048, 10);
    const plan = await planWith([profile]);
    expect(plan?.groups).toHaveLength(1);
    const g = plan!.groups[0]!;
    expect(g.keep.endsWith('/Downloads/a.jpg')).toBe(true);
    const inside = g.members.find((m) => m.relPath.endsWith('/Downloads/a.jpg'))!;
    expect(inside.removable).toBe(false);
    expect(inside.why).toContain('Also look for duplicates in my C: folders');
    expect(g.members.find((m) => m.relPath.endsWith('/a-copy.jpg'))?.removable).toBe(true);
  });

  it('the job refuses a file in the user folders even when an old plan offered it (the setting was switched off since)', async () => {
    addFile(['Documents', 'a.jpg'], 'job1', 2048, 5000);
    const dup = addFile(['Documents', 'copy', 'a.jpg'], 'job1', 2048, 10);
    const plan = await makePlan(); // setting on when the plan was made
    const params = paramsFor(plan, 'a.jpg', ['a.jpg']);
    const picked = { files: params.files.filter((f) => f.relPath === rel('Documents', 'copy', 'a.jpg')) };
    const off = laptopCleanHandler({ ...jobDeps(), userFolderRoots: () => [docs] });
    const { ctx, warns } = ctxFor(picked);
    await expect(off.run(ctx)).rejects.toBeInstanceOf(JobFailure);
    expect(warns.join('\n')).toContain('C: folders');
    expect(fs.existsSync(dup)).toBe(true);
    expect(allFiles(qroot)).toEqual([]);
    // With the setting on the same request moves it.
    const on = laptopCleanHandler({ ...jobDeps(), userFolderRoots: () => [] });
    await on.run(ctxFor(picked).ctx);
    expect(fs.existsSync(dup)).toBe(false);
  });
});
