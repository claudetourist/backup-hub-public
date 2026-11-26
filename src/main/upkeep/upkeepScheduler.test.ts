import { describe, expect, it } from 'vitest';
import type { UpkeepCommand, UpkeepReport } from './upkeepProtocol';
import {
  CHECK_EVERY_MS,
  IDLE_NEEDED_SECONDS,
  RERUN_AFTER_NOTHING_LEFT_MS,
  RERUN_AFTER_TROUBLE_MS,
  STOP_GRACE_MS,
  UpkeepScheduler,
  WATCH_EVERY_MS,
  type UpkeepChild,
} from './upkeepScheduler';

class FakeChild implements UpkeepChild {
  sent: UpkeepCommand[] = [];
  killed = false;
  private spawnL: ((pid: number) => void) | null = null;
  private messageL: ((r: UpkeepReport) => void) | null = null;
  private exitL: ((code: number | null) => void) | null = null;
  postMessage(command: UpkeepCommand): void {
    this.sent.push(command);
  }
  kill(): void {
    this.killed = true;
    this.exit(null);
  }
  onSpawn(l: (pid: number) => void): void {
    this.spawnL = l;
  }
  onMessage(l: (r: UpkeepReport) => void): void {
    this.messageL = l;
  }
  onExit(l: (code: number | null) => void): void {
    this.exitL = l;
  }
  spawned(pid = 4242): void {
    this.spawnL?.(pid);
  }
  report(r: UpkeepReport): void {
    this.messageL?.(r);
  }
  exit(code: number | null): void {
    this.exitL?.(code);
  }
  get types(): string[] {
    return this.sent.map((c) => c.type);
  }
}

const finished = (over: Partial<Extract<UpkeepReport, { type: 'finished' }>['summary']> = {}): UpkeepReport => ({
  type: 'finished',
  summary: { stopped: false, busy: false, sorted: 0, eventsTrimmed: 0, jobsTrimmed: 0, optimized: false, nothingLeft: true, ...over },
});

/** A scheduler with a fake clock and fake timers: `advance(ms)` fires the timers that fall due. */
function setup(initial: { idle?: number; battery?: boolean; jobs?: boolean; paused?: boolean } = {}) {
  const world = { now: 1_000_000, idle: initial.idle ?? 600, battery: initial.battery ?? false, jobs: initial.jobs ?? false, paused: initial.paused ?? false };
  const timers: { at: number; run: () => void; id: number; cancelled: boolean }[] = [];
  let nextTimer = 0;
  const children: FakeChild[] = [];
  const priorities: number[] = [];
  const errors: string[] = [];
  const scheduler = new UpkeepScheduler({
    now: () => world.now,
    idleSeconds: () => world.idle,
    onBattery: () => world.battery,
    jobsBusy: () => world.jobs,
    paused: () => world.paused,
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    dbFile: 'D:/data/backuphub.db',
    lowerPriority: (pid) => void priorities.push(pid),
    schedule: (run, ms) => {
      const t = { at: world.now + ms, run, id: nextTimer++, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    log: { info: () => {}, warn: (...a) => void errors.push(String(a[0])), error: (...a) => void errors.push(String(a[0])) },
  });
  const advance = (ms: number): void => {
    const end = world.now + ms;
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && t.at <= end).toSorted((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      due.cancelled = true;
      world.now = Math.max(world.now, due.at);
      due.run();
    }
    world.now = end;
  };
  return { world, scheduler, advance, children, priorities, errors };
}

describe('UpkeepScheduler: when it may start', () => {
  it('starts the process after the first 30 s look when every condition holds, tells it the database file, and lowers its priority', () => {
    const t = setup();
    t.scheduler.start();
    t.advance(CHECK_EVERY_MS - 1);
    expect(t.children).toHaveLength(0);
    t.advance(1);
    expect(t.children).toHaveLength(1);
    expect(t.children[0]!.sent).toEqual([{ type: 'start', dbFile: 'D:/data/backuphub.db' }]);
    expect(t.scheduler.isRunning).toBe(true);
    t.children[0]!.spawned(777);
    expect(t.priorities).toEqual([777]);
  });

  it.each([
    ['the computer was used less than 3 minutes ago', { idle: IDLE_NEEDED_SECONDS - 1 }],
    ['it runs on battery', { battery: true }],
    ['a job is queued or running', { jobs: true }],
    ['Pause everything is on', { paused: true }],
  ])('does not start when %s', (_name, state) => {
    const t = setup(state);
    t.scheduler.start();
    t.advance(CHECK_EVERY_MS * 10);
    expect(t.children).toHaveLength(0);
  });

  it('starts at exactly 180 s of idle time', () => {
    const t = setup({ idle: IDLE_NEEDED_SECONDS });
    t.scheduler.start();
    t.advance(CHECK_EVERY_MS);
    expect(t.children).toHaveLength(1);
  });

  it('starts when the last condition comes true, at the next look', () => {
    const t = setup({ jobs: true });
    t.scheduler.start();
    t.advance(CHECK_EVERY_MS * 3);
    expect(t.children).toHaveLength(0);
    t.world.jobs = false;
    t.advance(CHECK_EVERY_MS);
    expect(t.children).toHaveLength(1);
  });

  it('never starts a second process while one runs', () => {
    const t = setup();
    t.scheduler.start();
    t.advance(CHECK_EVERY_MS + 60_000);
    expect(t.children).toHaveLength(1);
  });

  it('does nothing before start() and after stop()', () => {
    const t = setup();
    t.scheduler.check();
    t.advance(CHECK_EVERY_MS * 2);
    expect(t.children).toHaveLength(0);
    t.scheduler.start();
    t.scheduler.stop();
    t.advance(CHECK_EVERY_MS * 2);
    expect(t.children).toHaveLength(0);
  });
});

describe('UpkeepScheduler: stopping fast', () => {
  function running() {
    const t = setup();
    t.scheduler.start();
    t.advance(CHECK_EVERY_MS);
    return { ...t, child: t.children[0]! };
  }

  it.each([
    ['the person uses the computer', (w: ReturnType<typeof setup>['world']) => void (w.idle = 0)],
    ['a job is created', (w: ReturnType<typeof setup>['world']) => void (w.jobs = true)],
    ['Pause everything is switched on', (w: ReturnType<typeof setup>['world']) => void (w.paused = true)],
    ['the power cable is pulled', (w: ReturnType<typeof setup>['world']) => void (w.battery = true)],
  ])('tells the process to stop within a second when %s', (_name, change) => {
    const t = running();
    change(t.world);
    t.advance(WATCH_EVERY_MS);
    expect(t.child.types).toEqual(['start', 'stop']);
  });

  it('an event (a job is created, Pause everything changes) stops it at once, without waiting for the next look', () => {
    const t = running();
    t.world.paused = true;
    t.scheduler.check();
    expect(t.child.types).toEqual(['start', 'stop']);
  });

  it('asks once, lets the process exit by itself, and does not end it', () => {
    const t = running();
    t.world.idle = 0;
    t.advance(WATCH_EVERY_MS * 3);
    expect(t.child.types).toEqual(['start', 'stop']);
    t.child.report(finished({ stopped: true, nothingLeft: false }));
    t.child.exit(0);
    t.advance(STOP_GRACE_MS * 2);
    expect(t.child.killed).toBe(false);
    expect(t.scheduler.isRunning).toBe(false);
  });

  it('ends a process that did not exit after the grace time', () => {
    const t = running();
    t.world.idle = 0;
    t.advance(WATCH_EVERY_MS);
    t.advance(STOP_GRACE_MS);
    expect(t.child.killed).toBe(true);
    expect(t.scheduler.isRunning).toBe(false);
    expect(t.errors.some((e) => e.includes('did not stop'))).toBe(true);
  });

  it('stop() (the app is closing) asks the process to stop too', () => {
    const t = running();
    t.scheduler.stop();
    expect(t.child.types).toEqual(['start', 'stop']);
  });
});

describe('UpkeepScheduler: after the process ends', () => {
  function ended(report: UpkeepReport | null, code: number | null) {
    const t = setup();
    t.scheduler.start();
    t.advance(CHECK_EVERY_MS);
    const child = t.children[0]!;
    if (report) child.report(report);
    child.exit(code);
    return t;
  }

  it('waits an hour after a pass that found nothing left to do', () => {
    const t = ended(finished(), 0);
    t.advance(RERUN_AFTER_NOTHING_LEFT_MS - CHECK_EVERY_MS);
    expect(t.children).toHaveLength(1);
    t.advance(CHECK_EVERY_MS * 2);
    expect(t.children).toHaveLength(2);
  });

  it('can start again at the next look after it was stopped (the work is not finished)', () => {
    const t = ended(finished({ stopped: true, nothingLeft: false }), 0);
    t.advance(CHECK_EVERY_MS);
    expect(t.children).toHaveLength(2);
  });

  it('a crash goes to the log only, and it waits 10 minutes', () => {
    const t = ended(null, 1);
    expect(t.errors.some((e) => e.includes('ended without finishing'))).toBe(true);
    t.advance(RERUN_AFTER_TROUBLE_MS - CHECK_EVERY_MS);
    expect(t.children).toHaveLength(1);
    t.advance(CHECK_EVERY_MS * 2);
    expect(t.children).toHaveLength(2);
  });

  it('a report of failure is logged and also waits 10 minutes', () => {
    const t = ended({ type: 'failed', message: 'Error: disk I/O error' }, 1);
    expect(t.errors.some((e) => e.includes('disk I/O error'))).toBe(true);
    t.advance(CHECK_EVERY_MS * 2);
    expect(t.children).toHaveLength(1);
  });

  it('a data file that stayed busy waits 10 minutes', () => {
    const t = ended(finished({ busy: true, nothingLeft: false }), 0);
    t.advance(CHECK_EVERY_MS * 2);
    expect(t.children).toHaveLength(1);
    t.advance(RERUN_AFTER_TROUBLE_MS);
    expect(t.children).toHaveLength(2);
  });

  it('a process that cannot be started is tried again after 10 minutes, quietly', () => {
    let now = 1_000_000;
    let fail = true;
    const scheduler = new UpkeepScheduler({
      now: () => now,
      idleSeconds: () => 600,
      onBattery: () => false,
      jobsBusy: () => false,
      paused: () => false,
      spawn: () => {
        if (fail) throw new Error('no such file');
        return new FakeChild();
      },
      dbFile: 'x',
      lowerPriority: () => {},
      schedule: () => () => {}, // the test calls check() itself
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    scheduler.start();
    scheduler.check();
    expect(scheduler.isRunning).toBe(false);
    fail = false;
    scheduler.check(); // within the 10 minutes: no new try
    expect(scheduler.isRunning).toBe(false);
    now += RERUN_AFTER_TROUBLE_MS;
    scheduler.check();
    expect(scheduler.isRunning).toBe(true);
  });
});
