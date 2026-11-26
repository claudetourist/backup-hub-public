import { useEffect, useState } from 'react';
import type { OnlyHereSummary, WouldLoseDetail, WouldLoseFilesPage, WouldLoseFilesRequest } from '../../shared/insights';
import type { HealthView } from './insightsModel';

/**
 * Drive health: asked when the screen opens and again when `refreshKey` changes (a drive plugged in or taken out). Main reads Windows in a
 * child process off the window's thread; until the answer is there the cards say "Checking...". Never on a timer.
 */
export function useDriveHealth(refreshKey: string): HealthView {
  const [view, setView] = useState<HealthView>({ state: 'loading' });
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await window.backupHub.insights.driveHealth();
        if (!alive) return;
        setView(result.ok ? { state: 'ready', byId: new Map(result.drives.map((d) => [d.placeId, d])) } : { state: 'failed', message: result.message });
      } catch {
        if (alive) setView({ state: 'failed', message: 'The drives could not be checked right now. Nothing was changed.' });
      }
    })();
    return () => {
      alive = false;
    };
    // refreshKey is not read inside: a drive that was plugged in or taken out means "ask again".
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [refreshKey]);
  return view;
}

/** The one-line summary of the named drives ("12 GB with no checked copy"): null until counted (or when it could not be). */
export function useOnlyHere(refreshKey: string): OnlyHereSummary[] | null {
  const [places, setPlaces] = useState<OnlyHereSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await window.backupHub.insights.onlyHere();
        if (alive && result.ok) setPlaces(result.places);
      } catch {
        // The card simply stays away.
      }
    })();
    return () => {
      alive = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [refreshKey]);
  return places;
}

export type DetailState = { state: 'loading' } | { state: 'failed'; message: string } | { state: 'ready'; detail: WouldLoseDetail };

/** What would be lost for one place: counted off the window's thread; "loading" until the numbers are there. */
export function useWouldLose(placeId: string): DetailState {
  const [view, setView] = useState<{ placeId: string; value: DetailState } | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      let value: DetailState;
      try {
        const result = await window.backupHub.insights.wouldLose(placeId);
        value = result.ok ? { state: 'ready', detail: result.detail } : { state: 'failed', message: result.message };
      } catch {
        value = { state: 'failed', message: 'This could not be counted right now. Nothing was changed.' };
      }
      if (alive) setView({ placeId, value });
    })();
    return () => {
      alive = false;
    };
  }, [placeId]);
  return view !== null && view.placeId === placeId ? view.value : { state: 'loading' };
}

export interface FilesState {
  files: WouldLoseFilesPage['files'];
  more: boolean;
  loading: boolean;
  message: string | null;
  loadMore(): void;
}

/** The pages of files (biggest first) for the words typed, the kind and the part. A new question starts again from the top; a stale answer is dropped. */
export function useLoseFiles(request: Omit<WouldLoseFilesRequest, 'offset'>): FilesState {
  // The question as text: what changes it is what asks again (the object itself is rebuilt on every render).
  const key = JSON.stringify(request);
  const [state, setState] = useState<{ key: string; files: WouldLoseFilesPage['files']; more: boolean; loading: boolean; message: string | null }>({ key: '', files: [], more: false, loading: true, message: null });
  const [wanted, setWanted] = useState<{ key: string; offset: number }>({ key, offset: 0 });
  const offset = wanted.key === key ? wanted.offset : 0;
  useEffect(() => {
    let alive = true;
    void (async () => {
      setState((s) => (s.key === key ? { ...s, loading: true, message: null } : { key, files: [], more: false, loading: true, message: null }));
      try {
        const result = await window.backupHub.insights.wouldLoseFiles({ ...(JSON.parse(key) as Omit<WouldLoseFilesRequest, 'offset'>), offset });
        if (!alive) return;
        if (!result.ok) setState((s) => ({ ...s, key, loading: false, message: result.message }));
        else setState((s) => ({ key, files: s.key === key && offset > 0 ? [...s.files, ...result.page.files] : result.page.files, more: result.page.more, loading: false, message: null }));
      } catch {
        if (alive) setState((s) => ({ ...s, key, loading: false, message: 'This could not be counted right now. Nothing was changed.' }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [key, offset]);
  const current = state.key === key;
  return {
    files: current ? state.files : [],
    more: current && state.more,
    loading: !current || state.loading,
    message: current ? state.message : null,
    loadMore: () => setWanted({ key, offset: state.files.length }),
  };
}
