import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Plan R0.6: every program and every worker thread the app starts goes through one helper, so the shutdown routine can end them all and the
 * next start can find leftovers. This scan fails when a new call appears anywhere else.
 */
const root = path.resolve(__dirname, '..');
const HELPERS = new Set(['lifecycle/childProcesses.ts', 'lifecycle/workers.ts']);

function sources(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !/\.test(util)?\.ts$/i.test(entry.name)) out.push({ rel: path.relative(root, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(root);
  return out.filter((s) => !HELPERS.has(s.rel));
}

describe('one door for child processes and workers', () => {
  it('no module outside the helpers can start a process (no run-time import of child_process)', () => {
    const offenders = sources().filter((s) => /^import\s+(?!type\b)[^;]*from 'node:child_process'/m.test(s.text));
    expect(offenders.map((o) => o.rel)).toEqual([]);
  });

  it('no module outside the helpers creates a Worker', () => {
    const offenders = sources().filter((s) => /new Worker\(/.test(s.text.replace(/\/\/.*$/gm, '')));
    expect(offenders.map((o) => o.rel)).toEqual([]);
  });

  it('every PowerShell command line is built by powershellArgs (it adds the marker)', () => {
    const offenders = sources().filter((s) => /'-NonInteractive'/.test(s.text));
    expect(offenders.map((o) => o.rel)).toEqual([]);
  });
});
