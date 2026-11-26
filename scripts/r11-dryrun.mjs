// R1.1 dry run: the same seed and "bring in PhoneBackup history" as the Backups screen, against a COPY of the database.
//
//   node scripts/r11-dryrun.mjs --db <copy of backuphub.db> [--t7 F:\] [--config <PhoneBackup config.json>] [--repeat]
//
// Reads the three real history files (ledger.db) read only from the T7, found by its identity card (never by a letter), and writes
// ONLY to the copy given by --db. Refuses a database inside a "Backup Hub\data" folder (the real one). Prints the counts. --repeat runs the import twice and
// shows that the second run changed no count. Writes one temporary bundle of the code to the system temp folder and removes it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => args.indexOf(name);
const value = (name) => (flag(name) >= 0 ? args[flag(name) + 1] : undefined);
const dbPath = value('--db');
if (!dbPath) {
  console.error('usage: node scripts/r11-dryrun.mjs --db <copy of backuphub.db> [--t7 F:\\] [--config <config.json>] [--repeat]');
  process.exit(2);
}
// The same refusal as in the code (checked again there), so a wrong path stops before anything is built.
const given = path.resolve(dbPath).toLowerCase();
if (/[\\/]backup ?hub[\\/]data([\\/]|$)/.test(given)) {
  console.error('This is the real database folder. A dry run only ever works on a copy. Nothing was done.');
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const betterSqlite = require.resolve('better-sqlite3');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-r11-'));
const bundle = path.join(work, 'dryrun.cjs');
let code = 1;
try {
  await build({
    entryPoints: [path.join(root, 'src', 'main', 'backupProfiles', 'dryRun.ts')],
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
  const { runDryRun } = createRequire(bundle)(bundle);
  code = await runDryRun({
    dbPath: path.resolve(dbPath),
    t7Root: value('--t7'),
    configPath: value('--config'),
    repeat: flag('--repeat') >= 0,
    print: (line) => console.log(line),
  });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(code);
