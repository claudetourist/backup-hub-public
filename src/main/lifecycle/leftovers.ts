import { POWERSHELL_MARKER } from './childProcesses';

/**
 * At start: end the PowerShell helpers a crashed or Task-Manager-killed Backup Hub left behind (they carry the "# BackupHub" marker in
 * their command line), and let go of the phone (`adb kill-server`). Only a process that passes EVERY test in `selectLeftovers` is ended;
 * nothing else on the computer is ever touched.
 */

/** Lists every powershell.exe with its parent and command line, plus every running process id, plus the finder's own id. Read-only. */
export const LEFTOVER_FINDER_SCRIPT = [
  '$alive = @(Get-Process | ForEach-Object { $_.Id })',
  '$procs = @(Get-CimInstance Win32_Process -Filter "Name = \'powershell.exe\'" | ForEach-Object { @{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; name = [string]$_.Name; cmd = [string]$_.CommandLine } })',
  '@{ self = $PID; alive = $alive; procs = $procs } | ConvertTo-Json -Compress -Depth 4',
].join('\n');

export interface ProcessSnapshot {
  /** The finder's own process id. */
  self: number;
  /** Every running process id (to tell whether a helper's parent is still alive). */
  alive: number[];
  procs: { pid: number; parent: number; name: string; cmd: string }[];
}

/** Reads the finder's output; null when it is not what the finder prints. */
export function parseSnapshot(text: string): ProcessSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as { self?: unknown; alive?: unknown; procs?: unknown };
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
  if (typeof o.self !== 'number') return null;
  const alive = list(o.alive).filter((n): n is number => typeof n === 'number');
  const procs = list(o.procs).flatMap((p) => {
    const q = p as { pid?: unknown; parent?: unknown; name?: unknown; cmd?: unknown } | null;
    return q && typeof q.pid === 'number' && typeof q.parent === 'number' && typeof q.name === 'string' && typeof q.cmd === 'string' ? [{ pid: q.pid, parent: q.parent, name: q.name, cmd: q.cmd }] : [];
  });
  return { self: o.self, alive, procs };
}

/**
 * The process ids to end. ALL of these must hold: it is a powershell.exe; its command line has the Backup Hub marker and is a
 * non-interactive helper; it is not this app and not the finder itself; and the process that started it is no longer running
 * (a helper of a live app, or of anything else alive, is never touched).
 */
export function selectLeftovers(snapshot: ProcessSnapshot, ownPid: number): number[] {
  const alive = new Set(snapshot.alive);
  return snapshot.procs
    .filter(
      (p) =>
        /^powershell\.exe$/i.test(p.name) &&
        p.cmd.includes(POWERSHELL_MARKER) &&
        /-NonInteractive/i.test(p.cmd) &&
        p.pid !== ownPid &&
        p.pid !== snapshot.self &&
        p.parent !== ownPid &&
        !alive.has(p.parent),
    )
    .map((p) => p.pid);
}

export interface LeftoverDeps {
  /** Runs the finder script in a hidden PowerShell (itself marked) and returns what it printed. */
  runFinder(script: string): Promise<string>;
  /** Ends one process by id. */
  kill(pid: number): void;
  ownPid: number;
  /** Lets go of the phone when adb.exe exists (the real one is releaseWithin). */
  releaseAdb(): Promise<unknown>;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
}

/** Never throws. Returns the ids it ended. */
export async function cleanUpLeftovers(deps: LeftoverDeps): Promise<{ ended: number[] }> {
  const ended: number[] = [];
  try {
    const snapshot = parseSnapshot(await deps.runFinder(LEFTOVER_FINDER_SCRIPT));
    if (snapshot) {
      for (const pid of selectLeftovers(snapshot, deps.ownPid)) {
        try {
          deps.kill(pid);
          ended.push(pid);
        } catch {
          // already gone
        }
      }
    } else deps.log.warn('start: the leftover check printed something unexpected; nothing was ended');
  } catch (err) {
    deps.log.warn('start: could not look for leftover helper processes', err);
  }
  if (ended.length > 0) deps.log.info(`start: ended ${ended.length} leftover Backup Hub helper process(es) from the last session`);
  try {
    await deps.releaseAdb();
  } catch {
    // nothing was running
  }
  return { ended };
}
