import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUSY_TIMEOUT_MS } from '../db/connection';
import { closeDatabase, DB_FILE_NAME, initDatabase, type Db } from '../db';
import type { UpkeepCommand, UpkeepReport } from './upkeepProtocol';
import { isUpkeepCommand, runUpkeepProcess, type ParentPortLike } from './upkeepProcessCore';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
let dir: string;
let db: Db;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-upkeepproc-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  file = path.join(dir, DB_FILE_NAME);
  db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('laptop-1', 1, 'laptop', 'L', 'connected', 1)").run();
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakePort() {
  let listener: ((event: { data: unknown }) => void) | null = null;
  const reports: UpkeepReport[] = [];
  const port: ParentPortLike = {
    on: (_event, l) => {
      listener = l;
    },
    postMessage: (m) => void reports.push(m),
  };
  return { port, reports, send: (command: unknown) => listener?.({ data: command }) };
}
const openLikeTheProcess = (f: string): Db => {
  const conn = new Database(f, { fileMustExist: true });
  conn.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  conn.pragma('foreign_keys = ON');
  return conn;
};

describe('the upkeep process', () => {
  it('opens its own connection on start, sorts everything, reports, and exits with 0', async () => {
    const insert = db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('laptop-1', ?, 1, 1, 2)");
    for (let i = 0; i < 25; i += 1) insert.run(`D:/x/${i}.pdf`);
    const { port, reports, send } = fakePort();
    const exits: number[] = [];
    const done = runUpkeepProcess(port, { open: openLikeTheProcess, now: Date.now, exit: (c) => void exits.push(c) });
    send({ type: 'start', dbFile: file });
    await done;
    expect(exits).toEqual([0]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ type: 'finished', summary: { stopped: false, sorted: 25, nothingLeft: true } });
    expect((db.prepare('SELECT count(*) AS n FROM files WHERE kind IS NULL').get() as { n: number }).n).toBe(0);
  });

  it('a stop message ends it between chunks: the finished chunks stay, and it reports stopped', async () => {
    const insert = db.prepare("INSERT INTO files (place_id, rel_path, size, first_seen_at, last_seen_at) VALUES ('laptop-1', ?, 1, 1, 2)");
    db.transaction(() => {
      for (let i = 0; i < 9000; i += 1) insert.run(`D:/x/${i}.pdf`);
    })();
    const { port, reports, send } = fakePort();
    const exits: number[] = [];
    const done = runUpkeepProcess(port, { open: openLikeTheProcess, now: Date.now, exit: (c) => void exits.push(c) });
    send({ type: 'start', dbFile: file });
    setTimeout(() => send({ type: 'stop' }), 40); // arrives while it waits between chunks
    await done;
    expect(exits).toEqual([0]);
    const report = reports[0] as Extract<UpkeepReport, { type: 'finished' }>;
    expect(report.summary.stopped).toBe(true);
    const left = (db.prepare('SELECT count(*) AS n FROM files WHERE kind IS NULL').get() as { n: number }).n;
    expect(left).toBeGreaterThan(0);
    expect(left + report.summary.sorted).toBe(9000);
  });

  it('a stop before the start message ends it without opening the database', async () => {
    const { port, reports, send } = fakePort();
    const exits: number[] = [];
    let opened = 0;
    const done = runUpkeepProcess(port, { open: (f) => (opened += 1, openLikeTheProcess(f)), now: Date.now, exit: (c) => void exits.push(c) });
    send({ type: 'stop' });
    await done;
    expect(opened).toBe(0);
    expect(exits).toEqual([0]);
    expect(reports[0]).toMatchObject({ type: 'finished', summary: { stopped: true } });
  });

  it('a failure is reported as failed and the process exits with 1', async () => {
    const { port, reports, send } = fakePort();
    const exits: number[] = [];
    const done = runUpkeepProcess(port, { open: () => { throw new Error('unable to open database file'); }, now: Date.now, exit: (c) => void exits.push(c) });
    send({ type: 'start', dbFile: path.join(dir, 'missing.db') });
    await done;
    expect(exits).toEqual([1]);
    expect(reports[0]).toMatchObject({ type: 'failed', message: expect.stringContaining('unable to open database file') });
  });

  it('ignores messages that are not commands, and a second start', async () => {
    const { port, send } = fakePort();
    let opened = 0;
    const done = runUpkeepProcess(port, { open: (f) => (opened += 1, openLikeTheProcess(f)), now: Date.now, exit: () => {} });
    send('hello');
    send({ type: 'start' });
    send({ type: 'start', dbFile: file });
    send({ type: 'start', dbFile: file });
    await done;
    expect(opened).toBe(1);
  });

  it('knows its commands', () => {
    const ok: UpkeepCommand[] = [{ type: 'stop' }, { type: 'start', dbFile: 'x' }];
    for (const c of ok) expect(isUpkeepCommand(c)).toBe(true);
    for (const c of [null, 'stop', {}, { type: 'start' }, { type: 'start', dbFile: '' }, { type: 'kill' }]) expect(isUpkeepCommand(c)).toBe(false);
  });

  it('is built as its own file next to main.js, opens the database only through its own connection, and never checkpoints with TRUNCATE', () => {
    const root = path.resolve(__dirname, '..', '..', '..');
    expect(fs.readFileSync(path.join(root, 'forge.config.ts'), 'utf8')).toContain("entry: 'src/main/upkeep/upkeepProcess.ts'");
    for (const f of ['upkeepProcess.ts', 'upkeepProcessCore.ts', 'upkeepWork.ts']) expect(fs.readFileSync(path.join(__dirname, f), 'utf8')).not.toMatch(/wal_checkpoint|TRUNCATE/i);
  });
});
