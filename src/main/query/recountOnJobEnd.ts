import type { DataVersion } from '../cache/dataVersion';
import { COPY_TO_LOCAL_JOB_KIND } from '../../shared/localCopy';
import { DRIVE_REFRESH_JOB_KIND } from '../../shared/drive';
import { HASH_FILES_JOB_KIND } from '../../shared/fingerprint';
import { IMPORT_V1_JOB_KIND } from '../../shared/importV1';
import { isFinished, type JobChangedEvent } from '../../shared/jobs';
import type { RequestOptions } from './queryService';

/**
 * The cached counts (file stats, fingerprint counts, coverage) stay valid until something that changes them ends. This is the
 * list of those things for jobs; the places poll never recounts.
 * - A Drive refresh or a copy ending recounts everything here.
 * - A listing, fingerprint run or v1 import ending recounts stats and coverage in the fingerprint service (it also
 *   keeps the Sources state in step); here they only bump the data version.
 * With a data version, the jobs that change what the counts are made from bump it here (a listing bumps it itself,
 * only when it found a difference; a running fingerprint job bumps it now and then so the numbers keep moving), and
 * every recount asks "did the data change?" first, so a job that changed nothing costs nothing.
 */
export interface RecountJobs {
  onChanged(listener: (event: JobChangedEvent) => void): () => void;
}
export interface RecountQuery {
  requestStats(options?: RequestOptions): void;
  requestCoverage(options?: RequestOptions): void;
}

/** While files are being fingerprinted the data version moves at most this often. */
export const PROGRESS_BUMP_MS = 5000;

export function wireRecountOnJobEnd(jobs: RecountJobs, query: RecountQuery, version?: DataVersion, now: () => number = Date.now): () => void {
  let lastProgressBump = 0;
  return jobs.onChanged((event) => {
    const kind = event.job.kind;
    if (event.reason === 'progress' && kind === HASH_FILES_JOB_KIND && version && now() - lastProgressBump >= PROGRESS_BUMP_MS) {
      lastProgressBump = now();
      version.bump();
      return;
    }
    if (event.reason !== 'state' || !isFinished(event.job.state)) return;
    if (kind === DRIVE_REFRESH_JOB_KIND || kind === COPY_TO_LOCAL_JOB_KIND) {
      version?.bump();
      query.requestStats({ force: true });
      query.requestCoverage({ force: true });
    } else if (kind === HASH_FILES_JOB_KIND || kind === IMPORT_V1_JOB_KIND) {
      version?.bump();
    }
  });
}
