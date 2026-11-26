import type { ChildProcess } from 'node:child_process';
import { powershellArgs, spawnChild } from '../lifecycle/childProcesses';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { powershellPath } from './powershell';
import { ownRemove } from '../danger/ownFiles';
import { APP_FOLDER, LEGACY_CARD_FOLDER, OWN_FILES_FOLDER } from '../../shared/appFolders';

/** A name as a PowerShell single-quoted string (an apostrophe is doubled). */
const psq = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/**
 * Windows file attributes that mark a OneDrive Files On-Demand placeholder (content not on this PC):
 * Offline, RecallOnOpen and RecallOnDataAccess. Node cannot read attributes, so a small PowerShell
 * helper enumerates them; it only reads directory entries and never opens a file.
 */
export const ATTR_OFFLINE = 0x1000;
export const ATTR_RECALL_ON_OPEN = 0x40000;
export const ATTR_RECALL_ON_DATA_ACCESS = 0x400000;
export const CLOUD_ATTRIBUTE_MASK = ATTR_OFFLINE | ATTR_RECALL_ON_OPEN | ATTR_RECALL_ON_DATA_ACCESS;

/** True when the attribute bits say the file's content is in the cloud only. */
export function isCloudOnlyAttributes(attributes: number): boolean {
  return (attributes & CLOUD_ATTRIBUTE_MASK) !== 0;
}

/**
 * The helper script. The root arrives in the BACKUPHUB_ROOT environment variable (no quoting
 * problems). Windows PowerShell 5.1 runs on .NET Framework, so the recursion is manual. Every
 * OneDrive folder is a reparse point (cloud tag), so reparse folders are entered unless PowerShell
 * says they are a junction or symlink, which are never followed. One path per output line;
 * unreadable folders are skipped silently.
 */
export const CLOUD_ONLY_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$mask = ${CLOUD_ATTRIBUTE_MASK}
$skip = @('$RECYCLE.BIN', 'System Volume Information', ${psq(LEGACY_CARD_FOLDER)})
$ownName = ${psq(OWN_FILES_FOLDER)}
$appName = ${psq(APP_FOLDER)}
$out = [Console]::Out
$stack = New-Object System.Collections.Generic.Stack[string]
$stack.Push($env:BACKUPHUB_ROOT)
while ($stack.Count -gt 0) {
  $dir = $stack.Pop()
  try {
    $info = New-Object System.IO.DirectoryInfo($dir)
    foreach ($entry in $info.EnumerateFileSystemInfos()) {
      $attr = [int]$entry.Attributes
      $isDir = ($attr -band 16) -ne 0
      $isReparse = ($attr -band 1024) -ne 0
      $isCloud = ($attr -band $mask) -ne 0
      if ($isDir) {
        if ($skip -contains $entry.Name) { continue }
        if ($entry.Name -eq $ownName -and $info.Name -eq $appName) { continue }
        if ($isReparse -and -not $isCloud) {
          # OneDrive folders are reparse points too (cloud tag, often only "pinned"); skip real links only.
          $link = (Get-Item -LiteralPath $entry.FullName -Force).LinkType
          if ($link -eq 'Junction' -or $link -eq 'SymbolicLink') { continue }
        }
        $stack.Push($entry.FullName)
      } elseif ($isCloud) {
        $out.WriteLine($entry.FullName)
      }
    }
  } catch { }
}
`;

/** Splits a stream of text chunks into complete lines (handles "\r\n" and a BOM at the start). */
export class LineSplitter {
  private rest = '';
  private first = true;

  push(chunk: string): string[] {
    let text = this.rest + chunk;
    if (this.first && text.length > 0) {
      text = text.replace(/^﻿/, '');
      this.first = false;
    }
    const parts = text.split(/\r?\n/);
    this.rest = parts.pop() ?? '';
    return parts.filter((line) => line !== '');
  }

  /** The last line, when the stream ended without a newline. */
  end(): string[] {
    const last = this.rest;
    this.rest = '';
    return last === '' ? [] : [last];
  }
}

export type SpawnFn = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; windowsHide: boolean }) => ChildProcess;

export interface StreamCloudOptions {
  signal?: AbortSignal;
  /** Gives up after this long (default 30 minutes: a huge OneDrive on a slow disk). */
  timeoutMs?: number;
  spawnFn?: SpawnFn;
  /** Defaults to the Windows PowerShell 5.1 path. */
  command?: string;
}

/**
 * Stream the full paths of cloud-only files under `root` to `onPath`. Resolves when the helper
 * ends cleanly; rejects (plain message) when it cannot start, times out, is aborted or exits with
 * an error. Paths already delivered stay delivered.
 */
export function streamCloudOnly(root: string, onPath: (path: string) => void, options: StreamCloudOptions = {}): Promise<void> {
  return runHelper(CLOUD_ONLY_SCRIPT, { BACKUPHUB_ROOT: root }, options, onPath);
}

/** Runs one of the helper scripts in a hidden PowerShell and hands each output line to `onLine`. */
function runHelper(script: string, env: Record<string, string>, options: StreamCloudOptions, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const doSpawn: SpawnFn = options.spawnFn ?? ((command, args, o) => spawnChild(command, args, { ...o, stdio: ['ignore', 'pipe', 'pipe'] }));
    let child: ChildProcess;
    try {
      child = doSpawn(options.command ?? powershellPath(), powershellArgs(script), {
        env: { ...process.env, ...env },
        windowsHide: true,
      });
    } catch (err) {
      reject(new Error(`The cloud-only check could not start (${err instanceof Error ? err.message : String(err)})`));
      return;
    }
    const splitter = new LineSplitter();
    let finished = false;
    const finish = (error: Error | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    };
    const kill = (): void => {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      kill();
      finish(new Error('The cloud-only check took too long'));
    }, options.timeoutMs ?? 30 * 60_000);
    timer.unref();
    const onAbort = (): void => {
      kill();
      finish(new Error('The cloud-only check was stopped'));
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const line of splitter.push(chunk)) onLine(line);
    });
    child.stderr?.resume();
    child.on('error', (err) => finish(new Error(`The cloud-only check could not run (${err.message})`)));
    child.on('close', (code) => {
      for (const line of splitter.end()) onLine(line);
      finish(code === 0 || code === null ? null : new Error(`The cloud-only check ended with an error (code ${code})`));
    });
  });
}

// ---- Path-list check (used right before a OneDrive file is fingerprinted) -----------------------

/** Most paths asked about in one helper run. */
export const MAX_CLOUD_CHECK_PATHS = 5000;

/**
 * What the helper found for one path: `cloud` (content is not on this PC: never open it), `local`
 * (attributes say it is on this PC), `missing`, or `unknown` (the helper could not tell).
 */
export type CloudCheckState = 'cloud' | 'local' | 'missing' | 'unknown';

/**
 * The path-list helper. It reads the given paths from a UTF-8 text file (one per line, named in
 * BACKUPHUB_LIST) and prints "index state" per line, where state is C (cloud-only), L (local),
 * M (missing) or E (could not tell). It only asks Windows for each path's attributes
 * (File.GetAttributes); it never opens a file, so nothing is downloaded.
 */
export const CLOUD_CHECK_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$mask = ${CLOUD_ATTRIBUTE_MASK}
$paths = [System.IO.File]::ReadAllLines($env:BACKUPHUB_LIST, [System.Text.Encoding]::UTF8)
$out = [Console]::Out
for ($i = 0; $i -lt $paths.Length; $i++) {
  try {
    $attr = [int][System.IO.File]::GetAttributes($paths[$i])
    if (($attr -band $mask) -ne 0) { $out.WriteLine("$i C") } else { $out.WriteLine("$i L") }
  } catch [System.IO.FileNotFoundException] {
    $out.WriteLine("$i M")
  } catch [System.IO.DirectoryNotFoundException] {
    $out.WriteLine("$i M")
  } catch {
    $out.WriteLine("$i E")
  }
}
`;

/** Turns one helper output line into an index and a state; null for anything else. */
export function parseCloudCheckLine(line: string): { index: number; state: CloudCheckState } | null {
  const m = /^(\d+) ([CLME])$/.exec(line.trim());
  if (!m) return null;
  const state: CloudCheckState = m[2] === 'C' ? 'cloud' : m[2] === 'L' ? 'local' : m[2] === 'M' ? 'missing' : 'unknown';
  return { index: Number(m[1]), state };
}

export interface CheckCloudOptions extends StreamCloudOptions {
  /** Where the temporary list file goes (default: the system temp folder). */
  tempDir?: string;
}

/**
 * Ask Windows for the attributes of exactly these paths (in runs of at most 5,000) and say which are
 * cloud-only. A path the helper did not answer for comes back as `unknown`: callers must treat
 * that like cloud-only and not read it. Rejects (plain message) only when the helper cannot run.
 */
export async function checkCloudOnlyPaths(
  paths: readonly string[],
  options: CheckCloudOptions = {},
): Promise<Map<string, CloudCheckState>> {
  const result = new Map<string, CloudCheckState>();
  for (let from = 0; from < paths.length; from += MAX_CLOUD_CHECK_PATHS) {
    const group = paths.slice(from, from + MAX_CLOUD_CHECK_PATHS);
    const states = await runCloudCheck(group, options);
    group.forEach((p, i) => result.set(p, states[i] ?? 'unknown'));
  }
  return result;
}

async function runCloudCheck(group: readonly string[], options: CheckCloudOptions): Promise<CloudCheckState[]> {
  const states: CloudCheckState[] = group.map(() => 'unknown');
  const dir = fs.mkdtempSync(path.join(options.tempDir ?? os.tmpdir(), 'backuphub-cloudcheck-'));
  const listFile = path.join(dir, 'paths.txt');
  try {
    fs.writeFileSync(listFile, group.join('\n'), 'utf8');
    await runHelper(CLOUD_CHECK_SCRIPT, { BACKUPHUB_LIST: listFile }, { timeoutMs: 120_000, ...options }, (line) => {
      const parsed = parseCloudCheckLine(line);
      if (parsed && parsed.index < states.length) states[parsed.index] = parsed.state;
    });
  } finally {
    ownRemove(dir, { recursive: true });
  }
  return states;
}
