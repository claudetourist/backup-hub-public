import { describe, expect, it } from 'vitest';
import { backedUpAt, compareLook, judgeChange, type CopyRow, type DestinationRef, type IndexedPhoneFile, type PhoneListedFile } from './compare';

const T = 1_700_000_000; // seconds
const row = (id: number, rel: string, size: number | null, mtimeSec: number | null, extra: Partial<IndexedPhoneFile> = {}): IndexedPhoneFile => ({ id, relPath: rel, size, mtimeMs: mtimeSec === null ? null : mtimeSec * 1000, sha256: null, goneAt: null, ...extra });
const file = (p: string, size: number, mtimeSec = T): PhoneListedFile => ({ path: p, size, mtimeSec });
const F = ['/sdcard/DCIM'];
const NFD = 'e' + String.fromCharCode(0x301) + '.jpg';
const NFC = String.fromCharCode(0xe9) + '.jpg';

function copy(id: number, origin: number | null, rel: string, size: number | null, extra: Partial<CopyRow> = {}): CopyRow {
  return { id, placeId: 'drive1', relPath: rel, size, mtimeMs: T * 1000, sha256: null, expectedSha256: null, originFileId: origin, verifiedHow: 'read_both', goneAt: null, ...extra };
}

describe('judging a change', () => {
  it('phones: size AND date (the same size is never a change; a date alone is never a change)', () => {
    const before = { size: 100, mtimeMs: T * 1000 };
    expect(judgeChange('size_and_date', before, { size: 101, mtimeMs: (T + 60) * 1000 })).toBe('changed');
    expect(judgeChange('size_and_date', before, { size: 101, mtimeMs: T * 1000 })).toBe('same');
    expect(judgeChange('size_and_date', before, { size: 100, mtimeMs: (T + 60) * 1000 })).toBe('same');
    expect(judgeChange('size_and_date', before, { size: 100, mtimeMs: T * 1000 })).toBe('same');
  });

  it('dates within 2 seconds are one date', () => {
    const before = { size: 100, mtimeMs: T * 1000 };
    expect(judgeChange('size_or_date', before, { size: 100, mtimeMs: T * 1000 + 2000 })).toBe('same');
    expect(judgeChange('size_or_date', before, { size: 100, mtimeMs: T * 1000 - 2000 })).toBe('same');
    expect(judgeChange('size_or_date', before, { size: 100, mtimeMs: T * 1000 + 2001 })).toBe('changed');
    expect(judgeChange('size_and_date', before, { size: 999, mtimeMs: T * 1000 + 2000 })).toBe('same');
    expect(judgeChange('size_and_date', before, { size: 999, mtimeMs: T * 1000 + 2001 })).toBe('changed');
  });

  it('folders: size OR date; the same size and a date off by whole hours waits for a checksum', () => {
    const before = { size: 100, mtimeMs: T * 1000 };
    expect(judgeChange('size_or_date', before, { size: 101, mtimeMs: T * 1000 })).toBe('changed');
    expect(judgeChange('size_or_date', before, { size: 100, mtimeMs: (T + 3600) * 1000 })).toBe('confirm');
    expect(judgeChange('size_or_date', before, { size: 100, mtimeMs: (T - 7200) * 1000 + 1500 })).toBe('confirm');
    expect(judgeChange('size_or_date', before, { size: 100, mtimeMs: (T + 3600 + 60) * 1000 })).toBe('changed');
    expect(judgeChange('size_or_date', before, { size: 101, mtimeMs: (T + 3600) * 1000 })).toBe('changed');
  });

  it('an unknown size or date counts as different (copying again costs space, never data)', () => {
    expect(judgeChange('size_and_date', { size: null, mtimeMs: null }, { size: 1, mtimeMs: 1 })).toBe('changed');
    expect(judgeChange('size_and_date', { size: 2, mtimeMs: null }, { size: 1, mtimeMs: 1 })).toBe('changed');
    expect(judgeChange('size_and_date', { size: 1, mtimeMs: null }, { size: 1, mtimeMs: 1 })).toBe('same'); // the same size is never a change on a phone
    expect(judgeChange('size_and_date', { size: 1, mtimeMs: 1 }, { size: 1, mtimeMs: 1 })).toBe('same');
  });
});

describe('compare: new / changed / gone / came back', () => {
  it('sorts every listed file and every known row', () => {
    const r = compareLook({
      folders: F,
      listed: [file('/sdcard/DCIM/same.jpg', 10), file('/sdcard/DCIM/new.jpg', 5), file('/sdcard/DCIM/edited.jpg', 21, T + 100), file('/sdcard/DCIM/back.jpg', 7)],
      indexed: [row(1, 'sdcard/DCIM/same.jpg', 10, T), row(2, 'sdcard/DCIM/edited.jpg', 20, T), row(3, 'sdcard/DCIM/gone.jpg', 3, T), row(4, 'sdcard/DCIM/back.jpg', 7, T, { goneAt: 99 }), row(5, 'sdcard/DCIM/oldgone.jpg', 7, T, { goneAt: 98 })],
    });
    const byPath = Object.fromEntries(r.entries.map((e) => [e.path, e]));
    expect(byPath['/sdcard/DCIM/same.jpg']).toMatchObject({ kind: 'same', indexId: 1, previous: null });
    expect(byPath['/sdcard/DCIM/new.jpg']).toMatchObject({ kind: 'new', indexId: null, relPath: 'sdcard/DCIM/new.jpg' });
    expect(byPath['/sdcard/DCIM/edited.jpg']).toMatchObject({ kind: 'changed', indexId: 2, previous: { size: 20, mtimeMs: T * 1000 } });
    expect(byPath['/sdcard/DCIM/back.jpg']).toMatchObject({ kind: 'came_back', indexId: 4 });
    expect(r.gone.map((g) => g.id)).toEqual([3]);
    expect(r.counts).toEqual({ new: 1, changed: 1, cameBack: 1, same: 1, gone: 1, indexedLive: 3, listed: 4 });
  });

  it('a gone file is found only inside the folders that were looked at, and not below a folder that could not be read', () => {
    const r = compareLook({
      folders: ['/sdcard/DCIM'],
      unreadable: ['/sdcard/DCIM/.thumbnails'],
      listed: [],
      indexed: [row(1, 'sdcard/Documents/a.txt', 1, T), row(2, 'sdcard/DCIM/.thumbnails/t.jpg', 1, T), row(3, 'sdcard/DCIM/b.jpg', 1, T), row(4, 'sdcard/DCIMX/c.jpg', 1, T)],
    });
    expect(r.gone.map((g) => g.id)).toEqual([3]);
    expect(r.counts.indexedLive).toBe(1);
  });

  it('names are one name in NFC; case counts (Android tells A.jpg and a.jpg apart)', () => {
    const r = compareLook({ folders: F, listed: [file(`/sdcard/DCIM/${NFD}`, 10), file('/sdcard/DCIM/A.jpg', 1), file('/sdcard/DCIM/a.jpg', 1)], indexed: [row(1, `sdcard/DCIM/${NFC}`, 10, T), row(2, 'sdcard/DCIM/a.jpg', 1, T)] });
    const byPath = Object.fromEntries(r.entries.map((e) => [e.path, e]));
    expect(byPath[`/sdcard/DCIM/${NFD}`]).toMatchObject({ kind: 'same', indexId: 1, relPath: `sdcard/DCIM/${NFC}` });
    expect(byPath['/sdcard/DCIM/A.jpg']!.kind).toBe('new');
    expect(byPath['/sdcard/DCIM/a.jpg']!.kind).toBe('same');
    expect(r.gone).toEqual([]);
  });

  it('two phone names that are one name in NFC are a clash: nothing is decided about them', () => {
    const r = compareLook({ folders: F, listed: [file(`/sdcard/DCIM/${NFD}`, 1), file(`/sdcard/DCIM/${NFC}`, 2)], indexed: [row(1, `sdcard/DCIM/${NFC}`, 2, T)] });
    expect(r.clashes).toHaveLength(1);
    expect(r.entries).toEqual([]);
    expect(r.gone).toEqual([]);
  });

  it('a changed file whose phone row has a checksum: the checksum no longer describes it', () => {
    const copies: CopyRow[] = [copy(10, 1, 'MyData/POCO/d1/sdcard/DCIM/a.jpg', 20, { sha256: 'aa', verifiedHow: 'read_both' })];
    const dest: DestinationRef = { id: 1, placeId: 'drive1', root: 'MyData/POCO', position: 1 };
    const r = compareLook({ folders: F, destinations: [dest], copies, listed: [file('/sdcard/DCIM/a.jpg', 21, T + 100)], indexed: [row(1, 'sdcard/DCIM/a.jpg', 20, T, { sha256: 'aa' })] });
    expect(r.entries[0]).toMatchObject({ kind: 'changed' });
    expect(r.entries[0]!.destinations[0]).toMatchObject({ backedUp: false });
  });
});

describe('backed up at destination X', () => {
  const d1: DestinationRef = { id: 1, placeId: 'drive1', root: 'MyData/POCO', position: 1 };
  const d2: DestinationRef = { id: 2, placeId: 'drive2', root: 'MyData/POCO', position: 2 };
  const now = { size: 20, mtimeMs: T * 1000, sha256: null as string | null };
  const ok = (c: CopyRow[], dest = d1, current = now, rule: 'size_and_date' | 'size_or_date' = 'size_and_date') => backedUpAt(1, current, dest, c, rule);

  it('needs a row at that destination pointing at the phone row, under its root, not gone, of the current size', () => {
    const base = copy(10, 1, 'MyData/POCO/POCO-d1/sdcard/DCIM/a.jpg', 20);
    expect(ok([base])).toEqual({ destinationId: 1, backedUp: true, worth: 'verified', copyId: 10 });
    expect(ok([{ ...base, originFileId: 2 }]).backedUp).toBe(false);
    expect(ok([{ ...base, goneAt: 5 }]).backedUp).toBe(false);
    expect(ok([{ ...base, placeId: 'drive2' }]).backedUp).toBe(false);
    expect(ok([{ ...base, relPath: 'Other/a.jpg' }]).backedUp).toBe(false);
    expect(ok([{ ...base, relPath: 'MyData/POCOX/a.jpg' }]).backedUp).toBe(false);
    expect(ok([{ ...base, size: 19 }]).backedUp).toBe(false);
    expect(ok([base], d2).backedUp).toBe(false);
    expect(ok([{ ...base, placeId: 'drive2' }], d2).backedUp).toBe(true);
    expect(ok([{ ...base, relPath: 'mydata/poco/x/a.jpg' }]).backedUp).toBe(true); // drive paths ignore case
  });

  it('where both checksums are known they must agree; else the change rule decides', () => {
    const base = copy(10, 1, 'MyData/POCO/d/a.jpg', 20, { sha256: 'aa' });
    expect(ok([base], d1, { ...now, sha256: 'aa' }).backedUp).toBe(true);
    expect(ok([base], d1, { ...now, sha256: 'bb' }).backedUp).toBe(false);
    expect(ok([{ ...base, sha256: null, expectedSha256: 'aa' }], d1, { ...now, sha256: 'aa' }).backedUp).toBe(true);
    // same checksum, other date: the checksum wins
    expect(ok([{ ...base, mtimeMs: (T + 500) * 1000 }], d1, { ...now, sha256: 'aa' }).backedUp).toBe(true);
    // no checksum: the phone rule (size AND date) calls it unchanged; a folder rule needs the date too
    expect(ok([{ ...base, sha256: null, mtimeMs: (T + 500) * 1000 }]).backedUp).toBe(true);
    expect(ok([{ ...base, sha256: null, mtimeMs: (T + 500) * 1000 }], d1, now, 'size_or_date').backedUp).toBe(false);
  });

  it('only read_both is verified; imported, name_size and the rest stop a recopy but are unverified', () => {
    for (const how of ['imported', 'name_size', 'none', null]) expect(ok([copy(10, 1, 'MyData/POCO/a.jpg', 20, { verifiedHow: how })])).toMatchObject({ backedUp: true, worth: 'unverified' });
    expect(ok([copy(10, 1, 'MyData/POCO/a.jpg', 20, { verifiedHow: 'read_both' })])).toMatchObject({ worth: 'verified' });
  });

  it("a copy that \"Check old copies\" found different (differs) is no copy at all: the file counts as not backed up, whatever else the row says", () => {
    const base = copy(10, 1, 'MyData/POCO/a.jpg', 20, { verifiedHow: 'imported', sha256: 'aa' });
    expect(ok([base], d1, { ...now, sha256: 'aa' }).backedUp).toBe(true);
    for (const how of ['differs']) {
      expect(ok([{ ...base, verifiedHow: how }], d1, { ...now, sha256: 'aa' })).toEqual({ destinationId: 1, backedUp: false, worth: null, copyId: null });
      expect(ok([{ ...base, verifiedHow: how, sha256: null }]).backedUp).toBe(false);
    }
    // Another, good copy of the same file still counts; the different one is passed over.
    const good = copy(11, 1, 'MyData/POCO/b.jpg', 20, { verifiedHow: 'read_both' });
    expect(ok([{ ...base, verifiedHow: 'differs' }, good])).toMatchObject({ backedUp: true, copyId: 11, worth: 'verified' });
  });

  it('with several matching copies the verified one is named, then the newest', () => {
    const copies = [copy(10, 1, 'MyData/POCO/a.jpg', 20, { verifiedHow: 'imported' }), copy(11, 1, 'MyData/POCO/b.jpg', 20, { verifiedHow: 'read_both' }), copy(12, 1, 'MyData/POCO/c.jpg', 20, { verifiedHow: 'imported' })];
    expect(ok(copies)).toMatchObject({ copyId: 11, worth: 'verified' });
    expect(ok([copies[0]!, copies[2]!])).toMatchObject({ copyId: 12 });
  });

  it('every listed file carries one state per destination, in destination order; a new file is backed up nowhere', () => {
    const r = compareLook({
      folders: F,
      destinations: [d2, d1],
      copies: [copy(10, 1, 'MyData/POCO/a.jpg', 20), copy(11, 1, 'MyData/POCO/a.jpg', 20, { placeId: 'drive2', verifiedHow: 'imported' })],
      listed: [file('/sdcard/DCIM/a.jpg', 20), file('/sdcard/DCIM/n.jpg', 1)],
      indexed: [row(1, 'sdcard/DCIM/a.jpg', 20, T)],
    });
    const a = r.entries.find((e) => e.path.endsWith('a.jpg'))!;
    expect(a.destinations.map((d) => [d.destinationId, d.backedUp, d.worth])).toEqual([[1, true, 'verified'], [2, true, 'unverified']]);
    expect(r.entries.find((e) => e.path.endsWith('n.jpg'))!.destinations.map((d) => d.backedUp)).toEqual([false, false]);
  });

  it('old versions of a file never count for its current version', () => {
    // v1 (size 20) was copied; the phone file is now 25 bytes and its row was updated in place
    const r = compareLook({ folders: F, destinations: [d1], copies: [copy(10, 1, 'MyData/POCO/d1/a.jpg', 20, { sha256: 'v1' })], listed: [file('/sdcard/DCIM/a.jpg', 25, T + 50)], indexed: [row(1, 'sdcard/DCIM/a.jpg', 25, T + 50)] });
    expect(r.entries[0]).toMatchObject({ kind: 'same' });
    expect(r.entries[0]!.destinations[0]!.backedUp).toBe(false);
  });
});
