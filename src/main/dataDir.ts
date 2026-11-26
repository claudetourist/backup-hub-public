import fs from 'node:fs';
import path from 'node:path';

/** Where data and logs live unless location.json says otherwise: below the user's %APPDATA% (never a fixed drive letter). */
export const DEFAULT_ROOT_FOLDER = 'Backup Hub';
export const defaultDataDirFor = (appDataDir: string): string => path.join(appDataDir, DEFAULT_ROOT_FOLDER, 'data');
export const defaultLogsDirFor = (appDataDir: string): string => path.join(appDataDir, DEFAULT_ROOT_FOLDER, 'logs');
/** Folder under %APPDATA% that holds only `location.json` (the pointer to the real data dir). */
export const LOCATION_FOLDER = 'BackupHub';
export const LOCATION_FILE = 'location.json';

export type DataDirSource = 'default' | 'location.json';

type FsApi = Pick<typeof fs, 'readFileSync' | 'mkdirSync'>;

export interface ResolveDataPathsInput {
  /** Usually %APPDATA% (app.getPath('appData')). */
  appDataDir: string;
  defaultDataDir?: string;
  defaultLogsDir?: string;
  /**
   * Folders that must never hold data: the executable's folder, the app bundle, `out\`.
   * A configured or default dataDir/logsDir inside any of these is rejected.
   */
  forbiddenRoots?: readonly string[];
  /** Injectable for tests; defaults to node:fs. */
  fs?: FsApi;
}

export interface ResolvedPaths {
  dataDir: string;
  logsDir: string;
  locationFile: string;
  source: DataDirSource;
  /** Non-fatal problems found while resolving (invalid JSON, forbidden path, ...). */
  warnings: string[];
}

interface LocationConfig {
  dataDir?: unknown;
  logsDir?: unknown;
}

const isWindows = process.platform === 'win32';

function normalize(p: string): string {
  const resolved = path.resolve(p);
  return isWindows ? resolved.toLowerCase() : resolved;
}

/** True when `child` is `parent` or lives anywhere below it. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(normalize(parent), normalize(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Why a candidate directory is unacceptable, or null if it is fine. */
export function rejectReason(candidate: unknown, forbiddenRoots: readonly string[]): string | null {
  if (typeof candidate !== 'string' || candidate.trim() === '') return 'not a non-empty string';
  if (!path.isAbsolute(candidate)) return 'not an absolute path';
  const hit = forbiddenRoots.find((root) => isInside(candidate, root));
  if (hit) return `inside the application folder (${hit})`;
  return null;
}

function readLocation(locationFile: string, fsApi: FsApi, warnings: string[]): LocationConfig {
  let raw: string;
  try {
    raw = fsApi.readFileSync(locationFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(`location.json unreadable (${(err as Error).message}); using defaults`);
    }
    return {};
  }
  try {
    // PowerShell's Out-File writes a BOM; JSON.parse rejects it.
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push('location.json is not a JSON object; using defaults');
      return {};
    }
    const obj = parsed as Record<string, unknown>;
    return { dataDir: obj.dataDir, logsDir: obj.logsDir };
  } catch {
    warnings.push('location.json is not valid JSON; using defaults');
    return {};
  }
}

function ensureDir(dir: string, fsApi: FsApi): string | null {
  try {
    fsApi.mkdirSync(dir, { recursive: true });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Pick one directory: configured value if valid and creatable, else the default (must be creatable). */
function pickDir(
  label: string,
  configured: unknown,
  fallback: string,
  forbiddenRoots: readonly string[],
  fsApi: FsApi,
  warnings: string[],
): { dir: string; fromConfig: boolean } {
  if (configured !== undefined) {
    const reason = rejectReason(configured, forbiddenRoots);
    if (reason) {
      warnings.push(`location.json ${label} ignored: ${reason}`);
    } else {
      const dir = path.resolve(configured as string);
      const failure = ensureDir(dir, fsApi);
      if (!failure) return { dir, fromConfig: true };
      warnings.push(`location.json ${label} "${dir}" cannot be created (${failure}); using default`);
    }
  }
  const dir = path.resolve(fallback);
  const reason = rejectReason(dir, forbiddenRoots);
  if (reason) throw new Error(`Refusing ${label} "${dir}": ${reason}`);
  const failure = ensureDir(dir, fsApi);
  if (failure) throw new Error(`Cannot create ${label} "${dir}": ${failure}`);
  return { dir, fromConfig: false };
}

/**
 * Work out where data and logs live and make sure both folders exist. Reads
 * `<appData>\BackupHub\location.json` ({"dataDir": "...", "logsDir": "..."}); a missing, invalid
 * or forbidden file falls back to the defaults (with a warning for the log). Throws only if
 * even the default folder is forbidden or cannot be created.
 */
export function resolveDataPaths(input: ResolveDataPathsInput): ResolvedPaths {
  const fsApi = input.fs ?? fs;
  const forbidden = input.forbiddenRoots ?? [];
  const warnings: string[] = [];
  const locationFile = path.join(input.appDataDir, LOCATION_FOLDER, LOCATION_FILE);
  const config = readLocation(locationFile, fsApi, warnings);

  const data = pickDir(
    'dataDir',
    config.dataDir,
    input.defaultDataDir ?? defaultDataDirFor(input.appDataDir),
    forbidden,
    fsApi,
    warnings,
  );
  const logs = pickDir(
    'logsDir',
    config.logsDir,
    input.defaultLogsDir ?? defaultLogsDirFor(input.appDataDir),
    forbidden,
    fsApi,
    warnings,
  );

  return {
    dataDir: data.dir,
    logsDir: logs.dir,
    locationFile,
    source: data.fromConfig ? 'location.json' : 'default',
    warnings,
  };
}

export type DevDataDirDecision = { ok: true; dataDir: string } | { ok: false; title: string; message: string };

/**
 * Hard guard for unpackaged (dev) runs: they may NEVER open the real data folder. Pure, so it is
 * unit-tested. `realDirs` are the folders a packaged app would use (the default and whatever
 * location.json points to). A packaged app is always allowed (and ignores the environment variable).
 */
export function decideDevDataDir(input: {
  isPackaged: boolean;
  envDataDir: string | undefined;
  realDirs: readonly string[];
}): DevDataDirDecision | { ok: true; dataDir: null } {
  if (input.isPackaged) return { ok: true, dataDir: null };
  const title = 'Dev run needs BACKUPHUB_DATA_DIR';
  const env = input.envDataDir?.trim();
  if (!env) {
    return {
      ok: false,
      title,
      message:
        'This is a development run, and development runs must never open the real Backup Hub data folder.\n\n' +
        'Set BACKUPHUB_DATA_DIR to a temporary folder (for example <the repo>/.devdata/run1) and start again.',
    };
  }
  if (!path.isAbsolute(env)) {
    return { ok: false, title, message: `BACKUPHUB_DATA_DIR must be an absolute folder path (it is "${env}").` };
  }
  const real = input.realDirs.find((dir) => typeof dir === 'string' && dir !== '' && (isInside(env, dir) || isInside(dir, env)));
  if (real) {
    return {
      ok: false,
      title,
      message: `BACKUPHUB_DATA_DIR ("${env}") is, or overlaps, the real data folder ("${real}"). Development runs must use a separate temporary folder.`,
    };
  }
  return { ok: true, dataDir: path.resolve(env) };
}

/** The data folders a packaged app would use: the default plus the one location.json names (if any). Read only. */
export function realDataDirs(appDataDir: string, defaultDataDir: string = defaultDataDirFor(appDataDir), fsApi: Pick<typeof fs, 'readFileSync'> = fs): string[] {
  const dirs = [defaultDataDir];
  const warnings: string[] = [];
  const configured = readLocation(path.join(appDataDir, LOCATION_FOLDER, LOCATION_FILE), fsApi as FsApi, warnings).dataDir;
  if (typeof configured === 'string' && configured.trim() !== '') dirs.push(configured);
  return dirs;
}
