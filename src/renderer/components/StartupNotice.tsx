import type { StartupStatus } from '../../shared/startup';
import { startupView } from '../startupModel';
import { ProgressBar } from './ProgressBar';

/** Shown instead of the screens while the data is not ready: what is happening, in plain words, and how far it is. */
export function StartupNotice({ status }: { status: StartupStatus | null }) {
  const view = startupView(status);
  return (
    <section className="opening" role="status" aria-live="polite" aria-label={view.title}>
      <h2 className="opening__title">{view.title}</h2>
      {view.detail ? <p className="opening__detail">{view.detail}</p> : null}
      {status !== null && status.phase !== 'opening' ? (
        <>
          <ProgressBar label={view.title} {...(view.percent === null ? { indeterminate: true } : { value: view.percent })} />
          {view.progressText ? <p className="opening__progress">{view.progressText}</p> : null}
        </>
      ) : null}
    </section>
  );
}
