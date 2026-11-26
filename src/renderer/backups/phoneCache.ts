import type { ConnectedPhones } from '../../shared/phoneBackup';

/**
 * The last answer to "which phone is plugged in", kept while the app runs. Asking adb from cold takes about 5 seconds, so screens show
 * this answer at once and ask again in the background. One question at a time: callers share the answer in flight.
 */
let last: ConnectedPhones | null = null;
let inflight: Promise<ConnectedPhones> | null = null;

/** The last answer, or null when no screen has asked yet. */
export function lastPhones(): ConnectedPhones | null {
  return last;
}

/** Asks again (or joins the question already asked) and remembers the answer. */
export function readPhones(): Promise<ConnectedPhones> {
  if (!inflight) {
    inflight = window.backupHub.phoneBackup
      .connected()
      .then((answer) => {
        last = answer;
        return answer;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Tests only. */
export function forgetPhonesForTests(): void {
  last = null;
  inflight = null;
}
