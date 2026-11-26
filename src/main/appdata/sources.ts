/**
 * The laptop app data list, resolved on THIS Windows profile at run time. Read only: nothing here writes.
 *
 * Paths in the list start with %APPDATA%, %LOCALAPPDATA% or %USERPROFILE% (never a user or laptop name) and may have one `*`
 * segment (Firefox profiles have random names). The walk skips cache and crash folders, temporary and lock files, links, and
 * the blocked folders (sign-in keys) even when they sit inside an added parent.
 */
import type { Stats, Dirent } from 'node:fs';
import { rawFs as fs } from '../rawFs';
import os from 'node:os';
import path from 'node:path';
import {
  APPDATA_BLOCKED,
  isExcludedAppDataDir,
  isExcludedAppDataFile,
  splitAppDataPath,
  type AppDataSource,
} from '../../shared/plans';

export interface AppDataEnv {
  appData: string;
  localAppData: string;
  userProfile: string;
}

/** The folders of the Windows profile this app runs as. Tests pass their own. */
export function appDataEnvFromProcess(env: NodeJS.ProcessEnv = process.env): AppDataEnv {
  const home = env['USERPROFILE'] ?? os.homedir();
  return {
    appData: env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming'),
    localAppData: env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local'),
    userProfile: home,
  };
}

function tokenRoot(token: string, env: AppDataEnv): string {
  return token === '%APPDATA%' ? env.appData : token === '%LOCALAPPDATA%' ? env.localAppData : env.userProfile;
}

const key = (p: string): string => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/** `*` in one segment: letters before and after must match (case ignored). */
function matchSegment(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern.toLowerCase() === name.toLowerCase();
  const [head = '', tail = ''] = pattern.split('*');
  const lower = name.toLowerCase();
  return lower.length >= head.length + tail.length && lower.startsWith(head.toLowerCase()) && lower.endsWith(tail.toLowerCase());
}

export interface ResolvedSource {
  source: AppDataSource;
  /** The real folder (or single file) on this laptop. */
  abs: string;
  isFile: boolean;
  /** Folder name inside the dated copy: the token and the path below it, e.g. `APPDATA__Notepad++`. */
  folderName: string;
  /** A short app name for messages ("Close Firefox and run again"). */
  app: string;
}

const NOISE = new Set(['mozilla', 'google', 'microsoft', 'packages', 'local', 'roaming', 'windows', 'user', 'user data', 'default', 'localstate', 'profiles', 'powershell', 'psreadline', 'scooter software']);

/** A plain app name for a list path. */
export function appNameOf(listPath: string): string {
  const parts = splitAppDataPath(listPath);
  if (!parts) return listPath;
  const names = parts.segments
    .map((s) => s.replace(/\*/g, '').replace(/^Microsoft\./i, '').replace(/_+$/, ''))
    .filter((s) => s !== '' && !NOISE.has(s.toLowerCase()));
  return names.at(0) ?? parts.segments.at(0) ?? listPath;
}

function safeFolderName(token: string, segments: readonly string[]): string {
  const base = [token.replaceAll('%', ''), ...segments].join('__');
  // eslint-disable-next-line no-control-regex
  return base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 150);
}

function exists(p: string): Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** The real folders and files a list entry matches on this laptop now (none when it is not installed). Never follows links. */
export function resolveSource(source: AppDataSource, env: AppDataEnv): ResolvedSource[] {
  const parts = splitAppDataPath(source.path);
  if (!parts || parts.segments.length === 0) return [];
  let candidates: { abs: string; segments: string[] }[] = [{ abs: tokenRoot(parts.token, env), segments: [] }];
  for (const segment of parts.segments) {
    const next: { abs: string; segments: string[] }[] = [];
    for (const c of candidates) {
      if (!segment.includes('*')) {
        const abs = path.join(c.abs, segment);
        if (exists(abs)) next.push({ abs, segments: [...c.segments, segment] });
        continue;
      }
      let names: string[] = [];
      try {
        names = fs.readdirSync(c.abs);
      } catch {
        names = [];
      }
      for (const name of names.toSorted()) if (matchSegment(segment, name)) next.push({ abs: path.join(c.abs, name), segments: [...c.segments, name] });
    }
    candidates = next;
  }
  const out: ResolvedSource[] = [];
  for (const c of candidates) {
    const st = exists(c.abs);
    if (!st || st.isSymbolicLink()) continue;
    if (!st.isDirectory() && !st.isFile()) continue;
    out.push({ source, abs: c.abs, isFile: st.isFile(), folderName: safeFolderName(parts.token, c.segments), app: appNameOf(source.path) });
  }
  return out;
}

/** The blocked folders as real paths on this profile (compared in lower case). */
export function blockedPaths(env: AppDataEnv): string[] {
  return APPDATA_BLOCKED.map((b) => {
    const parts = splitAppDataPath(b)!;
    return key(path.join(tokenRoot(parts.token, env), ...parts.segments));
  });
}

export interface SourceFile {
  abs: string;
  /** Path below the source folder, with "/". For a single file: its own name. */
  rel: string;
  size: number;
  mtimeMs: number;
}

/** True when `abs` is a blocked folder or lies inside one. */
export function isBlockedPath(abs: string, blocked: readonly string[]): boolean {
  const k = key(abs);
  return blocked.some((b) => k === b || k.startsWith(`${b}\\`));
}

/**
 * Walks one resolved source and yields every file worth copying, in name order. Links are never followed. `yieldNow` is
 * called between folders so a big tree does not freeze the app.
 */
export async function* walkSource(resolved: ResolvedSource, blocked: readonly string[], yieldNow: () => Promise<void> = () => Promise.resolve()): AsyncGenerator<SourceFile> {
  if (isBlockedPath(resolved.abs, blocked)) return;
  if (resolved.isFile) {
    const st = exists(resolved.abs);
    if (st?.isFile() && !isExcludedAppDataFile(path.basename(resolved.abs))) yield { abs: resolved.abs, rel: path.basename(resolved.abs), size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
    return;
  }
  const stack: { dir: string; rel: string }[] = [{ dir: resolved.abs, rel: '' }];
  while (stack.length > 0) {
    const { dir, rel } = stack.pop()!;
    await yieldNow();
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const dirs: { dir: string; rel: string }[] = [];
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (isExcludedAppDataDir(entry.name) || isBlockedPath(abs, blocked)) continue;
        dirs.push({ dir: abs, rel: rel === '' ? entry.name : `${rel}/${entry.name}` });
      } else if (entry.isFile()) {
        if (isExcludedAppDataFile(entry.name)) continue;
        let st: Stats;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        yield { abs, rel: rel === '' ? entry.name : `${rel}/${entry.name}`, size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
      }
    }
    for (const d of dirs.toReversed()) stack.push(d);
  }
}

/** Counts how many real folders or files each list entry matches (the plan page shows "not on this laptop" for 0). */
export function countFound(sources: readonly AppDataSource[], env: AppDataEnv): number[] {
  return sources.map((s) => resolveSource(s, env).length);
}

/** Order of work: high first, then medium, then low; inside a priority the list order. Only entries switched on. */
export function orderedSources(sources: readonly AppDataSource[]): AppDataSource[] {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return sources.filter((s) => s.on).map((s, i) => ({ s, i })).toSorted((a, b) => rank[a.s.priority] - rank[b.s.priority] || a.i - b.i).map((x) => x.s);
}

/** A chosen folder (from the picker) as a list path with a token, or null when it is not inside the profile's folders. */
export function toListPath(abs: string, env: AppDataEnv): string | null {
  const candidates: [string, string][] = [
    ['%APPDATA%', env.appData],
    ['%LOCALAPPDATA%', env.localAppData],
    ['%USERPROFILE%', env.userProfile],
  ];
  // The most specific root first: AppData\Local lies inside the profile.
  const sorted = candidates.toSorted((a, b) => b[1].length - a[1].length);
  const k = key(abs);
  // The whole of AppData (or the whole profile) is not a folder to add: it would take everything, caches and sign-ins included.
  if ([env.appData, env.localAppData, path.dirname(env.appData), env.userProfile].some((r) => key(r) === k)) return null;
  for (const [token, root] of sorted) {
    const r = key(root);
    if (k.startsWith(`${r}\\`)) {
      const below = path.resolve(abs).slice(path.resolve(root).length).replace(/^[\\/]+|[\\/]+$/g, '');
      return below === '' ? null : `${token}\\${below.split(/[\\/]+/).join('\\')}`;
    }
  }
  return null;
}
