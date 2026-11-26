import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobService } from '../jobs/jobService';
import { makeRig, World } from '../look/harness/world.testutil';
import { realMirrorDrive } from './mirrorDrive';
import { MirrorService } from './mirrorService';
import type { MirrorDeps } from './mirrorTypes';

/**
 * Speed of "Check old copies" over real folders: N small files that are already on both drives with the same size (the old copies of the previous tool).
 * Before the split (the combined copy job read and compared them one by one, then linked each with its own transaction): known 146 files/s, unknown 93 files/s (20,000 files, SSD temp folder).
 * Only runs when MIRROR_SPEED=1 (it makes 2 x N files in the system temp folder): `MIRROR_SPEED=1 MIRROR_SPEED_FILES=20000 npx vitest run src/main/mirror/mirrorSpeed.test.ts`.
 * Prints files per second for the two cases: the first drive's checksum is known (one read per file) and unknown (two reads).
 */
const N = Number(process.env['MIRROR_SPEED_FILES'] ?? 20_000);
const rel = (i: number): string => `S1/d${String(i % 200).padStart(3, '0')}/f${i}.jpg`;
const content = (i: number): string => `file number ${i} `.repeat(60 + (i % 40));

let t7 = '';
let seagate = '';
const sums = new Map<string, string>();

beforeAll(() => {
  if (!process.env['MIRROR_SPEED']) return;
  t7 = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-speed-t7-'));
  seagate = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-speed-sea-'));
  for (let i = 0; i < N; i += 1) {
    const text = content(i);
    sums.set(`MyData/POCO/${rel(i)}`, createHash('sha256').update(text).digest('hex'));
    for (const root of [t7, seagate]) {
      const file = path.join(root, 'MyData', 'POCO', ...rel(i).split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      fs.utimesSync(file, 1_700_000_000, 1_700_000_000);
    }
  }
}, 600_000);
afterAll(async () => {
  for (const d of [t7, seagate]) if (d) await fs.promises.rm(d, { recursive: true, force: true });
}, 300_000);

const waitFor = async (cond: () => boolean, ms = 3_600_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe.skipIf(!process.env['MIRROR_SPEED'])('files per second: same-size files already on the second drive', () => {
  for (const known of [true, false]) {
    it(`${N} files, first drive's checksum ${known ? 'known (one read)' : 'unknown (two reads)'}`, async () => {
      const rig = makeRig();
      const w = new World(rig, { seed: 41 });
      const place = (i: number): string => w.destinations[i]!.placeId;
      rig.db.prepare('UPDATE places SET label = ? WHERE id = ?').run('T7', place(0));
      rig.db.prepare('UPDATE places SET label = ? WHERE id = ?').run('Seagate2TB', place(1));
      w.tick(60);
      const deps: MirrorDeps = {
        db: rig.db,
        log: { info: () => undefined, warn: () => undefined },
        now: () => w.nowMs,
        pluggedPlaces: async () => new Set([place(0), place(1)]),
        drivesFor: async () => ({ src: realMirrorDrive({ db: rig.db, placeId: place(0), label: 'T7', root: t7 }), dst: realMirrorDrive({ db: rig.db, placeId: place(1), label: 'Seagate2TB', root: seagate }) }),
        sleep: async () => undefined,
      };
      const jobs = new JobService({ db: rig.db });
      const s = new MirrorService(deps, jobs);
      for (const h of s.handlers()) jobs.register(h);
      jobs.start();
      try {
        rig.db.prepare('DELETE FROM backup_destinations WHERE position = 2').run();
        expect(s.addCopy({ backupId: w.profileId, placeId: place(1) }).ok).toBe(true);
        const look = await s.startLook(w.profileId);
        await waitFor(() => jobs.get(look.jobId!)?.state === 'done');
        if (known) {
          const set = rig.db.prepare('UPDATE files SET expected_sha256 = ?, sha256 = ? WHERE place_id = ? AND rel_path = ?');
          rig.db.transaction(() => {
            for (const [r, sha] of sums) set.run(sha, sha, place(0), r);
          })();
        }
        const t0 = Date.now();
        const result = await RUN(s, jobs, w.profileId);
        const sec = (Date.now() - t0) / 1000;
        console.log(`SPEED ${known ? 'known' : 'unknown'} checksum: ${N} files in ${sec.toFixed(1)} s = ${(N / sec).toFixed(0)} files/s (${result})`);
      } finally {
        w.dispose();
        rig.close();
      }
    }, 3_600_000);
  }
});

async function RUN(s: MirrorService, jobs: JobService, backupId: number): Promise<string> {
  const p = await s.checkPreview(backupId);
  if (!p.ok) throw new Error('no list');
  expect(p.plan.totals.files).toBe(N);
  const started = await s.checkStart({ planId: p.plan.planId, hash: p.plan.hash });
  expect(started.ok).toBe(true);
  await waitFor(() => ['done', 'done_warnings', 'failed'].includes(jobs.get(started.jobId!)?.state ?? ''));
  const rep = s.checkReport(started.jobId!);
  return `verified ${rep?.verified}, different ${rep?.differs}, one read ${rep?.oneRead}, two reads ${rep?.twoReads}`;
}
