import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeRig, World, type Rig } from '../look/harness/world.testutil';
import { upsertFiles } from '../listing/fileStore';
import { fullWalk } from '../listing/fullWalker';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { normalizeRoot } from '../listing/roots';
import { RulesStore } from '../rules/rulesStore';
import { KEEP_SYNC_PARTS } from '../../shared/appFolders';
import { runFolderPreview } from './previewTool';
import { keepSyncPaths } from './keepSync';

/** R2.1 proof helper (scripts/r21-preview.mjs): what a folder backup would do, read only, on a database file. */
let rig: Rig;
let w: World;
let source: string;
let local: string;
const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

beforeEach(() => {
  rig = makeRig();
  w = new World(rig, { seed: 81, drives: [{ caseInsensitive: true }] });
  source = normalizeRoot(fs.mkdtempSync(path.join(os.tmpdir(), 'zz-prev-src-')));
  local = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-prev-local-'));
  rig.db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES ('laptop-prev', 1, 'laptop', 'Laptop', '{}', 1)").run();
});
afterEach(() => {
  vi.restoreAllMocks();
  w.dispose();
  rig.close();
  fs.rmSync(source, { recursive: true, force: true });
  fs.rmSync(local, { recursive: true, force: true });
});

const put = (rel: string, content: string, mtimeSec = 1_700_000_000): void => {
  const file = path.join(source, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.utimesSync(file, mtimeSec, mtimeSec);
};

describe('the preview script', () => {
  it('prints what would be copied, already backed up, excluded and in use, and writes nothing anywhere', async () => {
    const id = Number(rig.db.prepare("INSERT INTO backup_profiles (person_id, name, source_kind, source_root, folder_prefix, change_rule, created_at) VALUES (1, 'Preview folder', 'folder', ?, 'Prev', 'size_or_date', 1)").run(source).lastInsertRowid);
    rig.db.prepare('INSERT INTO backup_destinations (backup_profile_id, place_id, root, role, enabled, position) VALUES (?, ?, ?, ?, 1, 1)').run(id, w.destinations[0]!.placeId, 'MyData/PrevBackup', 'primary');
    put('same.txt', 'same-content');
    put('new.txt', 'brand new file');
    put('changed.txt', 'changed and longer now');
    put('Games/save.dat', 'excluded save');
    const seed = (rel: string, size: number): void =>
      upsertFiles(rig.db, w.destinations[0]!.placeId, [{ relPath: `MyData/PrevBackup/Prev-05Jul26/${rel}`, size, mtimeMs: 1_700_000_000_000, cloudOnly: false }], 1, true);
    seed('same.txt', 'same-content'.length);
    seed('changed.txt', 5);
    new RulesStore(rig.db).add(id, { scope: 'folder', pattern: '/source/Games', choice: 'leave_out' });
    rig.db.pragma('wal_checkpoint(TRUNCATE)');
    const before = sha(path.join(rig.dir, 'test.db'));
    const lines: string[] = [];
    const code = await runFolderPreview({ dbPath: path.join(rig.dir, 'test.db'), backup: 'Preview folder', print: (l) => lines.push(l) });
    const text = lines.join('\n');
    expect(code).toBe(0);
    expect(text).toContain('TO COPY: 2 files');
    expect(text).toContain('1 new, 1 changed');
    expect(text).toContain('ALREADY BACKED UP: 1 files');
    expect(text).toContain('IN USE by another program: 0 of the 2 files asked');
    expect(text).toContain('EXCLUDED by your choices: 1 files');
    expect(text).toContain('changed.txt|22|');
    expect(text).not.toContain('save.dat|');
    // Nothing was written: the database file is byte for byte the same, nothing new in the folder, nothing created next to it.
    rig.db.pragma('wal_checkpoint(TRUNCATE)');
    expect(sha(path.join(rig.dir, 'test.db'))).toBe(before);
    expect(fs.readdirSync(source).toSorted()).toEqual(['Games', 'changed.txt', 'new.txt', 'same.txt']);
    expect(fs.readdirSync(rig.dir).filter((f) => !f.startsWith('test.db'))).toEqual([]);
  });

  it('a backup that does not exist lists the ones that do; the Google Keep notes are never opened, not even to see whether they are in use', async () => {
    const lines: string[] = [];
    expect(await runFolderPreview({ dbPath: path.join(rig.dir, 'test.db'), backup: 'nope', print: (l) => lines.push(l) })).toBe(2);
    expect(lines.join('')).toContain('No such folder backup');

    const keep = keepSyncPaths(local)!;
    fs.mkdirSync(keep.snapshots, { recursive: true });
    fs.writeFileSync(path.join(keep.snapshots, 'keep-20260101-000000.jsonl.gz'), 'PRIVATE-CANARY-1');
    fs.writeFileSync(path.join(keep.snapshots, 'keep-20260102-000000.jsonl.gz'), 'PRIVATE-CANARY-22');
    const id = Number(rig.db.prepare("INSERT INTO backup_profiles (person_id, name, source_kind, source_root, folder_prefix, change_rule, import_key, created_at) VALUES (1, 'Keep notes', 'folder', 'keep-sync', 'keep-sync', 'size_or_date', 'keep-sync', 1)").run().lastInsertRowid);
    rig.db.prepare('INSERT INTO backup_destinations (backup_profile_id, place_id, root, role, enabled, position) VALUES (?, ?, ?, ?, 1, 1)').run(id, w.destinations[0]!.placeId, KEEP_SYNC_PARTS.join('/'), 'primary');
    upsertFiles(rig.db, w.destinations[0]!.placeId, [{ relPath: `${KEEP_SYNC_PARTS.join('/')}/keep-20260101-000000.jsonl.gz`, size: 'PRIVATE-CANARY-1'.length, mtimeMs: 1, cloudOnly: false }], 1, true);
    rig.db.pragma('wal_checkpoint(TRUNCATE)');
    const opened: string[] = [];
    const real = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(((p: unknown, ...rest: unknown[]) => {
      opened.push(String(p));
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as never);
    const out: string[] = [];
    expect(await runFolderPreview({ dbPath: path.join(rig.dir, 'test.db'), backup: 'Keep notes', localAppData: local, print: (l) => out.push(l) })).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('TO COPY: 1 files');
    expect(text).toContain('ALREADY BACKED UP: 1 files');
    expect(text).toContain('never opened');
    expect(text).not.toContain('PRIVATE-CANARY');
    expect(opened.filter((p) => p.toLowerCase().startsWith(local.toLowerCase()))).toEqual([]);
  });

  const makeProfile = (): number => {
    const id = Number(rig.db.prepare("INSERT INTO backup_profiles (person_id, name, source_kind, source_root, folder_prefix, change_rule, created_at) VALUES (1, 'Preview folder', 'folder', ?, 'Prev', 'size_or_date', 1)").run(source).lastInsertRowid);
    rig.db.prepare('INSERT INTO backup_destinations (backup_profile_id, place_id, root, role, enabled, position) VALUES (?, ?, ?, ?, 1, 1)').run(id, w.destinations[0]!.placeId, 'MyData/PrevBackup', 'primary');
    return id;
  };

  it('leaves out the same folders as the app when the database has no saved skip list (settings default), and obeys a saved list', async () => {
    makeProfile();
    expect(DEFAULT_SETTINGS.skipFolders).toContain('node_modules');
    put('Docs/a.txt', 'a');
    put('proj/node_modules/pkg/index.js', 'js');
    rig.db.pragma('wal_checkpoint(TRUNCATE)');
    const lines: string[] = [];
    expect(await runFolderPreview({ dbPath: path.join(rig.dir, 'test.db'), backup: 'Preview folder', print: (l) => lines.push(l), all: true })).toBe(0);
    expect(lines.join('\n')).toContain('TO COPY: 1 files');
    expect(lines.join('\n')).not.toContain('node_modules');
    // The person emptied the list: now they are counted, as the app would.
    rig.db.prepare("INSERT INTO settings (key, value) VALUES ('skipFolders', '[]')").run();
    rig.db.pragma('wal_checkpoint(TRUNCATE)');
    const again: string[] = [];
    await runFolderPreview({ dbPath: path.join(rig.dir, 'test.db'), backup: 'Preview folder', print: (l) => again.push(l), all: true });
    expect(again.join('\n')).toContain('TO COPY: 2 files');
    expect(again.join('\n')).toContain('node_modules');
  });

  it('a folder renamed since the last look is found by the files\' own ids: nothing to copy, one line for the folder (read only)', async () => {
    makeProfile();
    const place = 'laptop-prev';
    const dest = w.destinations[0]!.placeId;
    for (let i = 0; i < 6; i += 1) put(`Trip/p${i}.jpg`, `photo ${i}`, 1_700_000_000 + i);
    put('Other/keep.txt', 'keep');
    await fullWalk({ db: rig.db, request: { placeId: place, root: source, rel: { kind: 'absolute' }, excludeDirs: [], oneDriveRoot: null, cloudRels: null, chunkSize: 100, trustFsId: true } });
    const rows = rig.db.prepare('SELECT id, rel_path, size, mtime FROM files WHERE place_id = ?').all(place) as { id: number; rel_path: string; size: number; mtime: number }[];
    expect(rows).toHaveLength(7);
    for (const r of rows) {
      const below = r.rel_path.slice(source.replaceAll('\\', '/').length + 1);
      upsertFiles(rig.db, dest, [{ relPath: `MyData/PrevBackup/Prev-05Jul26/${below}`, size: r.size, mtimeMs: r.mtime, cloudOnly: false }], 1, true);
      rig.db.prepare('UPDATE files SET origin_file_id = ?, verified_how = ? WHERE place_id = ? AND rel_path = ?').run(r.id, 'read_both', dest, `MyData/PrevBackup/Prev-05Jul26/${below}`);
    }
    fs.renameSync(path.join(source, 'Trip'), path.join(source, 'Goa 2026'));
    rig.db.pragma('wal_checkpoint(TRUNCATE)');
    const before = sha(path.join(rig.dir, 'test.db'));
    const lines: string[] = [];
    expect(await runFolderPreview({ dbPath: path.join(rig.dir, 'test.db'), backup: 'Preview folder', print: (l) => lines.push(l) })).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('TO COPY: 0 files');
    expect(text).toContain('ALREADY BACKED UP: 7 files');
    expect(text).toContain('RENAMED OR MOVED since they were backed up: 6 files');
    expect(text).toContain('folder renamed: Trip > Goa 2026 (6 files)');
    rig.db.pragma('wal_checkpoint(TRUNCATE)');
    expect(sha(path.join(rig.dir, 'test.db'))).toBe(before);
  });

  it('the script refuses the real data folder', () => {
    let failed: { status?: number; stderr?: Buffer } = {};
    try {
      execFileSync(process.execPath, [path.resolve(__dirname, '..', '..', '..', 'scripts', 'r21-preview.mjs'), '--db', 'D:\\BackupHub\\data\\backuphub.db'], { stdio: 'pipe' });
    } catch (err) {
      failed = err as { status?: number; stderr?: Buffer };
    }
    expect(failed.status).toBe(2);
    expect(String(failed.stderr)).toContain('real data folder');
  });
});
