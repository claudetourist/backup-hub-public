import { describe, expect, it, vi } from 'vitest';
import type { App, Session } from 'electron';
import { applyCsp, denyAllPermissions, guardAllWebContents } from './hardening';

function fakeSession() {
  const captured: { request?: (...a: unknown[]) => void; check?: () => boolean; device?: () => boolean; headers?: (details: unknown, cb: (r: unknown) => void) => void } = {};
  const session = {
    setPermissionRequestHandler: vi.fn((fn: (...a: unknown[]) => void) => void (captured.request = fn)),
    setPermissionCheckHandler: vi.fn((fn: () => boolean) => void (captured.check = fn)),
    setDevicePermissionHandler: vi.fn((fn: () => boolean) => void (captured.device = fn)),
    webRequest: { onHeadersReceived: vi.fn((fn: (details: unknown, cb: (r: unknown) => void) => void) => void (captured.headers = fn)) },
  };
  return { session: session as unknown as Session, raw: session, captured };
}

describe('denyAllPermissions', () => {
  it('refuses every permission request, check and device request', () => {
    const { session, captured } = fakeSession();
    denyAllPermissions(session);
    const answer = vi.fn();
    captured.request!({}, 'media', answer);
    captured.request!({}, 'geolocation', answer);
    expect(answer.mock.calls).toEqual([[false], [false]]);
    expect(captured.check!()).toBe(false);
    expect(captured.device!()).toBe(false);
  });

  it('sets the handlers once per session', () => {
    const { session, raw } = fakeSession();
    denyAllPermissions(session);
    denyAllPermissions(session);
    expect(raw.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
  });
});

describe('guardAllWebContents', () => {
  function run() {
    let created: ((event: unknown, contents: unknown) => void) | undefined;
    const app = { on: vi.fn((name: string, fn: (event: unknown, contents: unknown) => void) => void (name === 'web-contents-created' && (created = fn))) };
    const openExternal = vi.fn();
    guardAllWebContents(app as unknown as App, { isAppUrl: (url) => url.startsWith('http://localhost:5173/'), openExternal });
    const { session } = fakeSession();
    const events = new Map<string, (...a: never[]) => void>();
    let openHandler: ((d: { url: string }) => { action: string }) | undefined;
    const contents = {
      session,
      on: vi.fn((name: string, fn: (...a: never[]) => void) => void events.set(name, fn)),
      setWindowOpenHandler: vi.fn((fn: (d: { url: string }) => { action: string }) => void (openHandler = fn)),
    };
    created!({}, contents);
    return { events, openHandler: openHandler!, openExternal };
  }

  it('blocks webviews', () => {
    const { events } = run();
    const event = { preventDefault: vi.fn() };
    (events.get('will-attach-webview') as (e: unknown) => void)(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('denies every pop-up; only http and https links go to the default browser', () => {
    const { openHandler, openExternal } = run();
    expect(openHandler({ url: 'https://example.com/a' })).toEqual({ action: 'deny' });
    expect(openHandler({ url: 'file:///C:/Windows/system32/calc.exe' })).toEqual({ action: 'deny' });
    expect(openHandler({ url: 'javascript:alert(1)' })).toEqual({ action: 'deny' });
    expect(openExternal.mock.calls).toEqual([['https://example.com/a']]);
  });

  it('blocks navigation and redirects away from the app, and lets the app address through', () => {
    const { events } = run();
    for (const name of ['will-navigate', 'will-redirect']) {
      const guard = events.get(name) as unknown as (e: { preventDefault(): void }, url: string) => void;
      const blocked = { preventDefault: vi.fn() };
      guard(blocked, 'https://evil.example/');
      expect(blocked.preventDefault).toHaveBeenCalled();
      const allowed = { preventDefault: vi.fn() };
      guard(allowed, 'http://localhost:5173/#jobs');
      expect(allowed.preventDefault).not.toHaveBeenCalled();
    }
  });
});

describe('applyCsp', () => {
  it('puts the policy on every response, replacing any other', () => {
    const { session, captured } = fakeSession();
    applyCsp(session, "default-src 'self'");
    const callback = vi.fn();
    captured.headers!({ responseHeaders: { 'Content-Type': ['text/html'], 'content-security-policy': ['x'] } }, callback);
    const headers = (callback.mock.calls[0]![0] as { responseHeaders: Record<string, string[]> }).responseHeaders;
    expect(headers['Content-Security-Policy']).toEqual(["default-src 'self'"]);
    expect(headers['Content-Type']).toEqual(['text/html']);
  });
});
