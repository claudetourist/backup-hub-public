// The budgets of PLAN section 5 that apply today, and the plain table. Pure (no files, no processes) so the unit test can check it.

export const BUDGETS = {
  launchMs: 2000,
  switchMs: 150,
  stallMs: 100,
  idleMemoryMb: 300,
  searchMs: 150,
};

export function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round1 = (n) => Math.round(n * 10) / 10;
const mb = (bytes) => `${round1(bytes / 1024 / 1024)} MB`;

/**
 * runs: one entry per app launch, each { homeReadyMs, switches: [{ screen, ms: [] }], memoryMb, maxStallMs, dbBytes, summary }.
 * search: { results: [{ name, worstMs, hits, status }] } or null. Returns { rows, pass } where a row is
 * { thing, budget, measured, pass } and pass is true / false, or null for a figure that is only reported.
 */
export function evaluate(runs, search) {
  const rows = [];
  const launch = runs.map((run) => run.homeReadyMs);
  const launchMedian = median(launch);
  rows.push({
    thing: 'Launch to a usable Home',
    budget: `< ${BUDGETS.launchMs} ms (median)`,
    measured: `median ${Math.round(launchMedian)} ms, worst ${Math.round(Math.max(...launch))} ms (${launch.length} launches)`,
    pass: launchMedian < BUDGETS.launchMs,
  });

  const perScreen = new Map();
  for (const run of runs) for (const entry of run.switches) perScreen.set(entry.screen, [...(perScreen.get(entry.screen) ?? []), ...entry.ms]);
  let worstScreen = '';
  let worstSwitch = 0;
  for (const [screen, times] of perScreen) {
    const worst = Math.max(...times);
    if (worst >= worstSwitch) {
      worstSwitch = worst;
      worstScreen = screen;
    }
  }
  const visits = Math.min(...[...perScreen.values()].map((times) => times.length));
  rows.push({
    thing: 'Screen switch (every sidebar screen)',
    budget: `< ${BUDGETS.switchMs} ms`,
    measured: `worst ${round1(worstSwitch)} ms (${worstScreen}); ${perScreen.size} screens, at least ${visits} visits each`,
    pass: perScreen.size > 0 && visits >= 3 && worstSwitch < BUDGETS.switchMs,
  });

  const stall = Math.max(...runs.map((run) => run.maxStallMs));
  rows.push({ thing: 'Longest main-thread stall', budget: `< ${BUDGETS.stallMs} ms`, measured: `${Math.round(stall)} ms`, pass: stall < BUDGETS.stallMs });

  const memory = Math.max(...runs.map((run) => run.memoryMb));
  rows.push({ thing: 'Memory while idle on Home', budget: `< ${BUDGETS.idleMemoryMb} MB`, measured: `${round1(memory)} MB (worst of ${runs.length})`, pass: memory < BUDGETS.idleMemoryMb });

  if (search) {
    const scenarios = search.results;
    const worst = scenarios.reduce((a, b) => (b.worstMs > a.worstMs ? b : a));
    rows.push({
      thing: `Search first page, ${search.rows.toLocaleString('en-US')} rows`,
      budget: `< ${BUDGETS.searchMs} ms`,
      measured: `worst ${worst.worstMs} ms (${worst.name}); ${scenarios.length} searches`,
      pass: scenarios.every((s) => s.status === 'done' && s.worstMs < BUDGETS.searchMs),
    });
    for (const s of scenarios) {
      rows.push({ thing: `  search: ${s.name}`, budget: `< ${BUDGETS.searchMs} ms`, measured: `${s.worstMs} ms, ${s.total === null ? 'first page only' : `${s.total.toLocaleString('en-US')} found`}${s.status === 'done' ? '' : ` (${s.status})`}`, pass: s.status === 'done' && s.worstMs < BUDGETS.searchMs });
    }
  } else {
    rows.push({ thing: 'Search first page', budget: `< ${BUDGETS.searchMs} ms`, measured: 'not measured', pass: false });
  }

  rows.push({ thing: 'Database size (launch runs)', budget: 'report only', measured: mb(Math.max(...runs.map((run) => run.dbBytes))), pass: null });
  rows.push({ thing: 'Start-up marks (first launch)', budget: 'report only', measured: runs[0].summary, pass: null });
  return { rows, pass: rows.every((row) => row.pass !== false) };
}

/** A plain text table: thing, budget, measured, result. */
export function formatTable(rows) {
  const cells = rows.map((row) => [row.thing, row.budget, row.measured, row.pass === null ? 'info' : row.pass ? 'pass' : 'FAIL']);
  const header = ['Thing', 'Budget', 'Measured', 'Result'];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c) => c.map((text, i) => text.padEnd(widths[i])).join('  ').trimEnd();
  return [line(header), widths.map((w) => '-'.repeat(w)).join('  '), ...cells.map(line)].join('\n');
}
