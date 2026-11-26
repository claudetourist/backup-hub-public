/**
 * Dev only (compiled out of production builds): pretend folder backups for the Backups screen in a plain browser (`#/backups?mock`). "OneDrive Local Backup"
 * (about 160 new or changed files, 412 OneDrive files that are online only, 61,204 already backed up, one saved exclusion) and, after the person presses
 * "Add Google Keep notes backup", "Google Keep notes (keep-sync)" (three snapshot files, copied flat). The look "finishes" after a moment, the copy advances
 * every 400 ms (two files are in use and are skipped), and there is a report and a list of copied files. Nothing here touches real data.
 */
import { CARD_FOLDER, KEEP_SYNC_PARTS } from '../../shared/appFolders';
import type { JobChangedEvent, JobRecord } from '../../shared/jobs';
import type { BackupRow } from '../../shared/backups';
import { PROGRESS_FAILED_LIMIT, PROGRESS_NEXT_LIMIT, PROGRESS_RECENT_LIMIT, type PreviewRow, type ProgressFailed } from '../../shared/phoneBackup';
import { IN_USE_REASON, KEEP_SYNC_NAME, ONLINE_ONLY_REASON, type FolderBackupCards, type FolderBackupProgress, type FolderBackupReport, type FolderBackupSelection, type FolderCopiedFiles, type FolderLookResult, type FolderPlanView } from '../../shared/folderBackup';
import { draftCovers, ruleWords, storedPattern, type RuleAddRequest, type RuleEffectRequest, type RuleRemoveRequest, type RuleView } from '../../shared/rules';

export const ONEDRIVE_ID = 2;
export const KEEP_ID = 5;
const LOOK_BASE = 9101;
const COPY_BASE = 9111;
const TICK_MS = 400;
/** The pretend copy is fast (the OneDrive list is 7.8 GB): about 20 seconds in all. */
const BYTES_PER_TICK = 200_000_000;

interface Env {
  put: (job: JobRecord, reason?: JobChangedEvent['reason']) => void;
  baseJob: (id: number, kind: string, title: string) => JobRecord;
  jobOf: (id: number) => JobRecord | undefined;
}

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return s / 4_294_967_296;
  };
}
const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** About 160 files of a OneDrive folder, big and small, new and changed. Same numbers every time. */
export function mockOneDriveRows(): PreviewRow[] {
  const rnd = lcg(7);
  const between = (lo: number, hi: number): number => Math.round(lo + rnd() * (hi - lo));
  const sec = (): number => Math.floor(new Date(2026, between(9, 10), between(1, 24), between(7, 21), between(0, 59)).getTime() / 1000);
  const rows: PreviewRow[] = [];
  const add = (path: string, size: number, kind: 'new' | 'changed' = 'new'): void => void rows.push({ path: `/source/${path}`, size, mtimeSec: sec(), kind });
  for (let i = 0; i < 9; i += 1) add(`Videos/Trip ${['Goa', 'Pune', 'Delhi'][i % 3]!} ${pad(i + 1)}.mp4`, between(80, 900) * 1_000_000);
  for (let i = 0; i < 70; i += 1) add(`Pictures/2026/IMG_${pad(between(1, 28))}${pad(between(1, 12))}_${pad(i, 4)}.jpg`, between(1_500, 6_000) * 1000, i % 17 === 0 ? 'changed' : 'new');
  for (let i = 0; i < 40; i += 1) add(`Documents/${['Taxes', 'Insurance', 'Bills', 'School'][i % 4]!}/${['Invoice', 'Statement', 'Form', 'Scan'][i % 4]!} ${pad(i + 1)}.pdf`, between(60, 4_000) * 1000, i % 11 === 0 ? 'changed' : 'new');
  for (let i = 0; i < 22; i += 1) add(`Desktop/notes-${pad(i + 1)}.docx`, between(20, 600) * 1000, i % 5 === 0 ? 'changed' : 'new');
  add('Mail/Outlook/archive.pst', 2_300_000_000, 'changed');
  add('Mail/Outlook/old-mail.pst', 780_000_000, 'changed');
  for (let i = 0; i < 12; i += 1) add(`Games/Saves/slot-${pad(i + 1)}.sav`, between(40, 900) * 1000);
  return rows;
}

const KEEP_ROWS: PreviewRow[] = [
  { path: '/source/keep-20261123-093000.jsonl.gz', size: 5_212_000, mtimeSec: Math.floor(Date.UTC(2026, 10, 23, 9, 30) / 1000), kind: 'new' },
  { path: '/source/keep-20261124-093000.jsonl.gz', size: 5_219_000, mtimeSec: Math.floor(Date.UTC(2026, 10, 24, 9, 30) / 1000), kind: 'new' },
  { path: '/source/keep-20261125-093000.jsonl.gz', size: 5_231_000, mtimeSec: Math.floor(Date.UTC(2026, 10, 25, 9, 30) / 1000), kind: 'new' },
];

interface Sim {
  order: PreviewRow[];
  index: number;
  copiedOfCurrent: number;
  doneIdx: number[];
  failed: ProgressFailed[];
  inUse: ProgressFailed[];
  bytesDone: number;
  bytesTotal: number;
  startedAt: number;
}

export interface FolderBackupMock {
  handlers: Record<string, unknown>;
  /** The backups the pretend list adds (the Google Keep notes, once added). */
  extraRows(): BackupRow[];
  /** How many exclusions the OneDrive backup has (for the Backups list). */
  choices(): number;
}

export function createFolderBackupMock(env: Env, phoneRules: Record<string, unknown>): FolderBackupMock {
  const rows = mockOneDriveRows();
  let keepAdded = false;
  const saved: RuleView[] = [{ id: 101, scope: 'folder', choice: 'leave_out', pattern: '/source/Games', words: ruleWords({ scope: 'folder', pattern: '/source/Games', choice: 'leave_out' }), createdAt: Date.UTC(2026, 10, 21, 9), everyBackup: false }];
  let nextRule = 102;
  const sims = new Map<number, Sim>();
  const reports = new Map<number, FolderBackupReport>();
  const copied = new Map<number, FolderCopiedFiles>();
  const timers = new Map<number, number>();
  const rowsOf = (backupId: number): PreviewRow[] => (backupId === KEEP_ID ? KEEP_ROWS : rows);
  const nameOfBackup = (id: number): string => (id === KEEP_ID ? KEEP_SYNC_NAME : 'OneDrive Local Backup');

  const plan = (backupId: number): FolderPlanView => {
    const keep = backupId === KEEP_ID;
    const live = rowsOf(backupId).filter((r) => backupId === KEEP_ID || !saved.some((s) => s.choice === 'leave_out' && draftCovers(s, r.path)));
    const left = backupId === KEEP_ID ? [] : rowsOf(backupId).filter((r) => saved.some((s) => s.choice === 'leave_out' && draftCovers(s, r.path)));
    return {
      planId: `mock-folder-plan-${backupId}`,
      hash: 'mock-folder-hash',
      backupId,
      backupName: nameOfBackup(backupId),
      sourceWords: keep ? 'the keep-sync snapshots' : 'C:\\Users\\you\\OneDrive',
      driveLabel: 'T7',
      folderWords: keep ? KEEP_SYNC_PARTS.join('\\') : 'MyData\\OneDriveBackup\\OneDrive-25Nov26',
      layout: keep ? 'flat' : 'dated',
      rows: live,
      totals: { files: live.length, bytes: live.reduce((s, r) => s + r.size, 0) },
      alreadyBackedUp: keep ? 41 : 61_204,
      sameContentElsewhere: keep ? 0 : 37,
      differentOnDrive: 0,
      moved: keep ? [] : [{ kind: 'folder_renamed', from: 'Pictures/Trip', to: 'Pictures/Goa 2026', files: 1_204 }],
      movedFiles: keep ? 0 : 1_204,
      leftOut: left.length > 0 ? [{ key: 'rule:101', filter: 'your_rule', folder: '/source/Games', files: left.length, bytes: left.reduce((s, r) => s + r.size, 0), canInclude: false, rule: { id: 101, words: saved[0]!.words } }] : [],
      onlineOnly: keep ? { files: 0, bytes: 0, examples: [] } : { files: 412, bytes: 8_400_000_000, examples: ['Pictures/2019/Reunion/IMG_0042.jpg', 'Videos/Old/Diwali 2019.mp4'] },
      notes: [],
      freeBytes: 300_000_000_000,
      blocked: null,
    };
  };

  const progress = (jobId: number): FolderBackupProgress | null => {
    const sim = sims.get(jobId);
    if (!sim) return null;
    const finished = env.jobOf(jobId)?.state !== 'running';
    const copying = !finished && sim.index < sim.order.length;
    const first = copying ? sim.index + 1 : sim.index;
    const file = (r: PreviewRow): { path: string; size: number } => ({ path: r.path, size: r.size });
    return {
      jobId,
      total: sim.order.length,
      done: sim.doneIdx.length,
      waiting: Math.max(0, sim.order.length - first),
      failedCount: sim.failed.length + sim.inUse.length,
      current: copying ? file(sim.order[sim.index]!) : null,
      next: sim.order.slice(first, first + PROGRESS_NEXT_LIMIT).map(file),
      recent: sim.doneIdx.slice(-PROGRESS_RECENT_LIMIT).toReversed().map((i) => file(sim.order[i]!)),
      failed: [...sim.failed, ...sim.inUse].slice(-PROGRESS_FAILED_LIMIT).toReversed(),
      finished,
    };
  };

  const tick = (backupId: number): void => {
    const jobId = COPY_BASE + (backupId === KEEP_ID ? 1 : 0);
    const s = sims.get(jobId);
    const job = env.jobOf(jobId);
    if (!s || !job || job.state !== 'running') return;
    let budget = backupId === KEEP_ID ? BYTES_PER_TICK / 20 : BYTES_PER_TICK;
    while (budget > 0 && s.index < s.order.length) {
      const row = s.order[s.index]!;
      const take = Math.min(row.size - s.copiedOfCurrent, budget);
      s.copiedOfCurrent += take;
      s.bytesDone += take;
      budget -= take;
      if (s.copiedOfCurrent >= row.size) {
        if (row.path.endsWith('.pst')) s.inUse.push({ path: row.path, size: row.size, reason: IN_USE_REASON });
        else s.doneIdx.push(s.index);
        s.index += 1;
        s.copiedOfCurrent = 0;
      }
    }
    const perSecond = Math.round((BYTES_PER_TICK * 1000) / TICK_MS);
    if (s.index >= s.order.length) {
      window.clearInterval(timers.get(jobId));
      const done = s.doneIdx.map((i) => s.order[i]!);
      reports.set(jobId, {
        jobId, runId: 88, backupName: nameOfBackup(backupId), sourceWords: backupId === KEEP_ID ? 'the keep-sync snapshots' : 'C:\\Users\\you\\OneDrive', layout: backupId === KEEP_ID ? 'flat' : 'dated',
        startedAt: s.startedAt, finishedAt: Date.now(), copied: { files: done.length, bytes: done.reduce((t, r) => t + r.size, 0) }, linked: backupId === KEEP_ID ? 0 : 5,
        inUse: s.inUse.length > 0 ? [{ reason: IN_USE_REASON, count: s.inUse.length, examples: s.inUse.map((f) => f.path.replace('/source/', '')) }] : [], inUseCount: s.inUse.length,
        skipped: backupId === KEEP_ID ? [] : [{ reason: ONLINE_ONLY_REASON, count: 3, examples: ['Pictures/2019/Reunion/IMG_0042.jpg'] }], failed: [],
        leftOut: backupId === KEEP_ID ? { files: 0, bytes: 0 } : { files: 12, bytes: 6_100_000 },
        onlineOnly: backupId === KEEP_ID ? { files: 0, bytes: 0, examples: [] } : { files: 412, bytes: 8_400_000_000, examples: ['Pictures/2019/Reunion/IMG_0042.jpg'] },
        where: [backupId === KEEP_ID ? `T7: ${KEEP_SYNC_PARTS.join('\\')}` : 'T7: MyData\\OneDriveBackup\\OneDrive-25Nov26'],
        listPath: backupId === KEEP_ID ? null : `T7:\\${CARD_FOLDER}\\lists\\OneDrive Local Backup\\2026-11-25.csv`, listProblem: null,
      });
      copied.set(jobId, { files: done.map((r) => ({ path: r.path, size: r.size, mtimeMs: r.mtimeSec * 1000 })), total: done.length });
      env.put({ ...job, state: s.inUse.length > 0 ? 'done_warnings' : 'done', progressDone: s.order.length, bytesDone: s.bytesTotal, finishedAt: Date.now(), speed: null, etaSeconds: null, message: 'Copied and checked' }, 'state');
      return;
    }
    env.put({ ...job, progressDone: s.index, progressTotal: s.order.length, bytesDone: s.bytesDone, bytesTotal: s.bytesTotal, message: `Copying ${nameOf(s.order[s.index]!.path)} (${s.index + 1} of ${s.order.length})`, speed: { unit: 'bytes', perSecond, itemsPerSecond: 1 }, etaSeconds: Math.ceil((s.bytesTotal - s.bytesDone) / perSecond) });
  };

  const isFolder = (id: unknown): boolean => id === ONEDRIVE_ID;
  const handlers: Record<string, unknown> = {
    'folderBackup.cards': (): Promise<FolderBackupCards> =>
      Promise.resolve({
        cards: [
          { backupId: ONEDRIVE_ID, backupName: 'OneDrive Local Backup', sourceWords: 'C:\\Users\\you\\OneDrive', driveLabel: 'T7', driveConnected: true, layout: 'dated' },
          ...(keepAdded ? [{ backupId: KEEP_ID, backupName: KEEP_SYNC_NAME, sourceWords: 'the keep-sync snapshots', driveLabel: 'T7', driveConnected: true, layout: 'flat' as const }] : []),
        ],
        keepSync: { available: true, exists: keepAdded },
      }),
    'folderBackup.addKeepSync': () => {
      keepAdded = true;
      return Promise.resolve({ ok: true, backupId: KEEP_ID, message: 'Added. Press Back up now on its card to see what would be copied. Nothing is copied until you confirm.' });
    },
    'folderBackup.look': (backupId: number) => {
      const jobId = LOOK_BASE + (backupId === KEEP_ID ? 1 : 0);
      const job = env.baseJob(jobId, 'folder.look', `Look at the folder: ${nameOfBackup(backupId)}`);
      job.message = backupId === KEEP_ID ? 'Looking at the keep-sync snapshots. Nothing is copied or opened.' : 'Looking at C:\\Users\\you\\OneDrive. Nothing is copied.';
      env.put(job, 'created');
      window.setTimeout(() => env.put({ ...job, state: 'done', finishedAt: Date.now(), message: 'Ready to copy. Nothing was copied.' }, 'state'), 900);
      return Promise.resolve({ ok: true, message: '', jobId });
    },
    'folderBackup.preview': (jobId: number): Promise<FolderLookResult | null> => {
      const backupId = jobId === LOOK_BASE + 1 ? KEEP_ID : ONEDRIVE_ID;
      return Promise.resolve(env.jobOf(jobId)?.state === 'done' ? { ok: true, plan: plan(backupId) } : null);
    },
    'folderBackup.start': (selection: FolderBackupSelection) => {
      const backupId = selection.planId.endsWith(String(KEEP_ID)) ? KEEP_ID : ONEDRIVE_ID;
      const jobId = COPY_BASE + (backupId === KEEP_ID ? 1 : 0);
      const out = new Set(selection.unticked);
      const order = plan(backupId).rows.filter((r) => !out.has(r.path)).toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      if (order.length === 0) return Promise.resolve({ ok: false, message: 'Nothing is ticked. Nothing was copied.', jobId: null });
      window.clearInterval(timers.get(jobId));
      reports.delete(jobId);
      const bytesTotal = order.reduce((s, r) => s + r.size, 0);
      sims.set(jobId, { order, index: 0, copiedOfCurrent: 0, doneIdx: [], failed: [], inUse: [], bytesDone: 0, bytesTotal, startedAt: Date.now() });
      env.put({ ...env.baseJob(jobId, 'folder.backup', `Back up ${nameOfBackup(backupId)} now (${order.length} files)`), progressTotal: order.length, bytesTotal, message: 'Starting' }, 'created');
      timers.set(jobId, window.setInterval(() => tick(backupId), TICK_MS));
      return Promise.resolve({ ok: true, message: '', jobId });
    },
    'folderBackup.progress': (jobId: number) => Promise.resolve(progress(jobId)),
    'folderBackup.report': (jobId: number) => Promise.resolve(reports.get(jobId) ?? null),
    'folderBackup.copied': (jobId: number) => Promise.resolve(copied.get(jobId) ?? null),
    // Exclusions of the OneDrive backup (the phone's answer for every other backup).
    'rules.list': (backupId: number) => (isFolder(backupId) ? Promise.resolve({ ok: true, backupId, backupName: 'OneDrive Local Backup', rules: [...saved] }) : (phoneRules['rules.list'] as (id: number) => unknown)(backupId)),
    'rules.effect': (request: RuleEffectRequest) => {
      if (!isFolder(request.backupId)) return (phoneRules['rules.effect'] as (r: RuleEffectRequest) => unknown)(request);
      const none = { files: 0, bytes: 0 };
      if (request.change.kind === 'remove') {
        const id = request.change.ruleId;
        const gone = saved.find((r) => r.id === id);
        const hit = gone ? rows.filter((r) => draftCovers(gone, r.path)) : [];
        return Promise.resolve({ ok: true, backupName: 'OneDrive Local Backup', hasPlan: true, leavesOut: none, bringsBack: { files: hit.length, bytes: hit.reduce((s, r) => s + r.size, 0) } });
      }
      const draft = request.change.draft;
      const hit = rows.filter((r) => draftCovers(draft, r.path));
      return Promise.resolve({ ok: true, backupName: 'OneDrive Local Backup', hasPlan: true, leavesOut: draft.choice === 'leave_out' ? { files: hit.length, bytes: hit.reduce((s, r) => s + r.size, 0) } : none, bringsBack: none });
    },
    'rules.add': (request: RuleAddRequest) => {
      if (!isFolder(request.backupId)) return (phoneRules['rules.add'] as (r: RuleAddRequest) => unknown)(request);
      const pattern = storedPattern(request);
      const twin = saved.find((r) => r.scope === request.scope && r.pattern === pattern && r.choice === request.choice);
      const rule: RuleView = twin ?? { id: nextRule++, scope: request.scope, choice: request.choice, pattern, words: ruleWords({ scope: request.scope, pattern, choice: request.choice }), createdAt: Date.now(), everyBackup: false };
      if (!twin) saved.push(rule);
      return Promise.resolve({ ok: true, message: 'Saved. Every later backup of OneDrive Local Backup will ' + (request.choice === 'leave_out' ? 'leave this out.' : 'include this.'), rule, count: saved.length, added: !twin });
    },
    'rules.remove': (request: RuleRemoveRequest) => {
      if (!isFolder(request.backupId)) return (phoneRules['rules.remove'] as (r: RuleRemoveRequest) => unknown)(request);
      const at = saved.findIndex((r) => r.id === request.ruleId);
      if (request.confirmed !== true || at < 0) return Promise.resolve({ ok: false, message: 'That choice is not on the list any more. Nothing was changed.' });
      saved.splice(at, 1);
      return Promise.resolve({ ok: true, message: 'Removed. Nothing was deleted.', count: saved.length });
    },
  };

  return {
    handlers,
    choices: () => saved.filter((r) => r.choice === 'leave_out').length,
    extraRows: () =>
      keepAdded
        ? [{ id: KEEP_ID, personId: 1, name: KEEP_SYNC_NAME, kind: 'folder', from: 'keep-sync snapshots', driveLabel: 'T7', folder: KEEP_SYNC_PARTS.join('/'), driveConnected: true, lastBackupAt: null, enabled: true, lastRunFailed: false, hubHasRun: false, phoneLinked: false, choices: 0 }]
        : [],
  };
}
