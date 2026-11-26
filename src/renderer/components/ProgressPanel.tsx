import type { ReactNode } from 'react';
import { PAUSED_SAFE_MESSAGE, PAUSING_MESSAGE } from '../../shared/jobs';
import { Button } from './Button';
import { ProgressBar } from './ProgressBar';
import { amountText, filesAlongside, percentDone, secondsLeft, speedLine, timeLeftText, wholePercent, type ProgressInput } from './progressModel';

interface ProgressPanelProps extends ProgressInput {
  /** What is being done, in plain words ("Copying Poco F4 camera to Seagate"). */
  what: string;
  paused?: boolean;
  /** Paused, but the job is still finishing its file and saving its place: "Pausing: saving your place…" (it is not safe to close the app yet). */
  pausing?: boolean;
  /** Shown right under the bar (for example the file being copied now). */
  detail?: ReactNode;
  /** Stop is being carried out (the buttons wait). */
  stopping?: boolean;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

/** A running job: what it does, how much is done, the speed, the time left, and Pause and Stop (PLAN section 6). */
export function ProgressPanel({ what, detail, paused = false, pausing = false, stopping = false, onPause, onResume, onStop, ...progress }: ProgressPanelProps) {
  const percent = percentDone(progress);
  const left = paused ? (pausing ? PAUSING_MESSAGE : PAUSED_SAFE_MESSAGE) : timeLeftText(secondsLeft(progress));
  const amount = amountText(progress);
  const files = filesAlongside(progress);
  return (
    <section className="progress-panel" aria-label={what}>
      <h2 className="progress-panel__what">{what}</h2>
      <ProgressBar label={what} {...(percent === null ? { indeterminate: true } : { value: percent })} tone={paused ? 'warn' : 'info'} valueText={amount} />
      {detail}
      <dl className="progress-panel__facts">
        <div>
          <dt>Done</dt>
          <dd>
            {amount}
            {percent === null ? '' : `, ${wholePercent(percent)}%`}
            {files === null ? '' : `, ${files}`}
          </dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd>{paused ? (pausing ? 'Pausing' : 'Paused') : speedLine(progress)}</dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd>{left}</dd>
        </div>
      </dl>
      <div className="progress-panel__actions">
        {paused ? (
          <Button variant="primary" disabled={stopping} onClick={onResume}>
            Resume
          </Button>
        ) : (
          <Button disabled={stopping} onClick={onPause}>
            Pause
          </Button>
        )}
        <Button variant="quiet" disabled={stopping} onClick={onStop}>
          {stopping ? 'Stopping...' : 'Stop'}
        </Button>
      </div>
    </section>
  );
}
