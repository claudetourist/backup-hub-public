import type { Shutdown } from './lifecycle/shutdown';

/**
 * What happens when the app is asked to quit (also when the last window closes: that calls app.quit()). The quit is held back once,
 * the one shutdown routine runs (lifecycle/shutdown.ts: timers, running jobs, upkeep, workers, the phone, helper processes, and only
 * then the database; hard limit 5 s), and then the quit is asked for again and goes through. A crash, a signal or a Windows log-off
 * reaches the same routine by its own trigger (lifecycle/triggers.ts), so there is only one way out.
 */
export interface QuitFlowDeps {
  shutdown: Pick<Shutdown, 'run'>;
  quitAgain: () => void;
}

export function createBeforeQuit(deps: QuitFlowDeps): (event: { preventDefault(): void }) => void {
  let held = false;
  let done = false;
  return (event) => {
    if (done) return;
    event.preventDefault();
    if (held) return;
    held = true;
    void deps.shutdown
      .run('quit')
      .catch(() => undefined)
      .finally(() => {
        done = true;
        deps.quitAgain();
      });
  };
}
