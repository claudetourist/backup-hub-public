import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, DB_FILE_NAME, initDatabase, type Db } from './index';
import { WalKeeper } from './walKeeper';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let dir: string;
let db: Db;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-wal-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

const autoCheckpoint = (): number => db.pragma('wal_autocheckpoint', { simple: true }) as number;

describe('the log file', () => {
  it('the main connection stops checkpointing by itself, a worker does it, and a failure gives the job back', async () => {
    const modes: string[] = [];
    let fail = false;
    const keeper = new WalKeeper({
      db,
      intervalMs: 10_000,
      log: silent,
      checkpoint: async (mode) => {
        modes.push(mode);
        if (fail) throw new Error('worker gone');
        return { busy: false };
      },
    });
    keeper.start();
    expect(autoCheckpoint()).toBe(0);
    keeper.truncateSoon();
    keeper.truncateSoon();
    await new Promise((resolve) => setTimeout(resolve, 20));
    // A second ask while one runs is folded into one more run, not a pile.
    expect(modes.filter((m) => m === 'TRUNCATE').length).toBeLessThanOrEqual(2);
    expect(modes).toContain('TRUNCATE');
    fail = true;
    keeper.truncateSoon();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(autoCheckpoint()).toBe(1000);
    keeper.stop();
  });

  it('when a reader is in the way the emptying does not wait; it asks again later and stops after maxRetries', async () => {
    let calls = 0;
    const keeper = new WalKeeper({
      db,
      intervalMs: 60_000,
      retryMs: 5,
      maxRetries: 3,
      log: silent,
      checkpoint: async (mode) => {
        if (mode === 'TRUNCATE') calls += 1;
        return { busy: mode === 'TRUNCATE' && calls < 3 };
      },
    });
    keeper.start();
    keeper.truncateSoon();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(3); // busy, busy, then it went through and no more asks
    keeper.stop();
    let asked = 0;
    const counting = new WalKeeper({ db, intervalMs: 60_000, retryMs: 5, maxRetries: 2, log: silent, checkpoint: async (mode) => ((asked += mode === 'TRUNCATE' ? 1 : 0), { busy: true }) });
    counting.start();
    counting.truncateSoon();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(asked).toBe(3); // the first ask plus two retries
    counting.stop();
  });

  it('closing the database empties the log file', () => {
    db.exec('CREATE TABLE IF NOT EXISTS junk (a TEXT)');
    const insert = db.prepare('INSERT INTO junk VALUES (?)');
    db.transaction(() => {
      for (let i = 0; i < 2000; i += 1) insert.run('x'.repeat(200));
    })();
    const wal = path.join(dir, `${DB_FILE_NAME}-wal`);
    closeDatabase(db, silent);
    expect(!fs.existsSync(wal) || fs.statSync(wal).size === 0).toBe(true);
    // afterEach closes again: closing twice is harmless.
  });
});
