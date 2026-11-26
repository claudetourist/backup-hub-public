import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initDatabase, type Db } from '../db';
import { JobService, type JobHandler } from './jobService';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
let dir: string;
let db: Db;
let service: JobService;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-noauto-'));
  const opened = initDatabase(dir, silent);
  if (!opened.ok) throw new Error('db did not open');
  db = opened.db;
  service = new JobService({ db, log: silent });
});
afterEach(() => {
  service.shutdown();
  closeDatabase(db, silent);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
import { COPY_TO_LOCAL_JOB_KIND } from '../../shared/localCopy';
import { PHONE_BACKUP_JOB_KIND, PHONE_CHECK_OLD_JOB_KIND } from '../../shared/phoneBackup';
import { MIRROR_COPY_JOB_KIND } from '../../shared/mirror';
import { FOLDER_BACKUP_JOB_KIND } from '../../shared/folderBackup';
import { MIRROR_CHECK_JOB_KIND } from '../../shared/mirrorCheck';
import { DRIVE_REFRESH_JOB_KIND } from '../../shared/drive';
import { GOOGLE_COPY_JOB_KIND } from '../../shared/googleCopy';
import { RESTORE_JOB_KIND } from '../../shared/restore';
import { HASH_FILES_JOB_KIND } from '../../shared/fingerprint';
import { IMPORT_V1_JOB_KIND } from '../../shared/importV1';
import { LIST_PLACE_JOB_KIND, LOOK_AGAIN_JOB_KIND } from '../../shared/listing';
import { INTERRUPTED_MESSAGE, isContinuable, NOT_STARTED_MESSAGE, PAUSED_ALL_MESSAGE } from '../../shared/jobs';
import { demoHandler, KIND_DEMO, KIND_DEMO_HEAVY } from './builtinJobs';

/**
 * Plan R0.6: nothing continues by itself. Every handler declared `resumable: true` is listed here (the source scan below fails when a
 * new one is added without being listed), and for each one an interrupted job with a checkpoint stays interrupted after
 * recoverInterrupted() and start().
 */
const RESUMABLE_KINDS = [KIND_DEMO, KIND_DEMO_HEAVY, LIST_PLACE_JOB_KIND, LOOK_AGAIN_JOB_KIND, DRIVE_REFRESH_JOB_KIND, HASH_FILES_JOB_KIND, IMPORT_V1_JOB_KIND, COPY_TO_LOCAL_JOB_KIND, PHONE_BACKUP_JOB_KIND, PHONE_CHECK_OLD_JOB_KIND, MIRROR_COPY_JOB_KIND, MIRROR_CHECK_JOB_KIND, FOLDER_BACKUP_JOB_KIND, GOOGLE_COPY_JOB_KIND, RESTORE_JOB_KIND];
/** The source files that declare a resumable handler (each registers the kinds above). */
const RESUMABLE_SOURCES = ['folderBackup/folderBackupService.ts', 'google/refreshJob.ts', 'googleCopy/googleCopyService.ts', 'hashing/hashJob.ts', 'import/fleetV1/importer.ts', 'jobs/builtinJobs.ts', 'listing/listJob.ts', 'localCopy/localCopyJob.ts', 'mirror/mirrorService.ts', 'phoneBackup/phoneBackupService.ts', 'restore/restoreJob.ts'];

describe('no job continues by itself', () => {
  it('the list of resumable handlers in the source is the list this test covers', () => {
    const root = path.resolve(__dirname, '..');
    const found: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts') && !/\.test(util)?\.ts$/i.test(e.name) && fs.readFileSync(full, 'utf8').includes('resumable: true')) found.push(path.relative(root, full).split(path.sep).join('/'));
      }
    };
    walk(root);
    expect(found.toSorted()).toEqual(RESUMABLE_SOURCES);
  });

  it.each(RESUMABLE_KINDS)('%s: an interrupted job with a checkpoint is not run again by recoverInterrupted() and start()', async (kind) => {
    const ran: number[] = [];
    if (kind === KIND_DEMO || kind === KIND_DEMO_HEAVY) {
      service.register({ ...demoHandler(kind, kind === KIND_DEMO_HEAVY), run: async (ctx) => void ran.push(ctx.jobId) });
    } else {
      service.register({ kind, heavy: false, resumable: true, run: async (ctx) => void ran.push(ctx.jobId) } satisfies JobHandler);
    }
    const id = Number(db.prepare("INSERT INTO jobs (kind, title, state, created_at, started_at, resume_json) VALUES (?, 'Left', 'running', 1, 1, ?)").run(kind, '{"at":5}').lastInsertRowid);
    expect(service.recoverInterrupted()).toEqual({ interrupted: 1 });
    service.start();
    await sleep(60);
    expect(ran).toEqual([]);
    expect(service.get(id)).toMatchObject({ state: 'failed', error: INTERRUPTED_MESSAGE, hasCheckpoint: true });
    // Only the person's Continue runs it, from the checkpoint.
    expect(service.continueInterrupted(id)).toBe(true);
    await until(() => ran.length === 1, 'the continued job');
    expect(ran).toEqual([id]);
  });

  it('a job waiting for an answer (needs_you) when the app closed is interrupted too, and not asked again by itself', async () => {
    const ran: number[] = [];
    service.register({ kind: 'test.ask', heavy: false, resumable: true, run: async (ctx) => void ran.push(ctx.jobId) });
    const id = Number(db.prepare("INSERT INTO jobs (kind, title, state, created_at, started_at, resume_json) VALUES ('test.ask', 'Ask', 'needs_you', 1, 1, '{}')").run().lastInsertRowid);
    service.recoverInterrupted();
    service.start();
    await sleep(40);
    expect(ran).toEqual([]);
    expect(service.get(id)?.state).toBe('failed');
  });

  const insertQueued = (kind: string, extra: { paused?: number; message?: string | null; resume?: string | null } = {}): number =>
    Number(
      db
        .prepare("INSERT INTO jobs (kind, title, state, created_at, paused, message, resume_json) VALUES (?, 'Waiting', 'queued', 1, ?, ?, ?)")
        .run(kind, extra.paused ?? 0, extra.message ?? null, extra.resume ?? null).lastInsertRowid,
    );

  it.each(RESUMABLE_KINDS)('%s: a job still QUEUED from the last session is held at launch too, and only Continue starts it', async (kind) => {
    const ran: number[] = [];
    if (kind === KIND_DEMO || kind === KIND_DEMO_HEAVY) {
      service.register({ ...demoHandler(kind, kind === KIND_DEMO_HEAVY), run: async (ctx) => void ran.push(ctx.jobId) });
    } else {
      service.register({ kind, heavy: false, resumable: true, run: async (ctx) => void ran.push(ctx.jobId) } satisfies JobHandler);
    }
    const id = insertQueued(kind);
    expect(service.recoverInterrupted()).toEqual({ interrupted: 1 });
    service.start();
    await sleep(60);
    expect(ran).toEqual([]);
    expect(service.get(id)).toMatchObject({ state: 'failed', error: INTERRUPTED_MESSAGE, message: NOT_STARTED_MESSAGE, hasCheckpoint: false });
    expect(isContinuable(service.get(id)!)).toBe(true);
    expect(service.continueInterrupted(id)).toBe(true);
    await until(() => ran.length === 1, 'the continued job');
    expect(ran).toEqual([id]);
  });

  it('a queued job can be dismissed instead: Continue goes away and nothing runs', async () => {
    const ran: number[] = [];
    service.register({ kind: 'test.queued', heavy: false, resumable: true, run: async (ctx) => void ran.push(ctx.jobId) });
    const id = insertQueued('test.queued');
    service.recoverInterrupted();
    service.start();
    expect(service.dismissInterrupted(id)).toBe(true);
    expect(isContinuable(service.get(id)!)).toBe(false);
    expect(service.continueInterrupted(id)).toBe(false);
    await sleep(40);
    expect(ran).toEqual([]);
  });

  it('a queued job of a kind that cannot resume is held too, with no Continue (retry from its own screen)', async () => {
    const ran: number[] = [];
    service.register({ kind: 'test.plain', heavy: false, run: async (ctx) => void ran.push(ctx.jobId) });
    const id = insertQueued('test.plain');
    service.recoverInterrupted();
    service.start();
    await sleep(40);
    expect(ran).toEqual([]);
    expect(service.get(id)).toMatchObject({ state: 'failed', error: INTERRUPTED_MESSAGE });
    expect(isContinuable(service.get(id)!)).toBe(false);
    expect(service.continueInterrupted(id)).toBe(false);
  });

  it('jobs the person or Pause everything already paused stay as they were (they never start by themselves)', () => {
    service.register({ kind: 'test.held', heavy: false, resumable: true, run: async () => undefined });
    const byPerson = insertQueued('test.held', { paused: 1, message: 'Paused', resume: '{"at":2}' });
    const byPauseAll = insertQueued('test.held', { paused: 1, message: PAUSED_ALL_MESSAGE, resume: '{"at":3}' });
    expect(service.recoverInterrupted()).toEqual({ interrupted: 0 });
    expect(service.get(byPerson)).toMatchObject({ state: 'queued', paused: true });
    expect(service.get(byPauseAll)).toMatchObject({ state: 'queued', paused: true });
  });
});
