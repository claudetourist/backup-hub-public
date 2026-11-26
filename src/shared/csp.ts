/** Content-Security-Policy for the packaged app. No remote fonts, scripts or connections, nothing inline. */
export const PRODUCTION_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * Hash of the one inline script Vite's React plugin puts in index.html in dev (the Fast Refresh preamble, with base "/").
 * A test recomputes it from the installed plugin, so an upgrade that changes the script fails loudly instead of silently
 * breaking the dev window.
 */
export const DEV_REACT_REFRESH_PREAMBLE_HASH = 'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk=';

/**
 * Content-Security-Policy for dev runs (never shipped): the production policy plus only what the Vite dev server needs.
 *  - script-src: the hash of the React Fast Refresh preamble (an inline module script). No 'unsafe-inline' for scripts.
 *  - style-src 'unsafe-inline': Vite's dev client injects every stylesheet as a <style> element, which has no hash or nonce.
 *  - connect-src ws://localhost:*: the HMR web socket (the port is whatever the dev server was given).
 * The dev server's own origin is covered by 'self' (the page is served from it).
 */
export const DEV_CSP =
  `default-src 'self'; script-src 'self' '${DEV_REACT_REFRESH_PREAMBLE_HASH}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; ` +
  "font-src 'self'; connect-src 'self' ws://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'";
