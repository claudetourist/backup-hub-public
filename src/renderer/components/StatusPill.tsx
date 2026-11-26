import type { ReactNode } from 'react';
import type { JobRecord } from '../../shared/jobs';
import { jobStatus } from '../jobs/jobsModel';
import {
  StatusAlertIcon,
  StatusCheckIcon,
  StatusCircleIcon,
  StatusClockIcon,
  StatusPlugIcon,
} from '../icons';
import { isDashed, STATUS_ICONS, STATUS_TONES, statusLine, statusText, type StatusIconName, type StatusInfo } from './backupStatus';
import { copyCountLabel, copyCountTone, jobStateLabel, jobStateTone, type JobState, type Tone } from './status';

/** Generic tinted pill. Always carries text, so colour is never the only signal. */
export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill pill--${tone}`}>{children}</span>;
}

/** A job's state in plain words: Queued, Running, Needs you, Done, Done with warnings, Failed. */
export function JobStatePill({ state, paused = false }: { state: JobState; paused?: boolean }) {
  if (paused && state === 'queued') {
    return (
      <Pill tone="amber">
        <span className="pill__dot" aria-hidden="true" />
        Paused
      </Pill>
    );
  }
  return (
    <Pill tone={jobStateTone(state)}>
      <span className={`pill__dot${state === 'running' ? ' pill__dot--pulse' : ''}`} aria-hidden="true" />
      {jobStateLabel(state)}
    </Pill>
  );
}

/** A job's state in plain words, including "Done with warnings" and "Stopped by you". */
export function JobStatusPill({ job }: { job: Pick<JobRecord, 'state' | 'paused' | 'error'> }) {
  const { label, tone } = jobStatus(job);
  return (
    <Pill tone={tone}>
      <span className={`pill__dot${job.state === 'running' ? ' pill__dot--pulse' : ''}`} aria-hidden="true" />
      {label}
    </Pill>
  );
}

/** How many backups a file or collection has: No backup, 1 backup, 2+ backups. */
export function CopyCountPill({ backups }: { backups: number }) {
  return (
    <Pill tone={copyCountTone(backups)}>
      <span className="pill__dot" aria-hidden="true" />
      {copyCountLabel(backups)}
    </Pill>
  );
}

const STATUS_ICON_COMPONENTS: Record<StatusIconName, typeof StatusCheckIcon> = {
  check: StatusCheckIcon,
  clock: StatusClockIcon,
  circle: StatusCircleIcon,
  plug: StatusPlugIcon,
  alert: StatusAlertIcon,
};

/**
 * The status of a backup at one destination: one of exactly five (Up to date, Behind, Never backed up, Not connected, Problem).
 * Always a word and an icon, never colour alone; "Not connected" is also drawn with a dashed outline. Shows how old the
 * information is when `updated` is given.
 */
export function StatusPill(props: StatusInfo) {
  const { status } = props;
  const Icon = STATUS_ICON_COMPONENTS[STATUS_ICONS[status]];
  const line = statusLine(props);
  return (
    <span className="status-pill-wrap" title={statusText(props)}>
      <span className={`status-pill status-pill--${STATUS_TONES[status]}${isDashed(status) ? ' status-pill--dashed' : ''}`} data-status={status}>
        <Icon size={14} />
        <b className="status-pill__word">{line.word}</b>
        {line.detail ? <span className="status-pill__detail">{line.detail}</span> : null}
      </span>
      {line.age ? <span className="status-pill__age">{line.age}</span> : null}
    </span>
  );
}
