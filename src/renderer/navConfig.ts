/**
 * The sidebar and the bottom menu as plain data (no React), so routing and the nav rules can be tested.
 * An entry with `hidden: true` has no screen yet: it stays in this list so the place is kept, but it is not shown and its
 * address opens Home instead. Turn it on when its screen exists.
 */
export type ScreenId = 'home' | 'backups' | 'devices' | 'files' | 'free-up-space' | 'activity' | 'settings';

export interface NavItem {
  id: ScreenId;
  label: string;
  /** Where it is shown: the sidebar, or the menu at the bottom of it. */
  placement: 'sidebar' | 'menu';
  hidden: boolean;
}

/** Sidebar order follows PLAN section 6: Home, Backups, Devices, Files, Free up space, Activity. */
export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'home', label: 'Home', placement: 'sidebar', hidden: false },
  { id: 'backups', label: 'Backups', placement: 'sidebar', hidden: false },
  { id: 'devices', label: 'Devices', placement: 'sidebar', hidden: false },
  { id: 'files', label: 'Files', placement: 'sidebar', hidden: false },
  { id: 'free-up-space', label: 'Free up space', placement: 'sidebar', hidden: false },
  { id: 'activity', label: 'Activity', placement: 'sidebar', hidden: false },
  { id: 'settings', label: 'Settings', placement: 'menu', hidden: false },
];

export const DEFAULT_SCREEN: ScreenId = 'home';

/** The screens that are shown in the sidebar, in order. */
export function sidebarItems(): NavItem[] {
  return NAV_ITEMS.filter((item) => item.placement === 'sidebar' && !item.hidden);
}

/** True when the name is a screen that exists today (hidden ones do not count). */
export function isRoutable(id: string): id is ScreenId {
  return NAV_ITEMS.some((item) => item.id === id && !item.hidden);
}

/** An entry of the menu at the bottom of the sidebar. It opens a screen, and a section of it when `sub` is given. */
export interface MenuEntry {
  id: 'settings' | 'help' | 'safety-copies';
  label: string;
  screen: ScreenId;
  sub: string | null;
  hidden: boolean;
}

export const MENU_ENTRIES: readonly MenuEntry[] = [
  { id: 'settings', label: 'Settings', screen: 'settings', sub: null, hidden: false },
  // There is no help page yet, so nothing is shown (the same rule as Backups).
  { id: 'help', label: 'Help', screen: 'settings', sub: null, hidden: true },
  { id: 'safety-copies', label: "Backup Hub's own safety copies", screen: 'settings', sub: 'tools', hidden: false },
];

export function menuEntries(): MenuEntry[] {
  return MENU_ENTRIES.filter((entry) => !entry.hidden);
}
