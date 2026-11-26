import { describe, expect, it } from 'vitest';
import { PROGRESS_FAILED_LIMIT, PROGRESS_NEXT_LIMIT, PROGRESS_RECENT_LIMIT } from '../../shared/phoneBackup';
import { RunProgress } from './runProgress';

const items = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `/sdcard/f${String(i).padStart(4, '0')}.jpg`, size: 100 + i }));

describe('the live progress of a phone backup run', () => {
  it('starts with everything waiting and nothing being copied', () => {
    const s = new RunProgress(items(5)).snapshot(1);
    expect(s).toMatchObject({ jobId: 1, total: 5, done: 0, waiting: 5, failedCount: 0, current: null, recent: [], failed: [], finished: false });
    expect(s.next.map((f) => f.path)).toEqual(items(5).map((i) => i.path));
  });

  it('follows one file at a time: the file now, those waiting in order, the ones done newest first', () => {
    const list = items(4);
    const p = new RunProgress(list);
    p.begin(0);
    expect(p.snapshot(1)).toMatchObject({ current: list[0], done: 0, waiting: 3 });
    expect(p.snapshot(1).next).toEqual(list.slice(1));
    p.done();
    p.begin(1);
    p.done();
    p.begin(2);
    const s = p.snapshot(1);
    expect(s).toMatchObject({ current: list[2], done: 2, waiting: 1 });
    expect(s.recent).toEqual([list[1], list[0]]);
    expect(s.next).toEqual([list[3]]);
  });

  it('keeps a file that was not copied with its reason, and counts it as finished, not done', () => {
    const list = items(3);
    const p = new RunProgress(list);
    p.begin(0);
    p.fail("The copy did not match the phone's checksum.");
    p.begin(1);
    p.done();
    const s = p.snapshot(1);
    expect(s.failedCount).toBe(1);
    expect(s.failed).toEqual([{ ...list[0], reason: "The copy did not match the phone's checksum." }]);
    expect(s.done).toBe(1);
    expect(s.waiting).toBe(1);
    expect(s.recent).toEqual([list[1]]);
  });

  it('ends cleanly: nothing is being copied and the snapshot says it is over', () => {
    const p = new RunProgress(items(3));
    p.begin(0);
    p.end();
    expect(p.snapshot(1)).toMatchObject({ current: null, finished: true });
    p.done();
    expect(p.snapshot(1).done).toBe(0);
  });

  it('carries on after a restart: the files before the start point are done or failed already', () => {
    const list = items(5);
    const p = new RunProgress(list, 3, [{ path: list[1]!.path, reason: 'gone' }]);
    const s = p.snapshot(9);
    expect(s).toMatchObject({ done: 2, failedCount: 1, waiting: 2, current: null });
    expect(s.next).toEqual(list.slice(3));
  });

  it('caps every list but counts everything (100,000 files stay small)', () => {
    const list = items(1000);
    const p = new RunProgress(list);
    for (let i = 0; i < 600; i += 1) {
      p.begin(i);
      if (i % 2 === 0) p.done();
      else p.fail(`reason ${i}`);
    }
    const s = p.snapshot(1);
    expect(s.done).toBe(300);
    expect(s.failedCount).toBe(300);
    expect(s.waiting).toBe(400);
    expect(s.next).toHaveLength(PROGRESS_NEXT_LIMIT);
    expect(s.recent).toHaveLength(PROGRESS_RECENT_LIMIT);
    expect(s.failed).toHaveLength(PROGRESS_FAILED_LIMIT);
    expect(s.recent[0]).toEqual(list[598]);
    expect(s.failed[0]!.path).toBe(list[599]!.path);
  });
});
