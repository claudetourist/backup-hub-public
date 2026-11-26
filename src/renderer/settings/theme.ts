import type { ThemeSetting } from '../../shared/settings';
import { THEME_SETTINGS } from '../../shared/settings';

/** The value of <html data-theme>: none for "system" (tokens.css then follows prefers-color-scheme). */
export function themeAttribute(theme: ThemeSetting): 'light' | 'dark' | null {
  return theme === 'system' ? null : theme;
}

export const THEME_CACHE_KEY = 'backuphub.theme';

/** Set the theme on the page. */
export function applyTheme(theme: ThemeSetting, root: HTMLElement = document.documentElement): void {
  const attribute = themeAttribute(theme);
  if (attribute) root.setAttribute('data-theme', attribute);
  else root.removeAttribute('data-theme');
}

/**
 * The renderer remembers the last theme so the very first frame already has it (the real setting
 * lives in the database, which opens after the window is shown). A per-viewer convenience only:
 * every access is guarded because storage can be unavailable.
 */
export function readCachedTheme(): ThemeSetting | null {
  try {
    const value = window.localStorage.getItem(THEME_CACHE_KEY);
    return THEME_SETTINGS.includes(value as ThemeSetting) ? (value as ThemeSetting) : null;
  } catch {
    return null;
  }
}

export function cacheTheme(theme: ThemeSetting): void {
  try {
    window.localStorage.setItem(THEME_CACHE_KEY, theme);
  } catch {
    // Storage unavailable: the setting still applies for this session.
  }
}
