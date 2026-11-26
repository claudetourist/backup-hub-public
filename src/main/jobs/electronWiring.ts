import { Notification, powerMonitor, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc';
import { KIND_DEMO, KIND_DEMO_HEAVY } from './builtinJobs';
import type { JobService, JobServiceLogger } from './jobService';
import { NOTIFICATIONS_ENABLED, toastFor } from './notifications';
import type { SecureIpc } from '../ipc/secureIpc';
import type { ArgsOf, InvokeChannel } from '../ipc/schemas';

export interface WiringOptions {
  /** The only way to register a handler: checks the sender and the arguments of every call (see ipc/secureIpc.ts). */
  secure: SecureIpc;
  /** Resolves once the database is open and the service exists; IPC waits for it. */
  ready: Promise<JobService>;
  getWindow: () => BrowserWindow | null;
  log: JobServiceLogger;
  /** Dev builds register the demo-job channel. */
  dev: boolean;
  /** A fixed value, or a function evaluated for every toast (so a Settings switch takes effect at once). */
  notificationsEnabled?: boolean | (() => boolean);
}

/** Jobs IPC handlers, the change-event push to the window, toasts and sleep/wake handling. */
export function wireJobs(options: WiringOptions): void {
  const { secure, ready, getWindow, log, dev } = options;
  const notifySetting = options.notificationsEnabled ?? NOTIFICATIONS_ENABLED;
  const notify = (): boolean => (typeof notifySetting === 'function' ? notifySetting() : notifySetting);

  const handle = <C extends InvokeChannel>(channel: C, fn: (service: JobService, ...args: ArgsOf<C>) => unknown): void => {
    secure.handle(channel, async (...args: ArgsOf<C>) => fn(await ready, ...args));
  };

  handle(IPC.jobsList, (s, filter) => s.list({ ...(filter?.states !== undefined ? { states: filter.states } : {}), ...(filter?.limit !== undefined ? { limit: filter.limit } : {}) }));
  handle(IPC.jobsGet, (s, id) => s.get(id));
  handle(IPC.jobsEvents, (s, id) => s.events(id));
  handle(IPC.jobsRetry, (s, id) => s.retry(id));
  handle(IPC.jobsCancel, (s, id) => s.cancel(id));
  handle(IPC.jobsPause, (s, id) => s.pause(id));
  handle(IPC.jobsResume, (s, id) => s.resume(id));
  handle(IPC.jobsResolve, (s, id, answer) => s.resolve(id, answer));
  handle(IPC.jobsContinue, (s, id) => s.continueInterrupted(id));
  handle(IPC.jobsDismiss, (s, id) => s.dismissInterrupted(id));
  if (dev) {
    handle(IPC.jobsCreateDemo, (s, raw) => {
      const o = raw ?? {};
      return s.create(o.heavy ? KIND_DEMO_HEAVY : KIND_DEMO, `Demo job (${o.mode ?? 'ok'})`, o);
    });
  }

  void (async () => {
    const service = await ready;
    service.onChanged((event) => {
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('jobs:changed', event);
      if (!notify()) return;
      const toast = toastFor(event);
      if (!toast || !Notification.isSupported()) return;
      const n = new Notification({ title: toast.title, body: toast.body });
      n.on('click', () => {
        const w = getWindow();
        if (!w || w.isDestroyed()) return;
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
        w.webContents.send('app:navigate', { screen: 'jobs' });
      });
      n.show();
    });
    powerMonitor.on('suspend', () => {
      log.info('jobs: laptop is going to sleep; pausing the runner');
      service.suspend();
    });
    powerMonitor.on('resume', () => {
      log.info('jobs: laptop woke up; continuing');
      service.resumeAfterSleep();
    });
  })().catch((err: unknown) => log.error('jobs wiring failed', err));
}
