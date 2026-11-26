import { useJobs } from '../jobs/JobsProvider';
import { workingSummary } from '../jobs/working';
import { ProgressBar } from './ProgressBar';

/**
 * Bottom of the sidebar: one line saying that Backup Hub is busy and with what, so a quiet laptop fan or a slow disk is never a
 * mystery. Pressing it opens Activity. When nothing is running a small "Activity" button stays, so the list (and its badge for
 * jobs that need you or failed) is always one press away.
 */
export function WorkingIndicator({ onOpen, badge = 0 }: { onOpen: () => void; badge?: number }) {
  const { jobs } = useJobs();
  const working = workingSummary(jobs);
  if (!working) {
    return (
      <button type="button" className="working working--idle" onClick={onOpen} title="Open Activity">
        <span className="working__row">
          <span>Activity</span>
          {badge > 0 ? (
            <span className="rail__badge working__count">
              <span aria-hidden="true">{badge}</span>
              <span className="sr-only">, {badge} need attention</span>
            </span>
          ) : (
            <span className="working__count">Nothing running</span>
          )}
        </span>
      </button>
    );
  }
  return (
    <button type="button" className="working" onClick={onOpen} title="Open Activity">
      <span className="working__row">
        <span className="working__spinner" aria-hidden="true" />
        <b>Working</b>
        <span className="working__count">{working.count}</span>
      </span>
      <span className="working__text">{working.text}</span>
      {working.percent !== null ? <ProgressBar value={working.percent} label="Progress of the job shown" /> : null}
      <span className="sr-only" role="status">
        Backup Hub is working: {working.text}
      </span>
    </button>
  );
}
