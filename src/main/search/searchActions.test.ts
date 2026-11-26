import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, type Db } from '../db';
import { isDriveLink, looksLikeEmail, SearchActions, withAuthUser } from './searchActions';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const BASE = path.resolve('/bh-test-drive');
const LAPTOP_ROOT = path.resolve('/bh-test-laptop/MyData');
const slashes = (p: string): string => p.split(path.sep).join('/');

let dir: string;
let db: Db;
let shown: string[];
let opened: string[];
let existing: Set<string>;
let connected: Map<string, string>; // place id -> base folder
let roots: Map<string, string[]>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-actions-'));
  const result = initDatabase(dir, silent);
  if (!result.ok) throw new Error('db did not open');
  db = result.db;
  for (const [id, kind] of [
    ['lap', 'laptop'],
    ['t7', 'drive'],
    ['od', 'onedrive'],
    ['g1', 'gdrive'],
  ] as const) {
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES (?, 1, ?, ?, 'connected', 1)").run(id, kind, id.toUpperCase());
  }
  shown = [];
  opened = [];
  existing = new Set();
  connected = new Map([
    ['lap', ''],
    ['t7', BASE],
    ['od', path.resolve('/bh-test-od')],
  ]);
  roots = new Map([
    ['lap', [LAPTOP_ROOT]],
    ['t7', ['Backups']],
    ['od', ['']],
    ['g1', ['']],
  ]);
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

function file(place: string, rel: string, extra: { link?: string; gone?: boolean } = {}): number {
  return Number(
    db
      .prepare('INSERT INTO files (place_id, rel_path, size, web_link, first_seen_at, last_seen_at, gone_at) VALUES (?, ?, 1, ?, 1, 2, ?)')
      .run(place, rel, extra.link ?? null, extra.gone ? 9 : null).lastInsertRowid,
  );
}

const actions = (): SearchActions =>
  new SearchActions({
    db,
    baseOf: (p) => connected.get(p.id) ?? null,
    rootsOf: (id) => roots.get(id) ?? [],
    exists: (p) => existing.has(p),
    showItem: (p) => void shown.push(p),
    openExternal: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
  });

describe('Show in folder guard', () => {
  it('opens a laptop file that is inside a listed folder and exists', () => {
    const abs = path.join(LAPTOP_ROOT, 'Reunion', 'a.mp4');
    existing.add(abs);
    const id = file('lap', slashes(abs));
    expect(actions().showInFolder(id)).toEqual({ ok: true });
    expect(shown).toEqual([abs]);
  });

  it('refuses a path outside every listed folder', () => {
    const abs = path.resolve('/bh-test-laptop/Other/a.mp4');
    existing.add(abs);
    const result = actions().showInFolder(file('lap', slashes(abs)));
    expect(result.ok).toBe(false);
    expect(shown).toEqual([]);
  });

  it('refuses a path that climbs out with ..', () => {
    const sneaky = `${slashes(LAPTOP_ROOT)}/../Other/a.mp4`;
    existing.add(path.resolve(sneaky));
    expect(actions().showInFolder(file('lap', sneaky)).ok).toBe(false);
    expect(shown).toEqual([]);
  });

  it('refuses a file that is not there any more', () => {
    const abs = path.join(LAPTOP_ROOT, 'missing.mp4');
    const result = actions().showInFolder(file('lap', slashes(abs)));
    expect(result.ok).toBe(false);
    expect(shown).toEqual([]);
  });

  it('refuses a place that is not connected', () => {
    connected.delete('t7');
    const id = file('t7', 'Backups/a.jpg');
    existing.add(path.join(BASE, 'Backups', 'a.jpg'));
    const result = actions().showInFolder(id);
    expect(result.ok).toBe(false);
    expect(shown).toEqual([]);
  });

  it('joins a drive file to the drive root, and only inside the listed folders of that drive', () => {
    existing.add(path.join(BASE, 'Backups', 'a.jpg'));
    existing.add(path.join(BASE, 'Private', 'b.jpg'));
    expect(actions().showInFolder(file('t7', 'Backups/a.jpg'))).toEqual({ ok: true });
    expect(shown).toEqual([path.join(BASE, 'Backups', 'a.jpg')]);
    expect(actions().showInFolder(file('t7', 'Private/b.jpg')).ok).toBe(false);
    expect(shown).toHaveLength(1);
  });

  it('a whole-place root (empty) allows any file of OneDrive', () => {
    const abs = path.join(path.resolve('/bh-test-od'), 'Docs', 'x.pdf');
    existing.add(abs);
    expect(actions().showInFolder(file('od', 'Docs/x.pdf'))).toEqual({ ok: true });
    expect(shown).toEqual([abs]);
  });

  it('refuses Google Drive copies, rows marked gone, unknown ids and bad ids', () => {
    const g = file('g1', 'My Drive/a.pdf');
    const gone = file('lap', slashes(path.join(LAPTOP_ROOT, 'old.txt')), { gone: true });
    for (const id of [g, gone, 99999, 0, -1, 1.5, '1', null, undefined]) {
      expect(actions().showInFolder(id).ok, String(id)).toBe(false);
    }
    expect(shown).toEqual([]);
  });

  it('refuses when the place lists no folders at all', () => {
    roots.set('t7', []);
    existing.add(path.join(BASE, 'Backups', 'a.jpg'));
    expect(actions().showInFolder(file('t7', 'Backups/a.jpg')).ok).toBe(false);
  });
});

describe('Open in Drive guard', () => {
  it('accepts only https addresses on drive.google.com and docs.google.com', () => {
    const good = ['https://drive.google.com/file/d/abc/view', 'https://docs.google.com/document/d/abc/edit?usp=drivesdk'];
    for (const link of good) expect(isDriveLink(link), link).toBe(true);
    const bad = [
      'http://drive.google.com/file/d/abc',
      'https://drive.google.com.evil.example/file',
      'https://evil.example/https://drive.google.com/',
      'https://user:pw@drive.google.com/file',
      'https://drive.google.com:8443/file',
      'https://www.google.com/',
      'https://notdrive.google.com/',
      'javascript:alert(1)',
      'file:///C:/Windows/System32/calc.exe',
      'ftp://drive.google.com/x',
      'drive.google.com/file',
      '',
      null,
      undefined,
      42,
      `https://drive.google.com/${'a'.repeat(2100)}`,
    ];
    for (const link of bad) expect(isDriveLink(link), String(link)).toBe(false);
  });

  it('opens the stored link of a Drive copy, and nothing else', async () => {
    const link = 'https://drive.google.com/file/d/abc/view';
    expect(await actions().openInDrive(file('g1', 'My Drive/a.pdf', { link }))).toEqual({ ok: true });
    expect(opened).toEqual([link]);
    const evil = file('g1', 'My Drive/b.pdf', { link: 'https://evil.example/' });
    const none = file('g1', 'My Drive/c.pdf');
    const local = file('lap', slashes(path.join(LAPTOP_ROOT, 'd.pdf')), { link });
    const gone = file('g1', 'My Drive/e.pdf', { link, gone: true });
    for (const id of [evil, none, local, gone, 99999, 'x']) expect((await actions().openInDrive(id)).ok, String(id)).toBe(false);
    expect(opened).toEqual([link]);
  });
});

describe('Open in Drive as the right account', () => {
  it('adds authuser to a link without a query, with a query, and replaces an old authuser', () => {
    expect(withAuthUser('https://drive.google.com/file/d/abc/view', 'sam@example.com')).toBe('https://drive.google.com/file/d/abc/view?authuser=sam%40example.com');
    expect(withAuthUser('https://docs.google.com/document/d/abc/edit?usp=drivesdk', 'sam@example.com')).toBe(
      'https://docs.google.com/document/d/abc/edit?usp=drivesdk&authuser=sam%40example.com',
    );
    expect(withAuthUser('https://drive.google.com/file/d/abc/view?authuser=0&usp=sharing#x', 'sam@example.com')).toBe(
      'https://drive.google.com/file/d/abc/view?authuser=sam%40example.com&usp=sharing#x',
    );
  });

  it('leaves the link alone when the label is not an email or the link is not a Drive link', () => {
    const link = 'https://drive.google.com/file/d/abc/view';
    for (const label of ['G1', 'My Drive', '', 'a@b', 'a b@c.com', 'x@y.com&authuser=9', null, 5]) expect(withAuthUser(link, label), String(label)).toBe(link);
    expect(withAuthUser('https://evil.example/x', 'sam@example.com')).toBe('https://evil.example/x');
    expect(looksLikeEmail('sam.lee+x@mail.example.com')).toBe(true);
  });

  it('opens a Drive copy of an account labelled with its email as that account', async () => {
    db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('g2', 1, 'gdrive', 'sam@example.com', 'connected', 1)").run();
    const id = file('g2', 'My Drive/a.pdf', { link: 'https://drive.google.com/file/d/abc/view?usp=drivesdk' });
    expect(await actions().openInDrive(id)).toEqual({ ok: true });
    expect(opened).toEqual(['https://drive.google.com/file/d/abc/view?usp=drivesdk&authuser=sam%40example.com']);
  });
});
