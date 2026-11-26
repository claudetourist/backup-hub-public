import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { finishSliced, finishSync, turn } from '../sliceWork';
import { MAX_MOVED_GROUPS } from '../../shared/folderBackup';
import { groupMovesSteps } from './movedGroups';

const group = (moves: { from: string; to: string }[]): ReturnType<typeof finishSync<{ groups: { kind: string; from: string; to: string; files: number }[]; files: number }>> => finishSync(groupMovesSteps(moves));

describe('files renamed or moved, told one line per folder', () => {
  it('a folder renamed: one line, whatever is below it', () => {
    expect(group([
      { from: 'Trip/a.jpg', to: 'Goa 2026/a.jpg' },
      { from: 'Trip/2025/b.jpg', to: 'Goa 2026/2025/b.jpg' },
      { from: 'Trip/2025/deep/c.jpg', to: 'Goa 2026/2025/deep/c.jpg' },
    ])).toEqual({ groups: [{ kind: 'folder_renamed', from: 'Trip', to: 'Goa 2026', files: 3 }], files: 3 });
  });

  it('a sub-folder renamed inside a folder is a rename; a folder put inside another is a move', () => {
    expect(group([{ from: 'A/Old/x.txt', to: 'A/New/x.txt' }]).groups[0]).toMatchObject({ kind: 'folder_renamed', from: 'A/Old', to: 'A/New' });
    expect(group([{ from: 'Docs/x.txt', to: 'Archive/Docs/x.txt' }]).groups[0]).toMatchObject({ kind: 'folder_moved', from: 'Docs', to: 'Archive/Docs' });
    expect(group([{ from: 'A/x.txt', to: 'B/C/x.txt' }]).groups[0]).toMatchObject({ kind: 'folder_moved', from: 'A', to: 'B/C' });
  });

  it('a file whose own name changed is counted with the files renamed on their own', () => {
    expect(group([{ from: 'A/x.txt', to: 'A/y.txt' }, { from: 'A/p.txt', to: 'B/q.txt' }])).toEqual({ groups: [{ kind: 'files', from: '', to: '', files: 2 }], files: 2 });
  });

  it('case does not tell two folders apart (Windows) and the biggest groups come first', () => {
    const moves = [
      ...Array.from({ length: 3 }, (_, i) => ({ from: `small/f${i}`, to: `Little/f${i}` })),
      ...Array.from({ length: 5 }, (_, i) => ({ from: `big/f${i}`, to: `Large/F${i}` })),
    ];
    const r = group(moves);
    expect(r.groups.map((g) => [g.from, g.to, g.files])).toEqual([['big', 'Large', 5], ['small', 'Little', 3]]);
  });

  it('only the biggest groups are carried; the total counts them all', () => {
    const moves = Array.from({ length: MAX_MOVED_GROUPS + 5 }, (_, i) => ({ from: `old${i}/f.txt`, to: `new${i}/f.txt` }));
    const r = group(moves);
    expect(r.groups).toHaveLength(MAX_MOVED_GROUPS);
    expect(r.files).toBe(MAX_MOVED_GROUPS + 5);
  });

  it('100,000 moved files are grouped without blocking the window (a turn of the loop between slices)', async () => {
    const moves = Array.from({ length: 100_000 }, (_, i) => ({ from: `Trip/d${i % 500}/f${i}.bin`, to: `Goa 2026/d${i % 500}/f${i}.bin` }));
    let max = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      max = Math.max(max, now - last - 10);
      last = now;
    }, 10);
    const t0 = performance.now();
    const r = await finishSliced(groupMovesSteps(moves), turn);
    clearInterval(timer);
    console.log(`[moved groups] 100,000 files: ${Math.round(performance.now() - t0)} ms in all, longest block ${Math.round(max)} ms`);
    expect(r.groups).toEqual([{ kind: 'folder_renamed', from: 'Trip', to: 'Goa 2026', files: 100_000 }]);
    expect(max).toBeLessThan(250);
  });
});
