import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COPY_TO_LOCAL_JOB_KIND } from '../../shared/localCopy';
import { DRIVE_REFRESH_JOB_KIND } from '../../shared/drive';
import { HASH_FILES_JOB_KIND } from '../../shared/fingerprint';
import { IMPORT_V1_JOB_KIND } from '../../shared/importV1';
import type { JobChangedEvent, JobRecord } from '../../shared/jobs';
import { LIST_PLACE_JOB_KIND } from '../../shared/listing';
import { closeDatabase, initDatabase, type Db } from '../db';
import { FingerprintService } from '../hashing/fingerprintService';
import { QueryService } from './queryService';
import { wireRecountOnJobEnd } from './recountOnJobEnd';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-recount-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  db.prepare("INSERT INTO places (id, profile_id, kind, label, status, created_at) VALUES ('laptop-1', 1, 'laptop', 'L', 'connected', 1)").run();
});
afterEach(() => {
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

const job = (kind: string, state: JobRecord['state'] = 'done'): JobRecord =>
  ({ id: 1, kind, title: kind, state, paused: false, message: null, speed: null, finishedAt: 5 }) as unknown as JobRecord;

/** The real query service (counting on the main thread), counters of how often it really counted. */
function setup() {
  const bus = new EventEmitter();
  const jobs = {
    onChanged: (listener: (event: JobChangedEvent) => void) => {
      bus.on('e', listener);
      return () => bus.off('e', listener);
    },
    params: () => null,
    create: () => 1,
    list: () => [] as JobRecord[],
  };
  const counted = { stats: 0, coverage: 0 };
  const log = {
    info: (...a: unknown[]) => {
      const line = String(a[0]);
      if (line.startsWith('query: stats counted')) counted.stats += 1;
      if (line.startsWith('query: coverage counted')) counted.coverage += 1;
    },
    warn: () => {},
  };
  const query = new QueryService({ dbFile: null, db, workerPath: null, log, schedule: (fn) => fn(), fallbackMinIntervalMs: 0 });
  wireRecountOnJobEnd(jobs, query);
  // The fingerprint service (listing, fingerprint and import ends) is wired as in the app.
  const fingerprints = new FingerprintService({ db, query, jobs, isConnected: () => true });
  const emit = (kind: string): void => void bus.emit('e', { reason: 'state', job: job(kind) } satisfies JobChangedEvent);
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));
  return { query, counted, emit, settle, fingerprints };
}

describe('counts are recounted on change, never by the places poll', () => {
  it('counts once when nothing is cached, then polling many times starts nothing', async () => {
    const { query, counted, settle } = setup();
    for (let i = 0; i < 200; i += 1) {
      query.requestStats(); // what the places poll does
    }
    await settle();
    expect(counted.stats).toBe(1);
    for (let i = 0; i < 200; i += 1) {
      query.requestStats();
    }
    await settle();
    expect(counted).toMatchObject({ stats: 1 });
  });

  it.each([DRIVE_REFRESH_JOB_KIND, COPY_TO_LOCAL_JOB_KIND, LIST_PLACE_JOB_KIND, HASH_FILES_JOB_KIND, IMPORT_V1_JOB_KIND])('a finished %s job recounts', async (kind) => {
    const { query, counted, emit, settle } = setup();
    query.requestStats();
    await settle();
    const before = { ...counted };
    emit(kind);
    await settle();
    expect(counted.stats).toBe(before.stats + 1);
  });

  it('jobs that change no numbers, and jobs that have not finished, recount nothing', async () => {
    const { query, counted, emit, settle } = setup();
    query.requestStats();
    await settle();
    const before = { ...counted };
    emit('db.snapshot');
    emit('settings.saveToDrive');
    emit('dev.demo');
    await settle();
    expect(counted).toEqual(before);
  });

});
