import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInside, LOCATION_FILE, LOCATION_FOLDER, rejectReason, resolveDataPaths } from './dataDir';

let root: string;
let appData: string;
let defaultData: string;
let defaultLogs: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-datadir-'));
  appData = path.join(root, 'AppData');
  defaultData = path.join(root, 'default', 'data');
  defaultLogs = path.join(root, 'default', 'logs');
  fs.mkdirSync(appData, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeLocation(content: string): void {
  const dir = path.join(appData, LOCATION_FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, LOCATION_FILE), content);
}

const base = () => ({ appDataDir: appData, defaultDataDir: defaultData, defaultLogsDir: defaultLogs });

describe('resolveDataPaths', () => {
  it('uses the defaults and creates both folders when there is no location.json', () => {
    const result = resolveDataPaths(base());
    expect(result.dataDir).toBe(defaultData);
    expect(result.logsDir).toBe(defaultLogs);
    expect(result.source).toBe('default');
    expect(result.warnings).toEqual([]);
    expect(fs.statSync(defaultData).isDirectory()).toBe(true);
    expect(fs.statSync(defaultLogs).isDirectory()).toBe(true);
  });

  it('does not write location.json itself', () => {
    resolveDataPaths(base());
    expect(fs.existsSync(path.join(appData, LOCATION_FOLDER))).toBe(false);
  });

  it('honours dataDir from location.json and creates it', () => {
    const custom = path.join(root, 'elsewhere', 'my-data');
    writeLocation(JSON.stringify({ dataDir: custom }));
    const result = resolveDataPaths(base());
    expect(result.dataDir).toBe(custom);
    expect(result.source).toBe('location.json');
    expect(fs.statSync(custom).isDirectory()).toBe(true);
    // logs stay on their default
    expect(result.logsDir).toBe(defaultLogs);
  });

  it('honours logsDir from location.json', () => {
    const customLogs = path.join(root, 'my-logs');
    writeLocation(JSON.stringify({ logsDir: customLogs }));
    const result = resolveDataPaths(base());
    expect(result.logsDir).toBe(customLogs);
    expect(result.dataDir).toBe(defaultData);
    expect(result.source).toBe('default');
  });

  it('accepts a location.json that starts with a byte order mark', () => {
    const custom = path.join(root, 'bom-data');
    writeLocation('﻿' + JSON.stringify({ dataDir: custom }));
    expect(resolveDataPaths(base()).dataDir).toBe(custom);
  });

  it('falls back to defaults on invalid JSON and says so', () => {
    writeLocation('{ not json');
    const result = resolveDataPaths(base());
    expect(result.dataDir).toBe(defaultData);
    expect(result.source).toBe('default');
    expect(result.warnings.join(' ')).toMatch(/not valid JSON/);
  });

  it('falls back when location.json is not an object', () => {
    writeLocation('["a"]');
    const result = resolveDataPaths(base());
    expect(result.dataDir).toBe(defaultData);
    expect(result.warnings.join(' ')).toMatch(/not a JSON object/);
  });

  it('ignores a relative or empty dataDir', () => {
    writeLocation(JSON.stringify({ dataDir: 'relative\\path' }));
    expect(resolveDataPaths(base()).dataDir).toBe(defaultData);
    writeLocation(JSON.stringify({ dataDir: '' }));
    expect(resolveDataPaths(base()).dataDir).toBe(defaultData);
    writeLocation(JSON.stringify({ dataDir: 42 }));
    expect(resolveDataPaths(base()).dataDir).toBe(defaultData);
  });

  it('rejects a dataDir inside a forbidden root (next to the exe or in out\\)', () => {
    const exeDir = path.join(root, 'out', 'Backup Hub-win32-x64');
    fs.mkdirSync(exeDir, { recursive: true });
    writeLocation(JSON.stringify({ dataDir: path.join(exeDir, 'userdata') }));
    const result = resolveDataPaths({ ...base(), forbiddenRoots: [exeDir, path.join(root, 'out')] });
    expect(result.dataDir).toBe(defaultData);
    expect(result.warnings.join(' ')).toMatch(/inside the application folder/);
    expect(fs.existsSync(path.join(exeDir, 'userdata'))).toBe(false);
  });

  it('refuses to start if even the default would be inside a forbidden root', () => {
    expect(() => resolveDataPaths({ ...base(), forbiddenRoots: [path.join(root, 'default')] })).toThrow(/Refusing/);
  });

  it('falls back to the default when the configured folder cannot be created', () => {
    const blocker = path.join(root, 'a-file');
    fs.writeFileSync(blocker, 'x');
    writeLocation(JSON.stringify({ dataDir: path.join(blocker, 'sub') }));
    const result = resolveDataPaths(base());
    expect(result.dataDir).toBe(defaultData);
    expect(result.warnings.join(' ')).toMatch(/cannot be created/);
  });
});

describe('isInside / rejectReason', () => {
  it('detects containment, case-insensitively on Windows, without prefix false positives', () => {
    const parent = path.join(root, 'App');
    expect(isInside(parent, parent)).toBe(true);
    expect(isInside(path.join(parent, 'a', 'b'), parent)).toBe(true);
    expect(isInside(path.join(root, 'App2'), parent)).toBe(false);
    expect(isInside(root, parent)).toBe(false);
    if (process.platform === 'win32') expect(isInside(path.join(parent.toUpperCase(), 'x'), parent)).toBe(true);
  });

  it('describes why a candidate is rejected', () => {
    expect(rejectReason(undefined, [])).toMatch(/non-empty/);
    expect(rejectReason('rel', [])).toMatch(/absolute/);
    expect(rejectReason(root, [])).toBeNull();
  });
});
