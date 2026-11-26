/**
 * The laptop app data list and its folder rules, shared by main and the settings. Pure data and pure functions only.
 *
 * Paths of the laptop app data list use %APPDATA% / %LOCALAPPDATA% / %USERPROFILE% tokens that main resolves at run time,
 * so no user or laptop name is ever written down here.
 */

/** The job that copies the laptop app data list to a drive as a dated folder. */
export const APPDATA_SNAPSHOT_JOB_KIND = 'appdata.snapshot';
/** Folder on the drive that holds the dated app data copies; NEVER listed and never sent to the cloud. */
export const APPDATA_ROOT_FOLDER = 'Laptop-AppData';
export const APPDATA_MANIFEST = 'manifest.json';
export const APPDATA_README = 'README.txt';
/** No job starts on a drive with less free room than this. */
export const MIN_DRIVE_FREE_BYTES = 2_000_000_000;
/** A drive with a USB error in this window is "having USB trouble". */
export const USB_TROUBLE_WINDOW_MS = 30 * 60 * 1000;
export const MAX_APPDATA_SOURCES = 100;

/** True when a stored rel_path sits inside a `Laptop-AppData` folder (case ignored). App data never enters the catalog or the cloud. */
export function isAppDataRelPath(relPath: string): boolean {
  return relPath
    .replaceAll('\\', '/')
    .split('/')
    .some((part) => part.toLowerCase() === APPDATA_ROOT_FOLDER.toLowerCase());
}

// ---- App data list -------------------------------------------------------------------------------------------------

export type AppDataPriority = 'high' | 'medium' | 'low';
export const APPDATA_PRIORITIES: readonly AppDataPriority[] = ['high', 'medium', 'low'];

export interface AppDataSource {
  /** Starts with %APPDATA%\, %LOCALAPPDATA%\ or %USERPROFILE%\. One segment may be a `*`. */
  path: string;
  priority: AppDataPriority;
  on: boolean;
}

const src = (path: string, priority: AppDataPriority): AppDataSource => ({ path, priority, on: true });

/** The user's list (6 Nov 2026). Measured at about 700 MB per copy after the excludes below. */
export const DEFAULT_APPDATA_SOURCES: readonly AppDataSource[] = [
  src('%APPDATA%\\Mozilla\\Firefox\\Profiles', 'high'),
  src('%LOCALAPPDATA%\\Claude-Data', 'high'),
  src('%APPDATA%\\Notepad++', 'high'),
  src('%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\Bookmarks', 'medium'),
  src('%APPDATA%\\Code\\User', 'medium'),
  src('%APPDATA%\\Cursor\\User', 'medium'),
  src('%APPDATA%\\Kiro\\User', 'medium'),
  src('%APPDATA%\\MongoDB Compass', 'medium'),
  src('%APPDATA%\\Postman', 'medium'),
  src('%APPDATA%\\Anki2', 'medium'),
  src('%LOCALAPPDATA%\\Packages\\Microsoft.MicrosoftStickyNotes_*\\LocalState', 'low'),
  src('%LOCALAPPDATA%\\Packages\\Microsoft.WindowsTerminal_*\\LocalState', 'low'),
  src('%APPDATA%\\Scooter Software', 'low'),
  src('%APPDATA%\\vlc', 'low'),
  src('%APPDATA%\\qBittorrent', 'low'),
  src('%APPDATA%\\Microsoft\\Windows\\PowerShell\\PSReadLine', 'low'),
];

/** Folder names (any depth, case ignored) that are never copied: caches and crash dumps. */
export const APPDATA_EXCLUDE_DIRS: readonly string[] = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'ShaderCache', 'Crashpad', 'blob_storage', 'CacheStorage', 'cache2', 'startupCache', 'crashes', 'minidumps', 'datareporting'];
/** File names never copied: `*.tmp`, `*.lock`, `LOCK`. */
export function isExcludedAppDataFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.tmp') || lower.endsWith('.lock') || lower === 'lock';
}
export function isExcludedAppDataDir(name: string): boolean {
  const lower = name.toLowerCase();
  return APPDATA_EXCLUDE_DIRS.some((d) => d.toLowerCase() === lower);
}

/** Cannot be added, and skipped even inside an added parent. */
export const APPDATA_BLOCKED: readonly string[] = ['%APPDATA%\\gcloud', '%APPDATA%\\GitHub CLI', '%USERPROFILE%\\.config\\gh'];

const TOKEN = /^(%APPDATA%|%LOCALAPPDATA%|%USERPROFILE%)(?:\\|$)/i;

/** Splits a list path into its token and the segments after it, or null when it does not start with a token. */
export function splitAppDataPath(path: string): { token: '%APPDATA%' | '%LOCALAPPDATA%' | '%USERPROFILE%'; segments: string[] } | null {
  const m = TOKEN.exec(path);
  if (!m) return null;
  const token = m[1]!.toUpperCase() as '%APPDATA%' | '%LOCALAPPDATA%' | '%USERPROFILE%';
  const rest = path.slice(m[0].length);
  return { token, segments: rest === '' ? [] : rest.split('\\') };
}

const samePath = (a: string, b: string): boolean => a.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase() === b.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();

/** True when `path` is, or lies inside, a blocked folder (compared as text, tokens upper-cased). */
export function isBlockedAppDataPath(path: string): boolean {
  const norm = path.replaceAll('/', '\\').replace(/\\+$/, '');
  return APPDATA_BLOCKED.some((b) => samePath(norm, b) || norm.toLowerCase().startsWith(`${b.toLowerCase()}\\`));
}

/** Why a path cannot be on the list, in plain words, or null when it is fine. */
export function appDataPathProblem(path: unknown): string | null {
  if (typeof path !== 'string' || path.trim() === '' || path.length > 300) return 'That folder is not valid.';
  const parts = splitAppDataPath(path);
  if (!parts || parts.segments.length === 0) return 'Pick a folder inside AppData or your user folder.';
  if (parts.segments.some((s) => s === '' || s === '.' || s === '..' || /[<>"|?:/]/.test(s))) return 'That folder is not valid.';
  if (parts.segments.filter((s) => s.includes('*')).length > 1 || parts.segments.some((s) => s.includes('*') && s !== s.replace(/\*+/g, '*'))) return 'Only one part of the path may use a star.';
  if (isBlockedAppDataPath(path)) return 'That folder holds sign-in keys and is never copied.';
  return null;
}

/** Checks the whole list (the setting `appDataSources`); null when anything is wrong. */
export function toAppDataSources(value: unknown): AppDataSource[] | null {
  if (!Array.isArray(value) || value.length > MAX_APPDATA_SOURCES) return null;
  const out: AppDataSource[] = [];
  for (const item of value as unknown[]) {
    if (item === null || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    if (appDataPathProblem(o['path']) !== null) return null;
    if (!APPDATA_PRIORITIES.includes(o['priority'] as AppDataPriority) || typeof o['on'] !== 'boolean') return null;
    const path = o['path'] as string;
    if (!out.some((x) => samePath(x.path, path))) out.push({ path, priority: o['priority'] as AppDataPriority, on: o['on'] });
  }
  return out;
}

export function defaultAppDataSources(): AppDataSource[] {
  return DEFAULT_APPDATA_SOURCES.map((s) => ({ path: s.path, priority: s.priority, on: s.on }));
}

export interface SkippedGroup {
  /** The app folder the files belong to (a name for the screen). */
  app: string;
  count: number;
}
