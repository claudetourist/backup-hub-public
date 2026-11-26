import nodeFs from 'node:fs';
import { createRequire } from 'node:module';

/**
 * File access that sees `.asar` files as the plain files they are. Inside Electron the `fs` module
 * pretends an .asar archive is a folder (so apps can load code from one); a backup tool listing or
 * fingerprinting user files must not (an archived Electron app on the T7 broke a listing, 30 Oct).
 * Electron ships the untouched module as `original-fs`; outside Electron (tests) plain `fs` is it.
 */
function load(): typeof nodeFs {
  if (!process.versions['electron']) return nodeFs;
  try {
    return createRequire(__filename)('original-fs') as typeof nodeFs;
  } catch {
    return nodeFs;
  }
}

export const rawFs: typeof nodeFs = load();
