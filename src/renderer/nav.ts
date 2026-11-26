import { createElement, useEffect, useRef, useState, type ComponentType, type ReactElement } from 'react';
import { CleanUpIcon, CopyIcon, FolderIcon, HomeIcon, JobsIcon, SettingsIcon, SourcesIcon } from './icons';
import { NAV_ITEMS, sidebarItems, type ScreenId } from './navConfig';

export type { ScreenId } from './navConfig';
export { resolveTarget, type NavTarget } from './routes';

export interface ScreenDef {
  id: ScreenId;
  label: string;
  Icon: ComponentType<{ size?: number }>;
  /** Each screen is its own chunk, loaded the first time it is opened. Null while the screen does not exist yet. */
  Screen: ComponentType | null;
}

const ICONS: Record<ScreenId, ComponentType<{ size?: number }>> = {
  home: HomeIcon,
  backups: CopyIcon,
  devices: SourcesIcon,
  files: FolderIcon,
  'free-up-space': CleanUpIcon,
  activity: JobsIcon,
  settings: SettingsIcon,
};

/** The screens that exist today, each loaded as its own chunk. */
const LOADERS: Partial<Record<ScreenId, () => Promise<{ default: ComponentType }>>> = {
  home: () => import('./screens/Home'),
  backups: () => import('./screens/Backups'),
  devices: () => import('./screens/Devices'),
  files: () => import('./screens/Search'),
  'free-up-space': () => import('./screens/FreeUpSpace'),
  activity: () => import('./screens/Activity'),
  settings: () => import('./screens/Settings'),
};

/**
 * A screen whose code is fetched by `load`. Not React.lazy on purpose: the first render of a lazy component always suspends,
 * even when its code is already loaded, and React then holds the screen back for 300 ms (its anti-flicker delay for a Suspense
 * fallback). This one draws the loaded screen at once, and nothing until it has loaded.
 */
function loadedScreen(load: () => Promise<{ default: ComponentType }>): { Screen: ComponentType; preload: () => Promise<void> } {
  let loaded: ComponentType | null = null;
  let failure: unknown = null;
  let pending: Promise<void> | null = null;
  const preload = (): Promise<void> => {
    pending ??= load().then(
      (module) => {
        loaded = module.default;
        return undefined;
      },
      (err: unknown) => {
        failure = err;
        return undefined;
      },
    );
    return pending;
  };
  function Screen(): ReactElement | null {
    const [, setLoadedTick] = useState(0);
    const drawn = useRef(loaded);
    useEffect(() => {
      if (drawn.current === null) {
        void preload().then(() => {
          setLoadedTick((tick) => tick + 1);
          return undefined;
        });
      }
    }, []);
    if (failure !== null) throw failure;
    return loaded === null ? null : createElement(loaded);
  }
  return { Screen, preload };
}

const LOADED_SCREENS = Object.fromEntries(Object.entries(LOADERS).map(([id, load]) => [id, loadedScreen(load)]));

/** Loads every screen's code in the background (after the first one is up), so switching screens never waits for a file. */
export function preloadScreens(): void {
  for (const entry of Object.values(LOADED_SCREENS)) void entry.preload();
}

/** Every entry of the nav config with its icon and screen (the screen is null for a hidden entry). */
export const SCREENS: readonly ScreenDef[] = NAV_ITEMS.map((item) => ({
  id: item.id,
  label: item.label,
  Icon: ICONS[item.id],
  Screen: LOADED_SCREENS[item.id]?.Screen ?? null,
}));

export function screenDef(id: ScreenId): ScreenDef | undefined {
  return SCREENS.find((screen) => screen.id === id);
}

/** The entries shown in the sidebar, with their icons. */
export function sidebarScreens(): ScreenDef[] {
  return sidebarItems().map((item) => screenDef(item.id)!);
}
