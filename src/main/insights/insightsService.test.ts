import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addIndexRows, addPlace, makeRig, type Rig } from '../backupProfiles/fixtures.testutil';
import type { PlaceView } from '../../shared/places';
import { InsightsService } from './insightsService';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 26, 12);
const GB = 1_000_000_000;

let rig: Rig;
beforeEach(() => {
  rig = makeRig();
  addPlace(rig.db, 'laptop', 'laptop', 'This laptop');
  addPlace(rig.db, 't7', 'drive', 'T7');
  addPlace(rig.db, 'sea', 'drive', 'Seagate2TB');
  addPlace(rig.db, 'phone', 'phone', 'Poco');
});
afterEach(() => rig.close());

const place = (over: Partial<PlaceView>): PlaceView =>
  ({ id: 'x', kind: 'drive', label: 'X', status: 'connected', rootHint: null, capacityBytes: 1000 * GB, freeBytes: 500 * GB, lastLookedAt: null, lastConnectedAt: null, gdrive: null, ...over }) as PlaceView;

const SMART = JSON.stringify([
  { Letter: 'C', Disk: 0, Health: 'Healthy', Operational: 'OK' },
  { Letter: 'E', Disk: 2, Health: 'Healthy', Operational: 'OK' },
  { Letter: 'F', Disk: 3, Health: 'Warning', Operational: 'OK' },
]);
const EVENTS = JSON.stringify([
  { Id: 153, Message: 'The IO operation at logical block address 0x1 for Disk 2 was retried.' },
  { Id: 55, Message: 'A corruption was discovered in the file system structure on volume E:.' },
]);

function service(places: PlaceView[], over: { smart?: string; events?: string; fail?: boolean } = {}) {
  const scripts: string[] = [];
  const svc = new InsightsService({
    db: rig.db,
    places: () => places,
    runScript: (script) => {
      scripts.push(script);
      if (over.fail) return Promise.reject(new Error('no PowerShell'));
      return Promise.resolve(script.includes('Get-WinEvent') ? (over.events ?? '') : (over.smart ?? SMART));
    },
    dataVersion: { current: () => 1 },
    now: () => NOW,
    log: { warn: () => {} },
  });
  return { svc, scripts };
}

const healthOf = async (svc: InsightsService, id: string) => {
  const result = await svc.driveHealth();
  if (!result.ok) throw new Error(result.message);
  return result.drives.find((d) => d.placeId === id)!;
};

const job = (kind: string, finishedAt: number, report: unknown, state = 'done'): number => {
  const id = Number(rig.db.prepare('INSERT INTO jobs (kind, title, state, created_at, finished_at) VALUES (?, ?, ?, 1, ?)').run(kind, kind, state, finishedAt).lastInsertRowid);
  const key = kind === 'mirror.checkOld' ? 'mirror.checkReport.' : 'phoneBackup.checkOld.report.';
  rig.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key + id, JSON.stringify(report));
  return id;
};

describe('Drive health', () => {
  const places = (): PlaceView[] => [
    place({ id: 'laptop', kind: 'laptop', label: 'This laptop', rootHint: 'C:' }),
    place({ id: 't7', label: 'T7', rootHint: 'E:' }),
    place({ id: 'sea', label: 'Seagate2TB', status: 'disconnected', rootHint: 'F:', lastConnectedAt: NOW - 40 * DAY }),
    place({ id: 'phone', kind: 'phone', label: 'Poco', status: 'disconnected', lastConnectedAt: NOW - 2 * DAY }),
  ];

  it('asks Windows once (the disks, then the log), keeps the answer for hours, and names disk errors per drive letter', async () => {
    const { svc, scripts } = service(places(), { events: EVENTS });
    const t7 = await healthOf(svc, 't7');
    expect(scripts).toHaveLength(2);
    expect(t7).toMatchObject({ smart: 'good', smartNote: 'Windows says this disk is healthy', windowsErrors: 2, kind: 'drive' });
    expect(t7.verdict).toBe('check-soon');
    expect(t7.reasons).toContain('Windows logged 2 disk errors in 30 days');
    expect((await healthOf(svc, 'laptop')).windowsErrors).toBe(0);
    expect(scripts).toHaveLength(2);
  });

  it('is Healthy with nothing wrong, and says "not plugged in, so Windows was not asked" for a drive that is away', async () => {
    const { svc } = service(places());
    expect(await healthOf(svc, 't7')).toMatchObject({ verdict: 'healthy', reasons: [], lastSeenAt: NOW });
    const sea = await healthOf(svc, 'sea');
    expect(sea.smartNote).toBe('Not plugged in, so Windows was not asked');
    expect(sea.smart).toBe('unknown');
    expect(sea.lastSeenAt).toBe(NOW - 40 * DAY);
    expect(sea).toMatchObject({ verdict: 'check-soon', reasons: ['Not seen for 40 days'] });
  });

  it('a phone has no disk for Windows: no Windows line, and never asks', async () => {
    const { svc, scripts } = service([place({ id: 'phone', kind: 'phone', label: 'Poco', status: 'disconnected', lastConnectedAt: NOW - DAY })]);
    expect(await healthOf(svc, 'phone')).toMatchObject({ smart: null, smartNote: '', windowsErrors: null, verdict: 'healthy' });
    expect(scripts).toHaveLength(0);
  });

  it('a Google account is judged by its room and its sign-in', async () => {
    const gd = (usage: number, status: PlaceView['status'] = 'connected') =>
      place({ id: 'g', kind: 'gdrive', label: 'a@example.com', status, lastLookedAt: NOW - DAY, gdrive: { quotaLimitBytes: 15 * GB, quotaUsageBytes: usage * GB } as PlaceView['gdrive'] });
    expect((await healthOf(service([gd(5)]).svc, 'g')).verdict).toBe('healthy');
    const full = await healthOf(service([gd(14)]).svc, 'g');
    expect(full).toMatchObject({ verdict: 'check-soon', reasons: ['Almost full'], freeBytes: 1 * GB, capacityBytes: 15 * GB });
    expect((await healthOf(service([gd(5, 'needs_signin')]).svc, 'g')).reasons).toEqual(['Needs signing in again']);
  });

  it('Windows saying the disk is failing, or a drive it cannot read, is a Problem', async () => {
    const bad = JSON.stringify([{ Letter: 'E', Disk: 2, Health: 'Unhealthy', Operational: 'Predictive Failure' }]);
    const t7 = await healthOf(service(places(), { smart: bad }).svc, 't7');
    expect(t7.verdict).toBe('problem');
    expect(t7.reasons[0]).toBe('Windows says this disk is failing');
    const unreadable = await healthOf(service([place({ id: 't7', label: 'T7', status: 'problem', rootHint: 'E:' })]).svc, 't7');
    expect(unreadable.verdict).toBe('problem');
  });

  it('when PowerShell fails the answer is "could not tell" and never a problem', async () => {
    const t7 = await healthOf(service(places(), { fail: true }).svc, 't7');
    expect(t7).toMatchObject({ smart: 'unknown', verdict: 'healthy', windowsErrors: null });
    expect(t7.smartNote).toBe('Windows could not tell how healthy this disk is');
  });

  it('shows the last "Check old copies" of each drive (a second drive check and a phone check, the newest wins) and the files it could not read', async () => {
    job('mirror.checkOld', NOW - 10 * DAY, { complete: true, backups: [{ targetLabel: 'Seagate2TB', verified: 900, differs: 2, failed: 1 }, { targetLabel: 'Seagate2TB', verified: 100, differs: 0, failed: 0 }], usbPauses: 0 });
    job('mirror.checkOld', NOW - 50 * DAY, { complete: true, backups: [{ targetLabel: 'Seagate2TB', verified: 5, differs: 0, failed: 0 }] });
    job('phone.checkOld', NOW - 3 * DAY, { driveLabel: 'T7', verified: { files: 40, bytes: 1 }, differCount: 0, couldNotRead: [{ reason: 'x', count: 2, examples: [] }, { reason: 'y', count: 3, examples: [] }] });
    job('phone.checkOld', NOW - 1 * DAY, { driveLabel: 'T7', verified: { files: 1, bytes: 1 }, differCount: 0, couldNotRead: [] }, 'failed');
    const { svc } = service(places());
    expect((await healthOf(svc, 'sea')).lastCheck).toEqual({ at: NOW - 10 * DAY, verified: 1000, differs: 2, couldNotRead: 1, complete: true });
    const t7 = await healthOf(svc, 't7');
    expect(t7.lastCheck).toEqual({ at: NOW - 3 * DAY, verified: 40, differs: 0, couldNotRead: 5, complete: true });
    expect(t7).toMatchObject({ readErrors: 5, verdict: 'check-soon' });
    expect(t7.reasons).toContain('5 files could not be read in the last check');
    expect((await healthOf(svc, 'laptop')).lastCheck).toBeNull();
  });

  it('counts USB pauses of the last 30 days from the reports, and open damaged and differing copies from the problems list', async () => {
    const id = job('mirror.copy', NOW - 5 * DAY, { usbPauses: 3, backups: [{ targetLabel: 'T7' }] });
    rig.db.prepare('UPDATE meta SET key = ? WHERE key = ?').run('mirror.report.' + id, 'phoneBackup.checkOld.report.' + id);
    addIndexRows(rig.db, [{ place: 't7', rel: 'a', size: 1 }, { place: 't7', rel: 'b', size: 1 }, { place: 'sea', rel: 'c', size: 1 }]);
    const fileId = (rel: string) => rig.db.prepare('SELECT id FROM files WHERE rel_path = ?').pluck().get(rel) as number;
    const problem = rig.db.prepare("INSERT INTO file_problems (file_id, kind, detected_at, state) VALUES (?, ?, 1, ?)");
    problem.run(fileId('a'), 'mirror_damaged', 'open');
    problem.run(fileId('b'), 'mirror_damaged', 'resolved');
    problem.run(fileId('c'), 'mirror_differs', 'open');
    const { svc } = service(places());
    const t7 = await healthOf(svc, 't7');
    expect(t7).toMatchObject({ usbTroubles: 3, damaged: 1, verdict: 'problem' });
    expect(t7.reasons).toEqual(['1 copy is damaged', 'Paused 3 times for USB trouble in 30 days']);
    expect(await healthOf(svc, 'sea')).toMatchObject({ differs: 1 });
  });

  it('knows how big the next backup to a drive is (the size of its last run)', async () => {
    rig.db.prepare("INSERT INTO backup_profiles (person_id, name, source_kind, folder_prefix, change_rule, created_at) VALUES (1, 'B', 'folder', '', 'size_and_date', 1)").run();
    const run = rig.db.prepare("INSERT INTO backup_runs (backup_profile_id, destination_place_id, started_at, state, bytes_copied) VALUES (1, 't7', ?, 'done', ?)");
    run.run(1000, 5 * GB);
    run.run(2000, 2 * GB);
    expect((await healthOf(service(places()).svc, 't7')).nextBackupBytes).toBe(2 * GB);
  });

  it('writes nothing to the database (only the reminder days are ever written)', async () => {
    const count = (): unknown => rig.db.prepare('SELECT (SELECT count(*) FROM meta) + (SELECT count(*) FROM jobs) + (SELECT count(*) FROM files) + (SELECT count(*) FROM file_problems)').pluck().get();
    const before = count();
    const { svc } = service(places(), { events: EVENTS });
    await svc.driveHealth();
    await svc.wouldLose('t7');
    expect(count()).toBe(before);
  });
});

describe('Reminder days', () => {
  it('are kept per backup, refuse a backup that is not there and numbers out of range', () => {
    rig.db.prepare("INSERT INTO backup_profiles (person_id, name, source_kind, folder_prefix, change_rule, created_at) VALUES (1, 'B', 'folder', '', 'size_and_date', 1)").run();
    const { svc } = service([]);
    expect(svc.setReminderDays(1, 14)).toEqual({ ok: true, days: { '1': 14 } });
    expect(svc.setReminderDays(1, 0).ok).toBe(false);
    expect(svc.setReminderDays(9, 3).ok).toBe(false);
    expect(svc.reminderDays()).toEqual({ ok: true, days: { '1': 14 } });
    expect(svc.setReminderDays(1, null)).toEqual({ ok: true, days: {} });
  });
});

describe('What would I lose? (service)', () => {
  it('says so when the worker is not there or a device is not known', async () => {
    const { svc } = service([]);
    expect((await svc.wouldLose('t7')).ok).toBe(false);
    expect((await svc.wouldLose('nope')).ok).toBe(false);
    expect(await svc.wouldLoseFiles({ placeId: 'nope', part: 'onlyHere', search: '', offset: 0, kind: null })).toEqual({ ok: false, message: 'That device was not found.' });
    expect((await svc.wouldLoseFiles({ placeId: 't7', part: 'onlyHere', search: '', offset: 0, kind: null })).ok).toBe(false);
  });
});
