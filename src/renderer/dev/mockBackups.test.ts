import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installMockApi } from './mockApi';

type Win = { location: { hash: string }; localStorage: { getItem: () => null; setItem: () => void }; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval; backupHub?: unknown };
const g = globalThis as unknown as { window?: Win };

beforeEach(() => {
  g.window = { location: { hash: '#/backups?mock' }, localStorage: { getItem: () => null, setItem: () => undefined }, setTimeout, clearTimeout, setInterval, clearInterval };
  installMockApi();
});
afterEach(() => {
  delete g.window;
});

const api = () => (g.window!.backupHub as { backups: { overview(): Promise<{ backups: { id: number; fromOldTool?: boolean; enabled: boolean }[]; removed?: { id: number; name: string }[] }>; sizes(): Promise<{ ok: boolean; sizes?: unknown[] }>; archive(id: number, c: boolean): Promise<{ ok: boolean; message: string }>; unarchive(id: number): Promise<{ ok: boolean; message: string }> }; jobs: { list(): Promise<{ kind: string; backupIds?: number[] }[]> } });

describe('the sample data of the Backups pages (?mock)', () => {
  it('has the three kinds, the old-tool flag and sizes that arrive a moment later', async () => {
    const o = await api().backups.overview();
    expect(o.backups.map((b) => b.id)).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(o.backups.find((b) => b.id === 1)!.fromOldTool).toBe(true);
    expect(o.removed).toEqual([]);
    const sizes = await api().backups.sizes();
    expect(sizes.ok).toBe(true);
    expect(sizes.sizes).toHaveLength(3);
  });

  it('Remove from list takes a switched-off backup off the list and Put back returns it; a switched-on one is refused', async () => {
    expect((await api().backups.archive(1, true)).ok).toBe(false);
    expect((await api().backups.archive(3, false)).ok).toBe(false);
    expect((await api().backups.archive(3, true)).ok).toBe(true);
    const after = await api().backups.overview();
    expect(after.backups.map((b) => b.id)).not.toContain(3);
    expect(after.removed!.map((r) => r.id)).toEqual([3]);
    await api().backups.unarchive(3);
    const back = await api().backups.overview();
    expect(back.backups.map((b) => b.id)).toContain(3);
    expect(back.removed).toEqual([]);
  });

  it('the sample jobs name their backup', async () => {
    const jobs = await api().jobs.list();
    expect(jobs.filter((j) => j.kind.startsWith('phone.') || j.kind.startsWith('mirror.')).every((j) => j.backupIds?.includes(1))).toBe(true);
  });
});
