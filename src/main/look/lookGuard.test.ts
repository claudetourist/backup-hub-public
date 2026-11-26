import { describe, expect, it } from 'vitest';
import type { PhoneLook } from '../adb/phoneLook';
import type { IndexedPhoneFile } from './compare';
import { DEFAULT_LOOK_POLICY, evaluateLook } from './lookGuard';

const T = 1_700_000_000;
const rows = (n: number): IndexedPhoneFile[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, relPath: `sdcard/DCIM/f${i}.jpg`, size: 10 + i, mtimeMs: T * 1000, sha256: null, goneAt: null }));
const look = (files: { i: number; size?: number; mtimeSec?: number }[], extra: Partial<PhoneLook> = {}): PhoneLook => ({
  serial: 'S',
  folders: ['/sdcard/DCIM'],
  complete: true,
  files: files.map((f) => ({ path: `/sdcard/DCIM/f${f.i}.jpg`, size: f.size ?? 10 + f.i, mtimeSec: f.mtimeSec ?? T })),
  perFolder: [],
  problems: [],
  unreadable: [],
  absentFolders: [],
  ...extra,
});
const all = (n: number): { i: number }[] => Array.from({ length: n }, (_, i) => ({ i }));

describe('the guard: an incomplete or doubtful look changes nothing and asks', () => {
  it('an incomplete look is a decision with the reasons; nothing is compared; only "try again" is offered', () => {
    const out = evaluateLook({ look: look(all(3), { complete: false, problems: [{ folder: '/sdcard/DCIM', kind: 'no_marker', detail: 'stopped part-way' }] }), indexed: rows(3) });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.compare).toBeNull();
    expect(out.decision).toMatchObject({ kind: 'look_incomplete', options: ['try_again'], title: "The phone's file list looks wrong" });
    expect(out.decision.reasons).toEqual(['/sdcard/DCIM: stopped part-way']);
    expect(out.decision.plain).toMatch(/nothing was changed/i);
    // "accept" cannot turn an incomplete look into a good one
    expect(evaluateLook({ look: look(all(3), { complete: false, problems: [] }), indexed: rows(3), accept: ['look_incomplete' as never] }).ok).toBe(false);
  });

  it('a look of no folder is not complete', () => {
    const out = evaluateLook({ look: look([], { complete: false, folders: [] }), indexed: [] });
    expect(out.ok).toBe(false);
  });

  it('an empty listing where files were before is a decision (accept waives it)', () => {
    const out = evaluateLook({ look: look([]), indexed: rows(5) });
    expect(out).toMatchObject({ ok: false, decision: { kind: 'look_empty', options: ['try_again', 'accept'] } });
    const accepted = evaluateLook({ look: look([]), indexed: rows(5), accept: ['look_empty'] });
    expect(accepted).toMatchObject({ ok: true, accepted: 'look_empty' });
    if (accepted.ok) expect(accepted.compare.gone).toHaveLength(5);
  });

  it('accepting an empty listing also covers the mass-change rule (one answer, not two questions)', () => {
    const out = evaluateLook({ look: look([]), indexed: rows(20), accept: ['look_empty'] });
    expect(out).toMatchObject({ ok: true, accepted: 'look_empty' });
    if (out.ok) expect(out.compare.gone).toHaveLength(20);
    // ...but accepting an empty listing does not excuse a non-empty one that lost a lot
    expect(evaluateLook({ look: look(all(5)), indexed: rows(20), accept: ['look_empty'] })).toMatchObject({ ok: false, decision: { kind: 'look_mass_change' } });
  });

  it('an empty listing where nothing was known is just an empty phone', () => {
    expect(evaluateLook({ look: look([]), indexed: [] })).toMatchObject({ ok: true, accepted: null });
  });

  it('more than 30% gone or changed is a decision; exactly 30% is not', () => {
    const base = rows(10);
    const keep = (n: number) => all(10).slice(0, n); // n of the 10 files are still there
    expect(evaluateLook({ look: look(keep(7)), indexed: base })).toMatchObject({ ok: true }); // 3 gone = 30%
    const out = evaluateLook({ look: look(keep(6)), indexed: base }); // 4 gone = 40%
    expect(out).toMatchObject({ ok: false, decision: { kind: 'look_mass_change', numbers: { known: 10, gone: 4, listed: 6 } } });
    expect(evaluateLook({ look: look(keep(6)), indexed: base, accept: ['look_mass_change'] })).toMatchObject({ ok: true, accepted: 'look_mass_change' });
  });

  it('changed files count too (a wholesale change of every file)', () => {
    const edited = all(10).map((f) => ({ i: f.i, size: 999 + f.i, mtimeSec: T + 5000 }));
    expect(evaluateLook({ look: look(edited), indexed: rows(10) })).toMatchObject({ ok: false, decision: { kind: 'look_mass_change', numbers: { changed: 10 } } });
    const few = all(10).map((f) => (f.i < 3 ? { i: f.i, size: 999, mtimeSec: T + 5000 } : { i: f.i }));
    expect(evaluateLook({ look: look(few), indexed: rows(10) })).toMatchObject({ ok: true });
  });

  it('new files never raise the alarm; a small phone is not judged by percentages', () => {
    expect(evaluateLook({ look: look([...all(10), { i: 50 }, { i: 51 }, { i: 52 }, { i: 53 }, { i: 54 }]), indexed: rows(10) })).toMatchObject({ ok: true });
    expect(evaluateLook({ look: look(all(2)), indexed: rows(3) })).toMatchObject({ ok: true }); // 1 of 3 gone, below the minimum
    expect(DEFAULT_LOOK_POLICY).toEqual({ massChangePercent: 30, massChangeMinFiles: 10 });
  });

  it('the percentage is a setting', () => {
    const strict = { massChangePercent: 5, massChangeMinFiles: 10 };
    expect(evaluateLook({ look: look(all(9)), indexed: rows(10), policy: strict })).toMatchObject({ ok: false });
    expect(evaluateLook({ look: look(all(9)), indexed: rows(10) })).toMatchObject({ ok: true });
  });

  it('a folder the phone refused does not count as gone files', () => {
    const base = rows(10).map((r, i) => ({ id: r.id, relPath: i < 5 ? `sdcard/DCIM/.thumbnails/f${i}.jpg` : r.relPath, size: r.size, mtimeMs: r.mtimeMs, sha256: null, goneAt: null }));
    const out = evaluateLook({ look: look(all(10).slice(5), { unreadable: ['/sdcard/DCIM/.thumbnails'] }), indexed: base });
    expect(out).toMatchObject({ ok: true });
    if (out.ok) expect(out.compare.counts).toMatchObject({ gone: 0, indexedLive: 5 });
  });

  it('a name clash is a decision and nothing else is decided', () => {
    const nfd = 'e' + String.fromCharCode(0x301) + '.jpg';
    const nfc = String.fromCharCode(0xe9) + '.jpg';
    const out = evaluateLook({ look: look([], { files: [{ path: `/sdcard/DCIM/${nfd}`, size: 1, mtimeSec: T }, { path: `/sdcard/DCIM/${nfc}`, size: 1, mtimeSec: T }] }), indexed: [] });
    expect(out).toMatchObject({ ok: false, decision: { kind: 'look_name_clash', options: ['try_again'] } });
  });
});
