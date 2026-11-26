import { DEFAULT_SCREEN, isRoutable, type ScreenId } from './navConfig';

/**
 * Hash routing, pure. An address looks like #/devices, or #/settings/security (a section of a screen).
 * Dev links may add flags after a question mark: #/home?mock&dark.
 */
export const GALLERY_ROUTE = 'gallery';

export interface Route {
  /** The screen to show. 'gallery' is the developer page; it exists only in dev builds. */
  screen: ScreenId | typeof GALLERY_ROUTE;
  /** The part after the screen name (for Settings: the group), or null. */
  sub: string | null;
}

export const HOME_ROUTE: Route = { screen: DEFAULT_SCREEN, sub: null };

/** Reads an address. Anything unknown or hidden lands on Home. `allowGallery` is true in dev builds only. */
export function parseHash(hash: string, allowGallery = false): Route {
  const [path = ''] = hash.replace(/^#/, '').split('?');
  const [name = '', sub] = path.split('/').filter((part) => part !== '');
  const cleanSub = sub ? decodeURIComponent(sub) : null;
  if (name === GALLERY_ROUTE && allowGallery) return { screen: GALLERY_ROUTE, sub: cleanSub };
  if (isRoutable(name)) return { screen: name, sub: cleanSub };
  return HOME_ROUTE;
}

/** The address of a screen: formatRoute('settings', 'tools') is "#/settings/tools". */
export function formatRoute(screen: ScreenId | typeof GALLERY_ROUTE, sub: string | null = null): string {
  return sub ? `#/${screen}/${encodeURIComponent(sub)}` : `#/${screen}`;
}

/** The dev flags of an address: "#/home?mock&dark" gives mock and dark. Also reads the old style "#sources,mock". */
export function hashFlags(hash: string): Set<string> {
  const flags = new Set<string>();
  const text = hash.replace(/^#/, '');
  const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text.slice(text.indexOf(',') + 1 || text.length);
  for (const flag of query.split(/[&,]/)) if (flag !== '') flags.add(flag);
  return flags;
}

/**
 * Where a screen can ask to go. The old names still work (a notification, an old button): each lands on the new home of that
 * function. 'jobs' is now Activity.
 */
export type NavTarget = ScreenId | 'search' | 'phone' | 'cleanup' | 'jobs' | 'sources';

export function resolveTarget(target: NavTarget): Route {
  switch (target) {
    case 'jobs':
      return { screen: 'activity', sub: null };
    case 'phone':
      return { screen: 'free-up-space', sub: null };
    case 'cleanup':
      // Laptop duplicates are under Settings, Tools.
      return { screen: 'settings', sub: 'tools' };
    case 'sources':
      return { screen: 'devices', sub: null };
    case 'search':
      return { screen: 'files', sub: null };
    default:
      return isRoutable(target) ? { screen: target, sub: null } : HOME_ROUTE;
  }
}

export function sameRoute(a: Route, b: Route): boolean {
  return a.screen === b.screen && a.sub === b.sub;
}
