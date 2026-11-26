import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ShellRunner } from '../adb/phoneLook';
import { LIST_END_MARKER, type RawListing } from '../adb/phoneModel';
import { MIGRATIONS } from '../db/migrations';
import { loadCopies, loadDestinations, loadPhoneIndex } from './lookStore';
import { runLook } from './lookRun';
import { makeRig, type Rig } from './harness/world.testutil';

const T = 1_700_000_000;
interface PF {
  path: string;
  size: number;
  mtimeSec: number;
}

/** A phone that is a list in memory: answers the listing command for any folder, with an optional failure. */
function phoneOf(files: () => PF[], broken: () => ((folder: string) => RawListing) | null = () => null): ShellRunner {
  return async (_serial, command) => {
    const folder = /^\{ find -H '(.*)' -type f/.exec(command)![1]!;
    const custom = broken();
    if (custom) return custom(folder);
    const mine = files().filter((f) => f.path.startsWith(`${folder}/`));
    return { exitCode: 0, stdout: mine.map((f) => `${f.size}|${f.mtimeSec}|${f.path}\n`).join('') + `${LIST_END_MARKER}|0|${mine.length}\n`, stderr: '' };
  };
}

describe('migration 0022', () => {
  it('adds only the position column, 1 for every row', () => {
    const last = MIGRATIONS[21]!;
    expect(last).toMatchObject({ version: 22, name: 'destination_position' });
    expect(MIGRATIONS.map((m) => m.version)).toEqual(Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1));
    const rig = makeRig();
    try {
      const cols = rig.db.prepare("SELECT name, type, \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('backup_destinations')").all() as { name: string; type: string; nn: number; d: string }[];
      expect(cols.find((c) => c.name === 'position')).toMatchObject({ type: 'INTEGER', nn: 1, d: '1' });
      rig.db.prepare("INSERT INTO places (id, profile_id, kind, label, created_at) VALUES ('p', 1, 'phone', 'p', 1), ('d', 1, 'drive', 'd', 1)").run();
      rig.db.prepare("INSERT INTO backup_profiles (person_id, name, source_kind, source_place_id, folder_prefix, change_rule, created_at) VALUES (1, 'b', 'phone', 'p', 'P', 'size_and_date', 1)").run();
      // a row inserted the old way (profileStore does) gets position 1
      rig.db.prepare("INSERT INTO backup_destinations (backup_profile_id, place_id, root) VALUES (1, 'd', 'MyData/P')").run();
      expect(loadDestinations(rig.db, 1)).toEqual([{ id: 1, placeId: 'd', root: 'MyData/P', position: 1 }]);
    } finally {
      rig.close();
    }
  });

  it('destinations come back in order of position (then id), and a disabled one is left out', () => {
    const rig = makeRig();
    try {
      rig.db.prepare("INSERT INTO places (id, profile_id, kind, label, created_at) VALUES ('p', 1, 'phone', 'p', 1), ('a', 1, 'drive', 'a', 1), ('b', 1, 'drive', 'b', 1), ('c', 1, 'drive', 'c', 1)").run();
      rig.db.prepare("INSERT INTO backup_profiles (person_id, name, source_kind, source_place_id, folder_prefix, change_rule, created_at) VALUES (1, 'b', 'phone', 'p', 'P', 'size_and_date', 1)").run();
      const ins = rig.db.prepare('INSERT INTO backup_destinations (backup_profile_id, place_id, root, enabled, position) VALUES (1, ?, ?, ?, ?)');
      ins.run('b', 'r', 1, 2);
      ins.run('a', 'r', 1, 1);
      ins.run('c', 'r', 0, 3);
      expect(loadDestinations(rig.db, 1).map((d) => [d.placeId, d.position])).toEqual([['a', 1], ['b', 2]]);
    } finally {
      rig.close();
    }
  });
});

describe('a look end to end: list, compare, guard, record', () => {
  let rig: Rig;
  let n = 0;
  let place: string;
  let phone: PF[];
  let breakIt: ((folder: string) => RawListing) | null;
  const run = (accept: Parameters<typeof runLook>[0]['accept'] = []) => runLook({ db: rig.db, placeId: place, serial: 'S', folders: ['/sdcard/DCIM'], run: phoneOf(() => phone, () => breakIt), accept, now: () => 5_000 + n });
  const rows = () => rig.db.prepare('SELECT id, rel_path, size, mtime, sha256, gone_at, gone_reason, kind FROM files WHERE place_id = ? ORDER BY rel_path').all(place) as { id: number; rel_path: string; size: number; mtime: number; sha256: string | null; gone_at: number | null; gone_reason: string | null; kind: string | null }[];

  beforeAll(() => {
    rig = makeRig();
  });
  afterAll(() => rig.close());
  beforeEach(() => {
    n += 1;
    place = `phone-${n}`;
    rig.db.prepare("INSERT INTO places (id, profile_id, kind, label, created_at) VALUES (?, 1, 'phone', 'Phone', 1)").run(place);
    phone = Array.from({ length: 12 }, (_, i) => ({ path: `/sdcard/DCIM/Camera/f${i}.jpg`, size: 100 + i, mtimeSec: T + i }));
    breakIt = null;
  });

  it('the first look records every file as a row with its kind; the second look changes nothing', async () => {
    const first = await run();
    expect(first.outcome.ok).toBe(true);
    expect(first.recorded).toEqual({ added: 12, changed: 0, cameBack: 0, markedGone: 0 });
    expect(rows()).toHaveLength(12);
    expect(rows()[0]).toMatchObject({ rel_path: 'sdcard/DCIM/Camera/f0.jpg', size: 100, mtime: T * 1000, gone_at: null });
    expect(rows().every((x) => x.kind !== null)).toBe(true);
    expect(rig.db.prepare('SELECT last_looked_at FROM places WHERE id = ?').pluck().get(place)).toBe(5_000 + n);
    const before = JSON.stringify(rows());
    const second = await run();
    expect(second.recorded).toEqual({ added: 0, changed: 0, cameBack: 0, markedGone: 0 });
    expect(JSON.stringify(rows())).toBe(before);
  });

  it('an edited file keeps its one row, updated in place, and loses its old checksum', async () => {
    await run();
    const id = rows().find((x) => x.rel_path.endsWith('/f3.jpg'))!.id;
    rig.db.prepare('UPDATE files SET sha256 = ? WHERE id = ?').run('aa'.repeat(32), id);
    phone[3] = { ...phone[3]!, size: 555, mtimeSec: T + 9999 };
    const r = await run();
    expect(r.recorded).toMatchObject({ changed: 1, added: 0 });
    expect(rows()).toHaveLength(12);
    expect(rows().find((x) => x.id === id)).toMatchObject({ size: 555, mtime: (T + 9999) * 1000, sha256: null, gone_at: null });
  });

  it('a file gone from the phone is marked gone with a reason and kept; if it comes back the same row lives again', async () => {
    await run();
    const [gone] = phone.splice(5, 1);
    const id = rows().find((x) => x.rel_path.endsWith('f5.jpg'))!.id;
    const r = await run();
    expect(r.recorded).toMatchObject({ markedGone: 1 });
    expect(rows()).toHaveLength(12);
    expect(rows().find((x) => x.id === id)).toMatchObject({ gone_reason: 'gone_from_source' });
    expect(rows().find((x) => x.id === id)!.gone_at).not.toBeNull();
    phone.push(gone!);
    const back = await run();
    expect(back.recorded).toMatchObject({ cameBack: 1, added: 0 });
    expect(rows().find((x) => x.id === id)).toMatchObject({ gone_at: null, gone_reason: null });
    expect(rows()).toHaveLength(12);
  });

  it('an incomplete look writes nothing at all and asks', async () => {
    await run();
    const before = JSON.stringify(rows());
    const looked = rig.db.prepare('SELECT last_looked_at FROM places WHERE id = ?').pluck().get(place);
    phone.length = 3; // would mean "9 gone" if it were believed
    for (const bad of [
      (): RawListing => ({ exitCode: 0, stdout: '1|1|/sdcard/DCIM/Camera/f0.jpg\n', stderr: '' }),
      (): RawListing => ({ exitCode: 1, stdout: '', stderr: 'error: device offline\n' }),
      (): RawListing => ({ exitCode: 0, stdout: `garbage\n${LIST_END_MARKER}|0|1\n`, stderr: '' }),
    ]) {
      breakIt = bad;
      const r = await run();
      expect(r.recorded).toBeNull();
      expect(r.outcome).toMatchObject({ ok: false, decision: { kind: 'look_incomplete' } });
      expect(JSON.stringify(rows())).toBe(before);
      expect(rig.db.prepare('SELECT last_looked_at FROM places WHERE id = ?').pluck().get(place)).toBe(looked);
    }
  });

  it('a mass change is a decision that writes nothing; accepting it records it', async () => {
    await run();
    const before = JSON.stringify(rows());
    phone.length = 4; // 8 of 12 gone
    const r = await run();
    expect(r.outcome).toMatchObject({ ok: false, decision: { kind: 'look_mass_change', numbers: { known: 12, gone: 8 } } });
    expect(r.recorded).toBeNull();
    expect(JSON.stringify(rows())).toBe(before);
    const accepted = await run(['look_mass_change']);
    expect(accepted.recorded).toMatchObject({ markedGone: 8 });
    expect(rows().filter((x) => x.gone_at !== null)).toHaveLength(8);
  });

  it('an empty phone where files were before is a decision', async () => {
    await run();
    phone.length = 0;
    const r = await run();
    expect(r.outcome).toMatchObject({ ok: false, decision: { kind: 'look_empty' } });
    expect(rows().every((x) => x.gone_at === null)).toBe(true);
  });

  it('rows outside the looked-at folders are never touched', async () => {
    await run();
    rig.db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at) VALUES (?, 'sdcard/Documents/a.txt', 1, 1, 1, 1)").run(place);
    phone.length = 12;
    await run();
    expect(rows().find((x) => x.rel_path === 'sdcard/Documents/a.txt')).toMatchObject({ gone_at: null });
  });

  it('works out "backed up at destination X" from the destination rows', async () => {
    rig.db.prepare("INSERT INTO places (id, profile_id, kind, label, created_at) VALUES (?, 1, 'drive', 'T7', 1)").run(`t7-${n}`);
    const profile = Number(
      rig.db.prepare("INSERT INTO backup_profiles (person_id, name, source_kind, source_place_id, phone_serial, folder_prefix, change_rule, created_at) VALUES (1, ?, 'phone', ?, ?, 'POCO', 'size_and_date', 1)").run(`b${n}`, place, `ser${n}`).lastInsertRowid,
    );
    rig.db.prepare("INSERT INTO backup_destinations (backup_profile_id, place_id, root, position) VALUES (?, ?, 'MyData/POCO', 1)").run(profile, `t7-${n}`);
    await run();
    const phoneRow = rows().find((x) => x.rel_path.endsWith('f1.jpg'))!;
    const addCopy = rig.db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at, origin_file_id, expected_sha256, verified_how) VALUES (?, ?, ?, ?, 1, 1, ?, 'aa', ?)");
    addCopy.run(`t7-${n}`, 'MyData/POCO/POCO-01Nov26/sdcard/DCIM/Camera/f1.jpg', phoneRow.size, phoneRow.mtime, phoneRow.id, 'imported');
    const report = await runLook({ db: rig.db, placeId: place, serial: 'S', folders: ['/sdcard/DCIM'], run: phoneOf(() => phone), backupProfileId: profile });
    if (!report.outcome.ok) throw new Error('look refused');
    const entries = report.outcome.compare.entries;
    const e = (name: string) => entries.find((x) => x.path.endsWith(name))!;
    expect(e('f1.jpg').destinations).toMatchObject([{ backedUp: true, worth: 'unverified' }]);
    expect(e('f2.jpg').destinations).toMatchObject([{ backedUp: false }]);
    expect(loadCopies(rig.db, [phoneRow.id])).toHaveLength(1);
    expect(loadPhoneIndex(rig.db, place, ['/sdcard/DCIM'])).toHaveLength(12);
  });
});
