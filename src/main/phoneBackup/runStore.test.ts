import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeRig, type Rig } from '../look/harness/world.testutil';
import { finishSliced } from '../sliceWork';
import { dropConfirmed, loadConfirmed, loadConfirmedSteps, saveConfirmed, saveConfirmedSteps, type ConfirmedRun } from './runStore';

let rig: Rig;
beforeEach(() => {
  rig = makeRig();
});
afterEach(() => rig.close());

function run(items: number, relinks: number): ConfirmedRun {
  return {
    planId: 'plan-1',
    backupId: 1,
    backupName: 'Poco F4',
    phoneName: 'Poco F4',
    serial: 'S',
    phonePlaceId: 'phone',
    destPlaceId: 'drive',
    destRoot: 'MyData/POCO',
    sessionFolder: 'POCO-24Nov26',
    items: Array.from({ length: items }, (_, i) => ({ path: `/sdcard/DCIM/IMG_${i}.jpg`, size: i, mtimeSec: 1000 + i, destRel: `MyData/POCO/POCO-24Nov26/DCIM/IMG_${i}.jpg`, rowId: i % 7 === 0 ? null : i })),
    relinks: Array.from({ length: relinks }, (_, i) => ({ path: `/sdcard/Old/${i}.jpg`, phoneRowId: i + 1, copyRowId: i + 5000, sha256: 'ab'.repeat(32) })),
    leftOut: { files: 3, bytes: 99 },
    notCovered: ['A second space'],
    folders: ['/sdcard'],
    accept: ['look_empty'],
  };
}

const keys = (): string[] => rig.db.prepare("SELECT key FROM meta WHERE key LIKE 'phoneBackup.run.%' ORDER BY key").pluck().all() as string[];

describe('the confirmed run is stored in pieces', () => {
  it('comes back exactly as it was saved (several pieces of files and of copies to link), by either reader', async () => {
    const r = run(2_500, 1_200);
    saveConfirmed(rig.db, 'plan-1', r);
    expect(keys()).toEqual(['phoneBackup.run.plan-1', 'phoneBackup.run.plan-1.i.0', 'phoneBackup.run.plan-1.i.1', 'phoneBackup.run.plan-1.i.2', 'phoneBackup.run.plan-1.r.0', 'phoneBackup.run.plan-1.r.1']);
    expect(loadConfirmed(rig.db, 'plan-1')).toEqual(r);
    let turns = 0;
    expect(await finishSliced(loadConfirmedSteps(rig.db, 'plan-1'), async () => void (turns += 1), 0)).toEqual(r);
    expect(turns).toBeGreaterThan(2); // read a piece at a time, with the event loop given a turn between
  });

  it('writes in slices too, and a list with nothing in it is fine', async () => {
    let turns = 0;
    await finishSliced(saveConfirmedSteps(rig.db, 'plan-2', run(2_500, 0)), async () => void (turns += 1), 0);
    expect(turns).toBeGreaterThan(2);
    expect(loadConfirmed(rig.db, 'plan-2')).toEqual(run(2_500, 0));
    saveConfirmed(rig.db, 'plan-3', run(0, 0));
    expect(loadConfirmed(rig.db, 'plan-3')).toEqual(run(0, 0));
  });

  it('reads a run an older version stored whole', () => {
    const r = run(5, 2);
    rig.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('phoneBackup.run.old', JSON.stringify(r));
    expect(loadConfirmed(rig.db, 'old')).toEqual(r);
  });

  it('a missing piece or a damaged head gives nothing (the job then says the list is gone) and never half a list', () => {
    saveConfirmed(rig.db, 'plan-1', run(2_500, 0));
    rig.db.prepare("DELETE FROM meta WHERE key = 'phoneBackup.run.plan-1.i.1'").run();
    expect(loadConfirmed(rig.db, 'plan-1')).toBeNull();
    rig.db.prepare("UPDATE meta SET value = '{broken' WHERE key = 'phoneBackup.run.plan-1'").run();
    expect(loadConfirmed(rig.db, 'plan-1')).toBeNull();
    expect(loadConfirmed(rig.db, 'nothing')).toBeNull();
  });

  it('the head is written last, so a run cut off while saving is never read as a whole', async () => {
    const steps = saveConfirmedSteps(rig.db, 'plan-1', run(2_500, 0));
    steps.next();
    expect(loadConfirmed(rig.db, 'plan-1')).toBeNull();
    for (;;) if (steps.next().done) break;
    expect(loadConfirmed(rig.db, 'plan-1')?.items).toHaveLength(2_500);
  });

  it('dropping one run takes its pieces and no other run (not even one whose name starts the same)', () => {
    saveConfirmed(rig.db, 'plan-1', run(2_500, 10));
    saveConfirmed(rig.db, 'plan-10', run(5, 0));
    dropConfirmed(rig.db, 'plan-1');
    expect(keys()).toEqual(['phoneBackup.run.plan-10', 'phoneBackup.run.plan-10.i.0']);
    expect(loadConfirmed(rig.db, 'plan-10')?.items).toHaveLength(5);
  });
});
