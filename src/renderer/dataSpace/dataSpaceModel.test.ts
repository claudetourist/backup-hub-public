import { describe, expect, it } from 'vitest';
import type { DataSpaceInfo } from '../../shared/dataSpace';
import { spaceFacts, spaceRow } from './dataSpaceModel';

const info = (over: Partial<DataSpaceInfo>): DataSpaceInfo => ({
  dataDir: 'D:/BackupHub/data',
  disk: 'D:',
  freeBytes: 40_000_000_000,
  dbBytes: 1_270_000_000,
  walBytes: 0,
  snapshotsBytes: 0,
  snapshotCount: 0,
  level: 'ok',
  message: null,
  warnBelowBytes: 5_000_000_000,
  blockBelowBytes: 2_000_000_000,
  ...over,
});

describe('Home line about room', () => {
  it('shows nothing while there is room, a notice under 5 GB and an urgent line under 2 GB', () => {
    expect(spaceRow(null)).toBeNull();
    expect(spaceRow(info({}))).toBeNull();
    expect(spaceRow(info({ level: 'low', freeBytes: 3_300_000_000, message: 'Only 3.3 GB free.' }))).toMatchObject({ severity: 'amber', title: 'Room is getting short on D:', detail: 'Only 3.3 GB free.' });
    expect(spaceRow(info({ level: 'critical', freeBytes: 1_000_000_000, message: 'Only 1.0 GB free.' }))).toMatchObject({ severity: 'crit' });
  });
});

describe('Settings facts', () => {
  it('shows the database size and the free space on its disk', () => {
    const facts = spaceFacts(info({}));
    expect(facts[0]).toMatchObject({ label: 'Database', value: '1.3 GB' });
    expect(facts[1]).toMatchObject({ label: 'Free space on D:', value: '40 GB free' });
  });

  it('mentions recent changes waiting in the log, the daily copies, and a disk Windows would not measure', () => {
    const facts = spaceFacts(info({ walBytes: 583_000_000, snapshotCount: 5, snapshotsBytes: 3_800_000_000, freeBytes: null }));
    expect(facts[0]?.note).toMatch(/plus .* of recent changes/);
    expect(facts[1]?.value).toBe('Windows did not say');
    expect(facts[2]).toMatchObject({ label: 'Daily copies in the data folder' });
  });
});
