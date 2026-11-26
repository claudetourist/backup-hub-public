/**
 * The four states of every screen (PLAN section 6): loading, empty, error (with Retry) and loaded. Pure.
 * While new results load, the old ones stay on screen, dimmed.
 */
export type ViewState = 'loading' | 'empty' | 'error' | 'loaded';

export interface ViewInput {
  /** A request is running. */
  loading: boolean;
  /** The last request failed (plain words), or null. */
  error: string | null;
  /** How many results are in hand (from an earlier request too), or null when there are none yet. */
  count: number | null;
}

export interface ViewResult {
  state: ViewState;
  /** True while old results are shown and a new request runs: show them dimmed, not replaced by a skeleton. */
  reloading: boolean;
}

export function viewStateOf({ loading, error, count }: ViewInput): ViewResult {
  const haveResults = count !== null;
  if (loading && !haveResults) return { state: 'loading', reloading: false };
  if (error !== null && !loading) return { state: 'error', reloading: false };
  if (!haveResults) return { state: 'loading', reloading: false };
  if (count === 0) return { state: 'empty', reloading: loading };
  return { state: 'loaded', reloading: loading };
}
