/**
 * Dev only (compiled out of production builds): the pretend second drive for the Backups screen in a plain browser (`#/backups?mock`): "Also keep a copy
 * on Seagate2TB" for the Poco F4 (the OneDrive backup already has one), a look that "finishes" after a moment, a list of about 150 files (large videos
 * first) with 4,310 files already on the Seagate to check and 2 different ones, a copy that advances every 400 ms, pauses once for USB trouble until
 * Continue is pressed, copies all but one file (the T7 copy of one looks damaged), and a report. "Check old copies": a preview (40,940 files, 173 GB,
 * three groups, one read or two, a time guess), a check that advances 900 files every 400 ms with "Checked so far: ..." and a report. Nothing here touches real data.
 */
import type { BackupRow } from '../../shared/backups';
import { LISTS_PARTS } from '../../shared/appFolders';
import { decisionKey, DECISION_CHOICE_LABELS, type DecisionCase } from '../../shared/decisions';
import type { JobChangedEvent, JobRecord } from '../../shared/jobs';
import { estimateCheckSeconds, MIRROR_CHECK_GROUP_WORDS, type MirrorCheckPlanView, type MirrorCheckPreviewResult, type MirrorCheckReport } from '../../shared/mirrorCheck';
import type { MirrorBackupStatus, MirrorLookResult, MirrorPlanView, MirrorReport, MirrorRow, MirrorSelection, MirrorStatusResult } from '../../shared/mirror';

const LOOK_JOB = 9101;
const COPY_JOB = 9102;
const CHECK_JOB = 9103;
/** The old copies on the pretend Seagate: 40,940 files, 173 GB, in the three groups, about a quarter needing two reads. */
const CHECK_GROUPS = [
  { group: 'photos', files: 18_000, bytes: 122_000_000_000 },
  { group: 'documents', files: 2_300, bytes: 6_000_000_000 },
  { group: 'other', files: 20_640, bytes: 45_000_000_000 },
] as const;
const CHECK_TOTAL = { files: 40_940, bytes: 173_000_000_000 };
const CHECK_TWO = { files: 9_940, bytes: 43_000_000_000 };
const CHECK_FILES_PER_TICK = 900;
const TICK_MS = 400;
const BYTES_PER_TICK = 45_000_000;
/** The mock's second drive and what is behind on it. */
const SEAGATE = { placeId: 'sample-seagate', label: 'Seagate2TB' };

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return s / 4_294_967_296;
  };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** About 150 files of the Poco F4's dated folders on the T7, as the list would show them. */
export function mockMirrorRows(): MirrorRow[] {
  const rnd = lcg(7);
  const between = (lo: number, hi: number): number => Math.round(lo + rnd() * (hi - lo));
  const rows: MirrorRow[] = [];
  const add = (path: string, size: number, own = false): void => {
    rows.push({ id: `0:${path}`, backupIndex: 0, path, size, mtimeMs: Date.UTC(2026, between(8, 10), between(1, 22), between(7, 21), between(0, 59)), ownChecksum: own });
  };
  for (let i = 0; i < 12; i += 1) add(`Poco-F4-${i % 2 === 0 ? '24Nov26' : '05Oct26'}/DCIM/Camera/VID_2026${pad(10 + (i % 2))}${pad(i + 1)}_${pad(between(7, 21))}${pad(i)}.mp4`, between(60, 480) * 1_000_000);
  for (let i = 0; i < 70; i += 1) add(`Poco-F4-24Nov26/DCIM/Camera/IMG_202611${pad((i % 22) + 1)}_${pad(between(7, 21))}${pad(i)}00.jpg`, between(2_000, 6_500) * 1000);
  for (let i = 0; i < 40; i += 1) add(`Poco-F4-05Oct26/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-2026100${(i % 9) + 1}-WA${pad(i, 4)}.jpg`, between(25, 320) * 1000, i % 13 === 0);
  for (let i = 0; i < 18; i += 1) add(`Poco-F4-05Oct26/Documents/${['Invoice', 'Ticket', 'Scan', 'Receipt', 'Report', 'Form'][i % 6]!}_${pad(i + 1)}.pdf`, between(80, 2_400) * 1000, i % 9 === 0);
  add('Poco-F4-24Nov26/Recordings/Memo 3.m4a', 4_200_000);
  return rows;
}

export interface MirrorMock {
  handlers: Record<string, unknown>;
  /** The Backups list row with the second drive added (when it was). */
  row(row: BackupRow): BackupRow;
}

export function createMirrorMock(env: {
  put: (job: JobRecord, reason?: JobChangedEvent['reason']) => void;
  baseJob: (id: number, kind: string, title: string) => JobRecord;
  addDecision: (c: DecisionCase) => void;
  jobOf: (id: number) => JobRecord | undefined;
}): MirrorMock {
  const rows = mockMirrorRows();
  let hasSecond = false;
  let done = false;
  let report: MirrorReport | null = null;
  let timer: number | undefined;
  let checkSim: { done: number; paused: boolean; startedAt: number } | null = null;
  let checkReport: MirrorCheckReport | null = null;
  let checkTimer: number | undefined;
  let sim: { order: MirrorRow[]; index: number; ofCurrent: number; bytesDone: number; bytesTotal: number; startedAt: number; paused: boolean; pausedOnce: boolean } | null = null;

  const plan = (): MirrorPlanView => ({
    planId: 'mock-mirror-plan',
    hash: 'mock-mirror-hash',
    backups: [{ backupId: 1, backupName: 'Poco F4', sourceLabel: 'T7', targetLabel: SEAGATE.label, folderWords: 'MyData\\POCO', files: rows.length, bytes: rows.reduce((s, r) => s + r.size, 0) }],
    rows,
    totals: { files: rows.length, bytes: rows.reduce((s, r) => s + r.size, 0) },
    toCheck: CHECK_TOTAL,
    different: { files: 2, examples: ['Poco-F4-05Oct26/Documents/Form_06.pdf', 'Poco-F4-05Oct26/Documents/Receipt_05.pdf'] },
    knownProblems: 0,
    ownChecksums: rows.filter((r) => r.ownChecksum).length,
    notes: [`${rows.filter((r) => r.ownChecksum).length} of these files have no checksum from the phone. Their own checksum is used, and the report says so.`],
    freeBytes: 1_200_000_000_000,
    blocked: null,
  });

  const status = (): MirrorStatusResult => {
    const total = rows.reduce((s, r) => s + r.size, 0);
    const backups: MirrorBackupStatus[] = [];
    if (hasSecond) {
      const behind = done ? { files: 1, bytes: 1_280_000 } : { files: rows.length + 2, bytes: total + 2_200_000 };
      backups.push({ backupId: 1, sourceLabel: 'T7', sourceConnected: true, mirrors: [{ ...SEAGATE, position: 2, connected: true, behindFiles: behind.files, behindBytes: behind.bytes, needYou: done ? 1 : 0 }] });
    }
    backups.push({ backupId: 2, sourceLabel: 'T7', sourceConnected: true, mirrors: [{ ...SEAGATE, position: 2, connected: true, behindFiles: 0, behindBytes: 0, needYou: 0 }] });
    return { backups };
  };

  const checkPlan = (): MirrorCheckPlanView => ({
    planId: 'mock-check-plan',
    hash: 'mock-check-hash',
    backups: [{ backupId: 1, backupName: 'Poco F4', sourceLabel: 'T7', targetLabel: SEAGATE.label, ...CHECK_TOTAL }],
    totals: CHECK_TOTAL,
    groups: [...CHECK_GROUPS],
    oneRead: { files: CHECK_TOTAL.files - CHECK_TWO.files, bytes: CHECK_TOTAL.bytes - CHECK_TWO.bytes },
    twoReads: CHECK_TWO,
    alreadyChecked: 0,
    estimateSeconds: estimateCheckSeconds(CHECK_TOTAL, CHECK_TWO),
    notes: [],
  });

  const checkSentence = (count: number): string => {
    let left = count;
    const parts = CHECK_GROUPS.map((g) => {
      const d = Math.min(left, g.files);
      left -= d;
      return `${MIRROR_CHECK_GROUP_WORDS[g.group]} ${d.toLocaleString('en-US')} of ${g.files.toLocaleString('en-US')}`;
    });
    return `Checked so far: ${parts.join(' · ')}`;
  };

  const checkTick = (): void => {
    const s = checkSim;
    const job = env.jobOf(CHECK_JOB);
    if (s === null || !job || job.state !== 'running' || s.paused) return;
    s.done = Math.min(CHECK_TOTAL.files, s.done + CHECK_FILES_PER_TICK);
    if (s.done >= CHECK_TOTAL.files) {
      window.clearInterval(checkTimer);
      checkReport = {
        jobId: CHECK_JOB, startedAt: s.startedAt, finishedAt: Date.now(), complete: true,
        backups: [{ backupId: 1, backupName: 'Poco F4', targetLabel: SEAGATE.label, verified: CHECK_TOTAL.files - 2, differs: 2, skipped: 0, failed: 0 }],
        verified: CHECK_TOTAL.files - 2, differs: 2, oneRead: CHECK_TOTAL.files - CHECK_TWO.files, twoReads: CHECK_TWO.files,
        groups: CHECK_GROUPS.map((g) => ({ group: g.group, done: g.files, total: g.files })), skipped: [], failed: [], usbPauses: 0,
      };
      env.put({ ...job, state: 'done_warnings', progressDone: CHECK_TOTAL.files, finishedAt: Date.now(), speed: null, etaSeconds: null, message: 'Checked' }, 'state');
      return;
    }
    const perSecond = Math.round((CHECK_FILES_PER_TICK * 1000) / TICK_MS);
    env.put({ ...job, progressDone: s.done, progressTotal: CHECK_TOTAL.files, message: checkSentence(s.done), speed: { unit: 'items', perSecond, itemsPerSecond: null }, etaSeconds: Math.ceil((CHECK_TOTAL.files - s.done) / perSecond) }, 'progress');
  };

  const finish = (s: NonNullable<typeof sim>): void => {
    window.clearInterval(timer);
    done = true;
    const copiedRows = s.order.filter((r) => !r.path.endsWith('Scan_03.pdf'));
    report = {
      jobId: COPY_JOB,
      startedAt: s.startedAt,
      finishedAt: Date.now(),
      backups: [{ backupId: 1, backupName: 'Poco F4', targetLabel: SEAGATE.label, copied: { files: copiedRows.length, bytes: copiedRows.reduce((t, r) => t + r.size, 0) }, linked: 0, damaged: 1, different: 2, failed: 0 }],
      copied: { files: copiedRows.length, bytes: copiedRows.reduce((t, r) => t + r.size, 0) },
      linked: 0,
      damaged: 1,
      different: 2,
      ownChecksums: copiedRows.filter((r) => r.ownChecksum).length,
      skipped: [],
      failed: [],
      where: [`${SEAGATE.label}: MyData\\POCO`],
      listPaths: [`${SEAGATE.label}:\\${LISTS_PARTS.join('\\')}\\Poco F4\\2026-11-24.csv`],
      listProblem: null,
      usbPauses: 1,
    };
    const at = Date.now();
    env.addDecision({
      key: decisionKey.mirror(31),
      source: 'mirror',
      headline: 'Scan_03.pdf: this T7 copy looks damaged',
      what: 'The copy of this file on T7 no longer matches the checksum it should have, so it was NOT copied to Seagate2TB. Nothing on either drive was changed. A good copy of it may still be on the phone or elsewhere.',
      at,
      choices: [{ id: 'leave_as_is', label: DECISION_CHOICE_LABELS.leave_as_is, hint: 'Only marks it as seen: the file stays as it is on both drives', action: 'answer' }, { id: 'show_file', label: DECISION_CHOICE_LABELS.show_file, hint: 'Opens the folder on T7', action: 'open' }],
      note: null,
      backupId: 1,
      fileId: 601,
      similar: 0,
    });
    env.addDecision({
      key: decisionKey.mirror(32),
      source: 'mirror',
      headline: 'Form_06.pdf: a different file is already on Seagate2TB',
      what: 'A file with the same name is already on Seagate2TB but its content is not the same as the one on T7. It was not replaced and nothing on either drive was changed.',
      at,
      choices: [{ id: 'leave_as_is', label: DECISION_CHOICE_LABELS.leave_as_is, hint: 'Only marks it as seen: the file stays as it is on both drives', action: 'answer' }, { id: 'show_file', label: DECISION_CHOICE_LABELS.show_file, hint: 'Opens the folder on T7', action: 'open' }],
      note: null,
      backupId: 1,
      fileId: 602,
      similar: 0,
    });
    const job = env.jobOf(COPY_JOB)!;
    env.put({ ...job, state: 'done_warnings', progressDone: s.order.length, bytesDone: s.bytesTotal, finishedAt: Date.now(), speed: null, etaSeconds: null, message: 'Copied and checked', warnings: ['Scan_03.pdf: this copy on the T7 looks damaged, so it was not copied. See Needs your decision.'] }, 'state');
  };

  const tick = (): void => {
    const s = sim;
    const job = env.jobOf(COPY_JOB);
    if (s === null || !job || job.state !== 'running' || s.paused) return;
    // Half way, the Seagate has a USB problem: the copy pauses with the plain message until Continue.
    if (!s.pausedOnce && s.bytesDone > s.bytesTotal / 2) {
      s.pausedOnce = true;
      s.paused = true;
      env.put({ ...job, state: 'needs_you', choices: ['Continue'], message: `${SEAGATE.label} had a USB problem. Plug it straight into the laptop, not a hub, then press Continue. Nothing is lost; the copy carries on where it stopped.` }, 'state');
      return;
    }
    let budget = BYTES_PER_TICK;
    while (budget > 0 && s.index < s.order.length) {
      const row = s.order[s.index]!;
      const take = Math.min(row.size - s.ofCurrent, budget);
      s.ofCurrent += take;
      s.bytesDone += take;
      budget -= take;
      if (s.ofCurrent >= row.size) {
        s.index += 1;
        s.ofCurrent = 0;
      }
    }
    if (s.index >= s.order.length) {
      finish(s);
      return;
    }
    const perSecond = Math.round((BYTES_PER_TICK * 1000) / TICK_MS);
    env.put({ ...job, progressDone: s.index, progressTotal: s.order.length, bytesDone: s.bytesDone, bytesTotal: s.bytesTotal, message: `Copying ${s.order[s.index]!.path.split('/').pop()!} (${s.index + 1} of ${s.order.length})`, speed: { unit: 'bytes', perSecond, itemsPerSecond: 1 }, etaSeconds: Math.ceil((s.bytesTotal - s.bytesDone) / perSecond) });
  };

  const handlers: Record<string, unknown> = {
    'mirror.choices': (backupId: number) => Promise.resolve(backupId === 1 && !hasSecond ? { ok: true, backupId, backupName: 'Poco F4', sourceLabel: 'T7', folder: 'MyData/POCO', drives: [SEAGATE] } : { ok: false, message: 'That backup already has a second drive.' }),
    'mirror.add': (request: { backupId: number }) => {
      if (request.backupId !== 1 || hasSecond) return Promise.resolve({ ok: false, message: 'That backup already has a second drive. Nothing was changed.' });
      hasSecond = true;
      return Promise.resolve({ ok: true, message: `Poco F4 will also be kept on ${SEAGATE.label}, in the folder MyData\\POCO. Nothing is copied until you bring it up to date.` });
    },
    'mirror.status': () => Promise.resolve(status()),
    'mirror.look': () => {
      const job = env.baseJob(LOOK_JOB, 'mirror.look', `Look at what ${SEAGATE.label} is missing: Poco F4`);
      job.message = 'Looking at T7: Poco F4';
      env.put(job, 'created');
      window.setTimeout(() => env.put({ ...job, state: 'done', finishedAt: Date.now(), message: `${rows.length} files are ready to copy. Nothing was copied.` }, 'state'), 700);
      return Promise.resolve({ ok: true, message: '', jobId: LOOK_JOB });
    },
    'mirror.preview': (jobId: number): Promise<MirrorLookResult | null> => Promise.resolve(jobId === LOOK_JOB && env.jobOf(LOOK_JOB)?.state === 'done' ? { ok: true, plan: plan() } : null),
    'mirror.start': (selection: MirrorSelection) => {
      const out = new Set(selection.unticked);
      const order = rows.filter((r) => !out.has(r.id)).toSorted((a, b) => b.size - a.size);
      if (order.length === 0) return Promise.resolve({ ok: false, message: 'Nothing is ticked. Nothing was copied.', jobId: null });
      window.clearInterval(timer);
      report = null;
      done = false;
      const bytesTotal = order.reduce((s, r) => s + r.size, 0);
      sim = { order, index: 0, ofCurrent: 0, bytesDone: 0, bytesTotal, startedAt: Date.now(), paused: false, pausedOnce: false };
      env.put({ ...env.baseJob(COPY_JOB, 'mirror.copy', `Bring ${SEAGATE.label} up to date (${order.length} files, ${(bytesTotal / 1e9).toFixed(1)} GB)`), progressTotal: order.length, bytesTotal, message: 'Starting' }, 'created');
      timer = window.setInterval(tick, TICK_MS);
      return Promise.resolve({ ok: true, message: '', jobId: COPY_JOB });
    },
    'mirror.report': (jobId: number) => Promise.resolve(jobId === COPY_JOB ? report : null),
    'mirror.checkPreview': (): Promise<MirrorCheckPreviewResult> => Promise.resolve({ ok: true, plan: checkPlan() }),
    'mirror.checkStart': () => {
      window.clearInterval(checkTimer);
      checkReport = null;
      checkSim = { done: 0, paused: false, startedAt: Date.now() };
      env.put({ ...env.baseJob(CHECK_JOB, 'mirror.checkOld', `Check old copies on ${SEAGATE.label} (${CHECK_TOTAL.files.toLocaleString('en-US')} files, 173.0 GB)`), progressTotal: CHECK_TOTAL.files, message: checkSentence(0) }, 'created');
      checkTimer = window.setInterval(checkTick, TICK_MS);
      return Promise.resolve({ ok: true, message: '', jobId: CHECK_JOB });
    },
    'mirror.checkReport': (jobId: number) => Promise.resolve(jobId === CHECK_JOB ? checkReport : null),
    // Continue after the USB pause.
    'jobs.resolve': (jobId: number) => {
      const job = env.jobOf(jobId);
      if (jobId === COPY_JOB && job && sim) {
        sim.paused = false;
        env.put({ ...job, state: 'running', choices: [], message: 'Carrying on' }, 'state');
      }
      return Promise.resolve({ ok: true });
    },
  };
  return {
    handlers,
    row: (row) => (row.id === 1 && hasSecond ? Object.assign({}, row, { destinations: [{ placeId: 'sample-t7', label: 'T7', position: 1, connected: true }, { ...SEAGATE, position: 2, connected: true }] }) : row.id === 1 ? Object.assign({}, row, { destinations: [{ placeId: 'sample-t7', label: 'T7', position: 1, connected: true }] }) : row.id === 2 ? Object.assign({}, row, { destinations: [{ placeId: 'sample-t7', label: 'T7', position: 1, connected: true }, { ...SEAGATE, position: 2, connected: true }] }) : row),
  };
}
