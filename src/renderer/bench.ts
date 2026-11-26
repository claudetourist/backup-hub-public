import { NAV_ITEMS } from './navConfig';

/**
 * Bench runs only (npm run bench: main opens the page as #/home?bench). Waits until Home is drawn with its data, notes when,
 * gives the lazy screens time to load, then switches to every screen 3 times and times each switch: from setting the address
 * to the second animation frame after the new screen's title is on the page. Reports to main, which adds the rest and quits.
 */
const ROUNDS = 3;
/** Lets the quiet preload of the other screens' code (App.tsx) finish before the first switch. */
const SETTLE_MS = 2500;
const WAIT_MS = 30_000;
/** The first wait: on a database copy that needs its safety check or an update, Home is not usable for a minute or two (the bench script gives the whole launch 4 minutes). */
const FIRST_WAIT_MS = 200_000;

const nextFrames = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const title = (): string => document.querySelector('#main-content .page-header__title')?.textContent ?? '';
const opening = (): boolean => document.querySelector('#main-content .opening') !== null;

function waitFor(ready: () => boolean, timeoutMs: number = WAIT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ready()) {
      resolve();
      return;
    }
    const finish = (): void => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
    const observer = new MutationObserver(() => {
      if (!ready()) return;
      finish();
      resolve();
    });
    const timer = window.setTimeout(() => {
      finish();
      reject(new Error('bench: the screen did not appear'));
    }, timeoutMs);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

async function visit(screen: string): Promise<number> {
  const before = title();
  const started = performance.now();
  window.location.hash = `#/${screen}`;
  await waitFor(() => title() !== '' && title() !== before && !opening());
  await nextFrames();
  return Math.round((performance.now() - started) * 10) / 10;
}

export async function runBench(): Promise<void> {
  await waitFor(() => title() === 'Home' && !opening(), FIRST_WAIT_MS);
  await nextFrames();
  const homeReadyEpochMs = performance.timeOrigin + performance.now();
  await new Promise((resolve) => window.setTimeout(resolve, SETTLE_MS));
  // Every visible screen except Home first (we are on Home), then Home again, so each is entered ROUNDS times.
  const ids = NAV_ITEMS.filter((item) => !item.hidden).map((item) => item.id);
  const order = [...ids.filter((id) => id !== 'home'), 'home'];
  const times = new Map<string, number[]>(order.map((id) => [id, []]));
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const id of order) times.get(id)!.push(await visit(id));
  }
  await window.backupHub.app.benchReport({ homeReadyEpochMs, switches: [...times].map(([screen, ms]) => ({ screen, ms })) });
}
