import { TIMING_MARKS, type TimingMark, type TimingsSnapshot } from '../shared/ipc';

/** Epoch ms when this process was created (Electron exposes the real value; Node falls back). */
export function processStartEpoch(now: number = Date.now()): number {
  const p = process as unknown as { getCreationTime?: () => number | null };
  const created = p.getCreationTime?.();
  if (typeof created === 'number' && Number.isFinite(created)) return created;
  return now - process.uptime() * 1000;
}

/** "startup: appReady=310ms windowCreated=338ms ... total=742ms" (marks in time order). */
export function formatTimingSummary(marks: Partial<Record<TimingMark, number>>): string {
  const reached = TIMING_MARKS.flatMap((name) => {
    const value = marks[name];
    return value === undefined ? [] : [[name, Math.round(value)] as const];
  }).toSorted((a, b) => a[1] - b[1]);
  if (reached.length === 0) return 'startup: no marks recorded';
  const parts = reached.map(([name, ms]) => `${name}=${ms}ms`);
  const total = reached[reached.length - 1]?.[1] ?? 0;
  const missing = TIMING_MARKS.filter((name) => marks[name] === undefined);
  const tail = missing.length > 0 ? ` (missing: ${missing.join(', ')})` : '';
  return `startup: ${parts.join(' ')} total=${total}ms${tail}`;
}

export class StartupTimings {
  private readonly marks: Partial<Record<TimingMark, number>> = {};

  constructor(
    private readonly originEpochMs: number = processStartEpoch(),
    private readonly clock: () => number = Date.now,
  ) {}

  /** Record a mark once; later calls for the same mark are ignored. Returns ms since process start. */
  mark(name: TimingMark, atEpochMs: number = this.clock()): number {
    const existing = this.marks[name];
    if (existing !== undefined) return existing;
    const ms = Math.max(0, atEpochMs - this.originEpochMs);
    this.marks[name] = ms;
    return ms;
  }

  snapshot(): TimingsSnapshot {
    return {
      marks: { ...this.marks },
      summary: formatTimingSummary(this.marks),
      complete: TIMING_MARKS.every((name) => this.marks[name] !== undefined),
    };
  }
}
