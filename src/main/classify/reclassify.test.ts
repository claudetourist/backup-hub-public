import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, type Db } from '../db';
import { reclassifyOtherSql } from '../db/migrations/0012_reclassify_other';
import { classifyChunk } from './sortKinds';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-reclass-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('laptop-1', 1, 'laptop', 'L', 'connected', 1)").run();
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('migration 0012', () => {
  it('sends only the "other" photo and video rows back to be sorted again, and the job then finds the new camera names', () => {
    const insert = db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at, kind) VALUES ('laptop-1', ?, 1, 1, 2, ?)");
    insert.run('D:/Pics/0I2A1030.JPG', 'photo-other');
    insert.run('D:/Vids/GOPR0123.MP4', 'video-other');
    insert.run('D:/Pics/holiday plan.jpg', 'photo-other');
    insert.run('D:/Music/song.mp3', 'audio-music');
    insert.run('D:/Pics/shot.jpg', 'photo-camera');
    db.exec(reclassifyOtherSql);
    const kinds = (): Record<string, string | null> => Object.fromEntries((db.prepare('SELECT rel_path, kind FROM files').all() as { rel_path: string; kind: string | null }[]).map((r) => [r.rel_path, r.kind]));
    expect(kinds()['D:/Music/song.mp3']).toBe('audio-music');
    expect(kinds()['D:/Pics/shot.jpg']).toBe('photo-camera');
    expect(kinds()['D:/Pics/0I2A1030.JPG']).toBeNull();
    classifyChunk(db, 0);
    expect(kinds()).toMatchObject({ 'D:/Pics/0I2A1030.JPG': 'photo-camera', 'D:/Vids/GOPR0123.MP4': 'video-camera', 'D:/Pics/holiday plan.jpg': 'photo-other' });
  });
});
