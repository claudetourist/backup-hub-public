import '@fontsource/instrument-sans/latin-400.css';
import '@fontsource/instrument-sans/latin-500.css';
import '@fontsource/instrument-sans/latin-600.css';
import '@fontsource/bricolage-grotesque/latin-600.css';
import '@fontsource/bricolage-grotesque/latin-700.css';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import './tokens.css';
import './app.css';
import './kit.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { hashFlags } from './routes';
import { applyTheme, readCachedTheme } from './settings/theme';

// The last theme is remembered here so the first frame already has it (the database opens after the window).
const cachedTheme = readCachedTheme();
if (cachedTheme) applyTheme(cachedTheme);

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');
const root = createRoot(container);
const show = (): void => root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
// Dev only: "#/devices?mock" in the URL uses sample data instead of the real bridge (review screenshots in a plain browser).
if (import.meta.env.DEV && hashFlags(window.location.hash).has('mock')) {
  void import('./dev/mockApi').then((m) => {
    m.installMockApi();
    show();
    return undefined;
  });
} else {
  show();
}

// Tell main the first frame is on screen (used for the startup timing summary).
let reported = false;
function reportFirstPaint(fcpMs: number | null): void {
  if (reported) return;
  reported = true;
  window.backupHub.app.reportFirstPaint({ fcpMs });
}

try {
  new PerformanceObserver((list, observer) => {
    const fcp = list.getEntriesByName('first-contentful-paint')[0];
    if (fcp) {
      observer.disconnect();
      reportFirstPaint(fcp.startTime);
    }
  }).observe({ type: 'paint', buffered: true });
} catch {
  // PerformanceObserver paint entries unavailable: the fallback below still reports.
}
// Fallback: two animation frames after load means a frame has been presented.
window.addEventListener('load', () => {
  requestAnimationFrame(() => requestAnimationFrame(() => reportFirstPaint(null)));
});

// Bench runs only (main opens the page as #/home?bench): walk the screens and report the timings. A normal start never loads this.
if (hashFlags(window.location.hash).has('bench')) {
  void import('./bench').then((m) => m.runBench()).catch((err: unknown) => console.error('bench failed', err));
}

// Dev only: ?light / ?dark in the address forces a theme for review screenshots (gallery has buttons too).
if (import.meta.env.DEV) {
  const flags = hashFlags(window.location.hash);
  const forced = flags.has('light') ? 'light' : flags.has('dark') ? 'dark' : null;
  if (forced) document.documentElement.setAttribute('data-theme', forced);
}
