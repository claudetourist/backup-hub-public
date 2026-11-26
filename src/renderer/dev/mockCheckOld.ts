/**
 * Dev only (compiled out of production builds): the pretend "Check old copies" for the Backups screen in a plain browser
 * (`#/backups?mock`): a Poco F4 with 33,721 files, 12,345 of them with a checked copy on the T7, a few folders with copies never checked,
 * a check that advances every 400 ms, and a report with two files that differ and one missing on the drive. Nothing here touches real data.
 */
import type { JobChangedEvent, JobRecord } from '../../shared/jobs';
import { PHONE_CHECK_OLD_JOB_KIND, type CheckOldCounts, type CheckOldCountsResult, type CheckOldFolderCounts, type CheckOldPlanResult, type CheckOldReport, type CheckOldRequest } from '../../shared/phoneBackup';

export const CHECK_JOB = 9003;
const TICK_MS = 400;
const TICKS = 14;

const bucket = (files: number, gb: number): { files: number; bytes: number } => ({ files, bytes: Math.round(gb * 1e9) });

/** [folder, files on phone, checked, not checked yet, no copy, left out] with sizes in GB for each part. */
const FOLDERS: { folder: string; checked: [number, number]; unchecked: [number, number]; noCopy: [number, number]; leftOut: [number, number] }[] = [
  { folder: 'DCIM/Camera', checked: [4_200, 21.4], unchecked: [11_600, 54.1], noCopy: [180, 1.9], leftOut: [0, 0] },
  { folder: 'Android/media', checked: [5_845, 6.1], unchecked: [6_500, 9.4], noCopy: [820, 0.6], leftOut: [12, 0.01] },
  { folder: 'Pictures/Screenshots', checked: [1_100, 0.9], unchecked: [1_900, 1.6], noCopy: [60, 0.05], leftOut: [0, 0] },
  { folder: 'Download', checked: [600, 2.2], unchecked: [0, 0], noCopy: [140, 0.8], leftOut: [64, 0.3] },
  { folder: 'Documents', checked: [600, 0.4], unchecked: [0, 0], noCopy: [100, 0.1], leftOut: [0, 0] },
];

const sum = (parts: { files: number; bytes: number }[]): { files: number; bytes: number } => parts.reduce((a, p) => ({ files: a.files + p.files, bytes: a.bytes + p.bytes }), { files: 0, bytes: 0 });

export interface CheckOldMock {
  handlers: Record<string, unknown>;
}

export function createCheckOldMock(env: { put: (job: JobRecord, reason?: JobChangedEvent['reason']) => void; baseJob: (id: number, kind: string, title: string) => JobRecord }): CheckOldMock {
  let checkedFolders: string[] = [];
  let finished = false;
  let report: CheckOldReport | null = null;
  let timer: number | undefined;
  let tick = 0;

  const folderCounts = (): CheckOldFolderCounts[] =>
    FOLDERS.map((f) => {
      const done = finished && checkedFolders.includes(f.folder);
      const checked = done ? bucket(f.checked[0] + f.unchecked[0] - (f.folder === 'DCIM/Camera' ? 3 : 0), f.checked[1] + f.unchecked[1]) : bucket(...f.checked);
      const unchecked = done ? bucket(0, 0) : bucket(...f.unchecked);
      const noCopy = done && f.folder === 'DCIM/Camera' ? bucket(f.noCopy[0] + 3, f.noCopy[1] + 0.2) : bucket(...f.noCopy);
      const leftOut = bucket(...f.leftOut);
      return { folder: f.folder, onPhone: sum([checked, unchecked, noCopy, leftOut]), checked, unchecked, noCopy, leftOut };
    });

  const counts = (): CheckOldCountsResult => {
    const folders = folderCounts();
    const pick = (key: keyof CheckOldCounts): { files: number; bytes: number } => sum(folders.map((f) => f[key]));
    return { ok: true, backupId: 1, driveLabel: 'T7', lookedAt: Date.now() - 3_600_000, total: { onPhone: pick('onPhone'), checked: pick('checked'), unchecked: pick('unchecked'), noCopy: pick('noCopy'), leftOut: pick('leftOut') }, folders };
  };

  const plan = (): CheckOldPlanResult => {
    const folders = folderCounts().filter((f) => f.unchecked.files > 0).map((f) => ({ folder: f.folder, files: f.unchecked.files, bytes: f.unchecked.bytes })).toSorted((a, b) => b.bytes - a.bytes);
    if (folders.length === 0) return { ok: false, message: 'Every copy of this phone\'s files on T7 has been checked already. Nothing to do.' };
    return { ok: true, backupId: 1, phoneName: 'Poco F4', driveLabel: 'T7', folders, totals: sum(folders) };
  };

  const finish = (asked: number, bytes: number, startedAt: number): void => {
    window.clearInterval(timer);
    finished = true;
    report = {
      jobId: CHECK_JOB, backupName: 'Poco F4', phoneName: 'Poco F4', driveLabel: 'T7', startedAt, finishedAt: Date.now(), asked,
      verified: { files: asked - 6, bytes: Math.round(bytes * 0.99) },
      differ: [{ path: '/sdcard/DCIM/Camera/VID_20240312_181102.mp4', size: 148_000_000 }, { path: '/sdcard/DCIM/Camera/IMG_20240312_181530.jpg', size: 4_200_000 }],
      differCount: 2,
      missing: [{ path: '/sdcard/DCIM/Camera/IMG_20240301_090011.jpg', size: 3_900_000 }],
      missingCount: 1,
      noLongerOnPhone: 2,
      couldNotRead: [{ reason: 'The phone did not give a checksum for this file.', count: 1, examples: ['/sdcard/DCIM/Camera/IMG_20240305_120000.jpg'] }],
    };
    env.put({ ...env.baseJob(CHECK_JOB, PHONE_CHECK_OLD_JOB_KIND, 'Check old copies: Poco F4'), state: 'done_warnings', progressDone: asked, progressTotal: asked, bytesDone: bytes, bytesTotal: bytes, finishedAt: Date.now(), message: 'Checked' }, 'state');
  };

  const handlers: Record<string, unknown> = {
    'phoneBackup.checkOldCounts': () => Promise.resolve(counts()),
    'phoneBackup.checkOldPlan': () => Promise.resolve(plan()),
    'phoneBackup.checkOldStart': (request: CheckOldRequest) => {
      const chosen = folderCounts().filter((f) => request.folders.includes(f.folder) && f.unchecked.files > 0);
      const asked = chosen.reduce((s, f) => s + f.unchecked.files, 0);
      const bytes = chosen.reduce((s, f) => s + f.unchecked.bytes, 0);
      if (asked === 0) return Promise.resolve({ ok: false, message: 'No old copies are left to check in the ticked folders. Nothing was checked.', jobId: null });
      checkedFolders = chosen.map((f) => f.folder);
      finished = false;
      report = null;
      tick = 0;
      window.clearInterval(timer);
      const startedAt = Date.now();
      const title = `Check old copies: Poco F4 (${asked.toLocaleString('en-US')} files)`;
      env.put({ ...env.baseJob(CHECK_JOB, PHONE_CHECK_OLD_JOB_KIND, title), progressTotal: asked, bytesTotal: bytes, message: 'Starting' }, 'created');
      timer = window.setInterval(() => {
        tick += 1;
        if (tick >= TICKS) return finish(asked, bytes, startedAt);
        const done = Math.floor((asked * tick) / TICKS);
        const folder = chosen[Math.min(chosen.length - 1, Math.floor((tick / TICKS) * chosen.length))]!.folder;
        const bytesDone = Math.floor((bytes * tick) / TICKS);
        env.put({ ...env.baseJob(CHECK_JOB, PHONE_CHECK_OLD_JOB_KIND, title), progressDone: done, progressTotal: asked, bytesDone, bytesTotal: bytes, message: `Checked ${done.toLocaleString('en-US')} of ${asked.toLocaleString('en-US')} (${(bytesDone / 1e9).toFixed(1)} of ${(bytes / 1e9).toFixed(1)} GB). Now: ${folder}`, speed: { unit: 'bytes', perSecond: Math.round(bytes / TICKS / (TICK_MS / 1000)), itemsPerSecond: 1 } });
      }, TICK_MS);
      return Promise.resolve({ ok: true, message: '', jobId: CHECK_JOB });
    },
    'phoneBackup.checkOldReport': (jobId: number) => Promise.resolve(jobId === CHECK_JOB ? report : null),
  };
  return { handlers };
}
