import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipc';
import { createAppUrlCheck } from './origin';
import { createSecureIpc, isTrustedSender, type SenderEvent } from './secureIpc';

const WEB = { id: 'main-window-contents' };
const win = { isDestroyed: () => false, webContents: WEB };
const isAppUrl = (url: string): boolean => url.startsWith('http://localhost:5173/');

function event(overrides: Partial<SenderEvent> = {}): SenderEvent {
  return { sender: WEB, senderFrame: { url: 'http://localhost:5173/', parent: null }, ...overrides };
}

describe('isTrustedSender', () => {
  it('accepts the main window, its top frame, at the app address', () => {
    expect(isTrustedSender(event(), win, isAppUrl)).toBe(true);
  });
  it('refuses another web contents, a sub-frame, a foreign address, a missing frame and a missing or destroyed window', () => {
    expect(isTrustedSender(event({ sender: { id: 'other' } }), win, isAppUrl)).toBe(false);
    expect(isTrustedSender(event({ senderFrame: { url: 'http://localhost:5173/', parent: {} } }), win, isAppUrl)).toBe(false);
    expect(isTrustedSender(event({ senderFrame: { url: 'https://evil.example/', parent: null } }), win, isAppUrl)).toBe(false);
    expect(isTrustedSender(event({ senderFrame: null }), win, isAppUrl)).toBe(false);
    expect(isTrustedSender(event({ senderFrame: undefined }), win, isAppUrl)).toBe(false);
    expect(isTrustedSender(event(), null, isAppUrl)).toBe(false);
    expect(isTrustedSender(event(), { isDestroyed: () => true, webContents: WEB }, isAppUrl)).toBe(false);
  });
});

function setup() {
  const handlers = new Map<string, (event: SenderEvent, ...args: unknown[]) => unknown>();
  const listeners = new Map<string, (event: SenderEvent, ...args: unknown[]) => unknown>();
  const ipcMain = {
    handle: vi.fn((channel: string, fn: (event: SenderEvent, ...args: unknown[]) => unknown) => void handlers.set(channel, fn)),
    on: vi.fn((channel: string, fn: (event: SenderEvent, ...args: unknown[]) => unknown) => void listeners.set(channel, fn)),
  };
  const log = { warn: vi.fn() };
  const secure = createSecureIpc({ ipcMain: ipcMain as never, getWindow: () => win, isAppUrl, log });
  return { secure, handlers, listeners, log };
}

describe('createSecureIpc', () => {
  it('runs the handler with the checked arguments for a trusted sender', async () => {
    const { secure, handlers } = setup();
    const handler = vi.fn((id: number) => id * 2);
    secure.handle(IPC.jobsGet, handler);
    await expect(handlers.get(IPC.jobsGet)!(event(), 21)).resolves.toBe(42);
    expect(handler).toHaveBeenCalledWith(21);
  });

  it('refuses an untrusted sender before looking at the arguments, and never runs the handler', async () => {
    const { secure, handlers, log } = setup();
    const handler = vi.fn();
    secure.handle(IPC.jobsGet, handler);
    await expect(handlers.get(IPC.jobsGet)!(event({ sender: {} }), 1)).rejects.toThrow('Untrusted sender');
    await expect(handlers.get(IPC.jobsGet)!(event({ senderFrame: { url: 'file:///C:/evil.html', parent: null } }), 1)).rejects.toThrow('Untrusted sender');
    expect(handler).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('answers a bad request with a plain "Invalid request" and logs only field names, never the values', async () => {
    const { secure, handlers, log } = setup();
    const handler = vi.fn();
    secure.handle(IPC.vaultUnlock, handler);
    await expect(handlers.get(IPC.vaultUnlock)!(event(), 12345)).rejects.toThrow(/^Invalid request$/);
    await expect(handlers.get(IPC.vaultUnlock)!(event(), 'ok', 'extra')).rejects.toThrow(/^Invalid request$/);
    expect(handler).not.toHaveBeenCalled();
    const logged = JSON.stringify(log.warn.mock.calls);
    expect(logged).toContain('vault:unlock');
    expect(logged).toContain('invalid request');
    expect(logged).not.toContain('12345');
  });

  it('does not echo a secret that was sent in a bad request', async () => {
    const { secure, handlers, log } = setup();
    secure.handle(IPC.settingsRestoreFromFile, vi.fn());
    await expect(handlers.get(IPC.settingsRestoreFromFile)!(event(), 'my-secret-phrase', 'not-a-boolean')).rejects.toThrow('Invalid request');
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('my-secret-phrase');
  });

  it('fire-and-forget: a good call runs, a bad or untrusted one is logged and ignored without throwing', () => {
    const { secure, listeners, log } = setup();
    const handler = vi.fn();
    secure.on(IPC.reportFirstPaint, handler);
    const listener = listeners.get(IPC.reportFirstPaint)!;
    listener(event(), { fcpMs: 80 });
    expect(handler).toHaveBeenCalledWith({ fcpMs: 80 });
    expect(() => listener(event(), { fcpMs: 'slow' })).not.toThrow();
    expect(() => listener(event({ sender: {} }), { fcpMs: 80 })).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  it('a channel cannot be registered twice', () => {
    const { secure } = setup();
    secure.handle(IPC.appVersion, () => '1');
    expect(() => secure.handle(IPC.appVersion, () => '2')).toThrow(/twice/);
  });
});

describe('createAppUrlCheck', () => {
  it('dev: only the dev server origin', () => {
    const check = createAppUrlCheck({ devServerUrl: 'http://localhost:5173', indexFile: 'unused' });
    expect(check('http://localhost:5173/')).toBe(true);
    expect(check('http://localhost:5173/#jobs')).toBe(true);
    expect(check('http://localhost:5174/')).toBe(false);
    expect(check('http://localhost.evil.example:5173/')).toBe(false);
    expect(check('https://localhost:5173/')).toBe(false);
    expect(check('file:///C:/x/index.html')).toBe(false);
    expect(check('not a url')).toBe(false);
  });

  it('packaged: only the built index.html over file://', () => {
    const indexFile = path.resolve('some', 'app', 'renderer', 'main_window', 'index.html');
    const check = createAppUrlCheck({ devServerUrl: null, indexFile });
    const own = pathToFileURL(indexFile).href;
    expect(check(own)).toBe(true);
    expect(check(own + '#jobs')).toBe(true);
    expect(check(pathToFileURL(path.resolve('some', 'app', 'renderer', 'main_window', 'other.html')).href)).toBe(false);
    expect(check('https://example.com/')).toBe(false);
    expect(check('http://localhost:5173/')).toBe(false);
    expect(check('')).toBe(false);
  });
});
