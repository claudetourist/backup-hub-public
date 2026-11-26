import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PlacesSnapshot } from '../../shared/places';

interface PlacesStore {
  /** Null until main has answered once. */
  snapshot: PlacesSnapshot | null;
  /** Ask main to list the drives now. */
  refresh: () => void;
}

const EMPTY: PlacesStore = { snapshot: null, refresh: () => undefined };

const PlacesContext = createContext<PlacesStore>(EMPTY);

/** One picture of places and drives for the whole app, kept current by main's change events. */
export function PlacesProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<PlacesSnapshot | null>(null);

  const refresh = useCallback(() => {
    void (async () => {
      try {
        setSnapshot(await window.backupHub.places.refresh());
      } catch {
        // Main is not ready yet; the next change event or refresh will fill it in.
      }
    })();
  }, []);

  useEffect(() => {
    const off = window.backupHub.places.onChanged(setSnapshot);
    // Not on the first-paint path: read the last known picture once the browser is idle.
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const first = await window.backupHub.places.list();
          setSnapshot((current) => current ?? first);
        } catch {
          // Try again on the next event.
        }
      })();
    }, 80);
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, []);

  const value = useMemo<PlacesStore>(() => ({ snapshot, refresh }), [snapshot, refresh]);
  return <PlacesContext.Provider value={value}>{children}</PlacesContext.Provider>;
}

export function usePlaces(): PlacesStore {
  return useContext(PlacesContext);
}
