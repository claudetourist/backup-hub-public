import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addIndexRows, addPlace, makeRig, type IndexRow, type Rig } from '../backupProfiles/fixtures.testutil';
import { insertFakeRows } from '../bigCatalog.testUtil';
import { folderOf, ONLY_HERE_SUMMARY_SQL, onlyHereSummaryOf, WOULD_LOSE_ROWS_SQL, wouldLoseFilesOf, wouldLoseOf } from './wouldLose';

let rig: Rig;
beforeEach(() => {
  rig = makeRig();
  addPlace(rig.db, 'laptop', 'laptop', 'This laptop');
  addPlace(rig.db, 't7', 'drive', 'T7');
  addPlace(rig.db, 'phone', 'phone', 'Poco');
  addPlace(rig.db, 'od', 'onedrive', 'OneDrive');
});
afterEach(() => rig.close());

const setKind = (place: string, rel: string, kind: string): void => void rig.db.prepare('UPDATE files SET kind = ? WHERE place_id = ? AND rel_path = ?').run(kind, place, rel);

describe('What would I lose? (the files with no checked copy anywhere else)', () => {
  beforeEach(() => {
    addIndexRows(rig.db, [
      { place: 'laptop', rel: 'Pictures/2023/a.jpg', size: 100, sha: 'A' },
      { place: 'laptop', rel: 'Pictures/2023/b.jpg', size: 200, sha: 'B' },
      { place: 'laptop', rel: 'Docs/c.doc', size: 300, sha: null },
      { place: 'laptop', rel: 'Docs/z.doc', size: 77, sha: null },
      { place: 'laptop', rel: 'Docs/d.txt', size: 50, sha: 'D' },
      { place: 'laptop', rel: 'Docs/empty.txt', size: 0, sha: null },
      { place: 'laptop', rel: 'Docs/gone.txt', size: 9, sha: 'G', gone: 5 },
      { place: 'laptop', rel: 'top.txt', size: 5, sha: 'T' },
      { place: 'laptop', rel: 'Dup/b2.jpg', size: 200, sha: 'B' },
      { place: 't7', rel: 'MyData/Laptop/Pictures/2023/a.jpg', size: 100, sha: 'A' },
      { place: 't7', rel: 'MyData/Laptop/Backup/c.doc', size: 300, sha: null },
      { place: 't7', rel: 'MyData/Laptop/Backup/d.txt', size: 50, sha: 'D2' },
      { place: 't7', rel: 'MyData/Laptop/top.txt', size: 5, sha: 'T', gone: 7 },
      { place: 't7', rel: 'MyData/Only/x.bin', size: 40, sha: 'X' },
    ]);
    rig.db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('laptop', 'Docs/n.bin', NULL, 1, 1)").run();
    setKind('laptop', 'Pictures/2023/b.jpg', 'photo-camera');
    setKind('laptop', 'Dup/b2.jpg', 'photo-camera');
    setKind('laptop', 'Docs/z.doc', 'documents');
    setKind('laptop', 'Docs/c.doc', 'documents');
  });

  it('only counts a file as safe when ANOTHER device holds the same SHA-256 (not a gone row, not the same device)', () => {
    const d = wouldLoseOf(rig.db, 'laptop');
    // b.jpg, b2.jpg (same device twice is no copy), z.doc, top.txt (its copy is gone), n.bin (no size: 0 bytes)
    expect(d.onlyHere).toMatchObject({ files: 5, bytes: 200 + 200 + 77 + 5 });
    expect(d.totalFiles).toBe(8);
  });

  it('shows a same-name-and-size file elsewhere as "maybe copied", never as safe, and says which files have no fingerprint', () => {
    const d = wouldLoseOf(rig.db, 'laptop');
    expect(d.maybeCopied).toMatchObject({ files: 2, bytes: 350 });
    expect(d.notChecked).toEqual({ files: 3, bytes: 300 + 77 });
  });

  it('groups by kind and folder, biggest first, empty files left out', () => {
    const d = wouldLoseOf(rig.db, 'laptop');
    expect(d.onlyHere.kinds.map((k) => [k.kind, k.files, k.bytes])).toEqual([['photo-camera', 2, 400], ['documents', 1, 77], ['other', 2, 5]]);
    expect(d.onlyHere.kinds[0]!.folders).toEqual([
      { folder: 'Dup', files: 1, bytes: 200 },
      { folder: 'Pictures/2023', files: 1, bytes: 200 },
    ]);
    expect(d.onlyHere.kinds[2]!.folders.map((f) => f.folder).toSorted()).toEqual(['(top level)', 'Docs']);
    expect(d.maybeCopied.kinds.map((k) => k.kind)).toEqual(['documents', 'other']);
  });

  it('a drive is grouped one folder deeper (its first folders are the app\'s own)', () => {
    const d = wouldLoseOf(rig.db, 't7');
    expect(d.onlyHere.files).toBe(1);
    expect(d.onlyHere.kinds[0]!.folders[0]!.folder).toBe('MyData/Only');
    expect(folderOf('MyData/Laptop/Pictures/a.jpg', 3)).toBe('MyData/Laptop/Pictures');
  });

  it('lists only the biggest 6 folders of a kind and lumps the rest together', () => {
    const rows: IndexRow[] = [];
    for (let i = 0; i < 9; i += 1) rows.push({ place: 'phone', rel: `DCIM/f${i}/p.jpg`, size: 10 * (i + 1), sha: 'P' + i });
    addIndexRows(rig.db, rows);
    rig.db.prepare("UPDATE files SET kind = 'photo-camera' WHERE place_id = 'phone'").run();
    const k = wouldLoseOf(rig.db, 'phone').onlyHere.kinds[0]!;
    expect(k.folders).toHaveLength(6);
    expect(k.folders[0]).toEqual({ folder: 'DCIM/f8', files: 1, bytes: 90 });
    expect(k.rest).toEqual({ folders: 3, files: 3, bytes: 10 + 20 + 30 });
  });

  it('the one-line summary is for the named drives only and is the detail\'s "only here" and "maybe copied" together', () => {
    const summary = onlyHereSummaryOf(rig.db);
    expect(summary.map((s) => s.placeId)).toEqual(['t7']);
    const d = wouldLoseOf(rig.db, 't7');
    expect(summary[0]).toEqual({ placeId: 't7', files: d.onlyHere.files + d.maybeCopied.files, bytes: d.onlyHere.bytes + d.maybeCopied.bytes });
    expect(summary[0]!.files).toBeGreaterThan(0);
  });

  it('never writes anything', () => {
    const before = rig.db.prepare('SELECT count(*) FROM files').pluck().get();
    wouldLoseOf(rig.db, 'laptop');
    onlyHereSummaryOf(rig.db);
    expect(rig.db.prepare('SELECT count(*) FROM files').pluck().get()).toBe(before);
  });
});

describe('What would I lose? by backup, and the list of files', () => {
  const backup = (name: string, kind: 'phone' | 'folder', over: { place?: string; dest?: { place: string; root: string }; archived?: boolean } = {}): number => {
    const id = Number(
      rig.db
        .prepare("INSERT INTO backup_profiles (person_id, name, source_kind, source_place_id, folder_prefix, change_rule, created_at, archived_at) VALUES (1, ?, ?, ?, '', 'size_and_date', 1, ?)")
        .run(name, kind, over.place ?? null, over.archived ? 5 : null).lastInsertRowid,
    );
    if (over.dest) rig.db.prepare('INSERT INTO backup_destinations (backup_profile_id, place_id, root) VALUES (?, ?, ?)').run(id, over.dest.place, over.dest.root);
    return id;
  };

  it('splits what only lives on a drive by the backup folder it is in (the deepest folder wins), and the rest as "Not part of any backup"', () => {
    const poco = backup('Poco F4', 'phone', { dest: { place: 't7', root: 'MyData/POCO' } });
    const imp = backup('IMP folder', 'folder', { dest: { place: 't7', root: 'MyData\\POCO\\IMP/' } });
    backup('Old one', 'folder', { dest: { place: 't7', root: 'MyData/Other' }, archived: true });
    addIndexRows(rig.db, [
      { place: 't7', rel: 'MyData/POCO/a.jpg', size: 100, sha: null },
      { place: 't7', rel: 'mydata/poco/IMP/b.doc', size: 500, sha: null },
      { place: 't7', rel: 'MyData/POCO2/c.bin', size: 30, sha: null },
      { place: 't7', rel: 'MyData/Other/d.bin', size: 70, sha: null },
    ]);
    const only = wouldLoseOf(rig.db, 't7').onlyHere;
    expect(only.byBackup).toEqual([
      { backupId: imp, name: 'IMP folder', files: 1, bytes: 500 },
      { backupId: null, name: 'Not part of any backup', files: 2, bytes: 100 },
      { backupId: poco, name: 'Poco F4', files: 1, bytes: 100 },
    ]);
  });

  it('a phone that is the source of a phone backup is that backup', () => {
    const poco = backup('Poco F4', 'phone', { place: 'phone' });
    addIndexRows(rig.db, [{ place: 'phone', rel: 'DCIM/Camera/a.jpg', size: 10, sha: 'P1' }]);
    expect(wouldLoseOf(rig.db, 'phone').onlyHere.byBackup).toEqual([{ backupId: poco, name: 'Poco F4', files: 1, bytes: 10 }]);
  });

  describe('the files, biggest first', () => {
    beforeEach(() => {
      addIndexRows(rig.db, [
        { place: 'laptop', rel: 'Pictures/Trip 2023/a.jpg', size: 100, sha: 'A1' },
        { place: 'laptop', rel: 'Pictures/Trip 2023/b.jpg', size: 900, sha: 'A2' },
        { place: 'laptop', rel: 'Docs/100%_done.doc', size: 300, sha: null },
        { place: 'laptop', rel: 'Docs/plain.doc', size: 300, sha: 'A3' },
        { place: 'laptop', rel: 'Docs/copied.doc', size: 10, sha: 'A4' },
        { place: 'laptop', rel: 'Docs/safe.doc', size: 999, sha: 'S' },
        { place: 'laptop', rel: 'Docs/empty.doc', size: 0, sha: 'E' },
        { place: 'phone', rel: 'x/copied.doc', size: 10, sha: null },
        { place: 't7', rel: 'MyData/safe.doc', size: 999, sha: 'S' },
      ]);
      setKind('laptop', 'Pictures/Trip 2023/a.jpg', 'photo-camera');
      setKind('laptop', 'Pictures/Trip 2023/b.jpg', 'photo-camera');
    });
    const ask = (over: Partial<Parameters<typeof wouldLoseFilesOf>[1]> = {}) => wouldLoseFilesOf(rig.db, { placeId: 'laptop', part: 'onlyHere', search: '', offset: 0, kind: null, ...over });

    it('lists the files with no checked copy, biggest first, and the "maybe copied" ones apart', () => {
      expect(ask().files.map((f) => [f.path, f.size, f.unchecked])).toEqual([
        ['Pictures/Trip 2023/b.jpg', 900, false],
        ['Docs/100%_done.doc', 300, true],
        ['Docs/plain.doc', 300, false],
        ['Pictures/Trip 2023/a.jpg', 100, false],
      ]);
      expect(ask({ part: 'maybeCopied' }).files.map((f) => f.path)).toEqual(['Docs/copied.doc']);
    });

    it('finds all the words typed in the path, case does not matter, and % and _ are letters', () => {
      expect(ask({ search: 'trip JPG' }).files.map((f) => f.path)).toEqual(['Pictures/Trip 2023/b.jpg', 'Pictures/Trip 2023/a.jpg']);
      expect(ask({ search: '100%' }).files.map((f) => f.path)).toEqual(['Docs/100%_done.doc']);
      expect(ask({ search: '%' }).files).toHaveLength(1);
      expect(ask({ search: '_' }).files).toHaveLength(1);
      expect(ask({ search: 'nothing like this' }).files).toEqual([]);
    });

    it('can be narrowed to a kind', () => {
      expect(ask({ kind: 'photo-camera' }).files).toHaveLength(2);
      expect(ask({ kind: 'other' }).files.map((f) => f.path)).toEqual(['Docs/100%_done.doc', 'Docs/plain.doc']);
    });

    it('pages: 100 at a time, and says when more follow', () => {
      const rows: IndexRow[] = Array.from({ length: 130 }, (_, i) => ({ place: 'od', rel: `f/n${String(i).padStart(3, '0')}.bin`, size: 1000 - i, sha: null }));
      addIndexRows(rig.db, rows);
      const first = wouldLoseFilesOf(rig.db, { placeId: 'od', part: 'onlyHere', search: '', offset: 0, kind: null });
      expect(first.files).toHaveLength(100);
      expect(first.more).toBe(true);
      const second = wouldLoseFilesOf(rig.db, { placeId: 'od', part: 'onlyHere', search: '', offset: 100, kind: null });
      expect(second.files.map((f) => f.size)).toEqual(Array.from({ length: 30 }, (_, i) => 900 - i));
      expect(second.more).toBe(false);
    });

    it('agrees with the counts of the same device', () => {
      const d = wouldLoseOf(rig.db, 'laptop');
      expect(ask().files.reduce((s, f) => s + f.size, 0)).toBe(d.onlyHere.bytes);
      expect(ask({ part: 'maybeCopied' }).files).toHaveLength(d.maybeCopied.files);
    });
  });
});

describe('What would I lose? on a generated catalog', () => {
  it('matches a plain re-count of 4 devices of random rows', () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const places = ['laptop', 't7', 'phone', 'od'];
    const rows: IndexRow[] = [];
    for (let i = 0; i < 4000; i += 1) {
      const place = places[rnd(4)]!;
      rows.push({ place, rel: `d${rnd(20)}/n${rnd(60)}-${i}.dat`.replace(/-\d+/, rnd(5) === 0 ? '' : '-' + rnd(8)), size: rnd(6) === 0 ? 0 : 100 + rnd(12), sha: rnd(4) === 0 ? null : 'S' + rnd(900), gone: rnd(10) === 0 ? 9 : null });
    }
    // The unique (place, rel_path) index: drop repeats.
    const seen = new Set<string>();
    const unique = rows.filter((r) => !seen.has(r.place + '|' + r.rel) && seen.add(r.place + '|' + r.rel));
    addIndexRows(rig.db, unique);
    const live = unique.filter((r) => r.gone === null && r.size !== 0);
    const nameOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);
    const summary = onlyHereSummaryOf(rig.db);
    for (const place of places) {
      let only = 0;
      let onlyBytes = 0;
      let maybe = 0;
      let maybeBytes = 0;
      for (const r of live.filter((x) => x.place === place)) {
        const checked = r.sha !== null && live.some((o) => o.place !== place && o.sha === r.sha);
        if (checked) continue;
        const similar = live.some((o) => o.place !== place && o.size === r.size && nameOf(o.rel) === nameOf(r.rel));
        if (similar) {
          maybe += 1;
          maybeBytes += r.size;
        } else {
          only += 1;
          onlyBytes += r.size;
        }
      }
      const d = wouldLoseOf(rig.db, place);
      expect([d.onlyHere.files, d.onlyHere.bytes, d.maybeCopied.files]).toEqual([only, onlyBytes, maybe]);
      const s = summary.find((x) => x.placeId === place);
      // The summary is for the named drives only: it holds the drive's files without a checked copy, "maybe" ones included.
      if (place === 't7') expect([s?.files ?? 0, s?.bytes ?? 0]).toEqual([only + maybe, onlyBytes + maybeBytes]);
      else expect(s).toBeUndefined();
    }
  });

  it('uses the two indexes for the lookups (EXPLAIN QUERY PLAN), never a scan per file', () => {
    insertFakeRows(rig.db, 'laptop', 'L', 2000, { fingerprinted: true });
    for (const sql of [ONLY_HERE_SUMMARY_SQL, WOULD_LOSE_ROWS_SQL]) {
      const plan = (rig.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(sql === WOULD_LOSE_ROWS_SQL ? { placeId: 'laptop' } : {}) as { detail: string }[]).map((r) => r.detail).join('\n');
      expect(plan).toContain('idx_files_sha256_live');
      if (sql === WOULD_LOSE_ROWS_SQL) expect(plan).toContain('idx_files_size_name');
      expect(plan).not.toMatch(/SCAN o|SCAN m/);
    }
  });
});
