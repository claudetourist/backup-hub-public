// R1.3 proof helper: prints what "Bring the second drive up to date" would copy for one backup, and what "Check old copies" would read (files per group, one read or two, a rough time). No copying.
//
//   node scripts/r13-preview.mjs --db <backuphub.db or a COPY of it> [--backup <number or name>] [--all]
//        [--hash --t7 <first drive root, e.g. F:\\> --seagate <second drive root, e.g. G:\\> [--limit 200]]
//
// READS the index (opened read only). It copies nothing, records nothing and writes nothing. With --hash it also READS (never writes) up to --limit
// files that are already on both drives with the same size (the second drive's file; the first drive's only when its checksum is not known), without the Windows cache, to say how many are the same. Writes one temporary bundle of the
// code to the system temp folder and removes it. Refuses the real data folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const value = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const dbPath = value('--db');
if (!dbPath) {
  console.error('usage: node scripts/r13-preview.mjs --db <copy of backuphub.db> [--backup <number or name>] [--all] [--hash --t7 <root> --seagate <root> [--limit N]]');
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

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-r13-'));
const bundle = path.join(work, 'preview.cjs');
let code = 1;
try {
  await build({
    entryPoints: [path.join(root, 'src', 'main', 'mirror', 'mirrorPreviewTool.ts')],
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
  const { runMirrorPreview } = createRequire(bundle)(bundle);
  code = await runMirrorPreview({
    dbPath: path.resolve(dbPath),
    backup: value('--backup'),
    all: args.includes('--all'),
    hash: args.includes('--hash'),
    srcRoot: value('--t7'),
    dstRoot: value('--seagate'),
    limit: value('--limit') === undefined ? undefined : Number(value('--limit')),
    print: (line) => console.log(line),
  });
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
process.exit(code);
