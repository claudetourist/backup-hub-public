// R2.1 proof helper: prints what a folder backup (OneDrive, D:\\MyData, the Google Keep notes) would copy right now, and what it would leave alone. No copying.
//
//   node scripts/r21-preview.mjs --db <backuphub.db or a COPY of it> --backup <number or name> [--all] [--max-open 5000]
//
// Prints: files and bytes to copy (new and changed), already backed up (and how many by their content), in use by another program, online only (OneDrive),
// excluded. The database is opened READ ONLY and nothing is written anywhere: no drive, no folder, no database. The folder is only walked (names, sizes, dates);
// the files to copy are asked about (a OneDrive file's attributes; a plain open and close of any other file, no byte is read). The Google Keep notes are
// never opened. Writes one temporary bundle of the code to the system temp folder and removes it. Refuses the real data folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const value = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const dbPath = value('--db');
if (!dbPath) {
  console.error('usage: node scripts/r21-preview.mjs --db <copy of backuphub.db> --backup <number or name> [--all] [--max-open N]');
  process.exit(2);
}

if (/[\\/]backup ?hub[\\/]data[\\/]/i.test(path.resolve(dbPath))) {
  console.error('That is the real data folder. Make a copy of the database first and point --db at the copy.');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const betterSqlite = require.resolve('better-sqlite3');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-r21-'));
const bundle = path.join(work, 'preview.cjs');
let code = 1;
try {
  await build({
    entryPoints: [path.join(root, 'src', 'main', 'folderBackup', 'previewTool.ts')],
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
  const { runFolderPreview } = createRequire(bundle)(bundle);
  code = await runFolderPreview({
    dbPath: path.resolve(dbPath),
    backup: value('--backup'),
    all: args.includes('--all'),
    maxOpen: value('--max-open') === undefined ? undefined : Number(value('--max-open')),
    print: (line) => console.log(line),
  });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(code);
