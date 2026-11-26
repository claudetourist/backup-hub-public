import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MOCK_WHY_FACTS, mockWhy } from '../../renderer/dev/mockDecisions';
import { makeRig, type Rig } from '../look/harness/world.testutil';
import { whyFile } from './whyFile';

/**
 * The sample "Why?" drawer of the browser mock (a phone photo with one checked copy and one not checked yet) must say exactly what the real
 * explanation says for the same facts, or the mock would teach the wrong words. The same facts are put in a real database here.
 */
let rig: Rig;
beforeEach(() => {
  rig = makeRig();
});
afterEach(() => rig.close());

describe('the sample "Why?" drawer of the mock matches the real explanation', () => {
  it('says the same lines, in the same sections, with the same colours', () => {
    const f = MOCK_WHY_FACTS;
    const { db } = rig;
    const place = db.prepare('INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES (?, 1, ?, ?, ?, 1)');
    place.run('phone', 'phone', 'Poco F4', '{}');
    place.run('t7', 'drive', 'T7', '{}');
    place.run('sg', 'drive', 'Seagate2TB', '{}');
    place.run('g1', 'gdrive', 'sam@example.com', '{}');
    db.prepare("INSERT INTO backup_profiles (id, person_id, name, source_kind, source_place_id, source_root, phone_serial, folder_prefix, change_rule, created_at) VALUES (7, 1, ?, 'phone', 'phone', '', 'SER', 'POCO', 'size_and_date', 1)").run(f.backupName);
    db.prepare("INSERT INTO backup_runs (id, backup_profile_id, destination_place_id, folder, started_at, state) VALUES (3, 7, 't7', 'f', ?, 'done')").run(f.copiedRun);
    const add = db.prepare(
      'INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, first_seen_at, last_seen_at, origin_file_id, verified_how, verified_at, backup_run_id) VALUES (?, ?, 1234, 1, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const sha = 'cd'.repeat(32);
    const phone = Number(add.run('phone', `sdcard/${f.phoneFolder}/${f.name}`, sha, null, f.firstSeen, f.lastSeen, null, null, null, null).lastInsertRowid);
    add.run('t7', `${f.t7Folder}/${f.name}`, sha, 'ee'.repeat(16), f.copiedRun, f.lastSeen, phone, 'read_both', f.t7CheckedAt, 3);
    add.run('sg', `${f.seagateFolder}/${f.name}`, sha, 'ee'.repeat(16), f.copiedRun, f.lastSeen, phone, 'imported', null, 3);
    expect(whyFile({ db }, { fileId: phone })).toEqual(mockWhy());
  });
});
