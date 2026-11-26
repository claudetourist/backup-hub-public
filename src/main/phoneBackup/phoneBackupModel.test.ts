import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS } from '../backupProfiles/filters';
import type { LookEntry } from '../look/compare';
import { pullTimeoutMs } from '../adb/adbPort';
import { groupFolderOf, leftOutBy, nomediaDirsOf, pythonExt } from './filterModel';
import { dayStamp, nameTag, placeOnDrive, remapPhonePath, sessionFolderName, timedName, windowsSafeParts } from './pathMap';
import { buildPlan, type LooseRow } from './planModel';
import { compileRules } from '../rules/ruleMatcher';
import type { BackupRule, RuleChoice, RuleScope } from '../../shared/rules';
import { csvField, listCsv, runDate } from './runCsv';

/** The filters, the path mapping, the plan and the list: pure rules ported from PhoneBackup (source_adapters.py, v3_engine.py). */
const F = DEFAULT_FILTERS as typeof DEFAULT_FILTERS & Record<string, string[]>;
const rule = (id: number, scope: RuleScope, pattern: string, choice: RuleChoice): BackupRule => ({ id, backupId: 1, scope, pattern, choice, destination: null, note: null, createdAt: 0 });

describe('the old filters, ported in the old order', () => {
  it('Python splitext: a name that only starts with a dot has no extension', () => {
    expect(pythonExt('/sdcard/DCIM/.nomedia')).toBe('');
    expect(pythonExt('/sdcard/a/b.JPG')).toBe('.JPG');
    expect(pythonExt('/sdcard/a/..x')).toBe('');
    expect(pythonExt('/sdcard/a/x.tar.gz')).toBe('.gz');
  });

  it('protected folders pass, other places pass, the three skip rules win first', () => {
    expect(leftOutBy('/sdcard/DCIM/Camera/a.jpg', F, [])).toBeNull();
    expect(leftOutBy('/sdcard/random/a.txt', F, [])).toBeNull();
    expect(leftOutBy('/sdcard/DCIM/Camera/a.tmp', F, [])).toBe('temporary_file');
    expect(leftOutBy('/sdcard/DCIM/.thumbnails/a.jpg', F, [])).toBe('cache_folder');
    expect(leftOutBy('/sdcard/Pictures/cache/a.jpg', F, [])).toBe('cache_folder'); // a skip fragment beats the protected folder
    expect(leftOutBy('/sdcard/WhatsApp/Media/.Statuses/a.jpg', F, [])).toBeNull();
    expect(leftOutBy('/sdcard/WhatsApp/Media/.hidden/a.jpg', F, [])).toBe('whatsapp_hidden');
  });

  it('the Android folder is judged by the two allowlists only', () => {
    expect(leftOutBy('/sdcard/Android/media/com.whatsapp/WhatsApp/x.jpg', F, [])).toBeNull();
    expect(leftOutBy('/sdcard/Android/media/com.other/x.jpg', F, [])).toBe('android_data');
    expect(leftOutBy('/sdcard/Android/data/com.miui.notes/files/n.txt', F, [])).toBeNull();
    expect(leftOutBy('/sdcard/Android/data/com.other/files/n.txt', F, [])).toBe('android_data');
    expect(leftOutBy('/sdcard/Android/obb/com.game/main.obb', F, [])).toBe('android_data');
  });

  it('a folder with a .nomedia file drops its files, unless it is a protected path', () => {
    const dirs = nomediaDirsOf(['/sdcard/Games/.nomedia', '/sdcard/DCIM/.nomedia', '/sdcard/x.jpg']);
    expect(dirs.toSorted()).toEqual(['/sdcard/DCIM/', '/sdcard/Games/']);
    expect(leftOutBy('/sdcard/Games/save.dat', F, dirs)).toBe('nomedia');
    expect(leftOutBy('/sdcard/Games/.nomedia', F, dirs)).toBe('nomedia');
    expect(leftOutBy('/sdcard/DCIM/a.jpg', F, dirs)).toBeNull();
  });

  it('left-out files are counted under the first three folders', () => {
    expect(groupFolderOf('/sdcard/Android/data/com.x/files/a/b.bin')).toBe('/sdcard/Android/data/com.x');
    expect(groupFolderOf('/sdcard/a.txt')).toBe('/sdcard');
  });
});

describe('where a file lands on the drive', () => {
  it('names the day like PhoneBackup (%d%b%y)', () => {
    expect(dayStamp(new Date(2026, 10, 23))).toBe('23Nov26');
    expect(dayStamp(new Date(2026, 0, 5))).toBe('05Jan26');
    expect(sessionFolderName('Poco-F4', new Date(2026, 10, 23))).toBe('Poco-F4-23Nov26');
  });

  it('removes /sdcard/ and moves the recorder, call recording and notes folders', () => {
    expect(remapPhonePath('/sdcard/DCIM/a.jpg')).toBe('DCIM/a.jpg');
    expect(remapPhonePath('/sdcard/Android/data/com.android.soundrecorder/files/r.m4a')).toBe('Recordings/Sound Recorder/r.m4a');
    expect(remapPhonePath('/sdcard/Android/data/com.miui.soundrecorder/files/r.m4a')).toBe('Recordings/Sound Recorder/r.m4a');
    expect(remapPhonePath('/sdcard/Android/data/com.google.android.dialer/files/callrecording/c.m4a')).toBe('Recordings/Call Recordings/c.m4a');
    expect(remapPhonePath('/sdcard/Android/data/com.miui.notes/files/img.png')).toBe('Notes Media/img.png');
    expect(remapPhonePath('/sdcard/x/sdcard/y.txt')).toBe('x/sdcard/y.txt'); // only the leading one goes
  });

  it('puts a file under <backup folder>/<prefix>-<day>/', () => {
    expect(placeOnDrive({ root: 'MyData/POCO', sessionFolder: 'Poco-F4-23Nov26', phonePath: '/sdcard/DCIM/Camera/a b.jpg' })).toEqual({ rel: 'MyData/POCO/Poco-F4-23Nov26/DCIM/Camera/a b.jpg', nameChanged: false });
  });

  it('a name Windows cannot store is cleaned and tagged so two different names never meet', () => {
    const a = windowsSafeParts('x/a:b.txt', '/sdcard/x/a:b.txt')!;
    const b = windowsSafeParts('x/a?b.txt', '/sdcard/x/a?b.txt')!;
    expect(a.changed && b.changed).toBe(true);
    expect(a.parts[1]).not.toBe(b.parts[1]);
    expect(a.parts[1]).toMatch(/^a_b \[[0-9a-f]{6}\]\.txt$/);
    expect(windowsSafeParts('../x', '/sdcard/../x')).toBeNull();
    expect(windowsSafeParts('CON', '/sdcard/CON')!.parts[0]).toMatch(/^_CON/);
    expect(windowsSafeParts('trail.', '/sdcard/trail.')!.changed).toBe(true);
    expect(nameTag('/sdcard/a')).toHaveLength(6);
  });

  it('a second version on the same day gets its time in the name', () => {
    expect(timedName('IMG_1.jpg', new Date(2026, 10, 23, 14, 30, 5))).toBe('IMG_1 (143005).jpg');
  });
});

describe('the plan', () => {
  const e = (path: string, size: number, o: Partial<LookEntry> = {}): LookEntry => ({
    kind: 'new',
    path,
    relPath: path.slice(1),
    size,
    mtimeSec: 1_700_000_000,
    indexId: null,
    previous: null,
    needsChecksum: false,
    destinations: [{ destinationId: 1, backedUp: false, worth: null, copyId: null }],
    ...o,
  });
  const input = (entries: LookEntry[], extra: Partial<Parameters<typeof buildPlan>[0]> = {}): Parameters<typeof buildPlan>[0] => ({
    entries,
    filters: DEFAULT_FILTERS,
    rules: compileRules([]),
    root: 'MyData/POCO',
    sessionFolder: 'POCO-23Nov26',
    now: new Date(2026, 10, 23, 12, 0, 0),
    rowIdOf: (rel) => rel.length,
    taken: new Map(),
    looseFor: () => [],
    listedPaths: entries.map((x) => x.path),
    ...extra,
  });

  it('copies new and changed files, skips backed-up ones, counts what is left out per filter and folder, honours exclusions', () => {
    const plan = buildPlan(
      input(
        [
          e('/sdcard/DCIM/Camera/new.jpg', 100),
          e('/sdcard/DCIM/Camera/edit.jpg', 50, { kind: 'changed' }),
          e('/sdcard/DCIM/Camera/done.jpg', 10, { destinations: [{ destinationId: 1, backedUp: true, worth: 'verified', copyId: 9 }] }),
          e('/sdcard/DCIM/.thumbnails/t.jpg', 5),
          e('/sdcard/Android/data/com.x/files/a.bin', 7),
          e('/sdcard/Android/data/com.x/files/b.bin', 8),
          e('/sdcard/Download/never.pdf', 3),
        ],
        { rules: compileRules([rule(1, 'file', '/sdcard/Download/never.pdf', 'leave_out')]) },
      ),
    );
    expect(plan.items.map((i) => [i.path, i.kind])).toEqual([
      ['/sdcard/DCIM/Camera/edit.jpg', 'changed'],
      ['/sdcard/DCIM/Camera/new.jpg', 'new'],
    ]);
    expect(plan.alreadyBackedUp).toBe(1);
    expect(plan.leftOut.map((b) => [b.filter, b.folder, b.files.length, b.bytes]).toSorted()).toEqual(
      [
        ['android_data', '/sdcard/Android/data/com.x', 2, 15],
        ['cache_folder', '/sdcard/DCIM/.thumbnails', 1, 5],
        ['your_rule', '/sdcard/Download/never.pdf', 1, 3],
      ].toSorted(),
    );
  });

  it('two phone files that differ only by case, or map to one name, never share a drive name', () => {
    const plan = buildPlan(input([e('/sdcard/Documents/A.txt', 1), e('/sdcard/Documents/a.txt', 2), e('/sdcard/Documents/b.txt', 3)]));
    const names = plan.items.map((i) => i.destRel.toLowerCase());
    expect(new Set(names).size).toBe(3);
  });

  it('a name already taken today is never reused: the same phone file gets its time, another gets a tag', () => {
    const taken = new Map<string, number | null>([
      ['mydata/poco/poco-23nov26/dcim/camera/a.jpg', 'sdcard/DCIM/Camera/a.jpg'.length],
      ['mydata/poco/poco-23nov26/dcim/camera/b.jpg', 999],
    ]);
    const plan = buildPlan(input([e('/sdcard/DCIM/Camera/a.jpg', 1, { kind: 'changed' }), e('/sdcard/DCIM/Camera/b.jpg', 2)], { taken }));
    const a = plan.items.find((i) => i.path.endsWith('a.jpg'))!;
    const b = plan.items.find((i) => i.path.endsWith('b.jpg'))!;
    expect(a.destRel).toMatch(/a \(120000\)\.jpg$/);
    expect(b.destRel).toMatch(/b \[[0-9a-f]{6}\]\.jpg$/);
  });

  it('a name-and-size match is only offered as a candidate', () => {
    const loose: LooseRow = { id: 4, relPath: 'MyData/POCO/old/IMG.jpg', size: 100, sha256: null };
    const plan = buildPlan(input([e('/sdcard/DCIM/Camera/IMG.jpg', 100)], { looseFor: (name, size) => (name === 'IMG.jpg' && size === 100 ? [loose] : []) }));
    expect(plan.items[0]!.candidates).toEqual([loose]);
    expect(plan.items).toHaveLength(1); // still to be copied until the checksum says otherwise
  });
});

describe('the list on the drive', () => {
  it('quotes every field, keeps new lines and quotes inside a field, and names the columns', () => {
    expect(csvField('a"b')).toBe('"a""b"');
    const csv = listCsv([{ destRel: 'MyData/x/a, b.jpg', phonePath: '/sdcard/it\'s "x"\nname.jpg', size: 12, mtimeMs: Date.UTC(2026, 10, 1, 8, 0, 0), sha256: 'ab' }]);
    expect(csv).toContain('"Path on the drive","Real name on the phone","Size in bytes","Date (UTC)","SHA-256"');
    expect(csv).toContain('"MyData/x/a, b.jpg","/sdcard/it\'s ""x""\nname.jpg","12","2026-11-01 08:00:00","ab"');
    expect(runDate(new Date(2026, 10, 3))).toBe('2026-11-03');
  });
});

describe('the pull time limit of PhoneBackup', () => {
  it('300 s plus 4 s per MB, at most 4 hours', () => {
    expect(pullTimeoutMs(0)).toBe(300_000);
    expect(pullTimeoutMs(100 * 1024 * 1024)).toBe(700_000);
    expect(pullTimeoutMs(1e13)).toBe(14_400_000);
    expect(pullTimeoutMs()).toBe(3_600_000);
  });
});
