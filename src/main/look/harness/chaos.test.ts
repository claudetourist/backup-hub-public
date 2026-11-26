import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScenario, type ScenarioResult } from './scenario.testutil';
import { makeRig, type Rig } from './world.testutil';

/**
 * Chaos tests (PLAN.md section 3c and 8): thousands of random events over the fake phone and unkind fake drives, invariants 1 to 5 checked
 * after every event. Seeds are fixed, so a failure is reproducible: copy the seed into a test of its own.
 */
const SEEDS = Array.from({ length: Number(process.env['LOOK_CHAOS_SEEDS'] ?? 60) }, (_, i) => i + 1);

describe('chaos: look and compare over random sequences', () => {
  let rig: Rig;
  const results: ScenarioResult[] = [];

  beforeAll(async () => {
    rig = makeRig();
    for (const seed of SEEDS) results.push(await runScenario(rig, seed, { length: 25 }));
  }, 300_000);

  afterAll(() => {
    rig.close();
    const t = (f: (r: ScenarioResult) => number): number => results.reduce((n, r) => n + f(r), 0);
    console.log(`chaos: ${results.length} sequences, ${t((r) => r.events.length)} events, ${t((r) => r.stats.copies)} copies, ${t((r) => r.stats.crashes)} killed runs, ${t((r) => r.stats.faultsEffective)} failing listings, ${t((r) => r.stats.cleans)} phone files freed, decisions ${JSON.stringify(results.reduce<Record<string, number>>((a, r) => { for (const [k, v] of Object.entries(r.stats.decisions)) a[k] = (a[k] ?? 0) + v; return a; }, {}))}`);
  });

  it('invariants 1 to 5 hold after every event of every sequence', () => {
    expect(results.flatMap((r) => r.violations).slice(0, 10)).toEqual([]);
  });

  it('every sequence has at least 20 events', () => {
    for (const r of results) expect(r.events.length, `seed ${r.seed}`).toBeGreaterThanOrEqual(20);
  });

  it('the sequences really exercise the hard cases (so a pass is not a trivial pass)', () => {
    const total = (pick: (r: ScenarioResult) => number): number => results.reduce((n, r) => n + pick(r), 0);
    const decisions = (kind: string): number => total((r) => r.stats.decisions[kind] ?? 0);
    expect(total((r) => r.stats.copies)).toBeGreaterThan(100);
    expect(total((r) => r.stats.faultsEffective)).toBeGreaterThan(20);
    expect(total((r) => r.stats.crashes)).toBeGreaterThan(3);
    expect(total((r) => r.stats.cleans)).toBeGreaterThan(0);
    expect(total((r) => r.stats.recordedGone)).toBeGreaterThan(20);
    expect(decisions('look_incomplete')).toBeGreaterThan(10);
    expect(decisions('look_empty')).toBeGreaterThan(0);
    expect(decisions('look_mass_change')).toBeGreaterThan(0);
    for (const e of ['create', 'edit', 'rename', 'move', 'delete', 'unplug', 'backup', 'twice', 'look']) expect(total((r) => r.stats.events[e] ?? 0), e).toBeGreaterThan(0);
  });

  it('the same seed gives the same sequence', async () => {
    const again = await runScenario(rig, SEEDS[3]!, { length: 25 });
    expect(again.events).toEqual(results[3]!.events);
    expect(again.stats).toEqual(results[3]!.stats);
  });
});
