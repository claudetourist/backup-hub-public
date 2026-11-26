import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DriveHealth, WouldLoseDetail } from '../../shared/insights';
import type { PlaceView } from '../../shared/places';
import { PlaceCard } from '../places/PlaceCard';
import { GoogleAccountsGrid } from '../places/GoogleAccountsGrid';
import { formatRoute, parseHash } from '../routes';
import { LoseAnswer, WouldLoseScreen } from './WouldLoseScreen';
import { HomeLoseCard } from './HomeLoseCard';
import { loseSub, type HealthView } from './insightsModel';

const render = (element: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(element);
const NOW = new Date(2026, 10, 26, 12).getTime();
const DAY = 86_400_000;
const GB = 1_000_000_000;

const drive = (over: Partial<PlaceView> = {}): PlaceView =>
  ({ id: 'sea', kind: 'drive', label: 'Seagate2TB', status: 'connected', capacityBytes: 1000 * GB, freeBytes: 500 * GB, lastLookedAt: null, lastConnectedAt: NOW, listing: 'idle', problem: null, ...over }) as PlaceView;

const health = (over: Partial<DriveHealth> = {}): DriveHealth =>
  ({
    placeId: 'sea', label: 'Seagate2TB', kind: 'drive', status: 'connected', lastSeenAt: NOW, freeBytes: 500 * GB, capacityBytes: 1000 * GB, smart: 'good', smartNote: 'Windows says this disk is healthy',
    windowsErrors: 0, usbTroubles: 0, readErrors: 0, damaged: 0, differs: 0, lastCheck: { at: NOW - 10 * DAY, verified: 1000, differs: 0, couldNotRead: 0, complete: true }, nextBackupBytes: null, verdict: 'healthy', reasons: [], ...over,
  }) as DriveHealth;

const ready = (...list: DriveHealth[]): HealthView => ({ state: 'ready', byId: new Map(list.map((d) => [d.placeId, d])) });

describe('Drive health on a device card', () => {
  it('shows the verdict, why, what Windows says, last seen, the last check of old copies and the errors', () => {
    const html = render(h(PlaceCard, { place: drive(), now: NOW, health: ready(health({ verdict: 'check-soon', reasons: ['Paused 2 times for USB trouble in 30 days'], usbTroubles: 2, windowsErrors: 1 })) }));
    expect(html).toContain('Check soon');
    expect(html).toContain('Paused 2 times for USB trouble in 30 days');
    expect(html).toContain('<dt>Disk</dt>');
    expect(html).toContain('Windows says this disk is healthy');
    expect(html).toContain('Connected now');
    expect(html).toContain('Old copies');
    expect(html).toContain('16 Nov: 1,000 the same');
    expect(html).toContain('1 disk error in Windows · 2 USB pauses');
  });

  it('says Healthy with no reasons, and "Checking…" until main has answered, and when it could not', () => {
    expect(render(h(PlaceCard, { place: drive(), now: NOW, health: ready(health()) }))).toContain('Healthy');
    const loading = render(h(PlaceCard, { place: drive(), now: NOW, health: { state: 'loading' } }));
    expect(loading).toContain('Checking…');
    expect(loading).not.toContain('Healthy');
    expect(render(h(PlaceCard, { place: drive(), now: NOW, health: { state: 'failed', message: 'x' } }))).toContain('Could not check right now');
  });

  it('a Problem is said in words, and a drive that is away says when it was last seen', () => {
    const html = render(h(PlaceCard, { place: drive({ status: 'disconnected' }), now: NOW, health: ready(health({ status: 'disconnected', verdict: 'problem', reasons: ['1 copy is damaged'], lastSeenAt: NOW - 40 * DAY, damaged: 1 })) }));
    expect(html).toContain('Problem');
    expect(html).toContain('17 Oct, 1 month ago');
  });

  it('a phone has no Windows line and no errors line', () => {
    const phone = { ...drive({ id: 'ph', kind: 'phone', label: 'Poco F4', status: 'disconnected', lastConnectedAt: NOW - 2 * DAY }) } as PlaceView;
    const html = render(h(PlaceCard, { place: phone, now: NOW, health: ready(health({ placeId: 'ph', kind: 'phone', status: 'disconnected', smart: null, smartNote: '', windowsErrors: null, lastSeenAt: NOW - 2 * DAY })) }));
    expect(html).toContain('Healthy');
    expect(html).not.toContain('<dt>Disk</dt>');
    expect(html).not.toContain('<dt>Errors</dt>');
  });

  it('"What would I lose?" is on a drive card, the laptop, a phone, OneDrive and a Google account, with or without health', () => {
    expect(render(h(PlaceCard, { place: drive(), now: NOW }))).toContain('What would I lose?');
    for (const kind of ['laptop', 'phone', 'onedrive'] as const) expect(render(h(PlaceCard, { place: drive({ kind }), now: NOW }))).toContain('What would I lose?');
    const account = { id: 'g1', kind: 'gdrive', label: 'a@example.com', status: 'connected', lastLookedAt: null, gdrive: { quotaUsageBytes: 1, quotaLimitBytes: 15 * GB, refresh: { signingIn: false } } } as unknown as PlaceView;
    expect(render(h(GoogleAccountsGrid, { accounts: [account], now: NOW }))).toContain('What would I lose?');
  });
});

describe('"What would I lose?" screen', () => {
  const detail: WouldLoseDetail = {
    placeId: 't7',
    onlyHere: {
      files: 3_420,
      bytes: 12_000_000_000,
      kinds: [{ kind: 'photo-camera', files: 3_420, bytes: 12_000_000_000, folders: [{ folder: 'MyData/POCO/DCIM', files: 3_420, bytes: 12_000_000_000 }], rest: { folders: 2, files: 20, bytes: 1_000 } }],
      byBackup: [{ backupId: 1, name: 'Poco F4', files: 3_000, bytes: 11_000_000_000 }, { backupId: null, name: 'Not part of any backup', files: 420, bytes: 1_000_000_000 }],
    },
    maybeCopied: { files: 30, bytes: 40_000_000, kinds: [], byBackup: [] },
    notChecked: { files: 3_450, bytes: 12_340_000_000 },
    totalFiles: 61_000,
  };

  it('opens at once with a placeholder, before anything is counted', () => {
    const html = render(h(WouldLoseScreen, { placeId: 't7' }));
    expect(html).toContain('What would I lose?');
    expect(html).toContain('Counting the files on this device that have no other checked copy');
    expect(html).toContain('nothing is copied, changed or deleted');
  });

  it('gives the answer first, then by backup, by kind, and the files with a search box', () => {
    const html = render(h(LoseAnswer, { placeId: 't7', label: 'T7', detail }));
    expect(html).toContain('12 GB (3,450 files) would be lost');
    expect(html).toContain('Only here (3,420)');
    expect(html).toContain('Looks copied, not proven (30)');
    expect(html).toContain('By backup');
    expect(html).toContain('Poco F4');
    expect(html).toContain('Not part of any backup');
    expect(html).toContain('By kind of file');
    expect(html).toContain('Camera photos');
    expect(html).toContain('and 2 more folders');
    expect(html).toContain('Show these files');
    expect(html).toContain('Search the names');
    expect(html).toContain('Finding the files');
    expect(html.indexOf('would be lost')).toBeLessThan(html.indexOf('By backup'));
  });

  it('says "Nothing would be lost" and offers no lists when every file has a checked copy', () => {
    const safe: WouldLoseDetail = { ...detail, onlyHere: { files: 0, bytes: 0, kinds: [], byBackup: [] }, maybeCopied: { files: 0, bytes: 0, kinds: [], byBackup: [] } };
    const html = render(h(LoseAnswer, { placeId: 't7', label: 'T7', detail: safe }));
    expect(html).toContain('Nothing would be lost');
    expect(html).not.toContain('By backup');
    expect(html).not.toContain('Search the names');
  });

  it('opens on the "maybe" part when nothing is surely only here', () => {
    const maybe: WouldLoseDetail = { ...detail, onlyHere: { files: 0, bytes: 0, kinds: [], byBackup: [] }, maybeCopied: { files: 5, bytes: 500, kinds: [{ kind: 'documents', files: 5, bytes: 500, folders: [], rest: { folders: 0, files: 0, bytes: 0 } }], byBackup: [{ backupId: null, name: 'Not part of any backup', files: 5, bytes: 500 }] } };
    const html = render(h(LoseAnswer, { placeId: 't7', label: 'T7', detail: maybe }));
    expect(html).toMatch(/aria-pressed="true"[^>]*>Looks copied, not proven \(5\)/);
    expect(html).toContain('Documents');
  });
});

describe('Home card and the address', () => {
  it('the Home card draws nothing until the drives are counted (and nothing when nothing is at risk)', () => {
    expect(render(h(HomeLoseCard, { places: [drive()], refreshKey: '' }))).toBe('');
  });

  it('the screen is a section of Devices: #/devices/lose:<place>', () => {
    expect(formatRoute('devices', loseSub('t7'))).toBe('#/devices/lose%3At7');
    expect(parseHash('#/devices/lose%3At7')).toEqual({ screen: 'devices', sub: 'lose:t7' });
  });
});
