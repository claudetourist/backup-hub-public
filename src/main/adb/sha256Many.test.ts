import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSha256Many, sha256ManyCommand } from './phoneModel';
import { BATCH_BYTES, BATCH_FILES, BATCH_PATH_CHARS, nextBatch } from '../phoneBackup/checkOldRun';
import { pullTimeoutMs } from './adbPort';

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('the checksum of many phone files in one call', () => {
  it('quotes every path (the same single quoting as one file) and refuses an unsafe one', () => {
    expect(sha256ManyCommand(['/sdcard/a.jpg', "/sdcard/it's.jpg", '/sdcard/$HOME;x'])).toBe(`sha256sum '/sdcard/a.jpg' '/sdcard/it'\\''s.jpg' '/sdcard/$HOME;x'`);
    expect(() => sha256ManyCommand([])).toThrow();
    expect(() => sha256ManyCommand(['/sdcard/ok.jpg', '/etc/passwd'])).toThrow();
    expect(() => sha256ManyCommand(['/sdcard/a/../../b'])).toThrow();
    expect(() => sha256ManyCommand(['/sdcard/a\nb'])).toThrow();
  });

  it('reads each answer by the exact path that was asked; a gone file, an unreadable file and a silent file are told apart', () => {
    const asked = ['/sdcard/a.jpg', '/sdcard/gone.jpg', '/sdcard/locked.jpg', '/sdcard/silent.jpg'];
    const stdout = `${sha('a')}  /sdcard/a.jpg\n${sha('x')}  /sdcard/not-asked.jpg\n`;
    const stderr = "sha256sum: /sdcard/gone.jpg: No such file or directory\nsha256sum: /sdcard/locked.jpg: Permission denied\n";
    const { answers, adbError } = parseSha256Many(asked, { exitCode: 1, stdout, stderr });
    expect(adbError).toBeNull();
    expect(answers.get('/sdcard/a.jpg')).toEqual({ kind: 'sha256', sha256: sha('a') });
    expect(answers.get('/sdcard/gone.jpg')).toEqual({ kind: 'missing' });
    expect(answers.get('/sdcard/locked.jpg')).toMatchObject({ kind: 'error', reason: expect.stringContaining('Permission denied') });
    expect(answers.get('/sdcard/silent.jpg')).toMatchObject({ kind: 'error' });
    expect(answers.has('/sdcard/not-asked.jpg')).toBe(false);
  });

  it('a call that failed as a whole (phone away, adb stopped) is one adb error, not a gone file for every name', () => {
    const asked = ['/sdcard/a.jpg', '/sdcard/b.jpg'];
    expect(parseSha256Many(asked, { exitCode: 1, stdout: '', stderr: "adb: device 'X' not found\n", error: 'adb failed' }).adbError).toMatch(/not found/);
    expect(parseSha256Many(asked, { exitCode: null, stdout: '', stderr: '', error: 'timed out' }).adbError).toBe('timed out');
    expect(parseSha256Many(asked, { exitCode: 0, stdout: `${sha('a')}  /sdcard/a.jpg\n${sha('b')}  /sdcard/b.jpg\n`, stderr: '' }).adbError).toBeNull();
  });

  it('a name that looks like another file\'s answer line cannot give that file a checksum', () => {
    const evilName = `/sdcard/x  /sdcard/victim.jpg`;
    const asked = ['/sdcard/victim.jpg', evilName];
    const stdout = `${sha('evil')}  ${evilName}\n`;
    const { answers } = parseSha256Many(asked, { exitCode: 1, stdout, stderr: '' });
    expect(answers.get(evilName)).toEqual({ kind: 'sha256', sha256: sha('evil') });
    expect(answers.get('/sdcard/victim.jpg')).toMatchObject({ kind: 'error' });
  });

  it('batches stay inside the count, the size and the length of the command; a single big file goes alone', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ path: `/sdcard/f${i}`, size: 10 }));
    expect(nextBatch(many, 0)).toBe(BATCH_FILES);
    expect(nextBatch(many, 80)).toBe(20);
    const big = [{ path: '/sdcard/a', size: BATCH_BYTES - 5 }, { path: '/sdcard/b', size: 10 }, { path: '/sdcard/c', size: 1 }];
    expect(nextBatch(big, 0)).toBe(1);
    expect(nextBatch(big, 1)).toBe(2);
    expect(nextBatch([{ path: '/sdcard/huge', size: BATCH_BYTES * 8 }, ...big], 0)).toBe(1);
    const long = Array.from({ length: 30 }, (_, i) => ({ path: `/sdcard/${'d'.repeat(900)}${i}`, size: 1 }));
    const n = nextBatch(long, 0);
    expect(n).toBeLessThan(30);
    expect(long.slice(0, n).reduce((s, f) => s + f.path.length + 3, 0)).toBeLessThanOrEqual(BATCH_PATH_CHARS);
    // One call's time limit comes from the same formula as a pull: 300 s plus 4 s per MB. A full batch stays within the 4 hour ceiling.
    expect(pullTimeoutMs(BATCH_BYTES)).toBeLessThanOrEqual(14_400_000);
    expect(nextBatch([], 0)).toBe(0);
  });
});

const shell = ['C:/Program Files/Git/bin/bash.exe', '/bin/bash', '/usr/bin/bash'].find((p) => fs.existsSync(p));
describe.skipIf(!shell)('the many-file command in a real shell (GNU sha256sum here; the phone has its own)', () => {
  it('hostile names stay single words, nothing runs, every file gets its own line and the answer is read back by exact path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-sha-'));
    try {
      const names = ["it's.jpg", 'a b.jpg', '$HOME.txt', 'semi;colon.txt', '-dash.txt', 'tick`s.txt', 'x(1).txt', 'amp&.txt', '[br].txt', 'two  spaces.txt'];
      const real = new Map<string, string>();
      for (const n of names) {
        fs.writeFileSync(path.join(dir, n), `content of ${n}`);
        real.set(`/sdcard/${n}`, sha(`content of ${n}`));
      }
      const asked = [...names.map((n) => `/sdcard/${n}`), '/sdcard/missing-one.jpg'];
      // The folder stands in for /sdcard: the shell runs in it and the path prefix is swapped for ".".
      const command = sha256ManyCommand(asked).replaceAll("'/sdcard/", "'./");
      const bin = path.dirname(shell!);
      const r = spawnSync(shell!, ['-c', command], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${path.join(bin, '..', 'usr', 'bin')}${path.delimiter}${bin}${path.delimiter}${process.env['PATH'] ?? ''}` } });
      const back = (s: string): string => s.replaceAll('./', '/sdcard/');
      const { answers, adbError } = parseSha256Many(asked, { exitCode: r.status, stdout: back(r.stdout), stderr: back(r.stderr) });
      expect(adbError).toBeNull();
      for (const [p, h] of real) expect(answers.get(p), p).toEqual({ kind: 'sha256', sha256: h });
      expect(answers.get('/sdcard/missing-one.jpg')).toEqual({ kind: 'missing' });
      expect(fs.readdirSync(dir).toSorted()).toEqual([...names].toSorted());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
