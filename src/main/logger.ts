import fs from 'node:fs';
import path from 'node:path';
import { ownMove, ownRemove } from './danger/ownFiles';
import { redactForLog } from './google/redact';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface RotatingLoggerOptions {
  dir: string;
  /** Base name; files are `<base>.log`, `<base>.1.log`, ... `<base>.<maxFiles-1>.log`. */
  baseName?: string;
  maxBytes?: number;
  /** Total files kept, including the current one. */
  maxFiles?: number;
  /** Mirror lines to the console (dev). */
  console?: boolean;
  now?: () => Date;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

function plainText(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/** The text of one log argument. Tokens, secrets and email addresses are removed here, so no caller can log them. */
export function formatLogArg(arg: unknown): string {
  return redactForLog(plainText(arg));
}

/** Synchronous size-based rotating file logger. Never throws: logging must not crash the app. */
export class RotatingLogger {
  private readonly dir: string;
  private readonly baseName: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly mirrorToConsole: boolean;
  private readonly now: () => Date;
  private size = 0;

  constructor(options: RotatingLoggerOptions) {
    this.dir = options.dir;
    this.baseName = options.baseName ?? 'backuphub';
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
    this.mirrorToConsole = options.console ?? false;
    this.now = options.now ?? (() => new Date());
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.size = fs.existsSync(this.filePath(0)) ? fs.statSync(this.filePath(0)).size : 0;
    } catch {
      this.size = 0;
    }
  }

  filePath(index = 0): string {
    const name = index === 0 ? `${this.baseName}.log` : `${this.baseName}.${index}.log`;
    return path.join(this.dir, name);
  }

  debug(...args: unknown[]): void {
    this.write('DEBUG', args);
  }
  info(...args: unknown[]): void {
    this.write('INFO', args);
  }
  warn(...args: unknown[]): void {
    this.write('WARN', args);
  }
  error(...args: unknown[]): void {
    this.write('ERROR', args);
  }

  write(level: LogLevel, args: unknown[]): void {
    const line = `[${this.now().toISOString()}] [${level}] ${args.map(formatLogArg).join(' ')}\n`;
    try {
      const bytes = Buffer.byteLength(line);
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      fs.appendFileSync(this.filePath(0), line);
      this.size += bytes;
    } catch {
      // Logging must never crash the app.
    }
    if (this.mirrorToConsole) {
      const out = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
      out(line.trimEnd());
    }
  }

  private rotate(): void {
    // Drop the oldest, then shift every remaining file up by one (current -> .1, .1 -> .2, ...).
    const last = this.maxFiles - 1;
    // The rotation is itself in the log: no extra line (it would be written into the file being rotated).
    if (last >= 1) ownRemove(this.filePath(last), { quiet: true });
    for (let i = last - 1; i >= 1; i--) {
      if (fs.existsSync(this.filePath(i))) ownMove(this.filePath(i), this.filePath(i + 1), { quiet: true });
    }
    if (last >= 1) ownMove(this.filePath(0), this.filePath(1), { quiet: true });
    else ownRemove(this.filePath(0), { quiet: true });
    this.size = 0;
  }
}

/** Process-wide logger. Lines logged before `initLogger` are buffered and flushed into the file. */
interface Pending {
  level: LogLevel;
  args: unknown[];
}
let active: RotatingLogger | null = null;
const pending: Pending[] = [];

export function initLogger(options: RotatingLoggerOptions): RotatingLogger {
  const created = new RotatingLogger(options);
  active = created;
  for (const entry of pending.splice(0)) created.write(entry.level, entry.args);
  return created;
}

function log(level: LogLevel, args: unknown[]): void {
  if (active) active.write(level, args);
  else if (pending.length < 200) pending.push({ level, args });
}

export const logger = {
  debug: (...args: unknown[]) => log('DEBUG', args),
  info: (...args: unknown[]) => log('INFO', args),
  warn: (...args: unknown[]) => log('WARN', args),
  error: (...args: unknown[]) => log('ERROR', args),
  filePath: () => active?.filePath(0) ?? null,
};
