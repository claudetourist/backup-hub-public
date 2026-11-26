import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECK_BYTES_PER_SECOND, estimateCheckMs, type StartupStatus } from '../shared/startup';
import { elapsedText, startupView, waitText } from './startupModel';

/** A few of the insider words (plainWords.test.ts scans all the window's text for the full list). */
const INSIDER = /\b(listings?|look again|fingerprint\w*|ledger|catalog\w*|jobs screen|sources|migrat\w*|integrity|quick_check|schema)\b/i;

const status = (partial: Partial<StartupStatus> & Pick<StartupStatus, 'phase'>): StartupStatus => ({ elapsedMs: 0, estimateMs: null, ...partial });
const GB = 1024 * 1024 * 1024;

describe('what Home says while the data is not ready', () => {
  it('opening: one plain line, no bar', () => {
    for (const s of [null, status({ phase: 'opening', elapsedMs: 4000 })]) {
      expect(startupView(s)).toEqual({ title: 'Opening your data…', detail: '', percent: null, progressText: '' });
    }
  });

  it('updating: says so in plain words, the bar only shows it is working, time so far', () => {
    const view = startupView(status({ phase: 'updating', elapsedMs: 65_000 }));
    expect(view.title).toBe('Updating your data');
    expect(view.detail).toContain('This happens once');
    expect(view.detail).toContain('Your files are not touched');
    expect(view.percent).toBeNull();
    expect(view.progressText).toBe('1 minute 5 seconds so far');
  });

  it('checking: "Checking your data", about how long, a bar that follows the guess and never reaches 100', () => {
    const estimate = estimateCheckMs(1.5 * GB);
    const early = startupView(status({ phase: 'checking', elapsedMs: 10_000, estimateMs: estimate }));
    expect(early.title).toBe('Checking your data');
    expect(early.detail).toContain('about a minute');
    expect(early.detail).toContain('Nothing is being changed');
    expect(early.percent).toBeGreaterThan(10);
    expect(early.percent).toBeLessThan(30);
    expect(early.progressText).toBe('10 seconds so far');
    const over = startupView(status({ phase: 'checking', elapsedMs: estimate * 3, estimateMs: estimate }));
    expect(over.percent).toBe(95);
    expect(over.detail).toContain('still working');
    expect(startupView(status({ phase: 'checking', elapsedMs: 0, estimateMs: estimate })).progressText).toBe('');
  });

  it('checking with no guess: the bar just moves', () => {
    const view = startupView(status({ phase: 'checking', elapsedMs: 5000 }));
    expect(view.percent).toBeNull();
    expect(view.detail).toContain('a minute');
  });

  it('wording of the wait and of the time so far', () => {
    expect(waitText(3000)).toBe('a few seconds');
    expect(waitText(30_000)).toBe('about half a minute');
    expect(waitText(51_000)).toBe('about a minute');
    expect(waitText(60_000 * 3)).toBe('about 3 minutes');
    expect(elapsedText(1000)).toBe('1 second');
    expect(elapsedText(42_000)).toBe('42 seconds');
    expect(elapsedText(121_000)).toBe('2 minutes 1 second');
  });

  it('every word it can show is plain words (no insider terms)', () => {
    const shown = [
      startupView(null),
      startupView(status({ phase: 'updating', elapsedMs: 3000 })),
      startupView(status({ phase: 'checking', elapsedMs: 200_000, estimateMs: 50_000 })),
      startupView(status({ phase: 'checking', elapsedMs: 3000 })),
    ];
    for (const view of shown) expect(`${view.title} ${view.detail} ${view.progressText}`).not.toMatch(INSIDER);
  });
});

describe('the guess of the safety check time', () => {
  it('is size over a slow disk rate, and never under 2 seconds', () => {
    expect(estimateCheckMs(0)).toBe(2000);
    expect(estimateCheckMs(CHECK_BYTES_PER_SECOND * 60)).toBe(60_000);
    // The real 1.5 GB database took about 40 s: the guess is a little above that, not far below.
    expect(estimateCheckMs(1.5 * GB)).toBeGreaterThan(40_000);
    expect(estimateCheckMs(1.5 * GB)).toBeLessThan(70_000);
  });
});

describe('the window and main are wired to it', () => {
  const read = (...parts: string[]): string => readFileSync(join(__dirname, ...parts), 'utf8');

  it('the shell shows the notice instead of the screens until the data is ready, and stops asking afterwards', () => {
    const app = read('App.tsx');
    expect(app).toContain('<StartupNotice status={startup} />');
    expect(app).toContain("dataReady ? 'screen-slot' : 'screen-slot screen-slot--waiting'");
    expect(app).toContain('window.clearInterval(timer)');
  });

  it('the bench waits for the notice to go (a database copy that needs its check or update)', () => {
    expect(read('bench.ts')).toContain('FIRST_WAIT_MS');
  });
});

describe('main never runs a migration itself', () => {
  const read = (...parts: string[]): string => readFileSync(join(__dirname, '..', 'main', ...parts), 'utf8');

  it('main.ts hands the migration to the worker and shows the "updating" state while it runs', () => {
    const main = read('main.ts');
    expect(main).toContain('migrateInWorker(workerPath, file)');
    expect(main).toContain("setStartupPhase('updating')");
    expect(main).toContain("setStartupPhase('checking', estimateCheckMs(bytes))");
    expect(main).not.toMatch(/\brunMigrations\b/);
  });
});
