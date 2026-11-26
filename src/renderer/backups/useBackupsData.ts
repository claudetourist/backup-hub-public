import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BackupRow, BackupsOverview, RemovedBackup } from '../../shared/backups';
import type { FolderBackupCards } from '../../shared/folderBackup';
import type { JobRecord } from '../../shared/jobs';
import type { MirrorStatusResult } from '../../shared/mirror';
import type { ConnectedPhones } from '../../shared/phoneBackup';
import type { ProfileView } from '../../shared/settings';
import { useJobs } from '../jobs/JobsProvider';
import { useNow } from '../jobs/useNow';
import { useProfileScope } from '../profiles/ProfileScopeProvider';
import { scopeBackups, type ProfileScope } from '../profiles/profileScope';
import { forgetUnplugged } from './backupsModel';
import type { SizesState } from './backupListModel';
import { lastPhones, readPhones } from './phoneCache';
import { useMirrorStatus } from './useMirrorStatus';

/** Everything the list of backups and a backup's page read, loaded once by the Backups screen and shared by both. */
export interface BackupsData {
  now: number;
  overview: BackupsOverview | null;
  loadError: string | null;
  /** The backups of the person in focus (null until the list is read). */
  rows: BackupRow[] | null;
  /** The backups taken off the list (of the person in focus). */
  removed: RemovedBackup[];
  folderCards: FolderBackupCards | null;
  connected: ConnectedPhones | null;
  lookingForPhones: boolean;
  hiddenPhones: ReadonlySet<string>;
  hidePhone: (serial: string) => void;
  mirror: MirrorStatusResult | null;
  sizes: SizesState;
  jobs: readonly JobRecord[];
  profiles: readonly ProfileView[];
  scope: ProfileScope;
  /** Reads the list again. */
  load: () => void;
  checkPhones: () => void;
}

/** The finished jobs and the states of the running ones: a change means "count the sizes and the second drive again". */
const jobsKey = (jobs: readonly JobRecord[]): string => jobs.map((j) => `${j.id}:${j.state}`).join(',');

export function useBackupsData(): BackupsData {
  const now = useNow();
  const [overview, setOverview] = useState<BackupsOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [folderCards, setFolderCards] = useState<FolderBackupCards | null>(null);
  // The last known answer shows at once; a fresh one follows (asking adb from cold takes about 5 seconds).
  const [connected, setConnected] = useState<ConnectedPhones | null>(() => lastPhones());
  const [lookingForPhones, setLookingForPhones] = useState(true);
  const [hiddenPhones, setHiddenPhones] = useState<ReadonlySet<string>>(new Set());
  const [sizes, setSizes] = useState<SizesState>('loading');
  const { profiles, scope } = useProfileScope();
  const { jobs } = useJobs();

  const load = useCallback((): void => {
    void (async () => {
      try {
        setOverview(await window.backupHub.backups.overview());
        setLoadError(null);
      } catch {
        setLoadError('The list of backups could not be read.');
      }
      try {
        setFolderCards(await window.backupHub.folderBackup.cards());
      } catch {
        setFolderCards(null);
      }
    })();
  }, []);
  useEffect(load, [load]);

  // Which phone is plugged in: asked once when the screen opens and when the person presses "Check for a phone". Never on a timer.
  const checkPhones = useCallback((): void => {
    void (async () => {
      try {
        const answer = await readPhones();
        setConnected(answer);
        setHiddenPhones((hidden) => forgetUnplugged(hidden, answer));
      } catch {
        setConnected(null);
      } finally {
        setLookingForPhones(false);
      }
    })();
  }, []);
  useEffect(checkPhones, [checkPhones]);

  const hidePhone = useCallback((serial: string): void => setHiddenPhones((hidden) => new Set([...hidden, serial])), []);

  const rows = useMemo(() => (overview ? scopeBackups(overview.backups, scope) : null), [overview, scope]);
  const removed = useMemo(() => (overview?.removed ? scopeBackups(overview.removed, scope) : []), [overview, scope]);

  // How far behind each second drive is, and how big each backup is: asked when the screen opens and when a job starts, ends or fails (both are counted off the window's thread).
  const ids = overview?.backups.map((b) => `${b.id}:${b.destinations?.length ?? 1}`).join(',') ?? '';
  const refreshKey = `${ids}|${jobsKey(jobs)}`;
  const mirror = useMirrorStatus(refreshKey);
  const sizesKey = `${ids}|${jobs.filter((j) => j.state === 'done' || j.state === 'done_warnings').length}`;
  useEffect(() => {
    if (ids === '') return undefined;
    let alive = true;
    void (async () => {
      try {
        const answer = await window.backupHub.backups.sizes();
        if (alive) setSizes(answer.ok ? new Map(answer.sizes.map((s) => [s.backupId, s])) : 'failed');
      } catch {
        if (alive) setSizes('failed');
      }
    })();
    return () => {
      alive = false;
    };
    // sizesKey is not read inside: a finished backup means "count again".
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [sizesKey, ids]);

  return { now, overview, loadError, rows, removed, folderCards, connected, lookingForPhones, hiddenPhones, hidePhone, mirror, sizes, jobs, profiles, scope, load, checkPhones };
}
