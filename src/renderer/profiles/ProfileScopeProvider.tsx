import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { JobRecord } from '../../shared/jobs';
import type { ProfileView } from '../../shared/settings';
import { useJobs } from '../jobs/JobsProvider';
import { usePlaces } from '../places/PlacesProvider';
import { useSettings } from '../settings/SettingsProvider';
import { scopeDevices, scopeFromSetting, scopeJobs, scopeToSetting, type ProfileScope } from './profileScope';

/** Settings tells the switcher that people were added, renamed or removed (or that an owner changed). */
export const PROFILES_CHANGED_EVENT = 'backuphub:profiles-changed';

interface ScopeStore {
  /** The people, in the order they were added. */
  profiles: readonly ProfileView[];
  /** True once main has answered with the people. */
  loaded: boolean;
  scope: ProfileScope;
  setScope: (scope: ProfileScope) => void;
}

const EMPTY: ScopeStore = { profiles: [], loaded: false, scope: 'all', setScope: () => undefined };
const ScopeContext = createContext<ScopeStore>(EMPTY);

/**
 * The person in focus, remembered between launches (the setting "activePerson"). Every screen follows it. A person who no longer exists
 * shows the first person; Everyone is a person-less choice saved as null.
 */
export function ProfileScopeProvider({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<readonly ProfileView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const { state, settings, update } = useSettings();
  // The choice just made, until the saved setting catches up (a click must show at once).
  const [chosen, setChosen] = useState<number | null | undefined>(undefined);

  const load = useCallback(() => {
    window.backupHub.profiles
      .list()
      .then((result) => {
        if (result.ok) {
          setProfiles(result.profiles);
          setLoaded(true);
        }
        return undefined;
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(PROFILES_CHANGED_EVENT, load);
    return () => window.removeEventListener(PROFILES_CHANGED_EVENT, load);
  }, [load]);

  const saved = chosen !== undefined ? chosen : settings.activePerson;
  // Until both the settings and the people are known the first person is shown (no flash of someone else's things).
  const scope = useMemo<ProfileScope>(() => (state === null && chosen === undefined ? scopeFromSetting(1, profiles) : scopeFromSetting(saved, profiles)), [state, chosen, saved, profiles]);
  const setScope = useCallback(
    (next: ProfileScope) => {
      const value = scopeToSetting(next);
      setChosen(value);
      void update('activePerson', value);
    },
    [update],
  );

  const value = useMemo(() => ({ profiles, loaded, scope, setScope }), [profiles, loaded, scope, setScope]);
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useProfileScope(): ScopeStore {
  return useContext(ScopeContext);
}

/** The places of the person in focus plus every shared one (null until main has answered once). */
export function useScopedPlaces(): ReturnType<typeof usePlaces> {
  const store = usePlaces();
  const { scope } = useProfileScope();
  return useMemo(() => ({ ...store, snapshot: store.snapshot === null ? null : { ...store.snapshot, places: scopeDevices(store.snapshot.places, scope) } }), [store, scope]);
}

/** The jobs of the person in focus. `sharedToo` keeps the jobs that belong to no one (drives, the laptop). */
export function useScopedJobs(sharedToo: boolean): readonly JobRecord[] {
  const { jobs } = useJobs();
  const { scope } = useProfileScope();
  return useMemo(() => scopeJobs(jobs, scope, sharedToo), [jobs, scope, sharedToo]);
}
