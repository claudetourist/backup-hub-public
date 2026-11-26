import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lookPhone } from '../../adb/phoneLook';
import { FakeDrive, DriveGoneError, ExistsError, TMP_DIR } from './fakeDrive.testutil';
import { ALL_FAULTS, FakeAdbShell, FakePhone, HARMLESS_FAULTS, type FaultKind } from './fakePhone.testutil';
import { Rng } from './rng.testutil';

describe('the seeded random generator', () => {
  it('gives the same numbers for the same seed and different ones for another', () => {
    const a = new Rng(5);
    const b = new Rng(5);
    expect([1, 2, 3, 4, 5].map(() => a.int(1000))).toEqual([1, 2, 3, 4, 5].map(() => b.int(1000)));
    expect(new Rng(6).next()).not.toBe(new Rng(5).next());
    expect(new Rng(1).weighted([['a', 0], ['b', 1]])).toBe('b');
  });
});

describe('the unkind fake drive', () => {
  const bytes = 'some file content';

  it('an unflushed write is lost when the cable is pulled; a flushed one stays', () => {
    const d = new FakeDrive('d');
    d.write('a.txt', bytes, 10);
    d.write('b.txt', bytes, 10);
    d.flush('b.txt');
    d.unplug();
    expect(() => d.readUncached('b.txt')).toThrow(DriveGoneError);
    d.plug();
    expect(d.exists('a.txt')).toBe(false);
    expect(d.readUncached('b.txt').toString()).toBe(bytes);
  });

  it('reading back without the flush only reads memory: the cached read succeeds, the drive read fails', () => {
    const d = new FakeDrive('d');
    d.write('a.txt', bytes, 10);
    expect(d.readCached('a.txt').toString()).toBe(bytes);
    expect(() => d.readUncached('a.txt')).toThrow(/not on the drive/);
    d.flush('a.txt');
    expect(d.readUncached('a.txt').toString()).toBe(bytes);
  });

  it('an unflushed write may be left torn (a first part), never a changed content', () => {
    let torn = 0;
    for (let seed = 1; seed <= 20; seed += 1) {
      const d = new FakeDrive('d', { tornWrites: true }, new Rng(seed));
      d.write('a.txt', bytes, 10);
      d.unplug();
      d.plug();
      const f = d.onDrive()[0];
      if (f) {
        torn += 1;
        expect(f.size).toBeLessThan(bytes.length);
        expect(bytes.startsWith(d.readUncached('a.txt').toString())).toBe(true);
      }
    }
    expect(torn).toBeGreaterThan(0);
  });

  it('the final move cannot replace: EEXIST for any name that is there, case ignored on a case-insensitive drive', () => {
    const d = new FakeDrive('d', { caseInsensitive: true });
    d.write(`${TMP_DIR}1`, bytes, 10);
    d.flush(`${TMP_DIR}1`);
    d.write('x/a.jpg', 'other', 10);
    d.flush('x/a.jpg');
    expect(() => d.linkNoReplace(`${TMP_DIR}1`, 'x/a.jpg')).toThrow(ExistsError);
    expect(() => d.linkNoReplace(`${TMP_DIR}1`, 'X/A.JPG')).toThrow(ExistsError);
    d.linkNoReplace(`${TMP_DIR}1`, 'x/b.jpg');
    expect(d.readCached('x/a.jpg').toString()).toBe('other');
    const exact = new FakeDrive('e');
    exact.write('x/a.jpg', 'o', 1);
    exact.write(`${TMP_DIR}1`, bytes, 1);
    expect(() => exact.linkNoReplace(`${TMP_DIR}1`, 'x/A.JPG')).not.toThrow();
  });

  it('a new name made by the move is lost by an unplug until it is flushed, and never tears the data', () => {
    const d = new FakeDrive('d', { tornWrites: true }, new Rng(3));
    d.write(`${TMP_DIR}1`, bytes, 1);
    d.flush(`${TMP_DIR}1`);
    d.linkNoReplace(`${TMP_DIR}1`, 'final.jpg');
    d.unplug();
    d.plug();
    expect(d.exists('final.jpg')).toBe(false);
    expect(d.readUncached(`${TMP_DIR}1`).toString()).toBe(bytes);
  });

  it('a write over a final name is recorded as an overwrite (never over a temp name)', () => {
    const d = new FakeDrive('d');
    d.write('final.jpg', 'one', 1);
    d.write('final.jpg', 'two', 2);
    d.write(`${TMP_DIR}1`, 'one', 1);
    d.write(`${TMP_DIR}1`, 'two', 1);
    expect(d.overwrites).toEqual(['final.jpg']);
  });

  it('exFAT-like: dates to 2 seconds, ids renumbered when plugged in again', () => {
    const d = new FakeDrive('d', { coarseDates: true, unstableIds: true });
    d.write('a', 'x', 1001);
    d.flush('a');
    expect(d.stat('a')!.mtimeSec).toBe(1000);
    const id = d.stat('a')!.id;
    d.unplug();
    d.plug();
    expect(d.stat('a')!.id).not.toBe(id);
    const steady = new FakeDrive('s');
    steady.write('a', 'x', 1001);
    steady.flush('a');
    const id2 = steady.stat('a')!.id;
    steady.unplug();
    steady.plug();
    expect(steady.stat('a')).toMatchObject({ mtimeSec: 1001, id: id2 });
  });

  it('nothing works while it is unplugged', () => {
    const d = new FakeDrive('d');
    d.unplug();
    expect(() => d.write('a', 'x', 1)).toThrow(DriveGoneError);
    expect(() => d.exists('a')).toThrow(DriveGoneError);
  });
});

describe('the fake phone and its fake adb', () => {
  let phone: FakePhone;
  let shell: FakeAdbShell;
  beforeAll(() => {
    phone = new FakePhone('SER');
    for (let i = 0; i < 12; i += 1) phone.write(`/sdcard/DCIM/Camera/f${i}.jpg`, `content ${i}`, 1_700_000_000 + i);
    phone.write('/sdcard/DCIM/.thumbnails/t.jpg', 'thumb', 1_700_000_000);
    phone.write("/sdcard/DCIM/Camera/it's $HOME;x`y`.jpg", 'hostile', 1_700_000_000);
    phone.write('/sdcard/Documents/a.txt', 'doc', 1_700_000_000);
    shell = new FakeAdbShell(phone, 4);
  });
  afterAll(() => phone.dispose());

  const look = (folders: string[] = ['/sdcard/DCIM', '/sdcard/Documents']) => lookPhone(shell.run, 'SER', folders);

  it('answers the fixed listing command, with hostile names, and the look is complete', async () => {
    const l = await look();
    expect(l.complete).toBe(true);
    expect(l.files).toHaveLength(15);
    expect(l.files.map((f) => f.path)).toContain("/sdcard/DCIM/Camera/it's $HOME;x`y`.jpg");
    expect(shell.commands.every((c) => c.startsWith('{ find ') && c.includes('@@BH_END'))).toBe(true);
  });

  it('refuses any other command', async () => {
    await expect(shell.run('SER', 'rm -rf /sdcard')).rejects.toThrow(/only answers/);
  });

  it('a folder that is not on the phone is explained, not an error', async () => {
    const l = await look(['/sdcard/Nope', '/sdcard/Documents']);
    expect(l).toMatchObject({ complete: true, absentFolders: ['/sdcard/Nope'] });
    expect(l.files).toHaveLength(1);
  });

  it.each(ALL_FAULTS.filter((f) => !HARMLESS_FAULTS.includes(f) && f !== 'empty_ok'))('the fault "%s" leaves the look incomplete', async (fault: FaultKind) => {
    for (let round = 0; round < 6; round += 1) {
      shell.faults.push(fault);
      const l = await look(['/sdcard/DCIM']);
      expect(l.complete, `${fault} round ${round}: ${JSON.stringify(l.problems)}`).toBe(false);
      expect(l.problems.length).toBeGreaterThan(0);
    }
  });

  it('a refused folder the filters drop is harmless: complete, with the folder named', async () => {
    shell.faults.push('denied_harmless');
    const l = await look(['/sdcard/DCIM']);
    expect(l).toMatchObject({ complete: true, unreadable: ['/sdcard/DCIM/.thumbnails'] });
    expect(l.files.some((f) => f.path.includes('.thumbnails'))).toBe(false);
    expect(shell.last.effective).toBe(true);
  });

  it('an empty but well-formed listing is complete (it is the 30% rule that doubts it)', async () => {
    shell.faults.push('empty_ok');
    expect(await look(['/sdcard/DCIM'])).toMatchObject({ complete: true, files: [] });
  });

  it('another device or a failing runner is an incomplete look, never a throw; an abort still throws', async () => {
    expect((await lookPhone(shell.run, 'OTHER', ['/sdcard/DCIM'])).complete).toBe(false);
    const boom = await lookPhone(() => Promise.reject(new Error('adb exploded')), 'SER', ['/sdcard/DCIM']);
    expect(boom.complete).toBe(false);
    expect(boom.problems[0]).toMatchObject({ kind: 'adb_failed', detail: 'adb exploded' });
    const ac = new AbortController();
    ac.abort();
    await expect(lookPhone(() => Promise.reject(new Error('aborted')), 'SER', ['/sdcard/DCIM'], { signal: ac.signal })).rejects.toThrow('aborted');
  });

  it('a folder it cannot send safely is a problem of its own, and no folder at all is not complete', async () => {
    const l = await look(['/sdcard/DCIM', "/sdcard/it's", '/data/x']);
    expect(l.complete).toBe(false);
    expect(l.problems.filter((p) => p.kind === 'bad_folder').map((p) => p.folder)).toEqual(["/sdcard/it's", '/data/x']);
    expect(await look([])).toMatchObject({ complete: false, files: [] });
  });

  it('overlapping folders list a file once', async () => {
    const l = await look(['/sdcard/DCIM', '/sdcard/DCIM/Camera']);
    expect(l.complete).toBe(true);
    expect(l.files).toHaveLength(14);
  });
});
