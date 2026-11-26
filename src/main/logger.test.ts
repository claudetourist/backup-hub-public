import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatLogArg, RotatingLogger } from './logger';
import { forgetSecret, registerSecret } from './google/redact';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-logger-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const fixedNow = () => new Date('2026-10-30T12:00:00.000Z');

describe('RotatingLogger', () => {
  it('creates the folder and writes timestamped, levelled lines', () => {
    const logDir = path.join(dir, 'nested', 'logs');
    const log = new RotatingLogger({ dir: logDir, now: fixedNow });
    log.info('hello', { a: 1 });
    log.error(new Error('boom'));
    const text = fs.readFileSync(log.filePath(0), 'utf8');
    expect(text).toContain('[2026-10-30T12:00:00.000Z] [INFO] hello {"a":1}');
    expect(text).toMatch(/\[ERROR\] Error: boom/);
  });

  it('rotates when the size limit is reached and keeps at most 5 files', () => {
    const log = new RotatingLogger({ dir, maxBytes: 200, maxFiles: 5, now: fixedNow });
    for (let i = 0; i < 100; i++) log.info(`line ${String(i).padStart(3, '0')} ${'x'.repeat(40)}`);
    const files = fs.readdirSync(dir).toSorted();
    expect(files).toEqual(['backuphub.1.log', 'backuphub.2.log', 'backuphub.3.log', 'backuphub.4.log', 'backuphub.log']);
    for (const file of files) expect(fs.statSync(path.join(dir, file)).size).toBeLessThanOrEqual(200);
    // newest line is in the current file, older lines in higher numbers
    expect(fs.readFileSync(log.filePath(0), 'utf8')).toContain('line 099');
    const oldest = fs.readFileSync(log.filePath(4), 'utf8');
    expect(oldest).not.toContain('line 000');
  });

  it('shifts files in order: current becomes .1 and .1 becomes .2', () => {
    const log = new RotatingLogger({ dir, maxBytes: 100, maxFiles: 3, now: fixedNow });
    log.info('first '.padEnd(60, 'a'));
    log.info('second '.padEnd(60, 'b'));
    log.info('third '.padEnd(60, 'c'));
    expect(fs.readFileSync(log.filePath(0), 'utf8')).toContain('third');
    expect(fs.readFileSync(log.filePath(1), 'utf8')).toContain('second');
    expect(fs.readFileSync(log.filePath(2), 'utf8')).toContain('first');
    log.info('fourth '.padEnd(60, 'd'));
    expect(fs.readFileSync(log.filePath(2), 'utf8')).toContain('second');
    expect(fs.existsSync(log.filePath(3))).toBe(false);
  });

  it('continues an existing file across restarts and counts its size', () => {
    const first = new RotatingLogger({ dir, maxBytes: 300, maxFiles: 2, now: fixedNow });
    first.info('a'.repeat(150));
    const second = new RotatingLogger({ dir, maxBytes: 300, maxFiles: 2, now: fixedNow });
    second.info('b'.repeat(150));
    expect(fs.existsSync(second.filePath(1))).toBe(true);
    expect(fs.readFileSync(second.filePath(1), 'utf8')).toContain('a'.repeat(150));
    expect(fs.readFileSync(second.filePath(0), 'utf8')).toContain('b'.repeat(150));
  });

  it('never throws when the folder is unusable', () => {
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    const log = new RotatingLogger({ dir: path.join(blocker, 'logs'), now: fixedNow });
    expect(() => log.info('still fine')).not.toThrow();
  });
});

describe('formatLogArg', () => {
  it('handles strings, objects, errors and circular values', () => {
    expect(formatLogArg('x')).toBe('x');
    expect(formatLogArg({ a: 1 })).toBe('{"a":1}');
    expect(formatLogArg(undefined)).toBe('undefined');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(formatLogArg(circular)).toBe('[object Object]');
  });
});

describe('log redaction', () => {
  it('removes email addresses (as [email]), Google tokens, Bearer headers and token fields from every line', () => {
    const log = new RotatingLogger({ dir, now: fixedNow });
    log.info('signed in as someone.name+tag@example.co.uk and other@mail.example.com');
    log.warn('Authorization: Bearer ya29.a0AfH6SMBabc-def_123');
    log.error(new Error('refresh failed for 1//0gAbCdEfGhIjKlMnOp-qrstu'));
    log.info('url https://x.example/cb?code=4/0AX4XfWhabcdefghijkl&access_token=zzz111&refresh_token=yyy222&client_secret=xxx333&keep=this');
    log.info({ account: 'me@example.org', refresh_token: 'json-secret-1', access_token: 'json-secret-2', client_secret: 'json-secret-3', code: 'json-secret-4' });
    log.debug('plain line, no secrets, 12 files at C:/Users/x/a.txt');
    const text = fs.readFileSync(log.filePath(0), 'utf8');
    for (const leak of ['someone.name', 'example.co.uk', 'other@mail', 'me@example.org', 'ya29', '1//0gAbC', '4/0AX4', 'zzz111', 'yyy222', 'xxx333', 'json-secret-1', 'json-secret-2', 'json-secret-3', 'json-secret-4']) {
      expect(text).not.toContain(leak);
    }
    expect(text).toContain('signed in as [email] and [email]');
    expect(text).toContain('keep=this');
    expect(text).toContain('plain line, no secrets, 12 files at C:/Users/x/a.txt');
  });

  it('removes registered secrets and cannot be bypassed through the formatter or an error stack', () => {
    registerSecret('registered-secret-value');
    try {
      expect(formatLogArg('x registered-secret-value y')).toBe('x [hidden] y');
      expect(formatLogArg(new Error('boom registered-secret-value a@b.example'))).not.toMatch(/registered-secret-value|a@b\.example/);
      expect(formatLogArg({ note: 'registered-secret-value' })).toBe('{"note":"[hidden]"}');
    } finally {
      forgetSecret('registered-secret-value');
    }
  });

  it('also covers the console mirror (it prints the same redacted line)', () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => void lines.push(line);
    try {
      new RotatingLogger({ dir, console: true, now: fixedNow }).info('mail me@example.org');
    } finally {
      console.log = original;
    }
    expect(lines.join('')).toContain('mail [email]');
    expect(lines.join('')).not.toContain('me@example.org');
  });
});
