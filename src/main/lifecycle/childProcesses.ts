import { execFile, spawn, type ChildProcess, type ExecFileOptions, type SpawnOptions } from 'node:child_process';

/**
 * Every program the app starts (PowerShell, adb) goes through this file, so that:
 *  - each child is recorded while it runs and the shutdown routine can end all of them,
 *  - each child is hidden (no console window), has a time limit, and carries the Backup Hub marker,
 *  - the next start can find a PowerShell a crash left behind (a Task Manager kill runs no code) and end only that one.
 * The marker: the environment variable BACKUPHUB_CHILD=1, and for PowerShell a first comment line "# BackupHub" in the -Command text,
 * which Windows shows in the process's command line (an environment variable is not visible there).
 */

export const CHILD_ENV_NAME = 'BACKUPHUB_CHILD';
/** The first line of every PowerShell command the app runs. The leftover finder looks for it in command lines. */
export const POWERSHELL_MARKER = '# BackupHub';
/** Used when a caller gives no limit: nothing the app starts may run forever. */
export const DEFAULT_CHILD_TIMEOUT_MS = 60_000;

/** The part of a child process the registry needs. */
export interface EndableChild {
  kill(signal?: NodeJS.Signals | number): boolean | void;
  readonly pid?: number | undefined;
}

export class ChildRegistry {
  private readonly children = new Set<EndableChild>();

  /** Records a running child; the returned function removes it (call it when the child has ended). */
  add(child: EndableChild): () => void {
    this.children.add(child);
    return () => void this.children.delete(child);
  }

  get size(): number {
    return this.children.size;
  }

  /** Ends every recorded child (a child that is already gone is ignored) and forgets them. Returns how many were ended. */
  endAll(): number {
    const all = [...this.children];
    this.children.clear();
    let ended = 0;
    for (const child of all) {
      try {
        child.kill();
        ended += 1;
      } catch {
        // already gone
      }
    }
    return ended;
  }
}

/** The one registry of this process. */
export const childRegistry = new ChildRegistry();

export type ExecFn = (file: string, args: readonly string[], options: ExecFileOptions, callback: (error: Error | null, stdout: string, stderr: string) => void) => ChildProcess;

export interface RunChildOptions {
  /** Default 60 s (DEFAULT_CHILD_TIMEOUT_MS). */
  timeoutMs?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
  /** Text written to the child's standard input (then closed). */
  input?: string;
  signal?: AbortSignal;
  registry?: ChildRegistry | undefined;
  /** Tests pass a fake in place of child_process.execFile. */
  exec?: ExecFn | undefined;
  /** Sees the standard output as it arrives (for a live count); the whole output still comes back at the end. */
  onStdout?: ((chunk: string) => void) | undefined;
}

export interface ChildResult {
  stdout: string;
  stderr: string;
}

/** The marker environment plus the caller's own variables. */
export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, [CHILD_ENV_NAME]: '1' };
}

/** The arguments of a hidden, non-interactive PowerShell that runs `script` with the marker as its first line. */
export function powershellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', `${POWERSHELL_MARKER}\n${script}`];
}

/**
 * Runs a program to the end and returns its output. Hidden window, time limit, recorded while it runs, removed when it ends. On failure the
 * error is the one Node gives, with `stdout` and `stderr` attached.
 */
export function runChild(file: string, args: readonly string[], options: RunChildOptions = {}): Promise<ChildResult> {
  const registry = options.registry ?? childRegistry;
  const exec = options.exec ?? (execFile as unknown as ExecFn);
  return new Promise((resolve, reject) => {
    let remove: () => void = () => undefined;
    const child = exec(
      file,
      args,
      {
        windowsHide: true,
        timeout: options.timeoutMs ?? DEFAULT_CHILD_TIMEOUT_MS,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
        encoding: 'utf8',
        env: childEnv(options.env),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        remove();
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
    remove = registry.add(child);
    if (options.onStdout) {
      const see = options.onStdout;
      child.stdout?.on('data', (chunk: unknown) => see(String(chunk)));
    }
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input);
  });
}

export interface SpawnChildOptions extends SpawnOptions {
  registry?: ChildRegistry | undefined;
  /** Ends the child after this long (default none: the caller owns a longer limit). */
  timeoutMs?: number | undefined;
  /** Tests pass a fake in place of child_process.spawn. */
  spawnFn?: ((command: string, args: readonly string[], options: SpawnOptions) => ChildProcess) | undefined;
}

/** Starts a long-running program (its output is streamed by the caller). Hidden window, marker, recorded until it exits or fails to start. */
export function spawnChild(command: string, args: readonly string[], options: SpawnChildOptions = {}): ChildProcess {
  const { registry = childRegistry, timeoutMs, spawnFn = spawn, ...spawnOptions } = options;
  const child = spawnFn(command, args, { windowsHide: true, ...spawnOptions, env: childEnv(spawnOptions.env as Record<string, string> | undefined) });
  const remove = registry.add(child);
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }, timeoutMs);
    timer.unref();
  }
  const done = (): void => {
    remove();
    if (timer !== undefined) clearTimeout(timer);
  };
  child.once('exit', done);
  child.once('error', done);
  return child;
}
