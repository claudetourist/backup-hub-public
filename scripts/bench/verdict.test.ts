import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no types
import { evaluate, formatTable, median } from './verdict.mjs';

const run = (over: Record<string, unknown> = {}) => ({
  homeReadyMs: 900,
  switches: [
    { screen: 'home', ms: [20, 30, 25] },
    { screen: 'files', ms: [60, 40, 50] },
  ],
  memoryMb: 250,
  maxStallMs: 40,
  dbBytes: 1_048_576,
  summary: 'startup: appReady=300ms',
  ...over,
});
const search = (worstMs = 80, status = 'done') => ({ rows: 2_000_000, results: [{ name: 'word', worstMs, hits: 500, total: 9, status }] });

describe('bench verdict', () => {
  it('median of an odd and an even list', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('passes when every budget holds, and judges the launch by its median', () => {
    const verdict = evaluate([run(), run({ homeReadyMs: 1900 }), run({ homeReadyMs: 3000 })], search());
    expect(verdict.rows[0].pass).toBe(true);
    expect(verdict.pass).toBe(true);
    expect(verdict.rows.at(-2).pass).toBeNull();
  });

  it('fails on each broken budget', () => {
    expect(evaluate([run({ homeReadyMs: 2500 })], search()).rows[0].pass).toBe(false);
    expect(evaluate([run({ switches: [{ screen: 'files', ms: [10, 20, 151] }] })], search()).rows[1].pass).toBe(false);
    expect(evaluate([run({ maxStallMs: 101 })], search()).rows[2].pass).toBe(false);
    expect(evaluate([run({ memoryMb: 300 })], search()).rows[3].pass).toBe(false);
    expect(evaluate([run()], search(151)).pass).toBe(false);
    expect(evaluate([run()], search(10, 'failed')).pass).toBe(false);
  });

  it('a search whose total was not counted still prints', () => {
    const text = formatTable(evaluate([run()], { rows: 2_000_000, results: [{ name: 'walk', worstMs: 90, hits: 500, total: null, status: 'done' }] }).rows);
    expect(text).toContain('first page only');
  });

  it('a screen visited fewer than 3 times fails, and so does a missing search', () => {
    expect(evaluate([run({ switches: [{ screen: 'home', ms: [1, 2] }] })], search()).rows[1].pass).toBe(false);
    expect(evaluate([run()], null).pass).toBe(false);
  });

  it('prints a table with the four columns', () => {
    const text = formatTable(evaluate([run()], search()).rows);
    expect(text.split('\n')[0]).toMatch(/^Thing\s+Budget\s+Measured\s+Result$/);
    expect(text).toContain('pass');
  });
});
