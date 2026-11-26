import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareLook, type PhoneListedFile } from './look/compare';
import { loadCopies, loadPhoneIndex, recordLook } from './look/lookStore';
import { makeRig, type Rig } from './look/harness/world.testutil';
import { hashPlan, type PlanItem } from './phoneBackup/planModel';
import { finishSliced, finishSync, sortSteps, type Steps, writeSliced } from './sliceWork';

/** The slicing helpers every long loop on the main thread uses: same answers as the one-go versions, and a stop part-way is harmless. */
function* counting(n: number): Steps<number> {
  let sum = 0;
  for (let i = 1; i <= n; i += 1) {
    sum += i;
    yield;
  }
  return sum;
}

describe('finishSync and finishSliced', () => {
  it('give the same answer; the sliced one gives the event loop a turn when its time slice is used up', async () => {
    expect(finishSync(counting(100))).toBe(5050);
    let turns = 0;
    expect(await finishSliced(counting(100), async () => void (turns += 1), -1)).toBe(5050);
    expect(turns).toBe(100);
    turns = 0;
    expect(await finishSliced(counting(100), async () => void (turns += 1), 60_000)).toBe(5050);
    expect(turns).toBe(0);
  });
});

describe('sortSteps', () => {
  it('sorts exactly like Array.sort (ties keep their order), for sizes around the chunk edges', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    for (const n of [0, 1, 99, 100, 101, 1000, 2503]) {
      const items = Array.from({ length: n }, (_, i) => ({ key: rnd() % 50, i }));
      const expected = items.toSorted((a, b) => a.key - b.key);
      const got = items.slice();
      finishSync(sortSteps(got, (a, b) => a.key - b.key, 100));
      expect(got).toEqual(expected);
    }
  });
});

describe('hashPlan', () => {
  const legacy = (p: { items: readonly PlanItem[]; relinks: readonly { path: string; copyRowId: number }[]; leftOut: readonly { key: string; files: number }[]; folder: string }): string =>
    createHash('sha256')
      .update(JSON.stringify({ f: p.folder, i: p.items.map((i) => [i.path, i.size, i.mtimeSec, i.destRel]), r: p.relinks.map((r) => [r.path, r.copyRowId]), l: p.leftOut.map((l) => [l.key, l.files]) }))
      .digest('hex');
  const item = (n: number): PlanItem => ({ path: `/sdcard/DCIM/a "${n}".jpg`, size: n, mtimeSec: 1000 + n, kind: 'new', rowId: n, destRel: `MyData/P/a ${n}.jpg`, candidates: [] });

  it('is the checksum the one-go version always made, so a plan made before and checked after still matches', () => {
    for (const n of [0, 1, 199, 200, 201, 1000]) {
      const parts = { items: Array.from({ length: n }, (_, i) => item(i)), relinks: [{ path: '/sdcard/x', copyRowId: 3 }], leftOut: [{ key: 'a|b', files: 2 }], folder: 'POCO-23Nov26' };
      expect(hashPlan(parts)).toBe(legacy(parts));
    }
  });
});

describe('recording a look in slices', () => {
  let rig: Rig;
  const T = 1_700_000_000;
  const phoneFiles = (from: number, to: number): PhoneListedFile[] => Array.from({ length: to - from }, (_, i) => ({ path: `/sdcard/DCIM/Camera/IMG_${String(from + i).padStart(5, '0')}.jpg`, size: 100 + from + i, mtimeSec: T + from + i }));
  const compareOf = (listed: PhoneListedFile[]): ReturnType<typeof compareLook> => compareLook({ listed, indexed: loadPhoneIndex(rig.db, 'ph', ['/sdcard/DCIM']), folders: ['/sdcard/DCIM'] });
  const rows = (): number => rig.db.prepare('SELECT count(*) FROM files WHERE place_id = ?').pluck().get('ph') as number;
  const goneRows = (): number => rig.db.prepare('SELECT count(*) FROM files WHERE place_id = ? AND gone_at IS NOT NULL').pluck().get('ph') as number;
  const lookedAt = (): number | null => rig.db.prepare("SELECT last_looked_at FROM places WHERE id = 'ph'").pluck().get() as number | null;

  beforeEach(() => {
    rig = makeRig();
    rig.db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES ('ph', 1, 'phone', 'p', '{}', 1)").run();
    // Every check of the time slice says "used up", so every slice ends with a turn.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 25));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rig.close();
  });

  it('writes everything: new rows, then the gone marks, then the time of the look', async () => {
    await recordLook(rig.db, 'ph', compareOf(phoneFiles(0, 1300)), 10);
    expect(rows()).toBe(1300);
    expect(lookedAt()).toBe(10);
    const done = await recordLook(rig.db, 'ph', compareOf(phoneFiles(300, 1400)), 20);
    expect(done).toMatchObject({ added: 100, markedGone: 300 });
    expect(rows()).toBe(1400);
    expect(goneRows()).toBe(300);
    expect(lookedAt()).toBe(20);
  });

  it('a stop part-way (the job is aborted) marks nothing gone and does not say the look was recorded: the next look decides again', async () => {
    await recordLook(rig.db, 'ph', compareOf(phoneFiles(0, 1300)), 10);
    const second = compareOf(phoneFiles(300, 2000));
    let turns = 0;
    const stop = async (): Promise<void> => {
      turns += 1;
      if (turns === 1) throw new Error('aborted');
    };
    await expect(recordLook(rig.db, 'ph', second, 20, stop)).rejects.toThrow('aborted');
    // The new rows of the first slices are in (each is true), but no file was marked gone and the look is not marked as made.
    expect(rows()).toBe(1300 + 500);
    expect(goneRows()).toBe(0);
    expect(lookedAt()).toBe(10);
    // Looking again from the half-written state finishes the job with the same final picture as an uninterrupted look.
    await recordLook(rig.db, 'ph', compareOf(phoneFiles(300, 2000)), 30);
    expect(rows()).toBe(2000);
    expect(goneRows()).toBe(300);
    expect(lookedAt()).toBe(30);
  });

  it('reads the index and the copies page by page without losing or repeating a row', () => {
    const insert = rig.db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, kind) VALUES ('ph', ?, 1, 1, 1, 1, 'photos')");
    rig.db.transaction(() => {
      for (let i = 0; i < 4500; i += 1) insert.run(`sdcard/DCIM/f${String(i).padStart(5, '0')}.jpg`);
      for (let i = 0; i < 30; i += 1) insert.run(`sdcard/Other/o${i}.jpg`);
    })();
    const index = loadPhoneIndex(rig.db, 'ph', ['/sdcard/DCIM', '/sdcard/Other']);
    expect(index).toHaveLength(4530);
    expect(new Set(index.map((r) => r.id)).size).toBe(4530);
    expect(index.map((r) => r.relPath).slice(0, 2)).toEqual(['sdcard/DCIM/f00000.jpg', 'sdcard/DCIM/f00001.jpg']);
    // Copies: a row at "another place" for every phone row, asked about in pages of 2,000 ids.
    rig.db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES ('dr', 1, 'drive', 'd', '{}', 1)").run();
    rig.db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, kind, origin_file_id) SELECT 'dr', 'x/' || rel_path, size, mtime, 1, 1, 'photos', id FROM files WHERE place_id = 'ph'").run();
    const copies = loadCopies(rig.db, index.map((r) => r.id));
    expect(copies).toHaveLength(4530);
    expect(new Set(copies.map((c) => c.originFileId)).size).toBe(4530);
  });
});

describe('writeSliced', () => {
  it('starts small, shrinks to one row when a row is slow, and carries what it learned to the next call through memo', async () => {
    const sizes: number[] = [];
    let clock = 0;
    const realNow = performance.now.bind(performance);
    const memo = { rows: 2 };
    // Each row "takes" 30 ms (like a cold write on the real db).
    performance.now = () => clock;
    try {
      const write = (slice: readonly number[]): void => {
        sizes.push(slice.length);
        clock += 30 * slice.length;
      };
      await writeSliced(Array.from({ length: 10 }, (_, i) => i), write, { pause: () => Promise.resolve(), memo });
      expect(sizes[0]).toBe(2);
      expect(sizes.slice(1).every((n) => n === 1)).toBe(true);
      expect(memo.rows).toBe(1);
      sizes.length = 0;
      await writeSliced([1, 2, 3], write, { pause: () => Promise.resolve(), memo });
      expect(sizes).toEqual([1, 1, 1]);
    } finally {
      performance.now = realNow;
    }
  });

  it('writes every item exactly once, in order', async () => {
    const seen: number[] = [];
    await writeSliced(Array.from({ length: 1000 }, (_, i) => i), (s) => void seen.push(...s), { pause: () => Promise.resolve() });
    expect(seen).toEqual(Array.from({ length: 1000 }, (_, i) => i));
  });
});
