import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { attentionCount, type JobRecord } from '../../shared/jobs';
import { useDismissedJobs } from './dismissedJobs';
import { mergeFresh, mergeJob } from './jobsModel';

interface JobsStore {
  jobs: readonly JobRecord[];
  /** False until the first list arrives from main. */
  loaded: boolean;
  /** Needs-you jobs plus failures in the last 24 hours (rail badge). */
  attention: number;
  /** True while a list request is in flight (the Refresh button on the Jobs screen shows it). */
  refreshing: boolean;
  refresh: () => void;
}

const EMPTY: JobsStore = { jobs: [], loaded: false, attention: 0, refreshing: false, refresh: () => undefined };

const JobsContext = createContext<JobsStore>(EMPTY);

/** One list of jobs for the whole app, kept current by main's change events. */
export function JobsProvider({ children }: { children: ReactNode }) {
  const [jobs, setJobs] = useState<readonly JobRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Jobs pushed since the current list request started.
  const pushedRef = useRef<JobRecord[]>([]);
  const loadingRef = useRef(false);

  const load = useCallback(() => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setRefreshing(true);
    pushedRef.current = [];
    void (async () => {
      try {
        const fresh = await window.backupHub.jobs.list({ limit: 300 });
        setJobs(mergeFresh(fresh, pushedRef.current));
      } catch {
        // Main is not ready or the call failed: show the empty state rather than a spinner forever.
      } finally {
        setLoaded(true);
        setRefreshing(false);
        loadingRef.current = false;
      }
    })();
  }, []);

  useEffect(() => {
    const off = window.backupHub.jobs.onChanged((event) => {
      if (loadingRef.current) pushedRef.current.push(event.job);
      setJobs((current) => mergeJob(current, event.job));
    });
    // Not on the first-paint path: the list is fetched once the browser is idle.
    const timer = window.setTimeout(load, 50);
    return () => {
      window.clearTimeout(timer);
      off();
    };
  }, [load]);

  // The "failed in the last 24 hours" count ages out on its own, so re-evaluate every minute.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const dismissed = useDismissedJobs();
  const value = useMemo<JobsStore>(
    () => ({ jobs, loaded, attention: attentionCount(jobs.filter((j) => !(j.state === 'failed' && dismissed.has(j.id))), Date.now()), refreshing, refresh: load }),
    // `tick` makes the 24-hour window move forward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobs, loaded, refreshing, load, tick, dismissed],
  );

  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

export function useJobs(): JobsStore {
  return useContext(JobsContext);
}
