// R1.2a proof helper: prints the preview list of a phone backup (no copying) to compare with PhoneBackup's --list-pending.
//
//   node scripts/r12-preview.mjs --db <backuphub.db or a copy> [--backup <number or name>]
//
// READS the phone (one fixed read-only listing command; adb kill-server afterwards) and the index (opened read only). It copies nothing,
// hashes nothing, records nothing and writes nothing. Writes one temporary bundle of the code to the system temp folder and removes it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const value = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const dbPath = value('--db');
if (!dbPath) {
  console.error('usage: node scripts/r12-preview.mjs --db <backuphub.db or a copy> [--backup <number or name>]');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const betterSqlite = require.resolve('better-sqlite3');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-r12-'));
const bundle = path.join(work, 'preview.cjs');
let code = 1;
try {
  await build({
    entryPoints: [path.join(root, 'src', 'main', 'phoneBackup', 'previewTool.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: bundle,
    logLevel: 'error',
    external: ['electron'],
    plugins: [
      {
        name: 'native-sqlite',
        setup(b) {
          b.onResolve({ filter: /^better-sqlite3$/ }, () => ({ path: betterSqlite, external: true }));
        },
      },
    ],
  });
  const { runPreviewTool } = createRequire(bundle)(bundle);
  code = await runPreviewTool({
    dbPath: path.resolve(dbPath),
    backup: value('--backup'),
    print: (line) => console.log(line),
  });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(code);
