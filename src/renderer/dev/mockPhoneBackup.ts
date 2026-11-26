/**
 * Dev only (compiled out of production builds): a pretend phone backup for the Backups screen in a plain browser (`#/backups?mock`).
 * About 230 files (big videos in DCIM/Camera, many small WhatsApp files, some documents), a look that "finishes" after a moment, a copy that
 * advances every 400 ms (two files fail with a reason), a report and the list of copied files. Nothing here touches real data.
 */
import { CARD_FOLDER } from '../../shared/appFolders';
import type { JobChangedEvent, JobRecord } from '../../shared/jobs';
import { createCheckOldMock } from './mockCheckOld';
import { createRulesMock } from './mockRules';
import { PROGRESS_FAILED_LIMIT, PROGRESS_NEXT_LIMIT, PROGRESS_RECENT_LIMIT, type CopiedFiles, type PhoneBackupProgress, type PhoneBackupReport, type PhoneBackupSelection, type PhoneLookResult, type PhonePlanView, type PreviewRow, type ProgressFailed } from '../../shared/phoneBackup';

const LOOK_JOB = 9001;
const COPY_JOB = 9002;
/** How fast the pretend copy goes: bytes per tick (a tick is 400 ms), so a 150 MB video takes about 10 seconds. */
const TICK_MS = 400;
const BYTES_PER_TICK = 6_000_000;

/** Same numbers every time, so a screenshot can be compared with the last one. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return s / 4_294_967_296;
  };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

export function mockPreviewRows(): PreviewRow[] {
  const rnd = lcg(42);
  const between = (lo: number, hi: number): number => Math.round(lo + rnd() * (hi - lo));
  const day = (): { y: number; m: number; d: number; sec: number } => {
    const d = between(1, 22);
    const m = rnd() < 0.5 ? 10 : 11;
    return { y: 2026, m, d, sec: Math.floor(new Date(2026, m - 1, d, between(7, 21), between(0, 59), between(0, 59)).getTime() / 1000) };
  };
  const rows: PreviewRow[] = [];
  const add = (path: string, size: number, sec: number, kind: 'new' | 'changed' = 'new'): void => {
    rows.push({ path, size, mtimeSec: sec, kind });
  };
  for (let i = 0; i < 14; i += 1) {
    const t = day();
    add(`/sdcard/DCIM/Camera/VID_${t.y}${pad(t.m)}${pad(t.d)}_${pad(between(7, 21))}${pad(between(0, 59))}${pad(i)}.mp4`, between(30, 220) * 1_000_000, t.sec);
  }
  for (let i = 0; i < 56; i += 1) {
    const t = day();
    add(`/sdcard/DCIM/Camera/IMG_${t.y}${pad(t.m)}${pad(t.d)}_${pad(between(7, 21))}${pad(between(0, 59))}${pad(i)}.jpg`, between(2_000, 6_500) * 1000, t.sec, i % 19 === 0 ? 'changed' : 'new');
  }
  for (let i = 0; i < 12; i += 1) {
    const t = day();
    add(`/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Video/VID-${t.y}${pad(t.m)}${pad(t.d)}-WA${pad(i, 4)}.mp4`, between(3, 24) * 1_000_000, t.sec);
  }
  for (let i = 0; i < 90; i += 1) {
    const t = day();
    add(`/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-${t.y}${pad(t.m)}${pad(t.d)}-WA${pad(i, 4)}.jpg`, between(25, 320) * 1000, t.sec);
  }
  for (let i = 0; i < 20; i += 1) {
    const t = day();
    add(`/sdcard/Pictures/Screenshots/Screenshot_${t.y}${pad(t.m)}${pad(t.d)}-${pad(between(7, 21))}${pad(between(0, 59))}${pad(i)}.png`, between(300, 1_800) * 1000, t.sec);
  }
  for (let i = 0; i < 18; i += 1) {
    const t = day();
    add(`/sdcard/Documents/${['Invoice', 'Ticket', 'Scan', 'Receipt', 'Report', 'Form'][i % 6]!}_${pad(i + 1)}.pdf`, between(80, 2_400) * 1000, t.sec, i === 3 ? 'changed' : 'new');
  }
  for (let i = 0; i < 12; i += 1) {
    const t = day();
    add(`/sdcard/Download/${['setup', 'photo-export', 'statement', 'bus-pass'][i % 4]!}-${pad(i + 1)}.${i % 3 === 0 ? 'zip' : 'pdf'}`, between(200, 40_000) * 1000, t.sec);
  }
  add('/sdcard/notes.txt', 2_100, day().sec, 'changed');
  add('/sdcard/Voice Recorder/Memo 3.m4a', 4_200_000, day().sec);
  // A Status folder of the ordinary WhatsApp (the saved choice of the mock is about WhatsApp Business), so "Never back up this folder" can be tried.
  for (let i = 0; i < 9; i += 1) {
    const t = day();
    add(`/sdcard/Android/media/com.whatsapp/WhatsApp/Media/.Statuses/${t.y}${pad(t.m)}${pad(t.d)}-status-${pad(i, 3)}.${i % 3 === 0 ? 'mp4' : 'jpg'}`, between(80, 4_000) * 1000, t.sec);
  }
  return rows;
}

const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

interface Sim {
  order: PreviewRow[];
  index: number;
  copiedOfCurrent: number;
  doneIdx: number[];
  failed: ProgressFailed[];
  bytesDone: number;
  bytesTotal: number;
  startedAt: number;
}

export interface PhoneBackupMock {
  /** The mock phone jobs, to add to the job list. */
  jobs(): JobRecord[];
  /** The window's way of hearing about job changes (the real bridge pushes them). */
  subscribe(callback: (event: JobChangedEvent) => void): () => void;
  /** The `phoneBackup.*` and `rules.*` answers. */
  handlers: Record<string, unknown>;
  /** How many choices the pretend backup has (for the Backups list). */
  choices(): number;
  /** The job list the other mocks (the second drive) put their jobs into. */
  env: { put: (job: JobRecord, reason?: JobChangedEvent['reason']) => void; baseJob: (id: number, kind: string, title: string) => JobRecord; jobOf: (id: number) => JobRecord | undefined };
}

export function createPhoneBackupMock(): PhoneBackupMock {
  const rows = mockPreviewRows();
  const rulesMock = createRulesMock(() => rows);
  const listeners = new Set<(event: JobChangedEvent) => void>();
  const jobs = new Map<number, JobRecord>();
  let sim: Sim | null = null;
  let report: PhoneBackupReport | null = null;
  let copied: CopiedFiles | null = null;
  let timer: number | undefined;

  const baseJob = (id: number, kind: string, title: string): JobRecord => ({
    id, kind, title, state: 'running', progressDone: 0, progressTotal: 0, bytesDone: 0, bytesTotal: 0, message: null, warnings: [], error: null,
    createdAt: Date.now(), startedAt: Date.now(), finishedAt: null, hasCheckpoint: false, speed: null, etaSeconds: null, paused: false, choices: [],
  });
  const put = (job: JobRecord, reason: JobChangedEvent['reason'] = 'progress'): void => {
    jobs.set(job.id, job);
    for (const l of listeners) l({ reason, job });
  };

  const plan = (): PhonePlanView => ({
    planId: 'mock-plan',
    hash: 'mock-hash',
    backupId: 1,
    backupName: 'Poco F4',
    phoneName: 'Poco F4',
    driveLabel: 'T7',
    folderWords: 'MyData\\POCO\\POCO-23Nov26',
    rows,
    totals: { files: rows.length, bytes: rows.reduce((s, r) => s + r.size, 0) },
    confirmedOnDrive: 12,
    notConfirmed: 0,
    alreadyBackedUp: 18_204,
    leftOut: [
      ...rulesMock.groups(),
      { key: 'cache:DCIM/.thumbnails', filter: 'cache_folder', folder: '/sdcard/DCIM/.thumbnails', files: 1_204, bytes: 310_000_000, canInclude: true },
      { key: 'tmp:Download', filter: 'temporary_file', folder: '/sdcard/Download', files: 7, bytes: 1_400_000, canInclude: true },
    ],
    notes: [],
    freeBytes: 300_000_000_000,
    blocked: null,
  });

  const progress = (jobId: number): PhoneBackupProgress | null => {
    if (jobId !== COPY_JOB || sim === null) return null;
    const finished = jobs.get(COPY_JOB)?.state !== 'running';
    const copying = !finished && sim.index < sim.order.length;
    const first = copying ? sim.index + 1 : sim.index;
    const file = (r: PreviewRow) => ({ path: r.path, size: r.size });
    return {
      jobId,
      total: sim.order.length,
      done: sim.doneIdx.length,
      waiting: Math.max(0, sim.order.length - first),
      failedCount: sim.failed.length,
      current: copying ? file(sim.order[sim.index]!) : null,
      next: sim.order.slice(first, first + PROGRESS_NEXT_LIMIT).map(file),
      recent: sim.doneIdx.slice(-PROGRESS_RECENT_LIMIT).toReversed().map((i) => file(sim!.order[i]!)),
      failed: sim.failed.slice(-PROGRESS_FAILED_LIMIT).toReversed(),
      finished,
    };
  };

  const tick = (): void => {
    const s = sim;
    if (s === null) return;
    const job = jobs.get(COPY_JOB)!;
    if (job.state !== 'running') return;
    let budget = BYTES_PER_TICK;
    while (budget > 0 && s.index < s.order.length) {
      const row = s.order[s.index]!;
      const need = row.size - s.copiedOfCurrent;
      const take = Math.min(need, budget);
      s.copiedOfCurrent += take;
      s.bytesDone += take;
      budget -= take;
      if (s.copiedOfCurrent >= row.size) {
        if (/WA0007\.jpg$|statement-03\.pdf$/.test(row.path)) s.failed.push({ path: row.path, size: row.size, reason: "The copy did not match the phone's checksum." });
        else s.doneIdx.push(s.index);
        s.index += 1;
        s.copiedOfCurrent = 0;
      }
    }
    const left = s.bytesTotal - s.bytesDone;
    const perSecond = Math.round((BYTES_PER_TICK * 1000) / TICK_MS);
    if (s.index >= s.order.length) {
      window.clearInterval(timer);
      const copiedRows = s.doneIdx.map((i) => s.order[i]!);
      report = {
        jobId: COPY_JOB, runId: 77, backupName: 'Poco F4', phoneName: 'Poco F4', startedAt: s.startedAt, finishedAt: Date.now(),
        copied: { files: copiedRows.length, bytes: copiedRows.reduce((t, r) => t + r.size, 0) }, linked: 12, skipped: [],
        failed: s.failed.length > 0 ? [{ reason: "The copy did not match the phone's checksum.", count: s.failed.length, examples: s.failed.map((f) => f.path) }] : [],
        leftOut: { files: 1_211, bytes: 311_400_000 }, where: ['T7: MyData\\POCO\\POCO-23Nov26'], notCovered: [], listPath: `T7:\\${CARD_FOLDER}\\lists\\Poco F4\\2026-11-23.csv`, listProblem: null,
      };
      copied = { files: copiedRows.map((r) => ({ path: r.path, size: r.size, mtimeMs: r.mtimeSec * 1000 })), total: copiedRows.length };
      put({ ...job, state: s.failed.length > 0 ? 'done_warnings' : 'done', progressDone: s.order.length, bytesDone: s.bytesTotal, finishedAt: Date.now(), speed: null, etaSeconds: null, message: 'Copied and checked' }, 'state');
      return;
    }
    put({ ...job, progressDone: s.index, progressTotal: s.order.length, bytesDone: s.bytesDone, bytesTotal: s.bytesTotal, message: `Copying ${nameOf(s.order[s.index]!.path)} (${s.index + 1} of ${s.order.length})`, speed: { unit: 'bytes', perSecond, itemsPerSecond: 1 }, etaSeconds: Math.ceil(left / perSecond) });
  };

  const handlers: Record<string, unknown> = {
    'phoneBackup.look': () => {
      const job = baseJob(LOOK_JOB, 'phone.look', 'Look at the phone: Poco F4');
      job.message = 'Reading the names of every file on the phone. This can take a few minutes.';
      put(job, 'created');
      window.setTimeout(() => put({ ...job, state: 'done', finishedAt: Date.now(), message: `${rows.length} files are ready to copy. Nothing was copied.` }, 'state'), 700);
      return Promise.resolve({ ok: true, message: '', jobId: LOOK_JOB });
    },
    'phoneBackup.preview': (jobId: number): Promise<PhoneLookResult | null> => Promise.resolve(jobId === LOOK_JOB && jobs.get(LOOK_JOB)?.state === 'done' ? { ok: true, plan: plan() } : null),
    'phoneBackup.start': (selection: PhoneBackupSelection) => {
      const out = new Set(selection.unticked);
      const order = rows.filter((r) => !out.has(r.path)).toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      if (order.length === 0) return Promise.resolve({ ok: false, message: 'Nothing is ticked. Nothing was copied.', jobId: null });
      window.clearInterval(timer);
      report = null;
      copied = null;
      const bytesTotal = order.reduce((s, r) => s + r.size, 0);
      sim = { order, index: 0, copiedOfCurrent: 0, doneIdx: [], failed: [], bytesDone: 0, bytesTotal, startedAt: Date.now() };
      put({ ...baseJob(COPY_JOB, 'phone.backup', `Back up Poco F4 now (${order.length} files)`), progressTotal: order.length, bytesTotal, message: 'Starting' }, 'created');
      timer = window.setInterval(tick, TICK_MS);
      return Promise.resolve({ ok: true, message: '', jobId: COPY_JOB });
    },
    'phoneBackup.progress': (jobId: number) => Promise.resolve(progress(jobId)),
    'phoneBackup.report': (jobId: number) => Promise.resolve(jobId === COPY_JOB ? report : null),
    'phoneBackup.copied': (jobId: number) => Promise.resolve(jobId === COPY_JOB ? copied : null),
    // "Check old copies": the numbers, the preview, a check that advances, a report (see mockCheckOld.ts).
    ...createCheckOldMock({ put, baseJob }).handlers,
    // "Your choices" and the things no backup can copy (see mockRules.ts).
    ...rulesMock.handlers,
  };

  return {
    jobs: () => [...jobs.values()],
    subscribe: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    handlers,
    choices: () => rulesMock.count(),
    env: { put, baseJob, jobOf: (id) => jobs.get(id) },
  };
}
