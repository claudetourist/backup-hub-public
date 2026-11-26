import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { crashDumpsDir, startCrashDumps } from './crashDumps';

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('local crash dumps only', () => {
  it('sets the folder first, then starts the reporter with nothing sent anywhere (no upload, no URL)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-crash-'));
    tmp.push(base);
    const dir = path.join(base, 'logs', 'crashes');
    const calls: string[] = [];
    let options: Record<string, unknown> | undefined;
    startCrashDumps({
      app: { setPath: (name, value) => void calls.push(`setPath ${name} ${value}`) },
      crashReporter: { start: (o) => { calls.push('start'); options = o; } },
      dir,
    });
    expect(calls).toEqual([`setPath crashDumps ${dir}`, 'start']);
    expect(options).toEqual({ uploadToServer: false, compress: true });
    expect(options).not.toHaveProperty('submitURL');
    expect(fs.statSync(dir).isDirectory()).toBe(true);
  });

  it('still starts the (local) reporter when the folder cannot be made or none is given', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'backuphub-crash-'));
    tmp.push(base);
    const blocker = path.join(base, 'file');
    fs.writeFileSync(blocker, 'x');
    let starts = 0;
    const app = { setPath: () => { throw new Error('should not be called for a folder that cannot be made'); } };
    startCrashDumps({ app, crashReporter: { start: () => void (starts += 1) }, dir: path.join(blocker, 'crashes') });
    startCrashDumps({ app, crashReporter: { start: () => void (starts += 1) }, dir: null });
    expect(starts).toBe(2);
  });

  it('the folder is inside the logs folder: bench and dev runs use their temp folder, a dev run without one touches nothing real', () => {
    const base = { isPackaged: false, benchDataDir: null, envDataDir: undefined, appDataDir: 'C:/AppData', forbiddenRoots: [] as string[] };
    expect(crashDumpsDir({ ...base, benchDataDir: 'T:/bench' })).toBe(path.join('T:/bench', 'logs', 'crashes'));
    expect(crashDumpsDir({ ...base, envDataDir: 'T:/dev' })).toBe(path.join('T:/dev', 'logs', 'crashes'));
    expect(crashDumpsDir(base)).toBeNull();
  });

  it('the source never gives the reporter a server address', () => {
    const text = fs.readFileSync(path.join(__dirname, 'crashDumps.ts'), 'utf8') + fs.readFileSync(path.join(__dirname, '..', 'main.ts'), 'utf8');
    expect(text).not.toMatch(/submitURL|uploadToServer:\s*true/);
    expect(text).toMatch(/uploadToServer: false, compress: true/);
  });
});
