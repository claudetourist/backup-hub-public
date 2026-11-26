import { describe, expect, it } from 'vitest';
import { menuEntries, NAV_ITEMS, sidebarItems, isRoutable } from './navConfig';
import { SCREENS, sidebarScreens } from './nav';
import { formatRoute, hashFlags, HOME_ROUTE, parseHash, resolveTarget, sameRoute } from './routes';
import { isGalleryShortcut, isSearchShortcut } from './shortcuts';

describe('hash routing', () => {
  it('reads the address of every screen that exists', () => {
    for (const id of ['home', 'devices', 'files', 'free-up-space', 'activity', 'settings'] as const) {
      expect(parseHash(`#/${id}`)).toEqual({ screen: id, sub: null });
    }
  });
  it('reads a part of a screen (the Settings group)', () => {
    expect(parseHash('#/settings/security')).toEqual({ screen: 'settings', sub: 'security' });
    expect(parseHash('#/settings/tools?mock&dark')).toEqual({ screen: 'settings', sub: 'tools' });
  });
  it('lands on Home for nothing and for nonsense; Backups is a screen of its own', () => {
    expect(parseHash('')).toEqual(HOME_ROUTE);
    expect(parseHash('#')).toEqual(HOME_ROUTE);
    expect(parseHash('#/nonsense')).toEqual(HOME_ROUTE);
    expect(parseHash('#/backups')).toEqual({ screen: 'backups', sub: null });
  });
  it('opens the gallery only when it is allowed (dev builds)', () => {
    expect(parseHash('#/gallery')).toEqual(HOME_ROUTE);
    expect(parseHash('#/gallery', true)).toEqual({ screen: 'gallery', sub: null });
    expect(parseHash('#/gallery/7', true)).toEqual({ screen: 'gallery', sub: '7' });
  });
  it('writes an address that reads back the same (so back and forward return to where you were)', () => {
    for (const route of [{ screen: 'files', sub: null }, { screen: 'settings', sub: 'security' }, { screen: 'activity', sub: null }] as const) {
      expect(parseHash(formatRoute(route.screen, route.sub))).toEqual(route);
    }
    expect(formatRoute('free-up-space')).toBe('#/free-up-space');
  });
  it('compares routes', () => {
    expect(sameRoute({ screen: 'home', sub: null }, { screen: 'home', sub: null })).toBe(true);
    expect(sameRoute({ screen: 'settings', sub: 'tools' }, { screen: 'settings', sub: null })).toBe(false);
  });
  it('reads dev flags, in the new and the old style', () => {
    expect([...hashFlags('#/home?mock&dark')]).toEqual(['mock', 'dark']);
    expect([...hashFlags('#sources,mock')]).toEqual(['mock']);
    expect(hashFlags('#/settings/security').size).toBe(0);
  });
  it('old names land on the new home of the function', () => {
    expect(resolveTarget('phone')).toEqual({ screen: 'free-up-space', sub: null });
    expect(resolveTarget('cleanup')).toEqual({ screen: 'settings', sub: 'tools' });
    expect(resolveTarget('jobs')).toEqual({ screen: 'activity', sub: null });
    expect(resolveTarget('sources')).toEqual({ screen: 'devices', sub: null });
    expect(resolveTarget('search')).toEqual({ screen: 'files', sub: null });
    expect(resolveTarget('backups')).toEqual({ screen: 'backups', sub: null });
    expect(resolveTarget('devices')).toEqual({ screen: 'devices', sub: null });
  });
});

describe('what the sidebar shows', () => {
  it('lists Home, Backups, Devices, Files, Free up space and Activity, in that order', () => {
    expect(sidebarItems().map((item) => item.label)).toEqual(['Home', 'Backups', 'Devices', 'Files', 'Free up space', 'Activity']);
  });
  it('shows Backups now that it has a screen', () => {
    const backups = NAV_ITEMS.find((item) => item.id === 'backups');
    expect(backups?.hidden).toBe(false);
    expect(sidebarItems().some((item) => item.id === 'backups')).toBe(true);
    expect(isRoutable('backups')).toBe(true);
    expect(SCREENS.find((screen) => screen.id === 'backups')?.Screen).not.toBeNull();
  });
  it('shows an entry only when its screen exists', () => {
    for (const screen of sidebarScreens()) expect(screen.Screen, screen.id).not.toBeNull();
    expect(NAV_ITEMS.filter((item) => !item.hidden).every((item) => SCREENS.find((s) => s.id === item.id)?.Screen !== null)).toBe(true);
  });
  it('puts Settings and the safety copies in the menu at the bottom, and keeps Help hidden until there is a help page', () => {
    expect(menuEntries().map((entry) => entry.label)).toEqual(['Settings', "Backup Hub's own safety copies"]);
    expect(menuEntries().find((entry) => entry.id === 'safety-copies')).toMatchObject({ screen: 'settings', sub: 'tools' });
  });
  it('every sidebar entry has an address that opens it', () => {
    for (const item of sidebarItems()) expect(parseHash(formatRoute(item.id)).screen).toBe(item.id);
  });
});

describe('keyboard shortcuts', () => {
  const key = (k: string, extra: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
  it('Ctrl+K (and Cmd+K) opens Files search', () => {
    expect(isSearchShortcut(key('k', { ctrlKey: true }))).toBe(true);
    expect(isSearchShortcut(key('K', { ctrlKey: true }))).toBe(true);
    expect(isSearchShortcut(key('k', { metaKey: true }))).toBe(true);
  });
  it('plain K, Ctrl+Shift+K and Ctrl+Alt+K do not', () => {
    expect(isSearchShortcut(key('k'))).toBe(false);
    expect(isSearchShortcut(key('k', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isSearchShortcut(key('k', { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isSearchShortcut(key('j', { ctrlKey: true }))).toBe(false);
  });
  it('Ctrl+Shift+G is the dev gallery', () => {
    expect(isGalleryShortcut(key('G', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isGalleryShortcut(key('g', { ctrlKey: true }))).toBe(false);
  });
});
