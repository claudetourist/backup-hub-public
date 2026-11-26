import fs from 'node:fs';
import path from 'node:path';
import { Session } from 'node:inspector';

/**
 * Diagnosis only: when BACKUPHUB_PROFILE is set (seconds, e.g. 90), records where the main process spends its time for that long
 * and writes `main-<time>.cpuprofile` into the logs folder. Off unless asked; nothing leaves the laptop.
 */
export function profileOnceIfAsked(logsDir: string, log: (line: string) => void): void {
  const seconds = Number(process.env['BACKUPHUB_PROFILE'] ?? '');
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const session = new Session();
  session.connect();
  session.post('Profiler.enable', () => {
    session.post('Profiler.setSamplingInterval', { interval: 1000 }, () => {
      session.post('Profiler.start', () => {
        log(`profile: recording the main process for ${seconds} s`);
        setTimeout(() => {
          session.post('Profiler.stop', (err, result) => {
            if (err || !result) {
              log(`profile: could not stop (${err?.message ?? 'no result'})`);
            } else {
              const file = path.join(logsDir, `main-${Date.now()}.cpuprofile`);
              fs.writeFileSync(file, JSON.stringify(result.profile));
              log(`profile: written to ${file}`);
            }
            session.disconnect();
          });
        }, seconds * 1000).unref();
      });
    });
  });
}
