import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Inside Electron the plain `fs` module treats an .asar file as a folder, so a walk of a user's files stopped with ENOTDIR on an
 * archived app (job 14, 30 Oct). Every file in src/main that walks a folder must use rawFs (original-fs).
 */
const ROOT = __dirname;

/** Only the app's own copy folders (names it made itself, never a user's .asar), or a comment. */
const OWN_FOLDERS_ONLY = new Set(['db/snapshots.ts', 'settings/saveToDrive.ts', 'listing/listJob.ts']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'migrations' ? [] : sourceFiles(full);
    return name.endsWith('.ts') && !/\.test\.ts$|testutil|testUtil/.test(name) ? [full] : [];
  });
}

describe('walkers see .asar files as plain files', () => {
  it('every file that lists a folder gets fs from rawFs', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      const text = readFileSync(file, 'utf8');
      if (!/\b(readdir|readdirSync|opendir|opendirSync)\b/.test(text)) continue;
      if (OWN_FOLDERS_ONLY.has(rel) || rel === 'rawFs.ts') continue;
      if (!/from '(\.\.\/)+rawFs'|from '\.\/rawFs'/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
