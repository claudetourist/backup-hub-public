// npm run bench: measures the budgets of PLAN section 5 that apply today and exits non-zero when one is broken.
//   node scripts/bench.mjs [--no-package] [--db <copy of a database>] [--runs 3] [--no-search]
// (--no-search skips the slow search part for a quick look at the launch numbers; the verdict then fails on "not measured".)
// - Packages the app first (npm run package), unless --no-package is given and the package is newer than the source.
// - Search: the real query code on a generated 2,000,000-row database (vitest, scripts/bench/searchBench.spec.ts), cached in the temp folder.
// - Launch, screen switches, stalls, memory: the packaged app, 3 launches, each on a fresh COPY of the database in a temp data folder.
//   --db <file> uses that file (and its -wal) as the source instead of the generated one. The source is only read.
// Everything it writes or deletes is inside <temp>/backuphub-bench (a guard refuses any other path) or out/bench (the result files).
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, formatTable } from './bench/verdict.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const benchRoot = path.join(os.tmpdir(), 'backuphub-bench');
const generatedDb = path.join(benchRoot, 'generated-2m', 'backuphub.db');
const LAUNCH_TIMEOUT_MS = 240_000;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const runCount = Math.max(1, Number(option('--runs') ?? 3) || 3);
const say = (line) => console.log(line);

/** Removes a folder, but only inside the bench temp folder. */
function removeOwn(target) {
  const resolved = path.resolve(target);
  if (!resolved.toLowerCase().startsWith((benchRoot + path.sep).toLowerCase())) throw new Error(`refusing to remove ${resolved}: not inside ${benchRoot}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

function newestMtime(target) {
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.mtimeMs;
  return fs.readdirSync(target).reduce((newest, name) => Math.max(newest, newestMtime(path.join(target, name))), 0);
}

function packagedExe() {
  const out = path.join(appDir, 'out');
  const folder = fs.existsSync(out) ? fs.readdirSync(out).find((name) => name.endsWith('-win32-x64') && fs.existsSync(path.join(out, name, 'BackupHub.exe'))) : undefined;
  return folder ? path.join(out, folder, 'BackupHub.exe') : null;
}

function ensurePackaged() {
  const exe = packagedExe();
  const sources = ['src', 'index.html', 'package.json', 'forge.config.ts', 'vite.main.config.ts', 'vite.preload.config.ts', 'vite.renderer.config.ts'];
  const sourceTime = Math.max(...sources.map((name) => newestMtime(path.join(appDir, name))));
  const packageTime = exe ? newestMtime(path.join(path.dirname(exe), 'resources', 'app.asar')) : 0;
  if (flag('--no-package') && exe && packageTime > sourceTime) {
    say('Using the existing package (newer than the source).');
    return exe;
  }
  say('Packaging the app (npm run package) ...');
  const result = spawnSync('npm run package', { cwd: appDir, shell: true, stdio: 'inherit' });
  const built = packagedExe();
  if (result.status !== 0 || !built) throw new Error('npm run package failed');
  return built;
}

function measureSearch(outFile) {
  say('Search: building the 2,000,000-row database if it is not cached (a few minutes the first time), then measuring ...');
  fs.mkdirSync(benchRoot, { recursive: true });
  const result = spawnSync('npx vitest run --config vitest.bench.config.ts --reporter=dot', {
    cwd: appDir,
    shell: true,
    stdio: 'inherit',
    env: { ...process.env, BACKUPHUB_BENCH_SEARCH_OUT: outFile },
  });
  if (result.status !== 0 || !fs.existsSync(outFile)) throw new Error('the search measurement did not finish');
  return JSON.parse(fs.readFileSync(outFile, 'utf8'));
}

/** A copy of the generated database must not look stale: mark it cleanly closed and recently checked, as the app would have left it. */
function markFresh(dbFile) {
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const db = new Database(dbFile);
  try {
    const set = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    set.run('clean_shutdown', '1');
    set.run('last_integrity_ok_at', String(Date.now()));
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

function logTail(dataDir) {
  try {
    const logs = path.join(dataDir, 'logs');
    return fs
      .readdirSync(logs)
      .filter((name) => name.endsWith('.log'))
      .flatMap((name) => fs.readFileSync(path.join(logs, name), 'utf8').split(/\r?\n/).slice(-15));
  } catch {
    return [];
  }
}

async function launchOnce(exe, index, sourceDb, fromUser) {
  const runDir = path.join(benchRoot, `run-${index}`);
  removeOwn(runDir);
  const dataDir = path.join(runDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, 'backuphub.db');
  fs.copyFileSync(sourceDb, target);
  if (fs.existsSync(`${sourceDb}-wal`)) fs.copyFileSync(`${sourceDb}-wal`, `${target}-wal`);
  if (!fromUser) markFresh(target);
  const resultFile = path.join(runDir, 'result.json');
  const env = { ...process.env, BACKUPHUB_BENCH: resultFile, BACKUPHUB_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [], { env, stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const timedOut = new Promise((resolve) => setTimeout(() => resolve('timeout'), LAUNCH_TIMEOUT_MS).unref());
  const outcome = await Promise.race([exited, timedOut]);
  if (outcome === 'timeout') {
    // Only the process this script started (and its children).
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    await exited;
  }
  let result = null;
  try {
    result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  } catch {
    // reported below
  }
  const failure = result?.ok ? null : { exit: outcome, error: result?.error ?? 'no result file', log: logTail(dataDir) };
  removeOwn(runDir);
  return { result, failure };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function main() {
  const fromUser = option('--db') !== undefined;
  const sourceDb = fromUser ? path.resolve(option('--db')) : generatedDb;
  if (fromUser && !fs.statSync(sourceDb, { throwIfNoEntry: false })?.isFile()) throw new Error(`--db: ${sourceDb} is not a file`);

  const exe = ensurePackaged();
  const search = flag('--no-search') ? null : measureSearch(path.join(benchRoot, 'search.json'));
  if (!fromUser && !fs.existsSync(generatedDb)) throw new Error('the generated database is missing');

  const runs = [];
  for (let i = 1; i <= runCount; i += 1) {
    say(`Launch ${i} of ${runCount} (a fresh copy of ${fromUser ? sourceDb : 'the generated database'}) ...`);
    const { result, failure } = await launchOnce(exe, i, sourceDb, fromUser);
    if (failure) {
      console.error(`Launch ${i} gave no result (${JSON.stringify(failure.exit)}: ${failure.error}). Last log lines:\n${failure.log.join('\n')}`);
      process.exitCode = 2;
      return;
    }
    say(`  home ready ${result.homeReadyMs} ms, memory ${result.memoryMb} MB, longest stall ${result.maxStallMs} ms`);
    runs.push(result);
  }

  const verdict = evaluate(runs, search);
  const table = formatTable(verdict.rows);
  say(`\n${table}\n`);
  say(verdict.pass ? 'BENCH PASSED' : 'BENCH FAILED: at least one budget is broken');
  const outDir = path.join(appDir, 'out', 'bench');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${stamp()}.json`);
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), pass: verdict.pass, source: fromUser ? sourceDb : 'generated 2,000,000-row database', rows: verdict.rows, table, runs, search }, null, 2));
  say(`Written: ${file}`);
  process.exitCode = verdict.pass ? 0 : 1;
}

main().catch((err) => {
  console.error(`bench stopped: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 2;
});
