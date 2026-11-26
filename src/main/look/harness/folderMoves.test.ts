import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invariant6 } from './invariants.testutil';
import { FolderWorld, SOURCE_BASE } from './folderWorld.testutil';
import { Rng } from './rng.testutil';
import { makeRig, World, type Rig } from './world.testutil';

/**
 * R1.6 in the fake world (PLAN 3c rules 2 and 3, invariant 6): a file or folder renamed or moved at the source is the same file. The real look, plan and run;
 * the folder is a fake whose files keep their file system id across a rename. Nothing is read or copied again, the plan says it in one line per folder, and the
 * row keeps its history. Then random sequences of creates, edits, renames, moves and backups check invariant 6 after every backup.
 */
let rig: Rig;
let w: World;
beforeEach(() => {
  rig = makeRig();
  w = new World(rig, { seed: 61, drives: [{ caseInsensitive: true }] });
});
afterEach(() => {
  w.dispose();
  rig.close();
});

const planOf = (r: { plan: { result: { ok: boolean } } }): import('../../../shared/folderBackup').FolderPlanView => {
  const result = r.plan.result as { ok: true; plan: import('../../../shared/folderBackup').FolderPlanView };
  expect(result.ok).toBe(true);
  return result.plan;
};
const history = (f: FolderWorld, rel: string): string[] =>
  (w.db.prepare('SELECT rel_path FROM file_paths WHERE file_id = ? ORDER BY from_at, rowid').pluck().all(f.rowOf(rel)) as string[]).map((p) => p.slice(SOURCE_BASE.length + 1));

describe('renamed and moved at the source', () => {
  it('a folder renamed (30 files): nothing is read or copied, one line says so, every row is the same row with its history', async () => {
    const f = new FolderWorld(w);
    for (let i = 0; i < 30; i += 1) f.put(`Trip/d${i % 3}/p${i}.jpg`, `photo ${i}`, w.nowSec - 5000 + i);
    f.put('Other/keep.txt', 'unrelated');
    expect((await f.backup()).report!.copied.files).toBe(31);
    const ids = new Map([...f.src.files.keys()].map((rel) => [rel, f.rowOf(rel)]));
    const before = f.durable();

    w.tick(60);
    f.src.renameFolder('Trip', 'Goa 2026');
    f.src.reads.length = 0;
    const run = await f.backup();
    const plan = planOf(run);
    expect(plan.totals.files).toBe(0);
    expect(plan.alreadyBackedUp).toBe(31);
    expect(plan.moved).toEqual([{ kind: 'folder_renamed', from: 'Trip', to: 'Goa 2026', files: 30 }]);
    expect(plan.movedFiles).toBe(30);
    expect(f.src.reads).toEqual([]);
    expect(f.durable()).toEqual(before);
    for (let i = 0; i < 30; i += 1) expect(f.rowOf(`Goa 2026/d${i % 3}/p${i}.jpg`)).toBe(ids.get(`Trip/d${i % 3}/p${i}.jpg`));
    expect(history(f, 'Goa 2026/d0/p0.jpg')).toEqual(['Trip/d0/p0.jpg', 'Goa 2026/d0/p0.jpg']);
    expect(w.db.prepare('SELECT count(*) FROM files WHERE place_id = ?').pluck().get(f.laptopPlace)).toBe(31);
    expect(f.violations(before)).toEqual([]);

    // Asked again: still nothing to copy, and the line is gone once the copy is made under the new name... the copies stay under the old one (nothing is moved on the drive).
    w.tick(60);
    expect(planOf(await f.backup()).totals.files).toBe(0);
  });

  it('a folder moved into another folder, and a file renamed on its own: told apart', async () => {
    const f = new FolderWorld(w);
    for (let i = 0; i < 5; i += 1) f.put(`Docs/sub/d${i}.txt`, `doc ${i}`, w.nowSec - 4000 + i);
    f.put('Notes/a.txt', 'note a', w.nowSec - 3000);
    f.put('Notes/b.txt', 'note b is longer', w.nowSec - 3001);
    await f.backup();
    w.tick(60);
    f.src.renameFolder('Docs', 'Archive/Docs');
    f.src.rename('Notes/a.txt', 'Notes/a-final.txt');
    f.src.reads.length = 0;
    const plan = planOf(await f.backup());
    expect(plan.totals.files).toBe(0);
    expect(plan.moved).toEqual([
      { kind: 'folder_moved', from: 'Docs', to: 'Archive/Docs', files: 5 },
      { kind: 'files', from: '', to: '', files: 1 },
    ]);
    expect(plan.movedFiles).toBe(6);
    expect(f.src.reads).toEqual([]);
  });

  it('moved AND edited: the edited file is copied, the rest of the folder is not', async () => {
    const f = new FolderWorld(w);
    f.put('Work/a.txt', 'file a', w.nowSec - 4000);
    f.put('Work/b.txt', 'file b', w.nowSec - 4001);
    await f.backup();
    w.tick(60);
    f.src.renameFolder('Work', 'Done');
    f.put('Done/b.txt', 'file b, edited and longer', w.nowSec - 10);
    f.src.reads.length = 0;
    const run = await f.backup();
    const plan = planOf(run);
    expect(plan.rows.map((r) => r.path)).toEqual(['/source/Done/b.txt']);
    expect(plan.moved).toEqual([{ kind: 'folder_renamed', from: 'Work', to: 'Done', files: 1 }]);
    expect(f.src.reads).toEqual(['Done/b.txt']);
  });

  it('a file whose id was never seen (no id in the row) is copied again as before: nothing is guessed', async () => {
    const f = new FolderWorld(w);
    f.put('A/x.txt', 'xx', w.nowSec - 4000);
    await f.backup();
    w.db.prepare('UPDATE files SET fs_id = NULL WHERE place_id = ?').run(f.laptopPlace);
    w.tick(60);
    f.src.rename('A/x.txt', 'A/y.txt');
    // The id comes back with this look, but the vanished row has none: no match.
    const plan = planOf(await f.backup());
    expect(plan.totals.files).toBe(1);
    expect(plan.movedFiles).toBe(0);
  });
});

describe('invariant 6 over random sequences', () => {
  const SEEDS = Array.from({ length: Number(process.env['LOOK_CHAOS_SEEDS'] ?? 20) }, (_, i) => i + 1);
  const DIRS = ['A/x', 'A/y', 'B', 'C/deep/er'];

  async function sequence(seed: number): Promise<{ violations: string[]; events: Record<string, number> }> {
    const r = makeRig();
    const world = new World(r, { seed, drives: [{ caseInsensitive: true }] });
    const f = new FolderWorld(world);
    const rng = new Rng(seed * 104_729 + 3);
    const violations: string[] = [];
    const events: Record<string, number> = {};
    const dirty = new Set<string>();
    let counter = 0;
    const lastSeen = new Map<string, string>();
    const idOf = (rel: string): string => f.src.files.get(rel)!.fsId!;
    const live = (): string[] => [...f.src.files.keys()];
    const topDirs = (): string[] => [...new Set(live().map((p) => p.split('/')[0]!))];
    const count = (e: string): void => {
      events[e] = (events[e] ?? 0) + 1;
    };
    try {
      for (let n = 0; n < 30; n += 1) {
        const kind = rng.weighted([['create', 5], ['edit', 2], ['rename', 3], ['move', 2], ['folder', 2], ['delete', 1], ['backup', 5]] as const);
        const files = live();
        const chosen = files.length === 0 && kind !== 'create' && kind !== 'backup' ? 'create' : kind;
        counter += 1;
        count(chosen);
        switch (chosen) {
          case 'create': {
            const rel = `${rng.pick(DIRS)}/n${counter}.txt`;
            f.put(rel, `c${seed}-${counter}-${'x'.repeat(rng.int(20))}`, world.nowSec - 3000 + counter);
            dirty.add(idOf(rel));
            break;
          }
          case 'edit': {
            const rel = rng.pick(files);
            f.put(rel, `${f.src.files.get(rel)!.content.toString()}+${counter}`, world.nowSec - 2000 + counter);
            dirty.add(idOf(rel));
            break;
          }
          case 'rename':
          case 'move': {
            const rel = rng.pick(files);
            const dir = chosen === 'rename' ? rel.slice(0, Math.max(0, rel.lastIndexOf('/'))) : rng.pick(DIRS);
            f.src.rename(rel, `${dir}/r${counter}-${rel.slice(rel.lastIndexOf('/') + 1)}`);
            break;
          }
          case 'folder': {
            const top = rng.pick(topDirs());
            if (live().some((p) => p.startsWith('R'))) break;
            f.src.renameFolder(top, `R${counter}`);
            break;
          }
          case 'delete': {
            const rel = rng.pick(files);
            dirty.delete(idOf(rel));
            f.src.files.delete(rel);
            break;
          }
          case 'backup': {
            world.tick(60);
            f.src.reads.length = 0;
            const before = f.durable();
            const run = await f.backup();
            const now = new Map(live().map((rel) => [idOf(rel), rel]));
            const mustRead = live().filter((rel) => dirty.has(idOf(rel))).map((rel) => rel);
            const lost: string[] = [];
            for (const [id, rel] of now) {
              const was = lastSeen.get(id);
              // A file moved AND edited is a new file by design (a new row): only the unchanged ones keep their history.
              if (was !== undefined && was !== rel && !dirty.has(id)) {
                const hist = (world.db.prepare('SELECT rel_path FROM file_paths WHERE file_id = ?').pluck().all(f.rowOf(rel)) as string[]).map((p) => p.slice(SOURCE_BASE.length + 1));
                if (!hist.includes(was)) lost.push(was);
              }
            }
            for (const v of invariant6({ read: [...f.src.reads].toSorted(), mustRead: mustRead.toSorted(), lostPaths: lost })) violations.push(`seed ${seed}, event ${n}: ${v}`);
            for (const v of f.violations(before)) violations.push(`seed ${seed}, event ${n}: ${v}`);
            if (!run.plan.result.ok) violations.push(`seed ${seed}, event ${n}: the plan was refused: ${(run.plan.result as { message: string }).message}`);
            dirty.clear();
            lastSeen.clear();
            for (const [id, rel] of now) lastSeen.set(id, rel);
            break;
          }
        }
      }
    } finally {
      world.dispose();
      r.close();
    }
    return { violations, events };
  }

  it('a rename or move never causes a recopy of unchanged content and never loses path history', async () => {
    const all: string[] = [];
    const total: Record<string, number> = {};
    for (const seed of SEEDS) {
      const r = await sequence(seed);
      all.push(...r.violations);
      for (const [k, v] of Object.entries(r.events)) total[k] = (total[k] ?? 0) + v;
    }
    expect(all.slice(0, 10)).toEqual([]);
    // The sequences really rename and move (so a pass is not a trivial pass).
    for (const e of ['create', 'edit', 'rename', 'move', 'folder', 'delete', 'backup']) expect(total[e], e).toBeGreaterThan(0);
  }, 300_000);
});
