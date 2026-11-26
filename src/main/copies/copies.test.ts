import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, type Db } from '../db';
import { allFingerprintCounts, copiesFor, placeCoverage } from './copiesIndex';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
let db: Db;

const LAPTOP = 'laptop-1';
const T7 = 'drive-t7';
const OD = 'onedrive-1';
const G1 = 'gdrive-1';
const G2 = 'gdrive-2';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-copies-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  for (const [id, kind, label] of [
    [LAPTOP, 'laptop', 'STUDY-PC'],
    [T7, 'drive', 'T7'],
    [OD, 'onedrive', 'OneDrive'],
    [G1, 'gdrive', 'Mail 1'],
    [G2, 'gdrive', 'Mail 2'],
  ] as const) {
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES (?, 1, ?, ?, 'connected', 1)").run(id, kind, label);
  }
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Add {
  sha?: string | null;
  md5?: string | null;
  size?: number | null;
  gone?: boolean;
  cloud?: boolean;
  error?: string | null;
}
/** A local row: when fingerprinted it has both sha256 and md5, like the hash job writes. */
function add(place: string, rel: string, o: Add = {}): number {
  const size = o.size === undefined ? 100 : o.size;
  const r = db
    .prepare(
      `INSERT INTO files (place_id, rel_path, size, sha256, md5, first_seen_at, last_seen_at, gone_at, cloud_only, hash_error)
       VALUES (?, ?, ?, ?, ?, 1, 2, ?, ?, ?)`,
    )
    .run(place, rel, size, o.sha ?? null, o.md5 ?? null, o.gone ? 5 : null, o.cloud ? 1 : 0, o.error ?? null);
  return Number(r.lastInsertRowid);
}
const local = (sha: string, md5: string): Add => ({ sha, md5 });
const drive = (md5: string, size = 100): Add => ({ md5, size });

describe('copiesFor', () => {
  it('local to local matches by sha256, in every other place, with the path', () => {
    const mine = add(LAPTOP, 'D:/MyData/a.jpg', local('s1', 'm1'));
    add(T7, 'Backup/a-copy.jpg', local('s1', 'm1'));
    add(OD, 'Pictures/a.jpg', local('s1', 'm1'));
    add(T7, 'Backup/other.jpg', local('s2', 'm2'));
    const copies = copiesFor(db, mine);
    expect(copies.map((c) => [c.placeLabel, c.relPath, c.match])).toEqual([
      ['OneDrive', 'Pictures/a.jpg', 'sha256'],
      ['T7', 'Backup/a-copy.jpg', 'sha256'],
    ]);
    expect(copies[0]).toMatchObject({ placeId: OD, placeKind: 'onedrive', size: 100, cloudOnly: false });
  });

  it('local to Google Drive matches by md5 plus size, both ways, and Drive to Drive too', () => {
    const mine = add(LAPTOP, 'D:/MyData/b.pdf', local('s9', 'abc123'));
    const g1 = add(G1, 'My Drive/b.pdf', drive('abc123'));
    add(G2, 'My Drive/b-again.pdf', drive('abc123'));
    add(G1, 'My Drive/wrong-size.pdf', drive('abc123', 999));
    add(G1, 'My Drive/other.pdf', drive('zzz'));
    const fromLocal = copiesFor(db, mine);
    expect(fromLocal.map((c) => [c.placeLabel, c.relPath, c.match])).toEqual([
      ['Mail 1', 'My Drive/b.pdf', 'md5+size'],
      ['Mail 2', 'My Drive/b-again.pdf', 'md5+size'],
    ]);
    const fromDrive = copiesFor(db, g1);
    expect(fromDrive.map((c) => [c.placeLabel, c.relPath, c.match])).toEqual([
      ['Mail 2', 'My Drive/b-again.pdf', 'md5+size'],
      ['STUDY-PC', 'D:/MyData/b.pdf', 'md5+size'],
    ]);
  });

  it('a local file is matched by sha256 first, so a same-md5 different-content local file is not a copy', () => {
    const mine = add(LAPTOP, 'D:/x', local('sA', 'collide'));
    add(T7, 'y', local('sB', 'collide')); // md5 collision with a different sha256: not the same content
    expect(copiesFor(db, mine)).toEqual([]);
  });

  it('ignores gone rows, itself, files with no checksum and cloud-only rows without one; says nothing for a gone file', () => {
    const mine = add(LAPTOP, 'D:/a', local('s1', 'm1'));
    add(T7, 'gone', { ...local('s1', 'm1'), gone: true });
    add(OD, 'cloud-unknown', { cloud: true });
    add(OD, 'not-hashed');
    expect(copiesFor(db, mine)).toEqual([]);
    const goneRow = add(LAPTOP, 'D:/b', { ...local('s1', 'm1'), gone: true });
    expect(copiesFor(db, goneRow)).toEqual([]);
    expect(copiesFor(db, 999999)).toEqual([]);
    const unhashed = add(LAPTOP, 'D:/c');
    expect(copiesFor(db, unhashed)).toEqual([]);
  });

  it('shows another path in the same place (a duplicate), and a cloud-only row that still has an old fingerprint', () => {
    const mine = add(LAPTOP, 'D:/a', local('s1', 'm1'));
    add(LAPTOP, 'D:/a-dup', local('s1', 'm1'));
    add(OD, 'old-cloud', { ...local('s1', 'm1'), cloud: true });
    const copies = copiesFor(db, mine);
    expect(copies.map((c) => [c.placeId, c.relPath, c.cloudOnly])).toEqual([
      [OD, 'old-cloud', true],
      [LAPTOP, 'D:/a-dup', false],
    ]);
  });
});

describe('placeCoverage', () => {
  it('counts files and bytes with 0, 1 and 2+ copies in OTHER places, plus not fingerprinted and cloud-only', () => {
    // Laptop: 6 files.
    add(LAPTOP, 'D:/solo.bin', { ...local('sSolo', 'mSolo'), size: 10 }); // no copy
    add(LAPTOP, 'D:/on-t7.bin', { ...local('sT7', 'mT7'), size: 20 }); // one other place (T7)
    add(T7, 'on-t7.bin', { ...local('sT7', 'mT7'), size: 20 });
    add(LAPTOP, 'D:/everywhere.bin', { ...local('sAll', 'mAll'), size: 30 }); // T7 + Drive
    add(T7, 'everywhere.bin', { ...local('sAll', 'mAll'), size: 30 });
    add(G1, 'My Drive/everywhere.bin', drive('mAll', 30));
    add(LAPTOP, 'D:/only-drive.bin', { ...local('sD', 'mD'), size: 40 }); // one place: Google Drive, by md5+size
    add(G2, 'My Drive/only-drive.bin', drive('mD', 40));
    add(LAPTOP, 'D:/waiting.bin', { size: 50 }); // not fingerprinted
    add(LAPTOP, 'D:/failed.bin', { size: 5, error: 'busy' }); // not fingerprinted either
    // Gone rows elsewhere do not count as copies; a gone row here is not counted at all.
    add(OD, 'solo-gone-copy.bin', { ...local('sSolo', 'mSolo'), gone: true });
    add(LAPTOP, 'D:/removed.bin', { ...local('sR', 'mR'), gone: true, size: 7 });
    // Two copies of the same content in ONE other place count as one place.
    add(LAPTOP, 'D:/twice.bin', { ...local('sTw', 'mTw'), size: 60 });
    add(T7, 'twice-1.bin', { ...local('sTw', 'mTw'), size: 60 });
    add(T7, 'twice-2.bin', { ...local('sTw', 'mTw'), size: 60 });

    const c = placeCoverage(db, LAPTOP);
    expect(c.none).toEqual({ files: 1, bytes: 10 });
    expect(c.one).toEqual({ files: 3, bytes: 20 + 40 + 60 });
    expect(c.twoPlus).toEqual({ files: 1, bytes: 30 });
    expect(c.notFingerprinted).toEqual({ files: 2, bytes: 55 });
    expect(c.cloudOnly).toEqual({ files: 0, bytes: 0 });
  });

  it('counts OneDrive placeholders on their own (copies unknown) and still counts their hashed siblings', () => {
    add(OD, 'cloud-1.docx', { cloud: true, size: 11 });
    add(OD, 'cloud-2.docx', { cloud: true, size: 12 });
    add(OD, 'here.docx', { ...local('sH', 'mH'), size: 13 });
    add(LAPTOP, 'D:/here-copy.docx', { ...local('sH', 'mH'), size: 13 });
    const c = placeCoverage(db, OD);
    expect(c.cloudOnly).toEqual({ files: 2, bytes: 23 });
    expect(c.one).toEqual({ files: 1, bytes: 13 });
    expect(c.none.files + c.twoPlus.files + c.notFingerprinted.files).toBe(0);
  });

  it('works for a Google Drive place (md5 + size against local files) and an empty place', () => {
    add(G1, 'My Drive/a.pdf', drive('mA', 70));
    add(G1, 'My Drive/Doc', { size: null }); // a Google Doc: no md5, no size
    add(LAPTOP, 'D:/a.pdf', { ...local('sA', 'mA'), size: 70 });
    const c = placeCoverage(db, G1);
    expect(c.one).toEqual({ files: 1, bytes: 70 });
    expect(c.notFingerprinted).toEqual({ files: 1, bytes: 0 });
    expect(placeCoverage(db, 'no-such-place')).toEqual({
      none: { files: 0, bytes: 0 },
      one: { files: 0, bytes: 0 },
      twoPlus: { files: 0, bytes: 0 },
      notFingerprinted: { files: 0, bytes: 0 },
      cloudOnly: { files: 0, bytes: 0 },
      empty: { files: 0, bytes: 0 },
    });
  });

  it('many identical files (for example thousands of tiny ones) are looked up once, not once per file', () => {
    const insert = db.prepare("INSERT INTO files (place_id, rel_path, size, sha256, md5, first_seen_at, last_seen_at) VALUES (?, ?, 1, 'sTiny', 'mTiny', 1, 2)");
    db.transaction(() => {
      for (let i = 0; i < 6000; i += 1) {
        insert.run(LAPTOP, `D:/empty/${i}`);
        insert.run(T7, `empty/${i}`);
      }
    })();
    const started = Date.now();
    const c = placeCoverage(db, LAPTOP);
    expect(c.one).toEqual({ files: 6000, bytes: 6000 });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('counts per place for the Devices screen: files, fingerprinted, bytes, failed (cloud-only and gone left out)', () => {
    add(LAPTOP, 'a', { ...local('s', 'm'), size: 10 });
    add(LAPTOP, 'b', { size: 30 });
    add(LAPTOP, 'c', { size: 5, error: 'busy' });
    add(LAPTOP, 'd', { size: 99, cloud: true });
    add(LAPTOP, 'e', { size: 99, gone: true });
    expect(allFingerprintCounts(db).get(LAPTOP)).toEqual({ fileCount: 3, fingerprintedFiles: 1, totalBytes: 45, fingerprintedBytes: 10, failedFiles: 1 });
  });
});

describe('placeCoverage on a big catalog', () => {
  it('300,000 synthetic rows (laptop, T7, OneDrive, Google Drive) answer in seconds, not minutes', () => {
    const insert = db.prepare(
      `INSERT INTO files (place_id, rel_path, size, sha256, md5, first_seen_at, last_seen_at, cloud_only)
       VALUES (@place, @rel, @size, @sha, @md5, 1, 2, @cloud)`,
    );
    const total = 300_000;
    db.transaction(() => {
      // Content k exists on the laptop for k in [0, 150k); T7 holds every 2nd one, OneDrive every 5th,
      // Google Drive every 3rd (md5 only). 10% of laptop rows are not fingerprinted.
      for (let k = 0; k < 150_000; k += 1) {
        const sha = `sha${k}`;
        const md5 = `md5${k}`;
        const size = (k % 5000) + 1;
        const fingerprinted = k % 10 !== 0;
        insert.run({ place: LAPTOP, rel: `D:/f/${k}`, size, sha: fingerprinted ? sha : null, md5: fingerprinted ? md5 : null, cloud: 0 });
        if (k % 2 === 0) insert.run({ place: T7, rel: `f/${k}`, size, sha, md5, cloud: 0 });
        if (k % 5 === 0) insert.run({ place: OD, rel: `f/${k}`, size, sha, md5, cloud: 0 });
        if (k % 3 === 0) insert.run({ place: G1, rel: `My Drive/${k}`, size, sha: null, md5, cloud: 0 });
      }
      // Pad with unrelated rows up to 300k.
      const have = (db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n;
      for (let i = 0; have + i < total; i += 1) {
        insert.run({ place: G2, rel: `My Drive/pad/${i}`, size: 5, sha: null, md5: `pad${i}`, cloud: 0 });
      }
    })();
    expect((db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }).n).toBeGreaterThanOrEqual(total);

    const started = Date.now();
    const c = placeCoverage(db, LAPTOP);
    const elapsed = Date.now() - started;

    // About 1 s on an idle laptop; the bound is loose because the suite runs files in parallel on 2 cores
    // (2.3 s seen with the app open). It still catches a return to per-row lookups (minutes).
    expect(elapsed).toBeLessThan(10_000);
    const counted = c.none.files + c.one.files + c.twoPlus.files + c.notFingerprinted.files + c.cloudOnly.files;
    expect(counted).toBe(150_000);
    expect(c.notFingerprinted.files).toBe(15_000);
    // Spot check against a direct count: fingerprinted laptop rows with a copy in none of the others.
    // k % 10 !== 0 and k odd, not multiple of 5 and not multiple of 3.
    let none = 0;
    for (let k = 0; k < 150_000; k += 1) if (k % 10 !== 0 && k % 2 !== 0 && k % 5 !== 0 && k % 3 !== 0) none += 1;
    expect(c.none.files).toBe(none);
  }, 120_000);
});
