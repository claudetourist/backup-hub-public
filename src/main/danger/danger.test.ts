import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUPS_PARTS, CARD_FILE, CARD_PARTS, DB_COPIES_PARTS, DRIVE_TMP_PARTS, LEGACY_CARD_FOLDER, QUARANTINE_PARTS, SET_ASIDE_PARTS } from '../../shared/appFolders';
import { closeDatabase, initDatabase, type Db } from '../db';
import { setAsideFolder } from '../places/appFolders';
import { parseSizes, statSizesCommand } from '../cleanup/adbClean';
import { DangerRefused, hashConfirmed, runDanger, setAsidePathFor, type ConfirmedEntry, type DangerEnv, type DangerItem, type Survivor } from './index';
import { parseRemoveMany, removeManyCommand } from './adbRm';
import { configureOwnFiles, ownCreateNew, ownMove, ownMoveDb, ownPathProblem, ownRemove, ownRemoveEmptyDir, ownReplace, OwnFilesRefused } from './ownFiles';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const NOW = new Date(2026, 10, 22, 12, 0, 0).getTime();

let dir: string;
let data: string;
let logs: string[];
beforeEach(() => {
  // A name that does not start with "backuphub-", so the test folder is not itself an app-owned place.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-danger-test-'));
  data = path.join(dir, 'data');
  logs = [];
  fs.mkdirSync(path.join(data, 'logs'), { recursive: true });
  configureOwnFiles({ dataDir: data, logsDir: path.join(data, 'logs'), log: (line) => logs.push(line) });
});
afterEach(() => {
  configureOwnFiles({ extraRoots: [os.tmpdir()] }); // back to the test setup
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A path below the test drive folder ("drive/<parts>" for `put`). */
const onDrive = (...parts: readonly string[]): string => ['drive', ...parts].join('/');

const put = (rel: string, text = 'x'): string => {
  const abs = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
};

describe('danger/ownFiles: only the app\'s own files', () => {
  it('accepts paths inside the fixed app-owned places', () => {
    const inside = [
      path.join(dir, 'drive', ...DRIVE_TMP_PARTS, 'a.bhtmp'),
      path.join(dir, 'drive', ...CARD_PARTS, CARD_FILE),
      path.join(dir, 'drive', ...CARD_PARTS, `${CARD_FILE}.tmp`),
      path.join(dir, 'drive', ...DB_COPIES_PARTS, 'backuphub-db-20261122-120000.db'),
      path.join(dir, 'drive', ...DB_COPIES_PARTS, 'Laptop-AppData', 'PC', '2026-11-22', 'x.txt'),
      path.join(dir, 'drive', ...BACKUPS_PARTS, 'Laptop-AppData', 'PC', '2026-11-22'),
      path.join(dir, 'drive', ...BACKUPS_PARTS, 'Laptop-AppData', 'PC', '2026-11-22', 'x.txt'),
      path.join(data, 'logs', 'backuphub.1.log'),
      path.join(data, 'snapshots', 'backuphub-20261122-120000.db'),
      path.join(data, 'restore', 'pending.db'),
      path.join(data, 'import-tmp', 'fleetv1-abc'),
      path.join(data, 'drive-tmp', 'list.jsonl'),
      path.join(data, 'vault-key.bin'),
      path.join(data, 'this-device.json'),
      path.join(os.tmpdir(), 'backuphub-extdb-xyz'),
      path.join(os.tmpdir(), 'backuphub-recovery-xyz', 'copy.db'),
    ];
    for (const p of inside) expect(ownPathProblem(p), p).toBeNull();
  });

  it('refuses everything else: user files, set-aside, the folders themselves, the live database, escapes, roots', () => {
    const outside = [
      path.join(dir, 'drive', 'MyData', 'photo.jpg'),
      path.join(dir, 'drive', 'BackupHub', 'Phone', 'a.jpg'),
      path.join(dir, 'drive', ...BACKUPS_PARTS, 'Reunion', 'a.jpg'), // backups made by the app are user content
      path.join(dir, 'drive', ...QUARANTINE_PARTS, '2026-11-22', 'a.jpg'),
      path.join(dir, 'drive', ...SET_ASIDE_PARTS, '2026-11-22', 'a.jpg'),
      path.join(dir, 'drive', ...DRIVE_TMP_PARTS), // the folder itself
      path.join(dir, 'drive', ...CARD_PARTS),
      path.join(dir, 'drive', ...DB_COPIES_PARTS),
      path.join(dir, 'drive', ...DB_COPIES_PARTS, 'Laptop-AppData'),
      path.join(dir, 'drive', ...BACKUPS_PARTS, 'Laptop-AppData'), // the app data folder itself
      path.join(dir, 'drive', ...BACKUPS_PARTS, 'Laptop-AppData', 'PC'), // one laptop's folder
      path.join(dir, 'drive', ...BACKUPS_PARTS, 'Reunion-Rescue', 'Laptop-AppData', 'PC', 'x.txt'), // a Laptop-AppData folder anywhere else in the backups is user content
      // The old-layout places at a drive root are not on the list any more: nothing is removed or replaced there.
      path.join(dir, 'drive', LEGACY_CARD_FOLDER, 'tmp', 'a.bhtmp'),
      path.join(dir, 'drive', LEGACY_CARD_FOLDER, CARD_FILE),
      path.join(dir, 'drive', 'BackupHub', 'settings', 'backuphub-db-20261122-120000.db'),
      path.join(dir, 'drive', 'Laptop-AppData', 'PC', '2026-11-22', 'x.txt'),
      path.join(data, 'logs'),
      path.join(data, 'backuphub.db'),
      path.join(data, 'backuphub.db-wal'),
      path.join(data, 'settings.json'),
      path.join(data, 'other', 'x'),
      path.join(os.tmpdir(), 'not-ours', 'x'),
      path.join(os.tmpdir(), 'x.txt'),
      path.join(dir, 'drive', ...DRIVE_TMP_PARTS, ...DRIVE_TMP_PARTS.map(() => '..'), 'Photos', 'photo.jpg'), // walks out of tmp
      path.parse(dir).root,
      '',
    ];
    for (const p of outside) expect(ownPathProblem(p), p).not.toBeNull();
  });

  it('removes an app-owned file and logs it; leaves a user file alone and says why', () => {
    const own = put(onDrive(...DRIVE_TMP_PARTS, 'a.bhtmp'));
    const user = put('drive/MyData/photo.jpg');
    ownRemove(own);
    expect(fs.existsSync(own)).toBe(false);
    expect(logs.join('\n')).toContain('removed');
    expect(() => ownRemove(user)).toThrow(OwnFilesRefused);
    expect(() => ownRemove(path.dirname(user), { recursive: true })).toThrow(OwnFilesRefused);
    expect(() => ownRemoveEmptyDir(path.dirname(user))).toThrow(OwnFilesRefused);
    expect(fs.existsSync(user)).toBe(true);
  });

  it('a move or replace needs BOTH ends to be app-owned', () => {
    const own = put(onDrive(...DRIVE_TMP_PARTS, 'a.bhtmp'), 'new');
    const user = put('drive/MyData/photo.jpg', 'precious');
    expect(() => ownMove(own, user)).toThrow(OwnFilesRefused);
    expect(() => ownMove(user, own)).toThrow(OwnFilesRefused);
    expect(() => ownReplace(own, user)).toThrow(OwnFilesRefused);
    expect(() => ownCreateNew(own, user)).toThrow(OwnFilesRefused);
    expect(fs.readFileSync(user, 'utf8')).toBe('precious');
    expect(fs.existsSync(own)).toBe(true);
  });

  it('ownCreateNew never replaces (EEXIST); ownReplace does replace an own file', () => {
    const tmp = put(onDrive(...CARD_PARTS, `${CARD_FILE}.tmp`), 'second');
    const card = put(onDrive(...CARD_PARTS, CARD_FILE), 'first');
    expect(() => ownCreateNew(tmp, card)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(fs.readFileSync(card, 'utf8')).toBe('first');
    ownReplace(tmp, card);
    expect(fs.readFileSync(card, 'utf8')).toBe('second');
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('the live database can be moved aside and a staged copy moved onto the free name, never onto a taken name', () => {
    const live = put('data/backuphub.db', 'old');
    const staged = put('data/restore/pending.db', 'new');
    const aside = path.join(data, 'before-restore', 's1');
    fs.mkdirSync(aside, { recursive: true });
    ownMoveDb(live, path.join(aside, 'backuphub.db'));
    ownMoveDb(staged, live);
    expect(fs.readFileSync(live, 'utf8')).toBe('new');
    expect(fs.readFileSync(path.join(aside, 'backuphub.db'), 'utf8')).toBe('old');
    const again = put('data/restore/pending2.db', 'newer');
    expect(() => ownMoveDb(again, live)).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(() => ownRemove(live)).toThrow(OwnFilesRefused);
  });
});

describe('danger: the one guarded path', () => {
  let db: Db;
  beforeEach(() => {
    const opened = initDatabase(data, silent);
    if (!opened.ok) throw new Error('db did not open');
    db = opened.db;
  });
  afterEach(() => closeDatabase(db, silent));

  const env = (extra: Partial<DangerEnv> = {}): DangerEnv => ({ db, now: () => NOW, ...extra });
  const survivor = (where: string, ref: string, hash: string | null): Survivor => ({ where, ref, readFresh: () => Promise.resolve(hash) });
  const entry = (id: string, action: ConfirmedEntry['action'], target: string, contentHash: string | null = null, serial: string | null = null): ConfirmedEntry => ({ id, action, target, contentHash, ...(serial === null ? {} : { serial }) });
  const rows = () => db.prepare('SELECT item_id, action, outcome, detail, proof_json, list_hash FROM danger_log ORDER BY id').all() as { item_id: string; action: string; outcome: string; detail: string | null; proof_json: string; list_hash: string }[];

  async function run(items: DangerItem[], confirmed: ConfirmedEntry[], extra: Partial<DangerEnv> = {}, min?: number) {
    return runDanger(env(extra), { listId: 'list-1', confirmedHash: hashConfirmed(confirmed), confirmed, items, ...(min === undefined ? {} : { minSurvivors: min }) });
  }

  it('deletes with the confirmed list and fresh proof, and writes a permanent log row', async () => {
    const f = put('laptop/dup.jpg', 'same');
    const keep = put('laptop/keep.jpg', 'same');
    const e = entry('1', 'delete-file', f, sha('same'));
    const [r] = await run([{ ...e, size: 4, survivors: [survivor('laptop keep', keep, sha('same'))] }], [e]);
    expect(r).toMatchObject({ id: '1', outcome: 'done' });
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(keep)).toBe(true);
    const log = rows();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ item_id: '1', action: 'delete-file', outcome: 'done', list_hash: hashConfirmed([e]) });
    expect(JSON.parse(log[0]!.proof_json)).toEqual([{ where: 'laptop keep', hash: sha('same') }]);
  });

  it('refuses everything when the list is not the one that was confirmed (hash differs, or the list is empty)', async () => {
    const f = put('laptop/dup.jpg', 'same');
    const e = entry('1', 'delete-file', f, sha('same'));
    const item: DangerItem = { ...e, survivors: [survivor('k', '/k', sha('same'))] };
    await expect(runDanger(env(), { listId: 'l', confirmedHash: hashConfirmed([e]), confirmed: [e, entry('2', 'delete-file', '/other', sha('z'))], items: [item] })).rejects.toBeInstanceOf(DangerRefused);
    await expect(runDanger(env(), { listId: 'l', confirmedHash: '', confirmed: [e], items: [item] })).rejects.toBeInstanceOf(DangerRefused);
    await expect(runDanger(env(), { listId: '', confirmedHash: hashConfirmed([e]), confirmed: [e], items: [item] })).rejects.toBeInstanceOf(DangerRefused);
    await expect(runDanger(env(), { listId: 'l', confirmedHash: hashConfirmed([e, e]), confirmed: [e, e], items: [item] })).rejects.toBeInstanceOf(DangerRefused);
    expect(fs.existsSync(f)).toBe(true);
    expect(rows()).toHaveLength(0);
  });

  it('refuses an item that changed after the confirm (other target, other checksum, other action)', async () => {
    const f = put('laptop/a.jpg', 'a');
    const other = put('laptop/b.jpg', 'b');
    const e = entry('1', 'delete-file', f, sha('a'));
    const proof = [survivor('k', '/k', sha('b'))];
    const results = await run(
      [
        { ...e, target: other, contentHash: sha('a'), survivors: proof },
        { ...e, contentHash: sha('b'), survivors: proof },
        { ...e, action: 'quarantine', to: path.join(dir, 'q', 'a.jpg'), toRoot: path.join(dir, 'q'), survivors: proof },
        { ...e, id: '9', survivors: proof },
      ],
      [e],
    );
    expect(results.map((r) => r.outcome)).toEqual(['refused', 'refused', 'refused', 'refused']);
    expect(fs.existsSync(f)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
    expect(rows().every((r) => r.outcome === 'refused')).toBe(true);
  });

  it('refuses without proof: none given, a copy that cannot be read, a copy with another checksum, the file itself, too few copies', async () => {
    const f = put('laptop/a.jpg', 'a');
    const e = entry('1', 'delete-file', f, sha('a'));
    const cases: [string, readonly Survivor[], number | undefined][] = [
      ['no survivors', [], undefined],
      ['unreadable', [survivor('k', '/k', null)], undefined],
      ['changed checksum', [survivor('k', '/k', sha('other'))], undefined],
      ['itself', [survivor('itself', f, sha('a'))], undefined],
      ['same place twice', [survivor('k', '/k', sha('a')), survivor('k again', '/k', sha('a'))], 2],
      ['one of two', [survivor('k', '/k', sha('a')), survivor('j', '/j', sha('zzz'))], 2],
      ['a reader that throws', [{ where: 'k', ref: '/k', readFresh: () => Promise.reject(new Error('drive gone')) }], undefined],
    ];
    for (const [name, survivors, min] of cases) {
      const [r] = await run([{ ...e, survivors }], [e], {}, min);
      expect(r?.outcome, name).toBe('refused');
      expect(fs.existsSync(f), name).toBe(true);
    }
    const noHash = entry('2', 'delete-file', f, null);
    const [r2] = await run([{ ...noHash, survivors: [survivor('k', '/k', sha('a'))] }], [noHash]);
    expect(r2?.outcome).toBe('refused');
    expect(rows().every((r) => r.outcome === 'refused')).toBe(true);
    expect(rows().length).toBe(cases.length + 1);
  });

  it('quarantine moves with proof and never replaces a file that is already at the destination', async () => {
    const f = put('laptop/a.jpg', 'a');
    const keep = put('laptop/keep.jpg', 'a');
    const q = path.join(dir, 'q');
    const to = path.join(q, '2026-11-22', 'a.jpg');
    const e = entry('1', 'quarantine', f, sha('a'));
    const item: DangerItem = { ...e, to, toRoot: q, survivors: [survivor('keep', keep, sha('a'))] };
    const taken = put('q/2026-11-22/a.jpg', 'someone else');
    const [clash] = await run([item], [e]);
    expect(clash).toMatchObject({ outcome: 'failed' });
    expect(fs.readFileSync(taken, 'utf8')).toBe('someone else');
    expect(fs.existsSync(f)).toBe(true);
    fs.rmSync(taken);
    const [ok] = await run([item], [e]);
    expect(ok).toMatchObject({ outcome: 'done', movedTo: to });
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.readFileSync(to, 'utf8')).toBe('a');
    // The place to move to must be inside the given root.
    const f2 = put('laptop/c.jpg', 'a');
    const e2 = entry('2', 'quarantine', f2, sha('a'));
    const [out] = await run([{ ...e2, to: path.join(dir, 'elsewhere', 'c.jpg'), toRoot: q, survivors: [survivor('keep', keep, sha('a'))] }], [e2]);
    expect(out?.outcome).toBe('failed');
    expect(fs.existsSync(f2)).toBe(true);
  });

  it('put-back needs the confirmed list but no proof, and never replaces', async () => {
    const q = path.join(dir, 'q');
    const inQ = put('q/a.jpg', 'a');
    const origin = path.join(dir, 'laptop', 'a.jpg');
    const e = entry('1', 'put-back', inQ);
    const [r] = await run([{ ...e, to: origin, toRoot: path.join(dir, 'laptop') }], [e]);
    expect(r?.outcome).toBe('done');
    expect(fs.readFileSync(origin, 'utf8')).toBe('a');
    expect(fs.existsSync(q) && fs.existsSync(inQ)).toBe(false);
    const again = put('q/a.jpg', 'a2');
    const [r2] = await run([{ ...e, target: again, to: origin, toRoot: path.join(dir, 'laptop') }], [{ ...e, target: again }]);
    expect(r2?.outcome).toBe('failed');
    expect(fs.readFileSync(origin, 'utf8')).toBe('a');
  });

  it("a damaged file in a backup root is moved aside into the set-aside folder of the app's own files, never overwritten or deleted", async () => {
    const drive = path.join(dir, 'drive');
    const damaged = put('drive/BackupHub/Phone/a.jpg', 'damaged');
    const good = put('other/a.jpg', 'good');
    const e = entry('1', 'set-aside', damaged, sha('good'));
    const survivors = [survivor('other drive', good, sha('good'))];
    const [r] = await run([{ ...e, driveRoot: drive, survivors }], [e]);
    const aside = path.join(setAsideFolder(drive), '2026-11-22', 'BackupHub', 'Phone', 'a.jpg');
    expect(r).toMatchObject({ outcome: 'done', movedTo: aside });
    expect(fs.readFileSync(aside, 'utf8')).toBe('damaged');
    expect(fs.existsSync(damaged)).toBe(false);
    // The same name set aside again gets a number; the first one is untouched.
    const again = put('drive/BackupHub/Phone/a.jpg', 'damaged again');
    const [r2] = await run([{ ...e, driveRoot: drive, survivors }], [e]);
    expect(r2?.movedTo).toBe(`${aside}.1`);
    expect(fs.readFileSync(aside, 'utf8')).toBe('damaged');
    expect(fs.existsSync(again)).toBe(false);
    expect(await setAsidePathFor(drive, path.join(drive, 'x', 'y.txt'), NOW, () => false)).toBe(path.join(setAsideFolder(drive), '2026-11-22', 'x', 'y.txt'));
    await expect(setAsidePathFor(drive, path.join(dir, 'not-on-drive.txt'), NOW)).rejects.toThrow(DangerRefused);
  });

  it('replace-damaged: the damaged file goes aside, the verified replacement takes its place, the temp name goes', async () => {
    const drive = path.join(dir, 'drive');
    const damaged = put('drive/BackupHub/a.jpg', 'damaged');
    const tmp = put(onDrive(...DRIVE_TMP_PARTS, 'a.bhtmp'), 'good');
    const good = put('other/a.jpg', 'good');
    const e = entry('1', 'replace-damaged', damaged, sha('good'));
    const survivors = [survivor('other', good, sha('good'))];
    const [r] = await run([{ ...e, driveRoot: drive, to: tmp, survivors }], [e]);
    expect(r?.outcome).toBe('done');
    expect(fs.readFileSync(damaged, 'utf8')).toBe('good');
    expect(fs.readFileSync(r!.movedTo!, 'utf8')).toBe('damaged');
    expect(fs.existsSync(tmp)).toBe(false);
    // A replacement that is not a Backup Hub temp file is refused before anything moves.
    const notTmp = put('drive/BackupHub/b.jpg', 'b');
    const e2 = entry('2', 'replace-damaged', damaged, sha('good'));
    const [r2] = await run([{ ...e2, driveRoot: drive, to: notTmp, survivors }], [e2]);
    expect(r2?.outcome).toBe('failed');
    expect(fs.readFileSync(damaged, 'utf8')).toBe('good');
  });

  it('adb rm: the phone is asked only after the list and the proof; an unsafe path never goes out', async () => {
    const sent: string[] = [];
    const adbRemove = (serial: string, p: string) => {
      sent.push(`${serial} ${p}`);
      return Promise.resolve();
    };
    const good = '/sdcard/DCIM/Camera/a.jpg';
    const e = entry('1', 'adb-rm', good, sha('a'), 'S1');
    const proof = [survivor('T7', '/t7/a.jpg', sha('a'))];
    expect((await run([{ ...e, survivors: [] }], [e], { adbRemove }))[0]?.outcome).toBe('refused');
    expect((await run([{ ...e, survivors: [survivor('T7', '/t7/a.jpg', sha('changed'))] }], [e], { adbRemove }))[0]?.outcome).toBe('refused');
    expect(sent).toEqual([]);
    expect((await run([{ ...e, survivors: proof }], [e], { adbRemove }))[0]?.outcome).toBe('done');
    expect(sent).toEqual([`S1 ${good}`]);
    const bad = entry('2', 'adb-rm', "/sdcard/DCIM/a';rm -rf /;'.jpg", sha('a'), 'S1');
    expect((await run([{ ...bad, survivors: proof }], [bad], { adbRemove }))[0]?.outcome).toBe('failed');
    expect(sent).toHaveLength(1);
    expect((await run([{ ...e, survivors: proof }], [e]))[0]?.outcome).toBe('failed'); // no phone connection given
    const failing = () => Promise.reject(new Error('device offline'));
    expect((await run([{ ...e, survivors: proof }], [e], { adbRemove: failing }))[0]).toMatchObject({ outcome: 'failed', reason: 'device offline' });
    expect(rows().filter((r) => r.outcome === 'failed').length).toBeGreaterThanOrEqual(3);
  });

  it('adb rm in a batch: every file is proved and logged on its own, the phone is asked once, nothing goes out after a stop or for an unproved file', async () => {
    const batches: { path: string; size: number }[][] = [];
    const adbRemoveMany = (_serial: string, items: readonly { path: string; size: number }[]) => {
      batches.push(items.map((i) => ({ ...i })));
      return Promise.resolve(items.map((i) => (i.path.endsWith('c.jpg') ? { ok: false as const, reason: 'its size changed' } : { ok: true as const })));
    };
    const mk = (id: string, name: string): DangerItem => ({ ...entry(id, 'adb-rm', `/sdcard/DCIM/Camera/${name}`, sha('a'), 'S1'), size: 100, survivors: [survivor('T7', `/t7/${name}`, sha('a'))] });
    const items = [mk('1', 'a.jpg'), mk('2', 'b.jpg'), mk('3', 'c.jpg')];
    const results = await run(items, items, { adbRemoveMany });
    expect(results.map((r) => r.outcome)).toEqual(['done', 'done', 'failed']);
    expect(results[2]?.reason).toBe('its size changed');
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((b) => b.path.split('/').pop())).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    expect(rows().filter((r) => r.action === 'adb-rm').map((r) => r.outcome)).toEqual(['done', 'done', 'failed']);
    // A file whose proof fails is refused and is not in the batch.
    const unproved: DangerItem = { ...mk('4', 'd.jpg'), survivors: [survivor('T7', '/t7/d.jpg', sha('changed'))] };
    const second = [mk('5', 'e.jpg'), unproved];
    expect((await run(second, second, { adbRemoveMany })).map((r) => r.outcome)).toEqual(['done', 'refused']);
    expect(batches[1]!.map((b) => b.path.split('/').pop())).toEqual(['e.jpg']);
    // A stop before the call: nothing is sent, every item is failed in the log.
    const stopped = new AbortController();
    stopped.abort();
    const third = [mk('6', 'f.jpg')];
    expect((await run(third, third, { adbRemoveMany, signal: stopped.signal }))[0]?.outcome).toBe('failed');
    expect(batches).toHaveLength(2);
    // An unsafe path or a missing planned size never goes out.
    const bad = { ...entry('7', 'adb-rm', "/sdcard/DCIM/a';rm -rf /;'.jpg", sha('a'), 'S1'), size: 100, survivors: [survivor('T7', '/t7/x', sha('a'))] };
    const noSize = { ...mk('8', 'g.jpg'), size: null };
    expect((await run([bad, noSize], [bad, noSize], { adbRemoveMany })).map((r) => r.outcome)).toEqual(['failed', 'failed']);
    expect(batches).toHaveLength(2);
  });

  it('the batch lines: each file is size-checked right before its own rm; unsafe paths and missing sizes are refused; the answers are read in order', () => {
    const line = removeManyCommand([
      { path: '/sdcard/DCIM/Camera/a.jpg', size: 100 },
      { path: '/sdcard/DCIM/Camera/b.jpg', size: 200 },
    ]);
    expect(line.split('case $(')).toHaveLength(3); // one case per file
    expect(line).toContain("case $(stat -c %s '/sdcard/DCIM/Camera/a.jpg' 2>/dev/null) in 100) if rm '/sdcard/DCIM/Camera/a.jpg'");
    expect(line).toContain("in 200) if rm '/sdcard/DCIM/Camera/b.jpg'");
    expect(line).not.toMatch(/rm -/); // no flags
    expect(() => removeManyCommand([{ path: "/sdcard/a';rm -rf /;'.jpg", size: 1 }])).toThrow();
    expect(() => removeManyCommand([{ path: '/sdcard/DCIM/a.jpg', size: 0 }])).toThrow();
    expect(() => removeManyCommand([])).toThrow();
    expect(parseRemoveMany(4, 'GONE\r\nCHANGED\nMISSING\nSTILL\n')).toEqual(['removed', 'changed', 'missing', 'still']);
    expect(() => parseRemoveMany(2, 'GONE\n')).toThrow();
    expect(() => parseRemoveMany(1, 'rm: permission denied\n')).toThrow();
    expect(statSizesCommand(['/sdcard/DCIM/a.jpg', '/sdcard/DCIM/b.jpg'])).toBe("stat -c %s '/sdcard/DCIM/a.jpg' 2>/dev/null || echo X; stat -c %s '/sdcard/DCIM/b.jpg' 2>/dev/null || echo X");
    expect(() => statSizesCommand(["/sdcard/a'b.jpg"])).toThrow();
    expect(parseSizes(3, '123\nX\n0\n')).toEqual([123, null, 0]);
    expect(() => parseSizes(2, '1\n')).toThrow();
  });

  it('Drive trash and delete: only with the list and proof, one file at a time', async () => {
    const calls: string[] = [];
    const driveTrash = (account: string, id: string) => (calls.push(`trash ${account} ${id}`), Promise.resolve());
    const driveDelete = (account: string, id: string) => (calls.push(`delete ${account} ${id}`), Promise.resolve());
    const t = entry('1', 'drive-trash', 'file-id-1', sha('a'), 'me@example.com');
    const d = entry('2', 'drive-delete', 'file-id-2', sha('a'), 'me@example.com');
    const proof = [survivor('T7', '/t7/a', sha('a'))];
    expect((await run([{ ...t, survivors: [] }, { ...d, survivors: [] }], [t, d], { driveTrash, driveDelete })).map((r) => r.outcome)).toEqual(['refused', 'refused']);
    expect(calls).toEqual([]);
    expect((await run([{ ...t, survivors: proof }, { ...d, survivors: proof }], [t, d], { driveTrash, driveDelete })).map((r) => r.outcome)).toEqual(['done', 'done']);
    expect(calls).toEqual(['trash me@example.com file-id-1', 'delete me@example.com file-id-2']);
  });

  it('removing an empty folder needs the list but no proof, and fails on a folder that holds something', async () => {
    const full = path.join(dir, 'q', 'full');
    put('q/full/x.txt', 'x');
    const empty = path.join(dir, 'q', 'empty');
    fs.mkdirSync(empty, { recursive: true });
    const a = entry('1', 'remove-empty-folder', full);
    const b = entry('2', 'remove-empty-folder', empty);
    const results = await run([a, b], [a, b]);
    expect(results.map((r) => r.outcome)).toEqual(['failed', 'done']);
    expect(fs.existsSync(full)).toBe(true);
    expect(fs.existsSync(empty)).toBe(false);
  });
});
