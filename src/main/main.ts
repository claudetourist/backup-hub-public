import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, powerMonitor, powerSaveBlocker, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { DEV_CSP, PRODUCTION_CSP } from '../shared/csp';
import { IPC, type TimingsSnapshot } from '../shared/ipc';
import { estimateCheckMs, type StartupPhase, type StartupStatus } from '../shared/startup';
import { wireAppIpc } from './appIpc';
import { createAppServices, type AppServices } from './appServices';
import { decideDevDataDir, realDataDirs, resolveDataPaths, type ResolvedPaths } from './dataDir';
import { BENCH_IDLE_MS, finishBench, readBenchConfig } from './bench';
import { closeDatabase, DB_FILE_NAME, initDatabaseAsync, markCleanShutdown, type Db } from './db';
import { registerBuiltinJobs, seedDemoJobs } from './jobs/builtinJobs';
import { wireJobs } from './jobs/electronWiring';
import { JobService } from './jobs/jobService';
import { assertWritable } from './fsutil';
import { initLogger, logger } from './logger';
import { migrateInWorker, quickCheckInWorker, warmSqliteInWorker } from './query/queryService';
import { createBeforeQuit } from './quitFlow';
import { AdbClient } from './adb/adbPort';
import { releaseWithin, QUIT_RELEASE_MS } from './adb/adbRelease';
import { childRegistry } from './lifecycle/childProcesses';
import { crashDumpsDir, startCrashDumps } from './lifecycle/crashDumps';
import { cleanUpLeftovers } from './lifecycle/leftovers';
import { buildShutdownSteps, createShutdown } from './lifecycle/shutdown';
import { createGoneDecider, disposeWithWindow, installChildGoneTrigger, installProcessTriggers, installRendererGone, installSessionEnd, WindowListeners } from './lifecycle/triggers';
import { workerRegistry } from './lifecycle/workers';
import { setDigestWorkerPath } from './hashing/blockDigest';
import { runPowerShell } from './listing/powershell';
import { createUpkeepScheduler } from './upkeep/electronUpkeep';
import type { UpkeepScheduler } from './upkeep/upkeepScheduler';
import { StallMonitor } from './stallMonitor';
import { busy } from './busyTracker';
import { profileOnceIfAsked } from './profileOnce';
import { StartupTimings } from './timing';
import { configureOwnFiles } from './danger/ownFiles';
import { applyCsp, denyAllPermissions, guardAllWebContents } from './hardening';
import { createAppUrlCheck } from './ipc/origin';
import { createSecureIpc, type SecureIpc } from './ipc/secureIpc';

// Same colour as --color-ground in the renderer's tokens.css, so the window never flashes white.
const GROUND_COLOR = '#F3F5F2';

/** Jobs never start before this long after the first paint (PLAN: no background work before first paint). */
const JOBS_START_DELAY_MS = 3000;
/** If the renderer never reports a first paint, start jobs anyway after this long. */
const JOBS_START_FALLBACK_MS = 20_000;
/** The database is opened after the window is visible; if ready-to-show never comes, open it after this long. */
const DB_OPEN_FALLBACK_MS = 5000;

// First thing: remember when this process was born so every mark is relative to it.
const timings = new StartupTimings();

// Memory (budget: under 300 MB idle): the page is a few local files and the screens are plain HTML, so no GPU drawing is needed.
// Software drawing keeps the GPU process small, and the network service runs inside the main process instead of as its own process.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');


// Bench run (npm run bench): only the packaged app, only with temp-folder paths; it never opens the real data and keeps its own
// Electron user folder, so it cannot clash with a running Backup Hub. Otherwise `bench` is null and nothing below changes.
const benchSetup = readBenchConfig(process.env, app.isPackaged);
const bench = benchSetup.config;
if (benchSetup.error) {
  console.error(benchSetup.error);
  app.exit(1);
} else if (bench) {
  app.setPath('userData', path.join(bench.dataDir, 'electron'));
}

// Crash dumps stay on this computer (nothing is uploaded), in a "crashes" folder inside the logs folder; started before the app is ready.
if (!benchSetup.error && !started) {
  startCrashDumps({
    app,
    crashReporter,
    dir: crashDumpsDir({ isPackaged: app.isPackaged, benchDataDir: bench?.dataDir ?? null, envDataDir: process.env['BACKUPHUB_DATA_DIR'], appDataDir: app.getPath('appData'), forbiddenRoots: forbiddenDataRoots() }),
    log: logger,
  });
}

if (started) {
  // Squirrel install/uninstall hook: do nothing else.
  app.quit();
}

const gotLock = started || benchSetup.error ? false : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let paths: ResolvedPaths | null = null;
let db: Db | null = null;
let jobs: JobService | null = null;
/** Decides when the invisible upkeep process may run (idle, mains power, no job, not paused). Never created in a bench run. */
let upkeep: UpkeepScheduler | null = null;
let dbOpenStarted = false;
/** What the start-up is doing while the data is not ready (the window says it in plain words on Home); the check and the migration run on worker threads. */
let startupPhase: { phase: StartupPhase; since: number; estimateMs: number | null } = { phase: 'opening', since: Date.now(), estimateMs: null };
function setStartupPhase(phase: StartupPhase, estimateMs: number | null = null): void {
  startupPhase = { phase, since: Date.now(), estimateMs };
}
function startupStatus(): StartupStatus {
  return { phase: startupPhase.phase, elapsedMs: Date.now() - startupPhase.since, estimateMs: startupPhase.estimateMs };
}
let jobsStarted = false;
let resolveJobs: (service: JobService) => void = () => undefined;
/** Resolves when the database is open and the job service exists; DB-dependent IPC waits on it. */
const jobsReady = new Promise<JobService>((resolve) => {
  resolveJobs = resolve;
});
let resolveServices: (services: AppServices) => void = () => undefined;
/** Resolves when the places, profiles, settings and vault services exist. */
const servicesReady = new Promise<AppServices>((resolve) => {
  resolveServices = resolve;
});
let services: AppServices | null = null;
let dbShutdownDone = false;
/** Logs a warning when the main loop is blocked for over half a second (with the running job kinds). */
const stallMonitor = new StallMonitor({
  thresholdMs: 500,
  runningKinds: () => {
    try {
      return jobs?.list({ states: ['running'] }).map((job) => job.kind) ?? [];
    } catch {
      return [];
    }
  },
  busyDuring: (windowMs) => busy.describe(windowMs),
  warn: (message) => logger.warn(`[stall] ${message}`),
});

/**
 * The one way out (see lifecycle/shutdown.ts). Every exit reaches it: quit and window-all-closed (through before-quit, quitFlow.ts),
 * an error nobody caught, a signal, Windows log-off or shut-down, and a renderer or GPU process that is gone for good.
 * Each part is a no-op for something that was never built (a quit before the database opened).
 */
const shutdown = createShutdown({
  steps: buildShutdownSteps({
    stopTimers: () => {
      stallMonitor.stop();
      services?.places.stopPolling();
      services?.usb.stop();
      services?.walKeeper.stop();
      upkeep?.stop();
    },
    pauseJobs: (maxMs) => jobs?.shutdownAndWait(maxMs) ?? Promise.resolve(),
    stopUpkeepProcess: () => upkeep?.endNow(),
    closeServices: () => {
      services?.pause.close();
      services?.vault.close();
      services?.query.close();
      services?.search.close();
      services?.searchIndex.close();
      services?.quickRunner.close();
    },
    terminateWorkers: () => workerRegistry.terminateAll(),
    releaseAdb: () => services?.releasePhoneOnQuit() ?? Promise.resolve(),
    endChildren: () => childRegistry.endAll(),
    closeDatabase: () => closeDatabaseOnce(),
  }),
  exit: (code) => app.exit(code),
  log: logger,
});
installProcessTriggers({ proc: process, shutdown, log: logger });
const decideGone = createGoneDecider();
installChildGoneTrigger({ app, shutdown, log: logger, decide: decideGone });

let summaryLogged = false;
let summaryTimer: NodeJS.Timeout | null = null;

function logSummaryOnce(reason: 'complete' | 'timeout'): void {
  if (summaryLogged) return;
  summaryLogged = true;
  if (summaryTimer) clearTimeout(summaryTimer);
  const snapshot = timings.snapshot();
  logger.info(reason === 'timeout' ? `${snapshot.summary} [gave up waiting]` : snapshot.summary);
}

function pushTimings(snapshot: TimingsSnapshot): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('timings:updated', snapshot);
}

function markTiming(name: Parameters<StartupTimings['mark']>[0]): void {
  timings.mark(name);
  const snapshot = timings.snapshot();
  if (snapshot.complete) logSummaryOnce('complete');
  pushTimings(snapshot);
}

/** Folders data must never live in: next to the executable, in the app bundle, in `out\`. */
function forbiddenDataRoots(): string[] {
  const appPath = app.getAppPath();
  return [path.dirname(process.execPath), appPath, path.join(appPath, 'out')];
}

/** Last step of the shutdown routine: close the database cleanly. Runs once. */
function closeDatabaseOnce(): void {
  if (dbShutdownDone || !db) return;
  dbShutdownDone = true;
  // No copy of the database is made on the way out any more.
  try {
    markCleanShutdown(db);
  } catch (err) {
    logger.warn('db: could not record the clean shutdown', err);
  }
  closeDatabase(db, logger);
  db = null;
}

/** Plain-language stop screen for a database that fails its integrity check. Nothing was changed. */
function showDatabaseProblem(file: string, dataDir: string, messages: string[], reason: 'integrity' | 'error'): void {
  const what =
    reason === 'integrity'
      ? 'The Backup Hub database did not pass its safety check, so the app has stopped without changing anything.'
      : 'Backup Hub could not open its database, so the app has stopped without changing anything.';
  dialog.showErrorBox(
    'Backup Hub cannot start',
    [
      what,
      '',
      `Data folder: ${dataDir}`,
      `Database file: ${file}`,
      '',
      'Your files and backups are not affected, and the database file was left exactly as it was.',
      'Please tell Claude (or whoever looks after this app) what you see below.',
      'Daily copies of the database are kept in the "snapshots" folder inside the data folder.',
      '',
      'Details:',
      ...messages.slice(0, 5),
    ].join('\n'),
  );
}

function registerIpc(secure: SecureIpc): void {
  secure.handle(IPC.appVersion, () => app.getVersion());
  secure.handle(IPC.appDataReady, async () => {
    await servicesReady;
    return true;
  });
  secure.handle(IPC.appStartupStatus, () => startupStatus());
  secure.handle(IPC.appTimings, () => timings.snapshot());
  secure.on(IPC.reportFirstPaint, (report) => {
    // The sender is already known to be our own window (secureIpc).
    if (typeof report.fcpMs === 'number') logger.info(`renderer first-contentful-paint ${Math.round(report.fcpMs)}ms after navigation start`);
    markTiming('firstPaint');
    scheduleJobsStart(JOBS_START_DELAY_MS);
  });
  let benchReported = false;
  secure.handle(IPC.benchReport, (report) => {
    if (!bench || !paths || benchReported) throw new Error('Not a bench run');
    benchReported = true;
    const dbFile = path.join(paths.dataDir, DB_FILE_NAME);
    void finishBench({
      report,
      config: bench,
      idleMs: BENCH_IDLE_MS,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      metrics: () => app.getAppMetrics(),
      stall: () => ({ maxMs: stallMonitor.maxStallMs, count: stallMonitor.stalls }),
      timings: () => timings.snapshot(),
      dbBytes: () => [dbFile, `${dbFile}-wal`].reduce((sum, file) => sum + (fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0), 0),
      electron: process.versions.electron,
      quit: () => app.quit(),
      log: logger,
    });
    return true;
  });
}

/** Dev runs only: BACKUPHUB_V1_SOURCE_DIR points the v1 import at a test copy. Ignored when packaged. */
function devImportSourceDir(): string | undefined {
  const dir = process.env['BACKUPHUB_V1_SOURCE_DIR'];
  return !app.isPackaged && dir ? dir : undefined;
}

/** Lets the event loop run its timers and I/O before the next slice of start-up work (the stall monitor, the window's own calls). */
const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

/** Open the database and start the services that need it. Runs after the window is visible. */
async function openDatabaseAndServices(): Promise<void> {
  if (dbOpenStarted || !paths) return;
  dbOpenStarted = true;
  // A needed quick_check runs on a worker thread with its own read-only connection; nothing writes before it passes. Then the
  // migrations run on a worker too (its own read-write connection, before ours opens), so neither blocks the main loop.
  const workerPath = path.join(__dirname, 'queryWorker.js');
  const opened = await initDatabaseAsync(
    paths.dataDir,
    logger,
    (file) => quickCheckInWorker(workerPath, file),
    ({ bytes }) => setStartupPhase('checking', estimateCheckMs(bytes)),
    Date.now,
    { run: (file) => migrateInWorker(workerPath, file), onStart: () => setStartupPhase('updating') },
  );
  setStartupPhase('opening');
  if (!opened.ok) {
    // Nothing was written. Drop the half-loaded window so the user sees only the explanation.
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    showDatabaseProblem(opened.file, paths.dataDir, opened.messages, opened.reason);
    app.exit(1);
    return;
  }
  db = opened.db;
  markTiming('dbReady');
  // The checksums of a copy's blocks are made on this worker thread, not on the window's thread (hashing/blockDigest.ts).
  setDigestWorkerPath(path.join(__dirname, 'digestWorker.js'));

  // Start-up work is cut into slices (each `nextTurn`) so no single slice blocks the main loop for long.
  await nextTurn();
  const service = new JobService({ db, log: logger });
  registerBuiltinJobs(service, { db, dataDir: paths.dataDir, log: logger, copyRefusal: () => services?.dataSpace.copyRefusal() ?? null, checkInWorker: (file) => quickCheckInWorker(path.join(__dirname, 'queryWorker.js'), file, 'full') }, !app.isPackaged);
  jobs = service;
  resolveJobs(service);
  await nextTurn();
  services = createAppServices({ db, dbFile: opened.file, keepSearchIndex: true, dataDir: paths.dataDir, logsDir: paths.logsDir, appVersion: app.getVersion(), jobs: service, log: logger, isOnBattery: () => powerMonitor.isOnBatteryPower(), keepAwake: () => { const id = powerSaveBlocker.start('prevent-app-suspension'); return () => { if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id); }; }, importSourceDir: devImportSourceDir(), openExternal: (url) => shell.openExternal(url) });
  await nextTurn();
  resolveServices(services);
  // After every handler is registered (the import is resumable and must be found).
  service.recoverInterrupted();
  if (!app.isPackaged && process.env['BACKUPHUB_DEMO_JOBS'] === '1') seedDemoJobs(service);
}

/** Let queued jobs run, prune old job log lines and queue the daily jobs. Happens once. */
function startJobs(): void {
  if (jobsStarted) return;
  jobsStarted = true;
  void (async () => {
    const service = await jobsReady;
    service.start();
    // Drive polling starts with the jobs: nothing runs in the background before the first paint.
    const ready = await servicesReady;
    // A bench run never looks at the attached drives (it reads their ID cards): it measures the app on the generated data only.
    if (!bench) {
      // Leftovers of a crashed last session: PowerShell helpers with the Backup Hub marker, and a running adb server. Ends nothing else.
      const adb = new AdbClient();
      void cleanUpLeftovers({
        runFinder: (script) => runPowerShell(script, { timeoutMs: 30_000 }),
        kill: (pid) => process.kill(pid),
        ownPid: process.pid,
        releaseAdb: () => releaseWithin(adb, QUIT_RELEASE_MS),
        log: logger,
      });
      ready.places.startPolling();
      // Folders to list are prepared after the first drive listing. NOTHING starts by itself (Simple plan, rule 2): no listing,
      // no sorting, no daily copy, no timers. Jobs are created only by the person's own clicks.
      void ready.places.refresh().then(() => ready.prepareListing()).catch((err: unknown) => logger.warn('[main] prepareListing failed:', err));
      startUpkeep(service, ready);
    }
  })();
}

/**
 * The invisible upkeep of the database (sorting old rows, trimming old history, a daily optimize) runs in its own process, only when the
 * computer has been idle for 3 minutes, on mains power, with no job and Pause everything off; it stops within a second when any of that ends.
 * It is not a job: it never shows in Activity or on Home, and its errors go to the log only.
 */
function startUpkeep(service: JobService, ready: AppServices): void {
  if (upkeep || !paths) return;
  const scheduler = createUpkeepScheduler({ scriptPath: path.join(__dirname, 'upkeepProcess.js'), dbFile: path.join(paths.dataDir, DB_FILE_NAME), jobs: service, pause: ready.pause, log: logger });
  upkeep = scheduler;
  ready.pause.onChanged(() => scheduler.check());
  service.onChanged((event) => {
    if (event.reason === 'created' || event.reason === 'state') scheduler.check();
  });
  scheduler.start();
}

/** Jobs begin JOBS_START_DELAY_MS after the first paint (or after the long fallback). */
function scheduleJobsStart(delayMs: number): void {
  setTimeout(startJobs, delayMs).unref();
}

function loadRenderer(win: BrowserWindow): void {
  // Dev only: BACKUPHUB_DEV_HASH=jobs opens the Jobs screen (screenshots without clicking).
  const devHash = !app.isPackaged ? (process.env['BACKUPHUB_DEV_HASH'] ?? '') : '';
  const load = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? win.loadURL(devHash ? `${MAIN_WINDOW_VITE_DEV_SERVER_URL}#${devHash}` : MAIN_WINDOW_VITE_DEV_SERVER_URL)
    : win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`), bench ? { hash: '/home?bench' } : undefined);
  load.catch((err: unknown) => logger.error('[main] failed to load renderer:', err));
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: GROUND_COLOR,
    title: 'Backup Hub',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
  markTiming('windowCreated');
  // While the page loads: have a worker load the SQLite addon, so the main thread's own load (about 100 ms) is not a stall.
  warmSqliteInWorker(path.join(__dirname, 'queryWorker.js'));

  win.once('ready-to-show', () => {
    markTiming('readyToShow');
    win.show();
    // The database opens only now, so it never delays the first window.
    setImmediate(() => void openDatabaseAndServices());
  });
  win.on('closed', () => {
    mainWindow = null;
  });
  // Every listener below belongs to this window and is removed when it closes (none outlives its window).
  const listeners = new WindowListeners();
  disposeWithWindow(win, listeners);
  // Windows log-off and shut-down (Electron emits no before-quit then).
  installSessionEnd(win, shutdown, listeners);

  // The shell never navigates away or opens windows: see guardAllWebContents in start() (external links go to the default browser).
  listeners.on(win.webContents, 'console-message', (event: { message: string; level: string; sourceId: string; lineNumber: number }) => {
    // The dev-only "Insecure Content-Security-Policy" notice is expected under Vite and absent when packaged.
    if (event.message.includes('Electron Security Warning')) return;
    if (event.level === 'warning' || event.level === 'error') {
      logger.warn(`[renderer ${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  // The page itself hung (Windows would show "Not responding"): log when and for how long.
  let hungSince: number | null = null;
  listeners.on(win, 'unresponsive', () => {
    hungSince = Date.now();
    logger.warn(`[freeze] the window stopped responding; window calls: ${busy.describe(5000) || 'none'}`);
  });
  listeners.on(win, 'responsive', () => {
    if (hungSince !== null) logger.warn(`[freeze] the window responds again after ${Date.now() - hungSince} ms`);
    hungSince = null;
  });
  // The page process ended: load the page again, or (launch failed, or the third crash in a minute) shut down in order.
  installRendererGone({
    win,
    listeners,
    decide: decideGone,
    reload: () => {
      if (!win.isDestroyed()) loadRenderer(win);
    },
    shutdown,
    log: logger,
  });
  listeners.on(win.webContents, 'preload-error', (_event: unknown, preloadPath: string, error: unknown) => {
    logger.error('[preload error]', preloadPath, error);
  });

  // Its own turn: creating the window is one long native call, and the page's first request is another.
  setTimeout(() => {
    if (!win.isDestroyed()) loadRenderer(win);
  }, 1);
  if (!app.isPackaged && process.env['BACKUPHUB_DEVTOOLS'] === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }
}

if (gotLock) {
  app.setAppUserModelId('com.backuphub.app');

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  // Quit, and the last window closing (which asks to quit), both go through the one shutdown routine (quitFlow.ts -> lifecycle/shutdown.ts).
  app.on('before-quit', createBeforeQuit({ shutdown, quitAgain: () => app.quit() }));
  app.on('window-all-closed', () => {
    app.quit();
  });

  start().catch((err: unknown) => {
    logger.error('[startup] failed:', err);
  });
}

async function start(): Promise<void> {
  await app.whenReady();
  markTiming('appReady');
  Menu.setApplicationMenu(null);

  // Hard guard: an unpackaged (dev) run can never open the real data folder. It needs
  // BACKUPHUB_DATA_DIR pointing at a separate temporary folder, and that folder may not be (or overlap)
  // the default data dir or the one location.json names. The real folder is not even created.
  const appDataDir = app.getPath('appData');
  // (A bench run is the one packaged run that takes the same path: its temp data folder, checked against the real ones.)
  const envDataRun = !app.isPackaged || bench !== null;
  const dev = decideDevDataDir({
    isPackaged: !envDataRun,
    envDataDir: process.env['BACKUPHUB_DATA_DIR'],
    realDirs: envDataRun ? realDataDirs(appDataDir) : [],
  });
  if (!dev.ok) {
    console.error(`[startup] ${dev.title}: ${dev.message}`);
    dialog.showErrorBox(dev.title, dev.message);
    app.exit(1);
    return;
  }
  if (dev.dataDir !== null) {
    paths = {
      dataDir: dev.dataDir,
      logsDir: path.join(dev.dataDir, 'logs'),
      locationFile: path.join(appDataDir, 'BackupHub', 'location.json'),
      source: 'default',
      warnings: [],
    };
    assertWritable(paths.logsDir); // T7 write ban (a dev data folder on a protected drive is refused)
    fs.mkdirSync(paths.logsDir, { recursive: true });
  } else {
    try {
      paths = resolveDataPaths({ appDataDir, forbiddenRoots: forbiddenDataRoots() });
    } catch (err) {
      dialog.showErrorBox('Backup Hub cannot start', `Could not prepare its data folder.\n\n${(err as Error).message}`);
      app.exit(1);
      return;
    }
  }
  // The app's own files (logs, temp, scratch, safety copies) may be removed only through danger/ownFiles, inside these places.
  configureOwnFiles({ dataDir: paths.dataDir, logsDir: paths.logsDir, log: (line) => logger.info(line) });
  initLogger({ dir: paths.logsDir, console: !app.isPackaged });
  profileOnceIfAsked(paths.logsDir, (line) => logger.info(line));
  logger.info(
    `Backup Hub ${app.getVersion()} starting (${app.isPackaged ? 'packaged' : 'dev'}), electron ${process.versions.electron}`,
  );
  logger.info(`data dir: ${paths.dataDir} (${paths.source}); logs dir: ${paths.logsDir}`);
  stallMonitor.start();
  for (const warning of paths.warnings) logger.warn(`data dir: ${warning}`);

  // Response-header CSP in both modes: the strict production policy when packaged (the built index.html also carries it as a
  // meta tag), the same policy plus what Vite's dev server needs (shared/csp.ts) in dev.
  applyCsp(session.defaultSession, app.isPackaged ? PRODUCTION_CSP : DEV_CSP);
  // Deny every permission, block webviews, pop-ups and navigation away from the app. Registered before the first window exists.
  const isAppUrl = createAppUrlCheck({
    devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL || null,
    indexFile: path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
  });
  denyAllPermissions(session.defaultSession);
  guardAllWebContents(app, { isAppUrl, openExternal: (url) => void shell.openExternal(url) });

  // Every IPC handler is registered through this: sender check, then the channel's zod schema (ipc/schemas.ts).
  const secure = createSecureIpc({ ipcMain, getWindow: () => mainWindow, isAppUrl, log: logger });
  registerIpc(secure);
  wireJobs({
    secure,
    ready: jobsReady,
    getWindow: () => mainWindow,
    log: logger,
    dev: !app.isPackaged,
    // Evaluated for every toast: the Settings switch applies at once. Demo runs never toast.
    notificationsEnabled: () => process.env['BACKUPHUB_DEMO_JOBS'] !== '1' && (services?.settings.get().notificationsEnabled ?? true),
  });
  wireAppIpc({ secure, ready: servicesReady, getWindow: () => mainWindow, log: logger });
  createWindow();
  setTimeout(() => void openDatabaseAndServices(), DB_OPEN_FALLBACK_MS).unref();
  scheduleJobsStart(JOBS_START_FALLBACK_MS);
  summaryTimer = setTimeout(() => logSummaryOnce('timeout'), 15_000);
  summaryTimer.unref();
}
