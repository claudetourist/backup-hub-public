import { describe, expect, it } from 'vitest';
import type { BackupRow } from '../../shared/backups';
import type { JobRecord } from '../../shared/jobs';
import type { MirrorStatusResult } from '../../shared/mirror';
import type { ConnectedPhones } from '../../shared/phoneBackup';
import { formatRoute, parseHash } from '../routes';
import { activeJobOf, backupSub, buildEntries, bulkActions, filterEntries, jobPercent, jobsOf, keptText, mainAction, numbersText, parseBackupSub, plugNote, behindNote, progressLine, resumeOf, sortEntries, statusOf, tabsFor, type ListContext } from './backupListModel';

const NOW = new Date(2026, 10, 25, 12).getTime();
const day = (d: number): number => NOW - d * 86_400_000;

export const row = (over: Partial<BackupRow> & { id: number; name: string }): BackupRow => ({
  personId: 1,
  kind: 'folder',
  from: 'C:\\Users\\you\\OneDrive',
  driveLabel: 'T7',
  folder: 'MyData/OneDriveBackup',
  driveConnected: true,
  lastBackupAt: day(2),
  enabled: true,
  lastRunFailed: false,
  hubHasRun: false,
  phoneLinked: false,
  choices: 0,
  ...over,
});

const job = (over: Partial<JobRecord> & { id: number; kind: string }): JobRecord => ({
  title: 'A job',
  state: 'running',
  progressDone: 0,
  progressTotal: 0,
  bytesDone: 0,
  bytesTotal: 0,
  message: null,
  warnings: [],
  error: null,
  createdAt: 1,
  startedAt: 1,
  finishedAt: null,
  hasCheckpoint: false,
  speed: null,
  etaSeconds: null,
  paused: false,
  choices: [],
  ...over,
});

const mirrorOf = (backupId: number, behind: number | null): MirrorStatusResult['backups'][number] => ({
  backupId,
  sourceLabel: 'T7',
  sourceConnected: true,
  mirrors: [{ placeId: 's', label: 'Seagate2TB', position: 2, connected: true, behindFiles: behind, behindBytes: 1_000_000, needYou: 0 }],
});

const ctx = (over: Partial<ListContext> = {}): ListContext => ({ now: NOW, mirror: null, sizes: 'loading', jobs: [], connected: null, ownerNames: new Map([[1, 'You'], [2, 'Sam']]), ...over });
const phones = (...ids: number[]): ConnectedPhones => ({ adb: 'ready', phones: ids.map((id) => ({ backupId: id, backupName: 'x', phoneName: 'Poco F4', serial: 's' + id, driveConnected: true })), hint: null, newPhones: [], backupsWithoutPhone: [] });

describe('the address of a backup page', () => {
  it('"12", "12/second" and "12/second/go" round trip through the hash and say which section and whether to start at once', () => {
    for (const [id, tab, go] of [[12, 'overview', false], [12, 'second', false], [7, 'backup', true]] as const) {
      const hash = formatRoute('backups', backupSub(id, tab, go));
      const route = parseHash(hash);
      expect(route.screen).toBe('backups');
      expect(parseBackupSub(route.sub)).toEqual({ id, tab, go });
    }
    expect(backupSub(12)).toBe('12');
    expect(parseBackupSub(null)).toBeNull();
    expect(parseBackupSub('abc')).toBeNull();
    expect(parseBackupSub('12/nonsense')).toEqual({ id: 12, tab: 'overview', go: false });
    // The list is #/backups: no page.
    expect(parseBackupSub(parseHash('#/backups').sub)).toBeNull();
  });

  it('a section that does not apply is not offered', () => {
    const ids = (r: Pick<BackupRow, 'kind' | 'destinations'>): string[] => tabsFor(r).map((t) => t.id);
    expect(ids({ kind: 'folder' })).toEqual(['overview', 'backup', 'choices', 'history', 'restore']);
    expect(ids({ kind: 'phone' })).toEqual(['overview', 'backup', 'check', 'google', 'free', 'choices', 'covered', 'history', 'restore']);
    const two = [{ placeId: 'a', label: 'T7', position: 1, connected: true }, { placeId: 'b', label: 'Seagate2TB', position: 2, connected: true }];
    expect(ids({ kind: 'folder', destinations: two })).toEqual(['overview', 'backup', 'second', 'check', 'choices', 'history', 'restore']);
  });
});

describe('the row of a backup', () => {
  it('has the status of Home: Problem, Never, Behind, Up to date, and a second drive that is behind makes it Behind', () => {
    expect(statusOf(row({ id: 1, name: 'a', lastRunFailed: true }), null, NOW)).toBe('problem');
    expect(statusOf(row({ id: 1, name: 'a', lastBackupAt: null }), null, NOW)).toBe('never');
    expect(statusOf(row({ id: 1, name: 'a', lastBackupAt: day(30) }), null, NOW)).toBe('behind');
    expect(statusOf(row({ id: 1, name: 'a' }), null, NOW)).toBe('up-to-date');
    expect(statusOf(row({ id: 1, name: 'a' }), { backups: [mirrorOf(1, 5)] }, NOW)).toBe('behind');
  });

  it('says where it is kept (with the second drive), what is not plugged in, and the numbers with a placeholder first', () => {
    const two = [{ placeId: 'a', label: 'T7', position: 1, connected: true }, { placeId: 'b', label: 'Seagate2TB', position: 2, connected: false }];
    expect(keptText(row({ id: 1, name: 'a' }))).toBe('T7 · MyData/OneDriveBackup');
    expect(keptText(row({ id: 1, name: 'a', destinations: two }))).toBe('T7 + Seagate2TB · MyData/OneDriveBackup');
    expect(plugNote(row({ id: 1, name: 'a', destinations: two }))).toBe('Seagate2TB is not plugged in');
    expect(plugNote(row({ id: 1, name: 'a', driveConnected: false }))).toBe('T7 is not plugged in');
    expect(behindNote({ backupId: 1, mirrors: [{ label: 'Seagate2TB', behindFiles: 9168, behindBytes: 3_702_231_369 }] } as never)).toBe('Seagate2TB is 9,168 files (3.7 GB) behind');
    expect(behindNote({ backupId: 1, mirrors: [{ label: 'Seagate2TB', behindFiles: 0, behindBytes: 0 }] } as never)).toBeNull();
    expect(numbersText('loading', 1)).toBe('Counting…');
    expect(numbersText('failed', 1)).toBe('Not counted');
    expect(numbersText(new Map([[1, { backupId: 1, files: 1204, bytes: 3_200_000_000 }]]), 1)).toBe('1,204 files · 3.2 GB');
    expect(numbersText(new Map([[1, { backupId: 1, files: 0, bytes: 0 }]]), 1)).toBe('No files yet');
  });

  it('shows the live line of its own job: "Copying to Seagate2TB, 17%", and a job over several backups shows on each of them', () => {
    const two = [{ placeId: 'a', label: 'T7', position: 1, connected: true }, { placeId: 'b', label: 'Seagate2TB', position: 2, connected: true }];
    const r = row({ id: 1, name: 'a', destinations: two });
    const all = job({ id: 9, kind: 'mirror.copy', bytesDone: 17, bytesTotal: 100, backupIds: [1, 2, 3] });
    expect(jobPercent(all)).toBe(17);
    expect(progressLine(r, all)).toBe('Copying to Seagate2TB, 17%');
    expect(progressLine(r, { ...all, paused: true })).toBe('Copying to Seagate2TB, paused at 17%');
    expect(progressLine(r, { ...all, state: 'needs_you' })).toBe('Copying to Seagate2TB: waiting for you');
    expect(progressLine(r, job({ id: 10, kind: 'phone.backup', progressDone: 1, progressTotal: 4 }))).toBe('Copying to T7, 25%');
    for (const id of [1, 2, 3]) expect(jobsOf([all], id).map((j) => j.id)).toEqual([9]);
    expect(jobsOf([all], 4)).toEqual([]);
    const entries = buildEntries([r, row({ id: 2, name: 'b' }), row({ id: 4, name: 'c' })], ctx({ jobs: [all] }));
    // The second backup has no second drive of its own: the line still names a drive.
    expect(entries.map((e) => e.progress)).toEqual(['Copying to Seagate2TB, 17%', 'Copying to the second drive, 17%', null]);
    expect(activeJobOf([{ ...all, state: 'done' }], 1)).toBeNull();
  });

  it('has ONE button: Back up now, Continue, Bring the second copy up to date, or Open', () => {
    const two = [{ placeId: 'a', label: 'T7', position: 1, connected: true }, { placeId: 'b', label: 'Seagate2TB', position: 2, connected: true }];
    const act = (r: BackupRow, over: Partial<ListContext> = {}): string => mainAction(r, ctx(over)).label;
    expect(act(row({ id: 1, name: 'a', lastBackupAt: day(40) }))).toBe('Back up now');
    expect(act(row({ id: 1, name: 'a', enabled: false }))).toBe('Open');
    // A phone that is not plugged in cannot be backed up: Open.
    expect(act(row({ id: 1, name: 'a', kind: 'phone', lastBackupAt: day(40) }), { connected: phones() })).toBe('Open');
    expect(act(row({ id: 1, name: 'a', kind: 'phone', lastBackupAt: day(40) }), { connected: phones(1) })).toBe('Back up now');
    // Up to date, second drive behind: bring it up to date.
    expect(act(row({ id: 1, name: 'a', destinations: two }), { mirror: { backups: [mirrorOf(1, 12)] } })).toBe('Bring Seagate2TB up to date');
    // A job that asks you: Continue.
    expect(act(row({ id: 1, name: 'a' }), { jobs: [job({ id: 3, kind: 'folder.backup', state: 'needs_you', backupIds: [1] })] })).toBe('Continue');
    expect(act(row({ id: 1, name: 'a' }), { jobs: [job({ id: 3, kind: 'folder.backup', backupIds: [1] })] })).toBe('Open');
    expect(mainAction(row({ id: 1, name: 'a', lastBackupAt: day(40) }), ctx())).toMatchObject({ tab: 'backup', go: true });
  });

  it('picks up a look or copy that is still going when the page is opened again', () => {
    const jobs = [job({ id: 5, kind: 'phone.backup', backupIds: [1] }), job({ id: 4, kind: 'phone.look', state: 'done', backupIds: [1] })];
    expect(resumeOf(jobs, 1, { look: 'phone.look', run: 'phone.backup' }, 'T7')).toEqual({ jobId: 5, phase: 'run', driveLabel: 'T7' });
    expect(resumeOf(jobs, 2, { look: 'phone.look', run: 'phone.backup' }, 'T7')).toBeNull();
  });
});

describe('search, sort and the actions for all backups', () => {
  const rows = [
    row({ id: 1, name: 'Poco F4', kind: 'phone', from: 'Phone', folder: 'MyData/POCO', lastBackupAt: day(40) }),
    row({ id: 2, name: 'OneDrive Local Backup', lastBackupAt: day(3) }),
    row({ id: 3, name: 'DDrive Local Backup', from: 'D:\\MyData', folder: 'MyData/DDriveBackup', lastBackupAt: null, personId: 2 }),
    row({ id: 4, name: 'Old IMP', enabled: false, lastBackupAt: day(100) }),
  ];
  const entries = buildEntries(rows, ctx());

  it('finds by name, source, drive or owner; every word must match', () => {
    expect(filterEntries(entries, 'onedrive').map((e) => e.row.id)).toEqual([2, 4]);
    expect(filterEntries(entries, 'sam').map((e) => e.row.id)).toEqual([3]);
    expect(filterEntries(entries, 'local d:').map((e) => e.row.id)).toEqual([3]);
    expect(filterEntries(entries, '  ').length).toBe(4);
    expect(filterEntries(entries, 'nothing like it')).toEqual([]);
  });

  it('sorts by need (switched-off last), by name, and by last backup (newest first, none last)', () => {
    expect(sortEntries(entries, 'status').map((e) => e.row.id)).toEqual([1, 3, 2, 4]);
    expect(sortEntries(entries, 'name').map((e) => e.row.name)).toEqual(['DDrive Local Backup', 'Old IMP', 'OneDrive Local Backup', 'Poco F4']);
    expect(sortEntries(entries, 'last').map((e) => e.row.id)).toEqual([2, 1, 4, 3]);
  });

  it('offers "all backups" actions only when they cover more than one backup', () => {
    const two = [{ placeId: 'a', label: 'T7', position: 1, connected: true }, { placeId: 'b', label: 'Seagate2TB', position: 2, connected: true }];
    const withSecond = [row({ id: 1, name: 'a', destinations: two }), row({ id: 2, name: 'b', destinations: two })];
    expect(bulkActions(withSecond, { backups: [mirrorOf(1, 3), mirrorOf(2, 0)] })).toEqual({ mirror: 'Bring Seagate2TB up to date (all backups)', check: 'Check old copies on Seagate2TB (all backups)' });
    expect(bulkActions(withSecond, { backups: [mirrorOf(1, 0), mirrorOf(2, 0)] })).toEqual({ mirror: null, check: 'Check old copies on Seagate2TB (all backups)' });
    expect(bulkActions(withSecond.slice(0, 1), { backups: [mirrorOf(1, 3)] })).toEqual({ mirror: null, check: null });
    expect(bulkActions(withSecond, null)).toEqual({ mirror: null, check: null });
  });
});
