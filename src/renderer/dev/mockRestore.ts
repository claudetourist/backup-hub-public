/**
 * Dev only (compiled out of production builds): "Get files back" in a plain browser (`#/backups/1/restore?mock`). The Poco F4 has four days on the pretend T7 (the Seagate2TB is
 * not plugged in), a small folder tree, one file that was never checked (it cannot come back), a list (files, size, where from, where to, 12 files would be downloaded from
 * Google), a copy that advances every 400 ms, and a report. Nothing here touches real data.
 */
import type { JobChangedEvent, JobRecord } from '../../shared/jobs';
import type { RestoreBrowseRequest, RestoreBrowseResult, RestoreDatesResult, RestoreEntry, RestoreInfoResult, RestorePlanRequest, RestorePlanResult, RestoreStartResult } from '../../shared/restore';

const RESTORE_JOB = 9105;
const TICK_MS = 400;
const DAY_MS = 86_400_000;
/** Local noon of 23 Nov 2026 and the days before it. */
const DAYS = [0, 7, 15, 30].map((back) => ({ folder: 'Poco-F4-' + new Date(Date.UTC(2026, 10, 23) - back * DAY_MS).toISOString().slice(8, 10) + ['Nov', 'Nov', 'Nov', 'Oct'][[0, 7, 15, 30].indexOf(back)] + '26', at: Date.UTC(2026, 10, 23, 12) - back * DAY_MS }));

const file = (name: string, bytes: number, held = 0): RestoreEntry => ({ name, folder: false, files: 1, bytes, mtime: Date.UTC(2026, 10, 20), held });
const folder = (name: string, files: number, bytes: number, held = 0): RestoreEntry => ({ name, folder: true, files, bytes, mtime: Date.UTC(2026, 10, 21), held });

const TREE: Record<string, RestoreEntry[]> = {
  '': [folder('DCIM', 2_410, 9_800_000_000), folder('Download', 38, 410_000_000, 1), folder('WhatsApp', 9_300, 6_100_000_000), file('notes.txt', 12_400)],
  DCIM: [folder('Camera', 2_380, 9_700_000_000), folder('Screenshots', 30, 100_000_000)],
  'DCIM/Camera': Array.from({ length: 40 }, (_v, i) => file('IMG_' + String(20_260_000 + i * 37) + '.jpg', 3_200_000 + i * 51_000)),
  'DCIM/Screenshots': Array.from({ length: 12 }, (_v, i) => file('Screenshot_' + String(i + 1).padStart(3, '0') + '.png', 480_000 + i * 12_000)),
  Download: [file('statement-03.pdf', 1_900_000, 1), file('ticket.pdf', 220_000), file('manual.pdf', 4_100_000)],
  WhatsApp: [folder('Media', 9_290, 6_090_000_000), file('chat.db.crypt14', 9_800_000)],
  'WhatsApp/Media': Array.from({ length: 25 }, (_v, i) => file('IMG-20261101-WA' + String(i).padStart(4, '0') + '.jpg', 150_000 + i * 9_000)),
};

export interface RestoreMock {
  handlers: Record<string, unknown>;
}

export function createRestoreMock(env: { put: (job: JobRecord, reason?: JobChangedEvent['reason']) => void; baseJob: (id: number, kind: string, title: string) => JobRecord; jobOf: (id: number) => JobRecord | undefined }): RestoreMock {
  let timer: number | undefined;
  let plan: { files: number; bytes: number; folderName: string } | null = null;

  const info = (backupId: number): RestoreInfoResult =>
    backupId === 1 || backupId === 2 || backupId === 3
      ? {
          ok: true,
          backupName: backupId === 1 ? 'Poco F4' : backupId === 2 ? 'OneDrive Local Backup' : 'IMP folder',
          layout: 'dated',
          sources: [
            { placeId: 'sample-t7', label: 'T7', connected: true },
            { placeId: 'sample-seagate', label: 'Seagate2TB', connected: false },
          ],
          from: { placeId: 'sample-t7', label: 'T7', connected: true },
          originalWords: backupId === 1 ? null : 'C:\\Users\\sample\\OneDrive',
          defaultParent: 'D:\\Restored',
          message: null,
        }
      : { ok: false, message: 'This backup is not on the list.' };

  const browse = (r: RestoreBrowseRequest): RestoreBrowseResult => ({ ok: true, entries: TREE[r.path] ?? [], moreFiles: 0 });

  const makePlan = (r: RestorePlanRequest): RestorePlanResult => {
    const pick = r.pick;
    const files = pick.kind === 'files' ? pick.fileIds.length : pick.kind === 'newest' ? 18_204 : pick.items.length === 0 ? 2_410 : pick.items.length * 12;
    const bytes = files * 3_900_000;
    plan = { files, bytes, folderName: 'Poco F4-2026-11-26' };
    const to = r.destination.mode === 'original' ? 'Back to where they were' : (r.destination.parent ?? 'D:\\Restored') + '\\' + plan.folderName;
    return {
      ok: true,
      plan: {
        planId: 'mock-restore-plan',
        files,
        bytes,
        fromWords: 'T7 and Google',
        fromGoogle: Math.min(12, files),
        toWords: to,
        held: { count: 1, examples: [{ path: 'Download/statement-03.pdf', why: 'This copy was never checked, so Backup Hub cannot prove it is whole.' }] },
        notAvailable: 0,
        freeBytes: 640_000_000_000,
      },
    };
  };

  let done = 0;
  const tick = (): void => {
    const job = env.jobOf(RESTORE_JOB);
    if (!plan || !job || job.state !== 'running') return;
    const step = Math.max(1, Math.round(plan.files / 20));
    done = Math.min(plan.files, done + step);
    if (done >= plan.files) {
      window.clearInterval(timer);
      env.put(
        { ...job, state: 'done_warnings', progressDone: plan.files, progressTotal: plan.files, bytesDone: plan.bytes, bytesTotal: plan.bytes, finishedAt: Date.now(), speed: null, etaSeconds: null, message: 'Got back ' + plan.files.toLocaleString('en-US') + ' files (' + (plan.bytes / 1e9).toFixed(1) + ' GB), 12 from Google. 1 file not brought back (1 never checked). Put in D:\\Restored\\' + plan.folderName + '. Nothing was overwritten or deleted.', warnings: ['Download/statement-03.pdf: This copy was never checked, so Backup Hub cannot prove it is whole. It was not brought back.'] },
        'state',
      );
      return;
    }
    env.put({ ...job, progressDone: done, progressTotal: plan.files, bytesDone: Math.round((plan.bytes * done) / plan.files), bytesTotal: plan.bytes, message: 'Getting back IMG_' + String(20_260_000 + done) + '.jpg (' + done + ' of ' + plan.files + ')', speed: { unit: 'bytes', perSecond: 40_000_000, itemsPerSecond: 9 }, etaSeconds: Math.ceil(((plan.files - done) / step) * (TICK_MS / 1000)) });
  };

  const handlers: Record<string, unknown> = {
    'restore.info': (backupId: number) => Promise.resolve(info(backupId)),
    'restore.dates': (): Promise<RestoreDatesResult> => new Promise((resolve) => window.setTimeout(() => resolve({ ok: true, dates: DAYS }), 500)),
    'restore.browse': (r: RestoreBrowseRequest) => new Promise((resolve) => window.setTimeout(() => resolve(browse(r)), 350)),
    'restore.plan': (r: RestorePlanRequest) => new Promise((resolve) => window.setTimeout(() => resolve(makePlan(r)), 600)),
    'restore.start': (): Promise<RestoreStartResult> => {
      if (!plan) return Promise.resolve({ ok: false, message: 'That list is gone. Make the list again. Nothing was copied.' });
      window.clearInterval(timer);
      done = 0;
      env.put({ ...env.baseJob(RESTORE_JOB, 'restore.files', 'Get files back'), progressTotal: plan.files, bytesTotal: plan.bytes, message: 'Starting' }, 'created');
      timer = window.setInterval(tick, TICK_MS);
      return Promise.resolve({ ok: true, jobId: RESTORE_JOB });
    },
    'restore.chooseFolder': () => Promise.resolve({ ok: false, canceled: true, message: 'This is a sample screen.' }),
  };
  return { handlers };
}
