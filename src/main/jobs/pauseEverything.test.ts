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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-hold-'));
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
import { PAUSED_ALL_MESSAGE } from '../../shared/jobs';

/** A job that counts steps and checkpoints, like the real ones (it yields at every step). */
function stepper(kind: string, total = 400) {
  const steps = new Map<number, number>();
  const handler: JobHandler = {
    kind,
    heavy: true,
    resumable: true,
    run: async (ctx) => {
      for (let i = 0; i < total; i += 1) {
        steps.set(ctx.jobId, i);
        ctx.checkpoint({ i });
        await ctx.yield();
        await sleep(1);
      }
      return 'done';
    },
  };
  return { handler, steps };
}
const stateOf = (id: number) => service.get(id)?.state;
const texts = (id: number) => service.events(id).map((e) => e.text);

describe('Pause everything in the job queue', () => {
  it('queued jobs are held while it is on and start when it ends', async () => {
    const ran: number[] = [];
    service.register({ kind: 'test.quick', heavy: false, run: async (ctx) => void ran.push(ctx.jobId) });
    service.start();
    service.setHeld(true);
    expect(service.isHeld).toBe(true);
    const id = service.create('test.quick', 'Quick');
    await sleep(40);
    expect(ran).toEqual([]);
    expect(stateOf(id)).toBe('queued');
    service.setHeld(false);
    await until(() => stateOf(id) === 'done', 'the held job to run');
    expect(ran).toEqual([id]);
  });

  it('nothing starts before start() while it is on (it is applied at launch, from the saved state)', async () => {
    const ran: number[] = [];
    service.register({ kind: 'test.quick', heavy: false, run: async (ctx) => void ran.push(ctx.jobId) });
    service.setHeld(true);
    const id = service.create('test.quick', 'Quick');
    service.start();
    await sleep(40);
    expect(ran).toEqual([]);
    expect(stateOf(id)).toBe('queued');
  });

  it('a running job stops at its next safe point, keeps its place, and goes on when it ends', async () => {
    const s = stepper('test.step');
    service.register(s.handler);
    service.start();
    const id = service.create('test.step', 'Steps');
    await until(() => (s.steps.get(id) ?? 0) > 3, 'some steps');
    service.setHeld(true);
    expect(service.get(id)).toMatchObject({ state: 'queued', paused: true }); // pausing: it works until its safe point
    await until(() => service.get(id)?.pausing === false, 'held at its safe point');
    expect(service.get(id)).toMatchObject({ state: 'queued', paused: true, message: PAUSED_ALL_MESSAGE });
    await sleep(30);
    const frozenAt = s.steps.get(id)!;
    await sleep(40);
    expect(s.steps.get(id)).toBe(frozenAt);
    service.setHeld(false);
    await until(() => (s.steps.get(id) ?? 0) > frozenAt + 3, 'steps after it ended');
    expect(service.get(id)).toMatchObject({ state: 'running', paused: false });
    expect(texts(id)).toEqual(expect.arrayContaining(['Paused by Pause everything', 'Resumed: Pause everything ended']));
    service.cancel(id);
  });

  it('a job the person paused stays paused when Pause everything ends', async () => {
    const s = stepper('test.step');
    service.register(s.handler);
    service.start();
    const id = service.create('test.step', 'Steps');
    await until(() => (s.steps.get(id) ?? 0) > 3, 'some steps');
    service.pause(id);
    service.setHeld(true);
    service.setHeld(false);
    await sleep(40);
    expect(service.get(id)).toMatchObject({ state: 'queued', paused: true });
    service.cancel(id);
  });

  it('jobs it paused survive a restart: letting go after the restart resumes exactly those', async () => {
    const s = stepper('test.step');
    service.register(s.handler);
    service.start();
    const id = service.create('test.step', 'Steps');
    await until(() => (s.steps.get(id) ?? 0) > 3, 'some steps');
    service.setHeld(true);
    service.shutdown();
    const again = new JobService({ db, log: silent });
    const s2 = stepper('test.step');
    again.register(s2.handler);
    again.recoverInterrupted();
    again.setHeld(true); // the saved state says it is still on
    again.start();
    await sleep(40);
    expect(s2.steps.size).toBe(0);
    expect(again.get(id)).toMatchObject({ state: 'queued', paused: true });
    again.setHeld(false);
    await until(() => s2.steps.has(id), 'the job to go on');
    again.cancel(id);
    again.shutdown();
  });

  it('letting go with nothing held is harmless, and a second "on" does nothing', () => {
    service.setHeld(false);
    service.setHeld(true);
    service.setHeld(true);
    expect(service.isHeld).toBe(true);
    service.setHeld(false);
    expect(service.isHeld).toBe(false);
  });

  it('hasPendingWork is true for a running or waiting job, not for a paused one', async () => {
    const s = stepper('test.step');
    service.register(s.handler);
    expect(service.hasPendingWork()).toBe(false);
    service.start();
    const id = service.create('test.step', 'Steps');
    expect(service.hasPendingWork()).toBe(true);
    await until(() => (s.steps.get(id) ?? 0) > 2, 'some steps');
    service.pause(id);
    expect(service.hasPendingWork()).toBe(false);
    service.cancel(id);
  });
});
