import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, type AppSettings, type SettingKey, type SettingsState } from '../../shared/settings';
import { applyTheme, cacheTheme } from './theme';

interface SettingsStore {
  /** Null until main has answered once. */
  state: SettingsState | null;
  settings: AppSettings;
  /** Saves one setting; resolves to a plain-language problem or null. */
  update: <K extends SettingKey>(key: K, value: AppSettings[K]) => Promise<string | null>;
}

const EMPTY: SettingsStore = { state: null, settings: DEFAULT_SETTINGS, update: () => Promise.resolve(null) };

const SettingsContext = createContext<SettingsStore>(EMPTY);

/** App-wide settings from main. The theme is applied to the page as soon as it is known. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SettingsState | null>(null);

  useEffect(() => {
    const off = window.backupHub.settings.onChanged(setState);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const first = await window.backupHub.settings.get();
          setState((current) => current ?? first);
        } catch {
          // Main not ready: the next change event fills it in.
        }
      })();
    }, 60);
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, []);

  const theme = state?.settings.theme;
  useEffect(() => {
    if (!theme) return;
    cacheTheme(theme);
    // A forced theme in the dev URL (#light / #dark, used for review screenshots) wins in dev builds.
    if (import.meta.env.DEV && /(?:^|[#&,])(light|dark)(?:$|[&,])/.test(window.location.hash)) return;
    applyTheme(theme);
  }, [theme]);

  const update = useCallback(async <K extends SettingKey>(key: K, value: AppSettings[K]): Promise<string | null> => {
    try {
      const result = await window.backupHub.settings.set(key, value);
      if (!result.ok) return result.message;
      setState((current) => (current ? { ...current, settings: result.settings } : current));
      return null;
    } catch {
      return 'That did not work. Please try again.';
    }
  }, []);

  const value = useMemo<SettingsStore>(() => ({ state, settings: state?.settings ?? DEFAULT_SETTINGS, update }), [state, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsStore {
  return useContext(SettingsContext);
}
