import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WhyResult } from '../../shared/decisions';
import { makeRig, type Rig } from '../look/harness/world.testutil';
import { RulesStore } from '../rules/rulesStore';
import { checkedWords, dayWords, goneWords, whyFile } from './whyFile';
import { WhyService } from './whyService';

const D = (m: number, d: number): number => Date.UTC(2026, m, d, 12);
const NOW = D(10, 24);

let rig: Rig;
beforeEach(() => {
  rig = makeRig();
});
afterEach(() => rig.close());

/** The people's own words only: none of the insider words may reach the window. */
const BANNED = /\b(rows?|index|rules?|destinations?|serial|verified_how|listings?|listed|look(ed)? again|fingerprint\w*|ledger|catalog\w*|hash|adb|place_id|sha256|md5)\b/i;

interface Rows {
  phone: number;
  t7?: number;
  seagate?: number;
  google?: number;
}

function world(options: { t7?: string | null; seagate?: string | null; google?: boolean; phonePath?: string; filters?: string } = {}): Rows {
  const { db } = rig;
  const place = db.prepare('INSERT INTO places (id, profile_id, kind, label, identity_json, created_at) VALUES (?, 1, ?, ?, ?, 1)');
  place.run('phone', 'phone', 'Poco F4', '{}');
  place.run('t7', 'drive', 'T7', '{}');
  place.run('sg', 'drive', 'Seagate2TB', '{}');
  place.run('g1', 'gdrive', 'sam@example.com', '{}');
  db.prepare("INSERT INTO backup_profiles (id, person_id, name, source_kind, source_place_id, source_root, phone_serial, folder_prefix, change_rule, filters_json, created_at) VALUES (7, 1, 'Poco F4', 'phone', 'phone', '', 'SER', 'POCO', 'size_and_date', ?, 1)").run(options.filters ?? '{}');
  const add = db.prepare(
    'INSERT INTO files (place_id, rel_path, size, mtime, sha256, md5, first_seen_at, last_seen_at, origin_file_id, verified_how, verified_at, backup_run_id) VALUES (?, ?, 1234, 1, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const phone = Number(add.run('phone', options.phonePath ?? 'sdcard/DCIM/Camera/IMG_1.jpg', 'aa'.repeat(32), null, D(8, 1), D(10, 23), null, null, null, null).lastInsertRowid);
  db.prepare("INSERT INTO backup_runs (id, backup_profile_id, destination_place_id, folder, started_at, state) VALUES (3, 7, 't7', 'f', ?, 'done')").run(D(9, 5));
  const out: Rows = { phone };
  const copy = (placeId: string, rel: string, how: string | null, at: number | null): number => Number(add.run(placeId, rel, 'aa'.repeat(32), 'bb'.repeat(16), D(9, 5), D(10, 23), phone, how, at, 3).lastInsertRowid);
  if (options.t7 !== null) out.t7 = copy('t7', 'MyData/POCO/POCO-05Oct26/DCIM/Camera/IMG_1.jpg', options.t7 ?? 'read_both', D(9, 6));
  if (options.seagate !== null) out.seagate = copy('sg', 'Backups/POCO/POCO-05Oct26/DCIM/Camera/IMG_1.jpg', options.seagate ?? 'imported', null);
  if (options.google) out.google = Number(add.run('g1', 'Backup Hub/Sam/Poco F4/DCIM/Camera/IMG_1.jpg', null, 'bb'.repeat(16), D(9, 8), D(10, 20), null, null, null, null).lastInsertRowid);
  return out;
}

const why = (request: Parameters<typeof whyFile>[1]): Extract<WhyResult, { ok: true }> => {
  const r = whyFile({ db: rig.db, now: () => NOW }, request);
  if (!r.ok) throw new Error(r.message);
  return r;
};
const lines = (r: Extract<WhyResult, { ok: true }>, title: string): string[] => r.sections.find((s) => s.title === title)!.lines.map((l) => l.text);
const WHERE = 'Where it is and how it was checked';
const LEFT = 'Is it left out?';
const SAFE = 'Free up phone space';
const HISTORY = 'What happened to it';

describe('Why? on a phone file: where the copies are and how each was checked', () => {
  it('one checked copy and one that is only brought in from the old tool: each in its own words, with its folder', () => {
    const rows = world();
    const r = why({ fileId: rows.phone });
    expect(r.name).toBe('IMG_1.jpg');
    expect(r.headline).toBe('3 copies: the phone, T7, Seagate2TB');
    expect(lines(r, WHERE)).toEqual([
      'This file: On the phone, in DCIM/Camera: the original',
      `On T7, in MyData/POCO/POCO-05Oct26/DCIM/Camera: read back and compared with the phone's file on ${dayWords(D(9, 6))}`,
      'On Seagate2TB, in Backups/POCO/POCO-05Oct26/DCIM/Camera: brought in from the old tool, not checked yet',
    ]);
    expect(r.sections.find((s) => s.title === WHERE)!.lines.map((l) => l.tone)).toEqual(['quiet', 'ok', 'warn']);
  });

  it('the same answer from the copy on the drive: it points back at the phone file and shows the same copies', () => {
    const rows = world();
    const fromCopy = why({ fileId: rows.t7! });
    const fromPhone = why({ fileId: rows.phone });
    expect(fromCopy.name).toBe('IMG_1.jpg');
    expect(lines(fromCopy, WHERE).map((l) => l.replace('This file: ', ''))).toEqual(lines(fromPhone, WHERE).map((l) => l.replace('This file: ', '')));
    expect(lines(fromCopy, WHERE).find((l) => l.startsWith('This file: '))).toMatch(/^This file: On T7/);
  });

  it('every state of a copy has its words: checked, brought in, name and size only, found different, not checked, and Google', () => {
    const base = { place_kind: 'drive', last_seen_at: D(10, 1) };
    expect(checkedWords({ ...base, verified_how: 'read_both', verified_at: D(9, 6) }).text).toBe(`read back and compared with the phone's file on ${dayWords(D(9, 6))}`);
    expect(checkedWords({ ...base, verified_how: 'imported', verified_at: null }).text).toBe('brought in from the old tool, not checked yet');
    expect(checkedWords({ ...base, verified_how: 'name_size', verified_at: null }).text).toBe('matched by name and size only, not checked yet');
    expect(checkedWords({ ...base, verified_how: 'differs', verified_at: D(9, 7) })).toEqual({ text: `found different from the phone's file on ${dayWords(D(9, 7))}`, tone: 'bad' });
    expect(checkedWords({ ...base, verified_how: null, verified_at: null })).toEqual({ text: 'not checked yet', tone: 'warn' });
    expect(checkedWords({ place_kind: 'gdrive', verified_how: null, verified_at: null, last_seen_at: D(10, 1) }, true).text).toMatch(/matched by Google's own checksum/);
    expect(checkedWords({ place_kind: 'gdrive', verified_how: null, verified_at: null, last_seen_at: D(10, 1) }, false).text).toBe('not checked yet');
  });

  it('a copy found different is said so on its line and in what happened to it', () => {
    const rows = world({ t7: 'differs' });
    rig.db.prepare("INSERT INTO file_problems (file_id, kind, detected_at, state) VALUES (?, 'copy_differs', ?, 'open')").run(rows.t7, D(9, 7));
    const r = why({ fileId: rows.phone });
    expect(lines(r, WHERE)[1]).toMatch(/found different from the phone's file/);
    expect(lines(r, HISTORY)).toContain(`A copy was found different from the phone's file on ${dayWords(D(9, 7))} and is waiting for your decision.`);
    rig.db.prepare("UPDATE file_problems SET state = 'acknowledged'").run();
    expect(lines(why({ fileId: rows.phone }), HISTORY)).toContain(`A copy was found different from the phone's file on ${dayWords(D(9, 7))}; you chose to copy it again at the next backup.`);
  });

  it('a file by its phone path in a backup (the preview list has paths, not ids); unknown paths and ids are said plainly', () => {
    world();
    expect(why({ backupId: 7, phonePath: '/sdcard/DCIM/Camera/IMG_1.jpg' }).name).toBe('IMG_1.jpg');
    const unseen = whyFile({ db: rig.db }, { backupId: 7, phonePath: '/sdcard/DCIM/Camera/new.jpg' });
    expect(unseen).toEqual({ ok: false, message: 'Backup Hub has not seen this file yet, so there is nothing to explain. Nothing was changed.' });
    expect(whyFile({ db: rig.db }, { backupId: 99, phonePath: '/sdcard/a.jpg' }).ok).toBe(false);
    expect(whyFile({ db: rig.db }, { backupId: 7, phonePath: 'sdcard/DCIM/Camera/IMG_1.jpg' }).ok).toBe(false);
    expect(whyFile({ db: rig.db }, { fileId: 424242 }).ok).toBe(false);
    expect(whyFile({ db: rig.db }, { fileId: -1 }).ok).toBe(false);
    expect(new WhyService({ db: rig.db }).why({ fileId: 424242 }).ok).toBe(false);
  });
});

describe('Why? on a phone file: does it count as safe for Free up phone space', () => {
  it('not yet: a checked copy on T7, an unchecked one on the Seagate, nothing in Google. It says which are missing', () => {
    const r = why({ fileId: world().phone });
    expect(lines(r, SAFE)).toEqual([
      'Not yet. Free up phone space needs a checked copy on T7, Seagate2TB, Google. Missing: Seagate2TB, Google.',
      'T7: a checked copy',
      'Seagate2TB: a copy, but brought in from the old tool, not checked yet',
      'Google: no copy',
    ]);
  });

  it('yes when all three are checked (Google by its own checksum)', () => {
    const r = why({ fileId: world({ seagate: 'read_both', google: true }).phone });
    expect(lines(r, SAFE)[0]).toBe('Yes. It has a checked copy on all three: it counts as safe for Free up phone space.');
    expect(lines(r, SAFE).slice(1)).toEqual(['T7: a checked copy', 'Seagate2TB: a checked copy', 'Google: a checked copy']);
  });

  it('a copy that was found different does not count, and no copy at all is "no copy"', () => {
    const r = why({ fileId: world({ t7: 'differs', seagate: null }).phone });
    expect(lines(r, SAFE)[0]).toBe('Not yet. Free up phone space needs a checked copy on T7, Seagate2TB, Google. Missing: T7, Seagate2TB, Google.');
    expect(lines(r, SAFE).slice(1)).toEqual([expect.stringMatching(/^T7: a copy, but found different/), 'Seagate2TB: no copy', 'Google: no copy']);
  });

  it('a file that is not on a phone, or is gone from it, has nothing to free up', () => {
    const rows = world();
    rig.db.prepare("UPDATE files SET gone_at = ?, gone_reason = 'phone_cleaned' WHERE id = ?").run(D(10, 10), rows.phone);
    expect(lines(why({ fileId: rows.t7! }), SAFE)).toEqual(['It is not on the phone any more, so there is nothing to free up.']);
    const loose = Number(rig.db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at) VALUES ('t7', 'Elsewhere/doc.pdf', 5, 1, 1, 1)").run().lastInsertRowid);
    expect(lines(why({ fileId: loose }), SAFE)).toEqual(['Free up phone space only looks at files on the phone; this file is not on a phone.']);
    expect(lines(why({ fileId: loose }), LEFT)).toEqual(['This file is not part of a phone backup, so none of your choices or filters apply to it.']);
  });
});

describe('Why? on a phone file: what leaves it out', () => {
  it('nothing: it is offered for copying', () => {
    expect(lines(why({ fileId: world().phone }), LEFT)).toEqual(['Nothing leaves it out: Poco F4 offers it for copying.']);
  });

  it('your own choice names itself, with its words and date; an "always include" beats a filter', () => {
    const rows = world({ phonePath: 'sdcard/DCIM/.thumbnails/t.jpg' });
    expect(lines(why({ fileId: rows.phone }), LEFT)).toEqual(['Left out of Poco F4 by a built-in filter: Cache and thumbnail folders. "Always include" in Your choices brings it back.']);
    const store = new RulesStore(rig.db, () => D(10, 20));
    store.add(7, { scope: 'folder', pattern: '/sdcard/DCIM/.thumbnails', choice: 'include' });
    const included = why({ fileId: rows.phone });
    expect(lines(included, LEFT)[0]).toMatch(new RegExp(`^Included in Poco F4 by your choice: Always include: .*\\.thumbnails.* \\(folder\\), saved ${dayWords(D(10, 20))}\\. A built-in filter would otherwise leave it out\\.$`));
    expect(included.sections.find((s) => s.title === LEFT)!.lines[0]!.tone).toBe('ok');
  });

  it('"never back up" a file, a folder and a kind of file each say so', () => {
    const rows = world();
    const store = new RulesStore(rig.db, () => D(10, 21));
    store.add(7, { scope: 'pattern', pattern: '*.jpg', choice: 'leave_out' });
    const r = why({ fileId: rows.phone });
    expect(lines(r, LEFT)[0]).toMatch(/^Left out of Poco F4 by your choice: Never back up: \.jpg files \(this kind of file\), saved .*It is not copied\. Remove the choice in Your choices to change that\.$/);
    expect(r.sections.find((s) => s.title === LEFT)!.lines[0]!.tone).toBe('warn');
  });

  it('a folder with a .nomedia file leaves its files out (found from the index, not from the phone)', () => {
    const rows = world({ phonePath: 'sdcard/Misc/Hidden/p.jpg' });
    rig.db.prepare("INSERT INTO files (place_id, rel_path, size, mtime, first_seen_at, last_seen_at) VALUES ('phone', 'sdcard/Misc/Hidden/.nomedia', 0, 1, 1, 1)").run();
    expect(lines(why({ fileId: rows.phone }), LEFT)).toEqual(['Left out of Poco F4 by a built-in filter: Folders the phone marks as not for the gallery (.nomedia). "Always include" in Your choices brings it back.']);
  });
});

describe('Why? on a phone file: what happened to it', () => {
  it('first seen, last seen, the run that copied it, and every copy or phone file that is gone with its reason', () => {
    const rows = world();
    rig.db.prepare("UPDATE files SET gone_at = ?, gone_reason = 'missing_on_drive' WHERE id = ?").run(D(10, 12), rows.seagate);
    const r = why({ fileId: rows.phone });
    expect(lines(r, HISTORY)).toEqual([
      `First seen on ${dayWords(D(8, 1))}.`,
      `Last seen on the phone on ${dayWords(D(10, 23))}.`,
      `Copied to T7 by the backup of ${dayWords(D(9, 5))}.`,
      `Copied to Seagate2TB by the backup of ${dayWords(D(9, 5))}.`,
      `The copy on Seagate2TB is gone: noticed on ${dayWords(D(10, 12))}; it was not on the drive any more when it was checked.`,
    ]);
    // A gone copy no longer counts as a copy.
    expect(lines(r, WHERE).join('\n')).not.toContain('Seagate');
    expect(lines(r, SAFE)[0]).toMatch(/Missing: Seagate2TB, Google/);
  });

  it('every reason a file can be gone has words', () => {
    for (const reason of ['gone_from_source', 'removed_on_purpose', 'merged', 'compressed', 'kept_only_on_other_drive', 'phone_cleaned', 'missing_on_drive']) expect(goneWords(reason)).not.toMatch(/_/);
    expect(goneWords(null)).toBe('it was no longer there at the last check');
    expect(goneWords('something new')).toBe('it was no longer there at the last check');
  });

  it('a phone file that is gone says so and that no copy is left, when none is', () => {
    const rows = world({ t7: null, seagate: null });
    rig.db.prepare("UPDATE files SET gone_at = ?, gone_reason = 'gone_from_source' WHERE id = ?").run(D(10, 2), rows.phone);
    const r = why({ fileId: rows.phone });
    expect(r.headline).toBe('Backup Hub has no copy of it that is still there');
    expect(lines(r, WHERE)).toEqual(['Backup Hub has no copy of this file that is still there.']);
    expect(lines(r, HISTORY)).toContain(`The phone file is gone: noticed on ${dayWords(D(10, 2))}; it was no longer on the phone at the next check.`);
  });
});

describe('Why? is read only and uses plain words', () => {
  it('writes nothing, and none of the insider words reaches a line', () => {
    const rows = world({ seagate: 'name_size', google: true });
    rig.db.prepare("INSERT INTO file_problems (file_id, kind, detected_at, state) VALUES (?, 'copy_differs', ?, 'open')").run(rows.t7, D(9, 7));
    new RulesStore(rig.db, () => D(10, 20)).add(7, { scope: 'file', pattern: '/sdcard/DCIM/Camera/IMG_1.jpg', choice: 'include' });
    const before = rig.db.prepare('SELECT total_changes()').pluck().get();
    const all = [rows.phone, rows.t7!, rows.seagate!, rows.google!].map((fileId) => why({ fileId }));
    expect(rig.db.prepare('SELECT total_changes()').pluck().get()).toBe(before);
    for (const r of all) for (const s of r.sections) for (const l of [s.title, r.headline, r.name, ...s.lines.map((x) => x.text)]) expect(l, l).not.toMatch(BANNED);
  });

  it('a Google file explains itself from its own side, and a copy that is gone is still explained', () => {
    const rows = world({ google: true });
    const r = why({ fileId: rows.google! });
    expect(lines(r, WHERE).find((l) => l.startsWith('This file: '))).toMatch(/^This file: In Google \(sam@example\.com\), in Backup Hub\/Sam\/Poco F4\/DCIM\/Camera: matched by Google's own checksum/);
    rig.db.prepare('UPDATE files SET gone_at = 5 WHERE id = ?').run(rows.t7);
    expect(why({ fileId: rows.t7! }).name).toBe('IMG_1.jpg');
  });
});
