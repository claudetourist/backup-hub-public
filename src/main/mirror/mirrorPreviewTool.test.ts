import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MirrorWorld } from '../look/harness/mirrorWorld.testutil';
import { makeRig, World, type Rig } from '../look/harness/world.testutil';
import { runMirrorPreview } from './mirrorPreviewTool';

let rig: Rig;
let w: World;
let mw: MirrorWorld;

beforeEach(() => {
  rig = makeRig();
  w = new World(rig, { seed: 77 });
  mw = new MirrorWorld(w);
});
afterEach(() => {
  w.dispose();
  rig.close();
});

const sha = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

describe('r13-preview: what would be copied, writes nothing', () => {
  it('prints the counts and leaves the database file byte for byte as it was', async () => {
    mw.seed('S1/big.bin', 'b'.repeat(500));
    mw.seed('S1/own.bin', 'no phone checksum', { expected: false });
    mw.seed('S1/same.bin', 'same');
    mw.seed('S1/diff.bin', 'T7');
    mw.seedSeagate('S1/same.bin', 'same');
    mw.seedSeagate('S1/diff.bin', 'a different size');
    await mw.plan(); // a look: brings the index up to date
    rig.db.pragma('wal_checkpoint(TRUNCATE)');
    const copy = path.join(rig.dir, 'copy.db');
    fs.copyFileSync(path.join(rig.dir, 'test.db'), copy);
    const before = sha(copy);
    const lines: string[] = [];
    const code = await runMirrorPreview({ dbPath: copy, print: (l) => lines.push(l) });
    expect(code).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('TO COPY to Seagate2TB: 2 files, 517 bytes');
    expect(text).toContain('1 of them have no phone checksum');
    expect(text).toContain('ALREADY on Seagate2TB with the same size, not checked yet: 1 files');
    expect(text).toContain('CHECK OLD COPIES on Seagate2TB: 1 files');
    expect(text).toContain('1 need ONE read');
    expect(text).toContain('other files: 1 files');
    expect(text).toContain('ALREADY on Seagate2TB with ANOTHER size: 1 files');
    expect(text).toContain('500|S1/big.bin|phone');
    expect(text).toContain('17|S1/own.bin|own');
    expect(sha(copy)).toBe(before);
    // (Opening a WAL database read only may leave empty -shm and -wal side files: no page of the database file changes.)
    expect(fs.existsSync(copy + '-wal') ? fs.statSync(copy + '-wal').size : 0).toBe(0);
  });

  it('says so for a backup with no second drive', async () => {
    rig.db.prepare('DELETE FROM backup_destinations WHERE position = 2').run();
    rig.db.pragma('wal_checkpoint(TRUNCATE)');
    const copy = path.join(rig.dir, 'copy.db');
    fs.copyFileSync(path.join(rig.dir, 'test.db'), copy);
    const lines: string[] = [];
    expect(await runMirrorPreview({ dbPath: copy, print: (l) => lines.push(l) })).toBe(2);
    expect(lines[0]).toContain('No such backup with a second drive');
  });

  it('--hash reads both drives and counts the same and the different (reads only)', async () => {
    mw.seed('S1/a.bin', 'aaaa');
    mw.seed('S1/b.bin', 'bbbb');
    mw.seedSeagate('S1/a.bin', 'aaaa');
    mw.seedSeagate('S1/b.bin', 'xxxx');
    await mw.plan();
    rig.db.pragma('wal_checkpoint(TRUNCATE)');
    const copy = path.join(rig.dir, 'copy.db');
    fs.copyFileSync(path.join(rig.dir, 'test.db'), copy);
    const t7 = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-prev-t7-'));
    const sea = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-prev-sea-'));
    try {
      for (const [root, b] of [[t7, 'bbbb'], [sea, 'xxxx']] as const) {
        fs.mkdirSync(path.join(root, 'MyData', 'POCO', 'S1'), { recursive: true });
        fs.writeFileSync(path.join(root, 'MyData', 'POCO', 'S1', 'a.bin'), 'aaaa');
        fs.writeFileSync(path.join(root, 'MyData', 'POCO', 'S1', 'b.bin'), b);
      }
      const lines: string[] = [];
      expect(await runMirrorPreview({ dbPath: copy, hash: true, srcRoot: t7, dstRoot: sea, print: (l) => lines.push(l) })).toBe(0);
      expect(lines.join('\n')).toContain('READ AND COMPARED 2 of 2 same-size files: 1 same, 1 different, 0 could not be read.');
    } finally {
      fs.rmSync(t7, { recursive: true, force: true });
      fs.rmSync(sea, { recursive: true, force: true });
    }
  });
});
