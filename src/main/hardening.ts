import type { App, Session } from 'electron';

/**
 * Deny-by-default for everything the window could ask of Electron besides our own IPC:
 *  - no permission is ever granted (camera, microphone, location, notifications from the page, devices ...);
 *  - no <webview>, no pop-up windows (an http or https link opens in the default browser, as before);
 *  - no navigation away from the app's own page.
 * The functions take the Electron objects as arguments so tests can pass fakes.
 */

const hardened = new WeakSet<object>();

/** Every permission request, permission check and device request is refused. Safe to call twice for one session. */
export function denyAllPermissions(session: Session): void {
  if (hardened.has(session)) return;
  hardened.add(session);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
}

export interface WebContentsGuardDeps {
  /** True for an address that belongs to the app (see ipc/origin.ts). */
  isAppUrl: (url: string) => boolean;
  /** Opens a link in the default browser. */
  openExternal: (url: string) => void;
}

/** Applies the guards to every web contents the app ever creates (the main window, DevTools, anything else). */
export function guardAllWebContents(app: Pick<App, 'on'>, deps: WebContentsGuardDeps): void {
  app.on('web-contents-created', (_event, contents) => {
    denyAllPermissions(contents.session);
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) deps.openExternal(url);
      return { action: 'deny' };
    });
    const keepInside = (event: { preventDefault(): void }, url: string): void => {
      if (!deps.isAppUrl(url)) event.preventDefault();
    };
    contents.on('will-navigate', keepInside);
    contents.on('will-redirect', keepInside);
  });
}

/** Puts the policy on every response the default session receives (dev server or packaged files alike). */
export function applyCsp(session: Session, policy: string): void {
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [policy] } });
  });
}
