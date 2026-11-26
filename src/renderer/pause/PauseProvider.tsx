import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { PAUSE_OFF, type PauseChoice, type PauseStatus } from '../../shared/pause';

interface PauseStore {
  status: PauseStatus;
  /** Switch Pause everything on for a while, until the person resumes, or off. Main keeps the state. */
  choose: (choice: PauseChoice) => void;
}

const EMPTY: PauseStore = { status: PAUSE_OFF, choose: () => undefined };

const PauseContext = createContext<PauseStore>(EMPTY);

/** The state of "Pause everything", kept current by main's change events (a timed pause ends by itself, and main says so). */
export function PauseProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<PauseStatus>(PAUSE_OFF);

  useEffect(() => {
    let alive = true;
    const off = window.backupHub.pause.onChanged(setStatus);
    window.backupHub.pause
      .get()
      .then((first) => {
        if (alive) setStatus(first);
        return undefined;
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off();
    };
  }, []);

  const choose = useCallback((choice: PauseChoice) => {
    window.backupHub.pause
      .set(choice)
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  const value = useMemo<PauseStore>(() => ({ status, choose }), [status, choose]);
  return <PauseContext.Provider value={value}>{children}</PauseContext.Provider>;
}

export function usePause(): PauseStore {
  return useContext(PauseContext);
}
