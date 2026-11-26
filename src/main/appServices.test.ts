import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAppServices } from './appServices';
import { closeDatabase, initDatabase } from './db';
import { JobService } from './jobs/jobService';

const silent = { info: () => {}, warn: () => {}, error: () => {} };

describe('app services smoke', () => {
  it('builds every service with the fast-start wiring (data version, count cache, gate) and shuts down cleanly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-smoke-'));
    const opened = initDatabase(dir, silent);
    if (!opened.ok) throw new Error('db');
    const jobs = new JobService({ db: opened.db, log: silent });
    const services = createAppServices({ db: opened.db, dataDir: dir, logsDir: path.join(dir, 'logs'), appVersion: 't', jobs, log: silent });
    expect(services.dataVersion.current()).toBeGreaterThan(0);
    // Nothing starts by itself before the window asks (no listing, no scan job).
    expect(jobs.list({ states: ['queued', 'running'] })).toEqual([]);
    services.pause.close();
    services.query.close();
    services.search.close();
    services.quickRunner.close();
    jobs.shutdown();
    closeDatabase(opened.db, silent);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('Pause everything: the saved state holds the job queue from the first moment, and a change holds or releases it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-smoke-pause-'));
    const opened = initDatabase(dir, silent);
    if (!opened.ok) throw new Error('db');
    opened.db.prepare("INSERT INTO settings (key, value) VALUES ('pauseEverything', '{\"mode\":\"manual\"}')").run();
    const jobs = new JobService({ db: opened.db, log: silent });
    const services = createAppServices({ db: opened.db, dataDir: dir, logsDir: path.join(dir, 'logs'), appVersion: 't', jobs, log: silent });
    expect(jobs.isHeld).toBe(true);
    expect(services.pause.get()).toEqual({ mode: 'manual' });
    services.pause.set('off');
    expect(jobs.isHeld).toBe(false);
    services.pause.set('hour');
    expect(jobs.isHeld).toBe(true);
    services.pause.close();
    services.query.close();
    services.search.close();
    services.quickRunner.close();
    jobs.shutdown();
    closeDatabase(opened.db, silent);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
