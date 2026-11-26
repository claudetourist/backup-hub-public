import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PlaceView } from '../../shared/places';
import { AccountsViewSwitch } from './AccountsViewSwitch';
import { ACCOUNTS_VIEW_KEY, readAccountsView, writeAccountsView } from './devicesModel';
import { GoogleAccountsGrid } from './GoogleAccountsGrid';
import { PlaceCard } from './PlaceCard';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const GB = 1_000_000_000;
const NOW = new Date(2026, 10, 24, 12).getTime();

const account = (n: number, used: number, over: Partial<PlaceView> = {}): PlaceView =>
  ({ id: 'g' + n, kind: 'gdrive', label: `acc${String(n).padStart(2, '0')}@example.com`, status: 'connected', lastLookedAt: new Date(2026, 10, 22, 9).getTime(), gdrive: { quotaUsageBytes: used * GB, quotaLimitBytes: 15 * GB, refresh: { signingIn: false } }, ...over }) as PlaceView;

const drive = (over: Partial<PlaceView> = {}): PlaceView =>
  ({ id: 't7', kind: 'drive', label: 'T7', status: 'connected', capacityBytes: 1000 * GB, freeBytes: 500 * GB, lastLookedAt: null, lastConnectedAt: null, listing: 'idle', problem: null, ...over }) as PlaceView;

describe('Devices: Google accounts as a compact list', () => {
  const accounts = Array.from({ length: 27 }, (_, i) => account(i + 1, i % 15));

  it('shows the 8 fullest first and folds the rest behind "Show all 27"', () => {
    const html = render(h(GoogleAccountsGrid, { accounts, now: NOW }));
    expect(html.match(/class="account-row"/g)).toHaveLength(8);
    expect(html).toContain('Show all 27');
    expect(html).toContain('Find an account');
    expect(html.indexOf('acc15@example.com')).toBeLessThan(html.indexOf('acc14@example.com'));
    expect(html).not.toContain('acc01@example.com');
  });

  it('says "Checked 22 Nov" or "Not checked yet", and offers Sign in again only where needed', () => {
    const html = render(h(GoogleAccountsGrid, { accounts: [account(1, 13, { lastLookedAt: new Date(2026, 9, 22, 9).getTime() }), account(2, 1, { lastLookedAt: null, status: 'needs_signin' })], now: NOW }));
    expect(html).toContain('Checked 22 Oct');
    expect(html).toContain('Not checked yet');
    expect(html).not.toContain('Last read');
    expect(html).not.toContain('Not read yet');
    expect(html.match(/Sign in again/g)).toHaveLength(1);
    expect(html).toContain('13 of 15 GB');
  });
});

describe('Devices: Check now on a card', () => {
  it('is on a plugged-in drive and the laptop', () => {
    expect(render(h(PlaceCard, { place: drive(), now: NOW }))).toContain('Check now');
    expect(render(h(PlaceCard, { place: drive({ kind: 'laptop', label: 'STUDY-PC' }), now: NOW }))).toContain('Check now');
  });

  it('is not on a drive that is not plugged in, and says "Checking…" while a check runs', () => {
    expect(render(h(PlaceCard, { place: drive({ status: 'disconnected' }), now: NOW }))).not.toContain('Check now');
    const busy = render(h(PlaceCard, { place: drive({ listing: 'running' }), now: NOW }));
    expect(busy).toContain('Checking…');
    expect(busy).toMatch(/<button[^>]*disabled[^>]*>Checking…/);
  });
});

describe('Devices: Google accounts List / Grid switch', () => {
  const accounts = [account(1, 13), account(2, 1, { lastLookedAt: null, status: 'needs_signin' })];

  it('the list is the default view and the Grid shows cards with name, space bar and last checked', () => {
    const list = render(h(GoogleAccountsGrid, { accounts, now: NOW }));
    expect(list).toContain('class="account-row"');
    expect(list).not.toContain('account-card');
    const grid = render(h(GoogleAccountsGrid, { accounts, now: NOW, view: 'grid' }));
    expect(grid.match(/class="account-card"/g)).toHaveLength(2);
    expect(grid).toContain('class="account-grid"');
    expect(grid).not.toContain('account-row');
    expect(grid).toContain('acc01@example.com');
    expect(grid).toContain('13 of 15 GB');
    expect(grid).toContain('Checked 22 Nov');
    expect(grid).toContain('Not checked yet');
    expect(grid.match(/Sign in again/g)).toHaveLength(1);
  });

  it('the switch says which view is on', () => {
    const html = render(h(AccountsViewSwitch, { view: 'grid', onChange: () => undefined }));
    expect(html).toMatch(/aria-pressed="false"[^>]*>List</);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Grid</);
  });

  it('the choice is remembered between visits, and a missing or broken store means the list', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readAccountsView(storage)).toBe('list');
    writeAccountsView(storage, 'grid');
    expect(store.get(ACCOUNTS_VIEW_KEY)).toBe('grid');
    expect(readAccountsView(storage)).toBe('grid');
    store.set(ACCOUNTS_VIEW_KEY, 'nonsense');
    expect(readAccountsView(storage)).toBe('list');
    expect(readAccountsView(null)).toBe('list');
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readAccountsView(broken)).toBe('list');
    expect(() => writeAccountsView(broken, 'grid')).not.toThrow();
  });
});
