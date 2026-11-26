import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Which page addresses count as "the app itself": the Vite dev server's origin in a dev run, and exactly the built
 * index.html (over file://) when packaged. Used for the sender check of every IPC call and for blocking navigation.
 */
export interface AppUrlOptions {
  /** MAIN_WINDOW_VITE_DEV_SERVER_URL; set only in dev runs. */
  devServerUrl?: string | null;
  /** Absolute path of the built renderer index.html (used when there is no dev server). */
  indexFile: string;
}

export function createAppUrlCheck(options: AppUrlOptions): (url: string) => boolean {
  if (options.devServerUrl) {
    const origin = new URL(options.devServerUrl).origin;
    return (url) => {
      try {
        return new URL(url).origin === origin;
      } catch {
        return false;
      }
    };
  }
  const expected = pathToFileURL(path.resolve(options.indexFile));
  const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
  return (url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'file:' && parsed.host === expected.host && fold(parsed.pathname) === fold(expected.pathname);
    } catch {
      return false;
    }
  };
}
