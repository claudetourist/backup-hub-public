import { describe, expect, it } from 'vitest';
import { CANCELLED_MESSAGE, INTERRUPTED_MESSAGE, type JobRecord, type JobState } from '../../shared/jobs';
import type { PlaceView } from '../../shared/places';
import type { BackupRow } from '../../shared/backups';
import type { ConnectedPhones } from '../../shared/phoneBackup';
import { driveReminders, homeTiles, NEEDS_YOU_LINKS, needsYou, recentActivity, yourBackups } from './homeModel';

const GB = 1_000_000_000;
const NOW = Date.UTC(2026, 10, 23, 12, 0, 0);
const DAY = 86_400_000;

function job(id: number, state: JobState, over: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    kind: 'k',
    title: `Job ${id}`,
    state,
    progressDone: 0,
    progressTotal: 0,
    bytesDone: 0,
    bytesTotal: 0,
    message: null,
    warnings: [],
    error: null,
    createdAt: NOW - DAY,
    startedAt: NOW - DAY,
    finishedAt: NOW - DAY,
    hasCheckpoint: false,
    speed: null,
    etaSeconds: null,
    choices: [],
    paused: false,
    ...over,
  };
}

function place(over: Partial<PlaceView>): PlaceView {
  return { id: 'p', kind: 'drive', label: 'T7', status: 'connected', capacityBytes: 1000 * GB, freeBytes: 500 * GB, gdrive: null, ...over } as PlaceView;
}

function account(id: string, used: number, limit: number, status: PlaceView['status'] = 'connected'): PlaceView {
  return place({ id, kind: 'gdrive', label: id, status, capacityBytes: null, freeBytes: null, gdrive: { quotaUsageBytes: used * GB, quotaLimitBytes: limit * GB } as PlaceView['gdrive'] });
}

describe('Home tiles', () => {
  it('has one tile per drive, plugged in first, and one for all accounts', () => {
    const tiles = homeTiles([place({ id: 'b', label: 'Seagate', status: 'disconnected', freeBytes: 100 * GB }), place({ id: 'a', label: 'T7' }), account('x', 5, 15), account('y', 10, 15), place({ id: 'l', kind: 'laptop', label: 'Laptop' })]);
    expect(tiles.map((t) => t.name)).toEqual(['T7', 'Seagate', '2 Google accounts']);
    expect(tiles[0]).toMatchObject({ connected: true, word: 'Connected', space: '500 GB free' });
    expect(tiles[1]).toMatchObject({ connected: false, word: 'Not connected', space: '100 GB free' });
    expect(tiles[2]).toMatchObject({ connected: true, word: 'Signed in', space: '15 GB free' });
  });
  it('says how many accounts need signing in', () => {
    const tile = homeTiles([account('x', 5, 15, 'needs_signin'), account('y', 5, 15)]).at(-1)!;
    expect(tile).toMatchObject({ connected: false, word: '1 need signing in' });
  });
  it('has no tiles when nothing is known', () => {
    expect(homeTiles([])).toEqual([]);
  });
});

describe('Needs you', () => {
  it('says nothing when all is well', () => {
    expect(needsYou([job(1, 'done'), job(2, 'running', { finishedAt: null })], [place({})], NOW)).toEqual([]);
  });
  it('lists real failures of the last 7 days, with the plain headline', () => {
    const items = needsYou([job(3, 'failed', { error: 'boom', title: 'Copy photos' })], [], NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ key: 'job:3', target: 'activity' });
    expect(items[0]!.text.startsWith('Copy photos: ')).toBe(true);
  });
  it('leaves out failures older than 7 days', () => {
    expect(needsYou([job(4, 'failed', { error: 'boom', finishedAt: NOW - 8 * DAY })], [], NOW)).toEqual([]);
    expect(needsYou([job(4, 'failed', { error: 'boom', finishedAt: NOW - 6 * DAY })], [], NOW)).toHaveLength(1);
  });
  it('does not count a job you stopped or that the app closing interrupted', () => {
    const stopped = job(5, 'failed', { error: CANCELLED_MESSAGE });
    const interrupted = job(6, 'failed', { error: INTERRUPTED_MESSAGE });
    expect(needsYou([stopped, interrupted], [], NOW)).toEqual([]);
  });
  it('lists a job that waits for an answer', () => {
    expect(needsYou([job(7, 'needs_you', { message: 'Which drive?', finishedAt: null })], [], NOW)[0]).toMatchObject({ text: 'Job 7: Which drive?', target: 'activity' });
  });
  it('lists low space: a connected drive at 85% or more, accounts at 90% or more, accounts to sign in', () => {
    const items = needsYou(
      [],
      [
        place({ id: 'a', label: 'T7', freeBytes: 140 * GB }),
        place({ id: 'b', label: 'Fine', freeBytes: 200 * GB }),
        place({ id: 'c', label: 'Away', status: 'disconnected', freeBytes: 0 }),
        account('x', 14, 15),
        account('y', 5, 15, 'needs_signin'),
        account('z', 3, 15),
      ],
      NOW,
    );
    expect(items.map((i) => i.text)).toEqual(['T7 is 86% full', '1 Google account is 90% full or more', '1 Google account needs signing in again']);
    expect(items.every((i) => i.target === 'devices')).toBe(true);
  });
});

describe('Needs you: interrupted jobs', () => {
  it('lists an interrupted job that kept a checkpoint until it is continued or dismissed', () => {
    const left = job(9, 'failed', { error: INTERRUPTED_MESSAGE, hasCheckpoint: true });
    expect(needsYou([left], [], NOW)).toEqual([{ key: 'job:9', text: 'Job 9: interrupted when the app closed. Continue it or dismiss it in Activity', target: 'activity' }]);
    expect(needsYou([{ ...left, message: 'Dismissed' }], [], NOW)).toEqual([]);
    expect(needsYou([{ ...left, retriedBy: 12 }], [], NOW)).toEqual([]);
    expect(needsYou([{ ...left, hasCheckpoint: false }], [], NOW)).toEqual([]);
    expect(needsYou([{ ...left, finishedAt: NOW - 8 * DAY }], [], NOW)).toEqual([]);
  });
});

describe('Reminders: a drive not plugged in for a while', () => {
  const away = (days: number, over: Partial<PlaceView> = {}): PlaceView => place({ status: 'disconnected', lastConnectedAt: NOW - days * DAY, ...over });

  it('says "T7 not plugged in for N days" once the drive has been away N days or more (default setting 14)', () => {
    expect(driveReminders([away(14)], 14, NOW)).toEqual([{ key: 'away:p', text: 'T7 not plugged in for 14 days' }]);
    expect(driveReminders([away(20)], 14, NOW)[0]?.text).toBe('T7 not plugged in for 20 days');
    expect(driveReminders([away(13, {})], 14, NOW)).toEqual([]);
    expect(driveReminders([away(13.9 as number)], 14, NOW)).toEqual([]);
  });

  it('follows the setting, and says "1 day" in the singular', () => {
    expect(driveReminders([away(3)], 7, NOW)).toEqual([]);
    expect(driveReminders([away(3)], 3, NOW)).toHaveLength(1);
    expect(driveReminders([away(1)], 1, NOW)[0]?.text).toBe('T7 not plugged in for 1 day');
  });

  it('leaves out a connected drive, a drive never seen, and everything that is not a named drive', () => {
    expect(driveReminders([away(40, { status: 'connected' })], 14, NOW)).toEqual([]);
    expect(driveReminders([away(40, { lastConnectedAt: null })], 14, NOW)).toEqual([]);
    expect(driveReminders([away(40, { kind: 'gdrive' }), away(40, { kind: 'laptop' }), away(40, { kind: 'phone' as PlaceView['kind'] })], 14, NOW)).toEqual([]);
  });

  it('lists the drive away longest first, one line each', () => {
    const lines = driveReminders([away(15, { id: 'a', label: 'Seagate' }), away(60, { id: 'b', label: 'T7' }), away(15, { id: 'c', label: 'Backup 2' })], 14, NOW);
    expect(lines.map((l) => l.text)).toEqual(['T7 not plugged in for 60 days', 'Backup 2 not plugged in for 15 days', 'Seagate not plugged in for 15 days']);
  });
});

describe('last 5 Activity items', () => {
  it('shows the newest five, one line each', () => {
    const jobs = Array.from({ length: 8 }, (_, i) => job(i + 1, 'done', { message: `Did ${i + 1}` }));
    const recent = recentActivity(jobs, NOW);
    expect(recent.map((r) => r.id)).toEqual([8, 7, 6, 5, 4]);
    expect(recent[0]).toMatchObject({ title: 'Job 8', line: 'Did 8' });
  });
  it('leaves out quiet upkeep jobs, as Activity does', () => {
    expect(recentActivity([job(1, 'done', { kind: 'db.snapshot' }), job(2, 'done')], NOW).map((r) => r.id)).toEqual([2]);
  });
  it('has no items without jobs', () => {
    expect(recentActivity([], NOW)).toEqual([]);
  });
});

describe('Needs you: where each kind of line goes', () => {
  it('sends jobs that need an answer, were interrupted or failed to Activity', () => {
    expect(needsYou([job(1, 'needs_you', { message: 'Pick one' })], [], NOW).map((i) => i.target)).toEqual(['activity']);
    expect(needsYou([job(2, 'failed', { error: INTERRUPTED_MESSAGE, hasCheckpoint: true })], [], NOW).map((i) => i.target)).toEqual(['activity']);
    expect(needsYou([job(3, 'failed', { error: 'The drive is full' })], [], NOW).map((i) => i.target)).toEqual(['activity']);
  });

  it('sends a full drive, a drive that cannot be read, full Google accounts and accounts to sign in to Devices', () => {
    expect(needsYou([], [place({ freeBytes: 100 * GB })], NOW).map((i) => i.target)).toEqual(['devices']);
    const bad = needsYou([], [place({ status: 'problem', problem: 'It cannot be read.' })], NOW);
    expect(bad).toEqual([{ key: 'problem:p', text: 'T7: It cannot be read.', target: 'devices' }]);
    expect(needsYou([], [account('a', 14, 15)], NOW).map((i) => i.target)).toEqual(['devices']);
    expect(needsYou([], [account('a', 1, 15, 'needs_signin')], NOW).map((i) => i.target)).toEqual(['devices']);
  });

  it('has a plain link word for each place', () => {
    expect(NEEDS_YOU_LINKS).toEqual({ activity: 'Open Activity', devices: 'Open Devices' });
  });
});

describe('Your backups', () => {
  const TODAY = new Date(2026, 10, 24, 12).getTime();
  const at = (y: number, m: number, d: number): number => new Date(y, m, d, 12).getTime();
  const row = (id: number, name: string, over: Partial<BackupRow> = {}): BackupRow => ({
    id,
    name,
    personId: 1,
    kind: 'folder',
    from: 'C:\\x',
    driveLabel: 'T7',
    folder: 'MyData/x',
    driveConnected: true,
    lastBackupAt: at(2026, 10, 23),
    enabled: true,
    lastRunFailed: false,
    hubHasRun: false,
    phoneLinked: false,
    choices: 0,
    ...over,
  });
  const phones = (...ids: number[]): ConnectedPhones => ({
    adb: 'ready',
    phones: ids.map((backupId) => ({ backupId, backupName: 'x', phoneName: 'x', serial: 's' + backupId, driveConnected: true })),
    hint: null,
    newPhones: [],
    backupsWithoutPhone: [],
  });

  it('lists the backups that are on, with the status word and the date', () => {
    const list = yourBackups([row(1, 'Docs'), row(2, 'Old', { enabled: false })], null, TODAY);
    expect(list).toEqual([{ id: 1, name: 'Docs', kind: 'laptop', status: 'up-to-date', lastLine: 'Last backup 23 Nov, yesterday', canBackUpNow: false, plugNote: null }]);
  });

  it('says how long ago, and "No backup yet" when there is none', () => {
    const [old, never] = yourBackups([row(1, 'Poco F4', { lastBackupAt: at(2026, 6, 17) }), row(2, 'New', { lastBackupAt: null })], null, TODAY);
    expect(old).toMatchObject({ status: 'behind', lastLine: 'Last backup 17 Jul, 4 months ago' });
    expect(never).toMatchObject({ status: 'never', lastLine: 'No backup yet' });
  });

  it('puts Problem first, then Behind, then Never backed up, then Up to date', () => {
    const list = yourBackups(
      [row(1, 'A fine'), row(2, 'B never', { lastBackupAt: null }), row(3, 'C behind', { lastBackupAt: at(2026, 9, 1) }), row(4, 'D problem', { lastRunFailed: true }), row(5, 'A behind', { lastBackupAt: at(2026, 9, 2) })],
      null,
      TODAY,
    );
    expect(list.map((b) => [b.name, b.status])).toEqual([['D problem', 'problem'], ['A behind', 'behind'], ['C behind', 'behind'], ['B never', 'never'], ['A fine', 'up-to-date']]);
  });

  it('offers "Back up now" for a phone that is plugged in, and says to plug in one that is not', () => {
    const list = yourBackups([row(1, 'Poco F4', { kind: 'phone' }), row(2, 'Mom Samsung', { kind: 'phone' }), row(3, 'Docs')], phones(1), TODAY);
    const by = (id: number): (typeof list)[number] => list.find((b) => b.id === id)!;
    expect(by(1)).toMatchObject({ canBackUpNow: true, plugNote: null });
    expect(by(2)).toMatchObject({ canBackUpNow: false, plugNote: 'Plug in Mom Samsung to back it up' });
    expect(by(3)).toMatchObject({ canBackUpNow: false, plugNote: null });
  });

  it('asks nothing about the plug while it is not known which phones are plugged in', () => {
    expect(yourBackups([row(1, 'Poco F4', { kind: 'phone' })], null, TODAY)[0]).toMatchObject({ canBackUpNow: false, plugNote: null });
  });
});
