import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decisionKey, parseDecisionKey, type DecisionCase } from '../../shared/decisions';
import type { JobContext } from '../jobs/jobService';
import { FakeCtx, ProductWorld } from '../look/harness/phoneBackupWorld.testutil';
import { makeRig, World, type Rig } from '../look/harness/world.testutil';
import { markDiffers } from '../phoneBackup/checkOldStore';
import { loadRefusal } from '../phoneBackup/lookRefusals';
import { PhoneBackupService } from '../phoneBackup/phoneBackupService';
import { recordDecision } from '../places/driveDecisions';
import { PlaceService } from '../places/placeService';
import { DecisionService } from './decisionService';
import { mockCases } from '../../renderer/dev/mockDecisions';
import { differsCase, driveCase, listNeedsDecision, lookCase } from './needsDecision';

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const NOW = Date.UTC(2026, 10, 24, 9, 0, 0);

let rig: Rig;
let w: World;
let pw: ProductWorld;
let created: { kind: string; title: string; params: unknown }[];
let phoneBackup: PhoneBackupService;
let places: PlaceService;
let service: DecisionService;
let jobSeq = 0;

beforeEach(() => {
  rig = makeRig();
  w = new World(rig, { seed: 21, drives: [{ caseInsensitive: true }, { caseInsensitive: true }] });
  pw = new ProductWorld(w);
  created = [];
  phoneBackup = new PhoneBackupService(pw.deps, { create: (kind, title, params) => (created.push({ kind, title, params }), created.length), list: () => [] });
  places = new PlaceService({ db: rig.db, dataDir: path.join(rig.dir, 'data'), hostname: 'TEST', appVersion: '0.1.0', systemDrive: 'C:', listVolumes: () => Promise.resolve([]), rootOf: (letter) => path.join(rig.dir, 'roots', letter.replace(':', '')), now: () => NOW, uuid: () => 'x', log: silent });
  service = new DecisionService({ db: rig.db, places, phoneBackup });
});
afterEach(() => {
  places.stopPolling();
  w.dispose();
  rig.close();
});

/** Runs the look job handler as the job service would; returns the plain text of the refusal, or null when a plan was made. */
async function runLook(accept: string[] = []): Promise<string | null> {
  jobSeq += 1;
  const ctx = Object.assign(new FakeCtx(), { jobId: jobSeq, params: { backupId: w.profileId, accept }, resume: null }) as unknown as JobContext;
  try {
    await phoneBackup.handlers()[0]!.run(ctx);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

const cases = (filter: Parameters<typeof listNeedsDecision>[1] = {}): DecisionCase[] => listNeedsDecision(rig.db, filter).cases;
const changes = (): number => rig.db.prepare('SELECT total_changes()').pluck().get() as number;

function fillPhone(count: number): void {
  for (let i = 0; i < count; i += 1) w.createFile(`/sdcard/DCIM/Camera/IMG_${i}.jpg`, `content ${i} ${'q'.repeat(i)}`);
}

describe('Needs your decision: drives', () => {
  const driveRow = (id: string, serial: string): void => {
    rig.db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES (?, 1, 'drive', ?, ?, 1)").run(id, 'T7', JSON.stringify({ serial: 'AAAA0001', capacity: 1_000_000 }));
    recordDecision(rig.db, id, 'serial_changed', { name: 'T7', letter: 'E:', storedSerial: 'AAAA0001', foundSerial: serial, foundCapacity: 1_000_000 }, NOW - 60_000);
  };

  it('an identity question is listed with two choices in plain words, and nothing is written by reading it', () => {
    driveRow('drive-t7', 'BBBB0002');
    const before = changes();
    const [c] = cases();
    expect(changes()).toBe(before);
    expect(c).toMatchObject({ source: 'drive', headline: 'Is this still T7?', at: NOW - 60_000, backupId: null, similar: 0 });
    expect(c!.choices.map((x) => x.label)).toEqual(['Yes, it is the same drive', 'No, keep it blocked']);
    expect(c!.what).toMatch(/Nothing is written to it until you say/);
    expect(c!.what).not.toMatch(/serial/i);
  });

  it('"Yes, it is the same drive" goes through the place service: the new facts are stored and the case closes', async () => {
    driveRow('drive-t7', 'BBBB0002');
    const key = cases()[0]!.key;
    expect(service.answer({ key, choice: 'same_drive' })).toMatchObject({ ok: true });
    expect(JSON.parse((rig.db.prepare('SELECT identity_json FROM places WHERE id = ?').get('drive-t7') as { identity_json: string }).identity_json)).toMatchObject({ serial: 'BBBB0002' });
    expect(cases()).toEqual([]);
    expect(service.answer({ key, choice: 'same_drive' })).toMatchObject({ ok: false }); // already answered
  });

  it('"No, keep it blocked" keeps the old facts and the drive stays blocked; a wrong kind of answer is refused', () => {
    driveRow('drive-t7', 'BBBB0002');
    const key = cases()[0]!.key;
    expect(service.answer({ key, choice: 'copy_again' })).toMatchObject({ ok: false });
    expect(service.answer({ key, choice: 'try_again' })).toMatchObject({ ok: false });
    expect(service.answer({ key, choice: 'other_drive' })).toMatchObject({ ok: true });
    expect(JSON.parse((rig.db.prepare('SELECT identity_json FROM places WHERE id = ?').get('drive-t7') as { identity_json: string }).identity_json)).toMatchObject({ serial: 'AAAA0001' });
    expect(places.identityBlock('drive-t7')).not.toBeNull();
    expect(cases()).toEqual([]);
  });

  it('two drives with one card, and a drive with two cards, are shown with no buttons and what to do; they cannot be answered here', () => {
    rig.db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES ('d2', 1, 'drive', 'T7', '{}', 1)").run();
    recordDecision(rig.db, 'd2', 'cloned_card', { name: 'T7', letters: ['E:', 'F:'] }, NOW);
    recordDecision(rig.db, 'd2', 'card_conflict', { name: 'T7', oldName: 'Seagate', oldId: 'z' }, NOW - 1);
    const list = cases();
    expect(list.map((c) => c.headline)).toEqual(['Two drives claim to be T7', 'T7 has two different name cards']);
    for (const c of list) {
      expect(c.choices).toEqual([]);
      expect(c.note).toMatch(/closes by itself/);
      expect(service.answer({ key: c.key, choice: 'same_drive' })).toMatchObject({ ok: false });
    }
  });

  it('only the drive of the backup is shown for one backup', () => {
    rig.db.prepare("INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES ('other-drive', 1, 'drive', 'Other', '{}', 1)").run();
    recordDecision(rig.db, 'other-drive', 'size_changed', { name: 'Other', foundCapacity: 5 }, NOW);
    recordDecision(rig.db, w.destinations[0]!.placeId, 'size_changed', { name: 'Fake', foundCapacity: 5 }, NOW);
    expect(cases().length).toBe(2);
    expect(cases({ backupId: w.profileId }).map((c) => c.headline)).toEqual(['Is this still Fake?']);
  });
});

describe('Needs your decision: a look at the phone that was refused', () => {
  it('a half list is refused, kept per backup, shown with one choice (Try again), and a later good look settles it', async () => {
    fillPhone(3);
    w.fault('locked');
    expect(await runLook()).toMatch(/did not come back complete/);
    const [c] = cases();
    expect(c).toMatchObject({ source: 'phone_look', key: decisionKey.look(w.profileId), backupId: w.profileId, headline: expect.stringContaining("the phone's file list did not come back complete") });
    expect(c!.choices.map((x) => x.id)).toEqual(['try_again']);
    // Accepting a half list is never offered and never allowed.
    expect(service.answer({ key: c!.key, choice: 'accept' })).toMatchObject({ ok: false, message: expect.stringContaining('can only be tried again') });
    expect(created).toEqual([]);
    // Try again goes through the phone backup service (a new look job, nothing accepted) and the case closes.
    const answered = service.answer({ key: c!.key, choice: 'try_again' });
    expect(answered).toMatchObject({ ok: true, jobId: 1 });
    expect(created).toEqual([{ kind: 'phone.look', title: expect.stringMatching(/^Look at the phone: Backup /), params: { backupId: w.profileId, accept: [] } }]);
    expect(cases()).toEqual([]);
    // A refused look that is then refused again comes back; a good look takes it away for good.
    w.fault('locked');
    await runLook();
    expect(cases()).toHaveLength(1);
    expect(await runLook()).toBeNull();
    expect(cases()).toEqual([]);
    expect(loadRefusal(rig.db, w.profileId)).toBeNull();
  });

  it('an empty list where files were before can be accepted: the look is started with that one answer, and the refusal goes', async () => {
    fillPhone(12);
    expect(await runLook()).toBeNull(); // 12 phone files are now known
    for (let i = 0; i < 12; i += 1) w.phone.remove(`/sdcard/DCIM/Camera/IMG_${i}.jpg`);
    expect(await runLook()).toMatch(/no files/);
    const [c] = cases();
    expect(c!.headline).toMatch(/showed no files/);
    expect(c!.choices.map((x) => x.id)).toEqual(['try_again', 'accept']);
    expect(service.answer({ key: c!.key, choice: 'accept' })).toMatchObject({ ok: true });
    expect(created.at(-1)!.params).toEqual({ backupId: w.profileId, accept: ['look_empty'] });
    expect(cases()).toEqual([]);
    expect(await runLook(['look_empty'])).toBeNull(); // the accepted look then goes through
  });

  it('a mass change can be accepted too, and the plain text says how many', async () => {
    fillPhone(12);
    expect(await runLook()).toBeNull();
    for (let i = 0; i < 6; i += 1) w.phone.remove(`/sdcard/DCIM/Camera/IMG_${i}.jpg`);
    await runLook();
    const [c] = cases();
    expect(c!.headline).toMatch(/many files look gone or changed/);
    expect(c!.what).toMatch(/6 of 12 known files/);
    expect(service.answer({ key: c!.key, choice: 'accept' })).toMatchObject({ ok: true });
    expect(created.at(-1)!.params).toEqual({ backupId: w.profileId, accept: ['look_mass_change'] });
  });

  it('the answer is refused while a phone job is waiting or running, and the case stays', async () => {
    fillPhone(2);
    w.fault('locked');
    await runLook();
    const busy = new PhoneBackupService(pw.deps, { create: () => 1, list: () => [{ kind: 'phone.look', state: 'running' } as never] });
    const s = new DecisionService({ db: rig.db, places, phoneBackup: busy });
    expect(s.answer({ key: decisionKey.look(w.profileId), choice: 'try_again' })).toMatchObject({ ok: false, message: expect.stringContaining('already waiting or running') });
    expect(cases()).toHaveLength(1);
  });

  it('a backup that is switched off shows no case, and one backup only shows its own', async () => {
    fillPhone(2);
    w.fault('locked');
    await runLook();
    expect(cases({ backupId: w.profileId + 100 })).toEqual([]);
    rig.db.prepare('UPDATE backup_profiles SET enabled = 0 WHERE id = ?').run(w.profileId);
    expect(cases()).toEqual([]);
  });
});

describe('Needs your decision: copies found different by Check old copies', () => {
  function copyOfPhoneFile(i: number): number {
    const phone = rig.db.prepare('SELECT id, rel_path FROM files WHERE place_id = ? AND rel_path = ?').get(w.placeId, `sdcard/DCIM/Camera/IMG_${i}.jpg`) as { id: number; rel_path: string };
    const place = w.destinations[0]!.placeId;
    const id = Number(
      rig.db
        .prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, origin_file_id, verified_how) VALUES (?, ?, 10, 1, 1, 1, ?, 'imported')")
        .run(place, `MyData/POCO/old/IMG_${i}.jpg`, phone.id).lastInsertRowid,
    );
    markDiffers(rig.db, id, NOW - i * 1000);
    return id;
  }

  beforeEach(async () => {
    fillPhone(3);
    await runLook();
  });

  it('is listed per file with two choices, the newest first, and "similar" counts the others of the same backup', () => {
    const ids = [0, 1, 2].map(copyOfPhoneFile);
    const list = cases();
    expect(list.map((c) => c.fileId)).toEqual(ids);
    expect(list[0]).toMatchObject({ source: 'copy_differs', backupId: w.profileId, similar: 2, headline: "IMG_0.jpg: the copy on Fake drive 1 is not the same as the phone's file" });
    expect(list[0]!.choices.map((x) => [x.id, x.action, x.label])).toEqual([
      ['copy_again', 'answer', 'Copy it again at the next backup'],
      ['show_file', 'open', 'Show the file'],
    ]);
    expect(list[0]!.what).toMatch(/was not touched/);
  });

  it('"Copy it again at the next backup" marks only that one as seen (the file itself is not touched)', () => {
    const [a, b] = [0, 1].map(copyOfPhoneFile);
    const key = cases()[0]!.key;
    const files = rig.db.prepare('SELECT count(*) FROM files').pluck().get();
    expect(service.answer({ key, choice: 'copy_again' })).toMatchObject({ ok: true });
    expect(rig.db.prepare("SELECT file_id FROM file_problems WHERE state = 'acknowledged'").pluck().all()).toEqual([a]);
    expect(cases().map((c) => c.fileId)).toEqual([b]);
    expect(rig.db.prepare('SELECT verified_how FROM files WHERE id = ?').pluck().get(a)).toBe('differs'); // still not a checked copy: the next backup copies it again
    expect(rig.db.prepare('SELECT count(*) FROM files').pluck().get()).toBe(files);
    expect(service.answer({ key, choice: 'copy_again' })).toMatchObject({ ok: false }); // already seen
  });

  it('"Do the same for the others" marks every open one of that backup; "Show the file" is not an answer main takes', () => {
    [0, 1, 2].forEach(copyOfPhoneFile);
    const key = cases()[1]!.key;
    expect(service.answer({ key, choice: 'show_file' as never })).toMatchObject({ ok: false });
    expect(service.answer({ key, choice: 'try_again' })).toMatchObject({ ok: false });
    expect(service.answer({ key, choice: 'copy_again', similar: true })).toMatchObject({ ok: true, message: expect.stringContaining('3 files') });
    expect(cases()).toEqual([]);
  });

  it('can be narrowed to one backup and to what a run just found', () => {
    [0, 1, 2].forEach(copyOfPhoneFile);
    expect(cases({ backupId: w.profileId }).length).toBe(3);
    expect(cases({ backupId: w.profileId + 1 })).toEqual([]);
    expect(cases({ since: NOW - 500 }).map((c) => c.fileId?.toString())).toHaveLength(1);
    expect(listNeedsDecision(rig.db, { since: NOW + 1 })).toEqual({ cases: [], total: 0 });
  });

  it('a long list is cut but the total is exact', () => {
    const place = w.destinations[0]!.placeId;
    const phone = rig.db.prepare('SELECT id FROM files WHERE place_id = ? LIMIT 1').pluck().get(w.placeId) as number;
    const addFile = rig.db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, origin_file_id, verified_how) VALUES (?, ?, 10, 1, 1, 1, ?, 'differs')");
    const addProblem = rig.db.prepare("INSERT INTO file_problems (file_id, kind, detected_at, state) VALUES (?, 'copy_differs', ?, 'open')");
    rig.db.transaction(() => {
      for (let i = 0; i < 130; i += 1) addProblem.run(Number(addFile.run(place, `MyData/POCO/many/f${i}.jpg`, phone).lastInsertRowid), NOW - i);
    })();
    const r = listNeedsDecision(rig.db);
    expect(r.cases).toHaveLength(100);
    expect(r.total).toBe(130);
  });
});

describe('the sample cases of the browser mock say what the real cases say', () => {
  it('the same headline, words, choices and keys as the real builders give for the same facts', () => {
    const [drive, look, differs] = mockCases();
    const at = (c: DecisionCase): DecisionCase => ({ ...c, at: 0 });
    expect(at(drive!)).toEqual(at(driveCase({ id: 1, placeId: 'x', kind: 'serial_changed', detail: { name: 'T7' }, foundAt: 0, answeredAt: null, answer: null })));
    expect(at(look!)).toEqual(at(lookCase({ backupId: 1, jobId: 1, kind: 'look_mass_change', canAccept: true, message: look!.what, at: 0 }, 'Poco F4')));
    expect(at(differs!)).toEqual(
      at(differsCase({ problem_id: 7, file_id: 501, detected_at: 0, copy_rel: 'MyData/POCO/old/IMG_20260110_142233.jpg', drive_label: 'T7', phone_rel: 'sdcard/DCIM/Camera/IMG_20260110_142233.jpg', backup_id: 1 }, 11)),
    );
    // The sample message of the refused look is what the guard really writes for these numbers.
    expect(look!.what).toBe('412 of 1204 known files look gone or changed since last time (more than 30%). Nothing was marked gone and nothing was planned. Try again, or accept it.');
  });
});

describe('keys and requests', () => {
  it('a key is read back only in its own shape', () => {
    expect(parseDecisionKey(decisionKey.drive(5))).toEqual({ source: 'drive', id: 5 });
    expect(parseDecisionKey(decisionKey.look(2))).toEqual({ source: 'phone_look', id: 2 });
    expect(parseDecisionKey(decisionKey.differs(99))).toEqual({ source: 'copy_differs', id: 99 });
    for (const bad of ['', 'drive:0', 'drive:-1', 'x:1', 'drive:1; DROP TABLE files', 'differs:1.5', 'look:']) expect(parseDecisionKey(bad)).toBeNull();
    expect(service.answer({ key: 'nonsense', choice: 'copy_again' })).toMatchObject({ ok: false });
  });
});
