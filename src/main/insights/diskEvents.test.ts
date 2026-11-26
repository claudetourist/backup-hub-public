import { describe, expect, it } from 'vitest';
import { eventsPerLetter, parseDiskEvents } from './diskEvents';

describe('disk errors in the Windows log (fake PowerShell output)', () => {
  const raw = JSON.stringify([
    { Id: 7, Message: 'The device, \\Device\\Harddisk2\\DR2, has a bad block.' },
    { Id: 153, Message: 'The IO operation at logical block address 0x1 for Disk 2 was retried.' },
    { Id: 55, Message: 'A corruption was discovered in the file system structure on volume E:.' },
    { Id: 140, Message: 'The system failed to flush data to the transaction log. Corruption may occur in VolumeId: F:, DeviceName: \\Device\\HarddiskVolume9.' },
    { Id: 51, Message: 'An error was detected on device \\Device\\Harddisk7\\DR7 during a paging operation.' },
    { Id: 11, Message: 'The driver detected a controller error.' },
    { Message: 'no id' },
    7,
  ]);

  it('reads the disk number or the drive letter each event names', () => {
    expect(parseDiskEvents(raw).map((e) => [e.id, e.disk, e.letter])).toEqual([[7, 2, null], [153, 2, null], [55, null, 'E:'], [140, null, null], [51, 7, null], [11, null, null]]);
    expect(parseDiskEvents('')).toEqual([]);
    expect(parseDiskEvents('\u{FEFF}{"Id":7,"Message":"Disk 3"}')).toEqual([{ id: 7, disk: 3, letter: null }]);
    expect(() => parseDiskEvents('not json')).toThrow(/not readable/);
  });

  it('counts per drive letter: by the volume named, else every letter on the disk named; unnamed events count for nobody', () => {
    const counts = eventsPerLetter(parseDiskEvents(raw), [
      { letter: 'E:', disk: 2 },
      { letter: 'D:', disk: 2 },
      { letter: 'G:', disk: 4 },
    ]);
    // E: has the volume event and the 2 disk events of disk 2; D: only the 2 disk events; G: none.
    expect(Object.fromEntries(counts)).toEqual({ 'E:': 3, 'D:': 2, 'G:': 0 });
  });
});
